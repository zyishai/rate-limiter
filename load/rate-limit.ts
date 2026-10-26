import { textSummary } from 'https://jslib.k6.io/k6-summary/0.1.0/index.js';
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import http, { type RefinedResponse, type RequestBody, type ResponseType } from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';
import type { Options, Scenario } from 'k6/options';
import {
  ENDPOINTS,
  isRedisScenario,
  parseChoice,
  RESULT_FILES,
  resultsDir,
  SCENARIOS,
  type ScenarioName,
} from './runs.ts';

const SCENARIO = parseChoice('SCENARIO', __ENV['SCENARIO'], SCENARIOS);
const ENDPOINT = parseChoice('ENDPOINT', __ENV['ENDPOINT'], ENDPOINTS);
if (isRedisScenario(SCENARIO) && ENDPOINT !== '/robust') {
  throw new Error(`${SCENARIO} only runs against /robust, because ${ENDPOINT} never calls Redis`);
}

const BASE_URL = __ENV['BASE_URL'] || 'http://localhost:8080';
const TCP_URL = __ENV['TCP_URL'] || 'http://localhost:8081';
const TOXIPROXY_URL = __ENV['TOXIPROXY_URL'] || 'http://localhost:8474';
const TARGET_URL = `${SCENARIO === 'connections' ? TCP_URL : BASE_URL}${ENDPOINT}`;

const DECISIONS = ['local', 'global', 'fallback'];

const allowed = new Counter('allowed');
const limited = new Counter('limited');
const limitedRate = new Rate('limited_rate');
const unexpectedStatus = new Counter('unexpected_status');
const missingRetryAfter = new Counter('missing_retry_after');
const fireLateness = new Trend('fire_lateness_ms', true);

http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }, 429));

interface Plan {
  readonly scenarios: Record<string, Scenario>;
  readonly thresholds: Record<string, string[]>;
}

const between = (min: number, max: number): string[] => [`count>=${min}`, `count<=${max}`];

const atRate = (rate: number, duration: string, startTime = '0s'): Scenario => ({
  executor: 'constant-arrival-rate',
  rate,
  timeUnit: '1s',
  duration,
  startTime,
  preAllocatedVUs: 50,
  maxVUs: 200,
  exec: 'load',
});

const firedTogether = (vus: number): Scenario => ({
  executor: 'per-vu-iterations',
  vus,
  iterations: 1,
  exec: 'fire',
});

const controlAt = (fn: string, startTime: string): Scenario => ({
  executor: 'per-vu-iterations',
  vus: 1,
  iterations: 1,
  startTime,
  exec: fn,
});

const PLANS: Record<ScenarioName, () => Plan> = {
  normal_load: () => ({
    scenarios: { normal_load: atRate(100, '30s') },
    thresholds: { 'limited_rate{scenario:normal_load}': ['rate<0.02'] },
  }),
  burst_then_load: () => ({
    scenarios: { burst: firedTogether(100), load: atRate(100, '30s', '3s') },
    thresholds: {
      'allowed{scenario:burst}': ['count<=30'],
      'allowed{scenario:load}': between(2700, 3100),
    },
  }),
  window_boundary: () => ({
    scenarios: { window_boundary: firedTogether(200) },
    thresholds: {
      'allowed{scenario:window_boundary}': ['count<=40'],
      'fire_lateness_ms{scenario:window_boundary}': ['max<15'],
    },
  }),
  over_limit: () => ({
    scenarios: { over_limit: atRate(500, '30s') },
    thresholds: { 'allowed{scenario:over_limit}': between(2700, 3300) },
  }),
  connections: () => ({
    scenarios: {
      one_connection: { executor: 'constant-vus', vus: 1, duration: '30s', exec: 'load' },
      many_connections: { ...atRate(500, '30s'), preAllocatedVUs: 50, maxVUs: 50 },
    },
    thresholds: {
      'allowed{scenario:one_connection}': between(2700, 3300),
      'allowed{scenario:many_connections}': between(2700, 3300),
      'http_reqs{scenario:one_connection}': ['count>=3000'],
    },
  }),
  ramp: () => ({
    scenarios: {
      ramp: {
        executor: 'ramping-arrival-rate',
        startRate: 0,
        timeUnit: '1s',
        stages: [{ target: 400, duration: '60s' }],
        preAllocatedVUs: 50,
        maxVUs: 200,
        exec: 'load',
      },
    },
    thresholds: { 'allowed{scenario:ramp}': between(4700, 5800) },
  }),
  redis_slow_below: () => ({
    scenarios: { redis_slow_below: atRate(300, '30s') },
    thresholds: {
      'allowed{decision:fallback}': ['count==0'],
      'allowed{scenario:redis_slow_below}': between(2700, 3300),
    },
  }),
  redis_slow_above: () => ({
    scenarios: { redis_slow_above: atRate(300, '30s') },
    thresholds: {
      'allowed{decision:fallback}': ['count>0'],
      'allowed{scenario:redis_slow_above}': ['count<=3300'],
    },
  }),
  redis_down: () => ({
    scenarios: {
      redis_down: atRate(300, '60s'),
      redis_disable: controlAt('disableRedis', '20s'),
      redis_enable: controlAt('enableRedis', '40s'),
    },
    thresholds: {
      'allowed{decision:fallback}': ['count>0'],
      'allowed{scenario:redis_down}': between(5400, 6600),
    },
  }),
};

const plan = PLANS[SCENARIO]();

export const options: Options = {
  scenarios: plan.scenarios,
  thresholds: {
    dropped_iterations: ['count==0'],
    'http_req_failed{role:load}': ['rate<0.01'],
    'unexpected_status{role:load}': ['count==0'],
    missing_retry_after: ['count==0'],
    'checks{role:load}': ['rate>0.99'],
    'http_req_duration{role:load}': ['p(95)<50', 'p(99)<100'],
    ...plan.thresholds,
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(95)', 'p(99)'],
};

interface SetupData {
  readonly key: string;
  readonly fireAtMs: readonly number[];
}

const LATENCY_MS: Partial<Record<ScenarioName, number>> = {
  redis_slow_below: 5,
  redis_slow_above: 50,
};

const toxiproxy = (path: string, body?: object): void => {
  const payload: RequestBody | null = body === undefined ? null : JSON.stringify(body);
  const res = http.post(`${TOXIPROXY_URL}${path}`, payload, {
    headers: { 'Content-Type': 'application/json' },
    tags: { role: 'control' },
  });
  if (res.status < 200 || res.status > 299) {
    exec.test.abort(`Toxiproxy ${path} answered ${res.status}: ${String(res.body)}`);
  }
};

const fireTimes = (nowMs: number): number[] => {
  if (SCENARIO === 'burst_then_load') return [nowMs + 2000];
  if (SCENARIO === 'window_boundary') {
    const boundaryMs = Math.ceil((nowMs + 2000) / 1000) * 1000;
    return [boundaryMs - 100, boundaryMs + 50];
  }
  return [];
};

export function setup(): SetupData {
  toxiproxy('/reset');
  const latency = LATENCY_MS[SCENARIO];
  if (latency !== undefined) {
    toxiproxy('/proxies/redis/toxics', {
      name: 'latency',
      type: 'latency',
      stream: 'downstream',
      toxicity: 1,
      attributes: { latency, jitter: 0 },
    });
  }

  const nowMs = Date.now();
  return { key: `${SCENARIO}-${nowMs}`, fireAtMs: fireTimes(nowMs) };
}

export function teardown(): void {
  toxiproxy('/reset');
}

const isValidRetryAfter = (value: string | undefined): boolean =>
  value !== undefined && /^\d+$/.test(value) && Number(value) >= 1;

const responseChecks = {
  'status is 200 or 429': (r: RefinedResponse<ResponseType>) =>
    r.status === 200 || r.status === 429,
  'X-Instance is present': (r: RefinedResponse<ResponseType>) => !!r.headers['X-Instance'],
  '429 has a valid Retry-After': (r: RefinedResponse<ResponseType>) =>
    r.status !== 429 || isValidRetryAfter(r.headers['Retry-After']),
  ...(ENDPOINT === '/robust' && {
    'X-Limiter-Decision is local, global or fallback': (r: RefinedResponse<ResponseType>) =>
      DECISIONS.includes(r.headers['X-Limiter-Decision'] ?? ''),
  }),
};

const send = (key: string): RefinedResponse<ResponseType> =>
  http.get(TARGET_URL, { headers: { 'X-API-Key': key }, tags: { role: 'load' } });

const record = (res: RefinedResponse<ResponseType>): Record<string, string> => {
  const tags = {
    role: 'load',
    decision: res.headers['X-Limiter-Decision'] ?? 'none',
    instance: res.headers['X-Instance'] ?? 'unknown',
  };

  if (res.status === 200) {
    allowed.add(1, tags);
  } else if (res.status === 429) {
    limited.add(1, tags);
    if (!isValidRetryAfter(res.headers['Retry-After'])) missingRetryAfter.add(1, tags);
  } else {
    unexpectedStatus.add(1, tags);
  }
  limitedRate.add(res.status === 429, tags);
  check(res, responseChecks, { role: 'load' });

  return tags;
};

export function load(data: SetupData): void {
  const key = SCENARIO === 'connections' ? `${data.key}-${exec.scenario.name}` : data.key;
  record(send(key));
}

export function fire(data: SetupData): void {
  http.get(`${BASE_URL}/naive`, {
    headers: { 'X-API-Key': `${data.key}-warmup` },
    tags: { role: 'control' },
  });

  const fireAtMs = data.fireAtMs[exec.scenario.iterationInTest % data.fireAtMs.length];
  if (fireAtMs === undefined) throw new Error(`${SCENARIO} has no fire times`);
  sleep(Math.max(0, fireAtMs - Date.now()) / 1000);

  const latenessMs = Date.now() - fireAtMs;
  fireLateness.add(latenessMs, record(send(data.key)));
}

export function disableRedis(): void {
  toxiproxy('/proxies/redis', { enabled: false });
}

export function enableRedis(): void {
  toxiproxy('/proxies/redis', { enabled: true });
}

export function handleSummary(data: object): Record<string, string> {
  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
    [`${resultsDir(SCENARIO, ENDPOINT)}/${RESULT_FILES.summary}`]: textSummary(data, {
      indent: ' ',
      enableColors: false,
    }),
  };
}

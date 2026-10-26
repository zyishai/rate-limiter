import { createReadStream, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { RESULT_FILES } from './runs.ts';

const DECISIONS = ['local', 'global', 'fallback', 'none'] as const;
const OUTCOMES: readonly Outcome[] = ['allowed', 'limited'];
const RELEVANT_METRICS = new Set(['http_reqs', 'http_req_duration', 'allowed', 'limited']);

interface Sample {
  readonly metric: string;
  readonly timestampMs: number;
  readonly value: number;
  readonly scenario: string;
  readonly tags: Readonly<Record<string, string>>;
}

type Outcome = 'allowed' | 'limited';

interface Second {
  offered: number;
  allowed: Record<string, number>;
  limited: Record<string, number>;
  allowedByScenario: Record<string, number>;
  durationsMs: number[];
}

export interface RunSummary {
  readonly text: string;
  readonly admitted: string;
}

const parseCsvLine = (line: string): string[] => {
  const fields: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted && char === '"' && line[i + 1] === '"') {
      field += '"';
      i++;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
};

const parseTags = (extraTags: string): Record<string, string> =>
  Object.fromEntries(
    extraTags
      .split('&')
      .filter(Boolean)
      .map((pair) => {
        const at = pair.indexOf('=');
        return [pair.slice(0, at), pair.slice(at + 1)];
      }),
  );

const readSamples = async (csvPath: string): Promise<{ samples: Sample[]; startMs: number }> => {
  const lines = createInterface({ input: createReadStream(csvPath).pipe(createGunzip()) });
  const samples: Sample[] = [];
  let columns: Record<string, number> = {};
  let startMs = Number.POSITIVE_INFINITY;

  for await (const line of lines) {
    const fields = parseCsvLine(line);
    if (Object.keys(columns).length === 0) {
      columns = Object.fromEntries(fields.map((name, index) => [name, index]));
      continue;
    }
    const field = (name: string): string => fields[columns[name] ?? -1] ?? '';

    const timestampMs = Number(field('timestamp'));
    startMs = Math.min(startMs, timestampMs);

    const metric = field('metric_name');
    if (!RELEVANT_METRICS.has(metric)) continue;

    const tags = parseTags(field('extra_tags'));
    if (tags['role'] !== 'load') continue;

    samples.push({
      metric,
      timestampMs,
      value: Number(field('metric_value')),
      scenario: field('scenario'),
      tags,
    });
  }
  return { samples, startMs };
};

const p99 = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.99) - 1] ?? 0;
};

const zeroPerDecision = (): Record<string, number> =>
  Object.fromEntries(DECISIONS.map((decision) => [decision, 0]));

const emptySecond = (): Second => ({
  offered: 0,
  allowed: zeroPerDecision(),
  limited: zeroPerDecision(),
  allowedByScenario: {},
  durationsMs: [],
});

const total = (perDecision: Record<string, number>): number =>
  Object.values(perDecision).reduce((sum, value) => sum + value, 0);

const timeRange = (samples: readonly Sample[]): { firstMs: number; lastMs: number } => {
  let firstMs = Number.POSITIVE_INFINITY;
  let lastMs = Number.NEGATIVE_INFINITY;
  for (const { timestampMs } of samples) {
    firstMs = Math.min(firstMs, timestampMs);
    lastMs = Math.max(lastMs, timestampMs);
  }
  return { firstMs, lastMs };
};

const count = (samples: readonly Sample[], metric: string): number =>
  samples.filter((sample) => sample.metric === metric).length;

const admittedPerSecond = (samples: readonly Sample[]): number => {
  const requests = samples.filter((sample) => sample.metric === 'http_reqs');
  if (requests.length === 0) return 0;

  const { firstMs, lastMs } = timeRange(requests);
  const spanSeconds = Math.max(1, Math.round((lastMs - firstMs) / 1000));
  return count(samples, 'allowed') / spanSeconds;
};

export const formatTable = (
  rows: readonly (readonly (string | number)[])[],
  align: 'left' | 'right' = 'right',
): string => {
  const widths = rows[0]?.map((_, column) =>
    Math.max(...rows.map((row) => String(row[column] ?? '').length)),
  );
  const pad = (cell: string | number, column: number): string => {
    const width = widths?.[column] ?? 0;
    return align === 'left' ? String(cell).padEnd(width) : String(cell).padStart(width);
  };
  return rows.map((row) => row.map(pad).join('  ').trimEnd()).join('\n');
};

const buildTimeline = (samples: readonly Sample[], startMs: number): Second[] => {
  const seconds: Second[] = [];
  for (const sample of samples) {
    const index = Math.floor((sample.timestampMs - startMs) / 1000);
    const second = seconds[index] ?? emptySecond();
    seconds[index] = second;

    if (sample.metric === 'http_reqs') second.offered++;
    if (sample.metric === 'http_req_duration') second.durationsMs.push(sample.value);
    if (sample.metric === 'allowed' || sample.metric === 'limited') {
      const perDecision = second[sample.metric];
      const decision = sample.tags['decision'] ?? 'none';
      perDecision[decision] = (perDecision[decision] ?? 0) + 1;
    }
    if (sample.metric === 'allowed') {
      const { allowedByScenario } = second;
      allowedByScenario[sample.scenario] = (allowedByScenario[sample.scenario] ?? 0) + 1;
    }
  }
  return Array.from(seconds, (second) => second ?? emptySecond());
};

const describeDecisions = (samples: readonly Sample[], outcome: Outcome): string =>
  DECISIONS.map(
    (decision) =>
      `${decision}=${samples.filter((s) => s.metric === outcome && s.tags['decision'] === decision).length}`,
  ).join(' ');

const describeScenarios = (samples: readonly Sample[]): Map<string, number> => {
  const scenarios = [...new Set(samples.map((sample) => sample.scenario))].sort();
  return new Map(
    scenarios.map((scenario) => [
      scenario,
      admittedPerSecond(samples.filter((sample) => sample.scenario === scenario)),
    ]),
  );
};

export const summarizeRun = async (dir: string): Promise<RunSummary> => {
  const { samples, startMs } = await readSamples(join(dir, RESULT_FILES.samples));
  const timeline = buildTimeline(samples, startMs);

  // Runs with several k6 scenarios (e.g. two clients) also get allowed per scenario per second.
  const loadScenarios = [...new Set(samples.map((sample) => sample.scenario))].sort();
  const scenarioColumns = loadScenarios.length > 1 ? loadScenarios : [];

  const timelineTable = formatTable([
    [
      'second',
      'offered',
      'allowed',
      'limited',
      ...OUTCOMES.flatMap((outcome) => DECISIONS.map((decision) => `${outcome}_${decision}`)),
      ...scenarioColumns.map((scenario) => `allowed@${scenario}`),
      'p99_ms',
    ],
    ...timeline.map((second, index) => [
      index,
      second.offered,
      total(second.allowed),
      total(second.limited),
      ...OUTCOMES.flatMap((outcome) => DECISIONS.map((decision) => second[outcome][decision] ?? 0)),
      ...scenarioColumns.map((scenario) => second.allowedByScenario[scenario] ?? 0),
      p99(second.durationsMs).toFixed(1),
    ]),
  ]);

  const allowedSamples = samples.filter((sample) => sample.metric === 'allowed');
  const instances = new Map<string, number>();
  for (const sample of allowedSamples) {
    const instance = sample.tags['instance'] ?? 'unknown';
    instances.set(instance, (instances.get(instance) ?? 0) + 1);
  }

  const perScenario = describeScenarios(samples);
  const totals = [
    `offered: ${count(samples, 'http_reqs')}`,
    `allowed: ${allowedSamples.length}`,
    `limited: ${count(samples, 'limited')}`,
    ...OUTCOMES.map((outcome) => `${outcome} by decision: ${describeDecisions(samples, outcome)}`),
    `p99 latency: ${p99(samples.filter((s) => s.metric === 'http_req_duration').map((s) => s.value)).toFixed(1)} ms`,
    `admitted req/s: ${admittedPerSecond(samples).toFixed(1)}`,
    ...[...perScenario].map(([scenario, rate]) => `  ${scenario}: ${rate.toFixed(1)}`),
    `instances serving allowed requests: ${instances.size}`,
    ...[...instances].sort().map(([instance, allowed]) => `  ${instance}: ${allowed}`),
  ];

  const text = `${timelineTable}\n\n${totals.join('\n')}\n`;
  writeFileSync(join(dir, RESULT_FILES.timeline), text);

  const admitted =
    perScenario.size > 1
      ? [...perScenario].map(([scenario, rate]) => `${scenario} ${rate.toFixed(1)}`).join(', ')
      : admittedPerSecond(samples).toFixed(1);
  return { text, admitted };
};

if (import.meta.main) {
  const dir = process.argv[2];
  if (dir === undefined) {
    console.error('Usage: npm run load:summarize -- results/<scenario>-<endpoint>');
    process.exit(1);
  }
  console.log((await summarizeRun(dir)).text);
}

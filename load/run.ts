import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  ENDPOINTS,
  type Endpoint,
  parseChoice,
  REDIS_SCENARIOS,
  RESULT_FILES,
  resultsDir,
  SCENARIOS,
  type ScenarioName,
} from './runs.ts';
import { formatTable, summarizeRun } from './summarize.ts';

const LOOP_SCENARIOS: readonly ScenarioName[] = [
  'normal_load',
  'burst_then_load',
  'over_limit',
  'connections',
  'ramp',
];
const PAUSE_BETWEEN_RUNS_MS = 5000;
const EXIT_THRESHOLDS_FAILED = 99;
const EXIT_INTERRUPTED = 105;

interface Run {
  readonly scenario: ScenarioName;
  readonly endpoint: Endpoint;
}

interface Outcome extends Run {
  readonly admitted: string;
  readonly thresholds: string;
}

const useDocker = process.env['K6'] === 'docker';
const singleInstance = process.env['INSTANCES'] === '1';
const scenarioFilter = process.env['SCENARIO']
  ? parseChoice('SCENARIO', process.env['SCENARIO'], SCENARIOS)
  : undefined;
const endpointFilter = process.env['ENDPOINT']
  ? parseChoice('ENDPOINT', process.env['ENDPOINT'], ENDPOINTS)
  : undefined;

const everyEndpoint = (scenario: ScenarioName): Run[] =>
  ENDPOINTS.map((endpoint) => ({ scenario, endpoint }));

const plannedRuns = (): Run[] => [
  ...LOOP_SCENARIOS.flatMap(everyEndpoint),
  ...(singleInstance ? everyEndpoint('window_boundary') : []),
  ...REDIS_SCENARIOS.map((scenario) => ({ scenario, endpoint: '/robust' as const })),
];

const selectRuns = (): Run[] =>
  plannedRuns().filter(
    (run) =>
      (scenarioFilter === undefined || run.scenario === scenarioFilter) &&
      (endpointFilter === undefined || run.endpoint === endpointFilter),
  );

const ensureK6 = (): void => {
  const [command, args] = useDocker ? ['docker', ['compose', 'version']] : ['k6', ['version']];
  if (spawnSync(command, args, { stdio: 'ignore' }).error) {
    console.error(
      useDocker
        ? 'Docker was not found on the PATH. Install Docker, or run k6 locally without K6=docker.'
        : 'k6 was not found on the PATH. Install it with `brew install k6`, or run with K6=docker.',
    );
    process.exit(1);
  }
};

const k6Env = (dir: string, liveDashboard: boolean): Record<string, string> => ({
  K6_WEB_DASHBOARD: 'true',
  K6_WEB_DASHBOARD_PERIOD: '1s',
  K6_WEB_DASHBOARD_EXPORT: `${dir}/${RESULT_FILES.report}`,
  K6_CSV_TIME_FORMAT: 'unix_milli',
  ...(liveDashboard ? {} : { K6_WEB_DASHBOARD_PORT: '-1' }),
});

// Paths are relative so they resolve the same way locally and in the k6 container (working_dir /).
const k6Args = ({ scenario, endpoint }: Run, dir: string): string[] => [
  'run',
  '--out',
  `csv=${dir}/${RESULT_FILES.samples}`,
  '-e',
  `SCENARIO=${scenario}`,
  '-e',
  `ENDPOINT=${endpoint}`,
  'load/rate-limit.ts',
];

const runK6 = (run: Run, dir: string, liveDashboard: boolean): number | null => {
  const env = k6Env(dir, liveDashboard);
  const result = useDocker
    ? spawnSync(
        'docker',
        [
          'compose',
          'run',
          '--rm',
          ...(liveDashboard ? ['--service-ports'] : []),
          ...Object.entries(env).flatMap(([name, value]) => ['-e', `${name}=${value}`]),
          'k6',
          ...k6Args(run, dir),
        ],
        { stdio: 'inherit' },
      )
    : spawnSync('k6', k6Args(run, dir), { stdio: 'inherit', env: { ...process.env, ...env } });
  return result.signal ? EXIT_INTERRUPTED : result.status;
};

const thresholdsResult = (exitCode: number | null): string => {
  if (exitCode === 0) return 'passed';
  if (exitCode === EXIT_THRESHOLDS_FAILED) return 'failed';
  return `error (exit ${exitCode})`;
};

const printTable = (outcomes: readonly Outcome[]): void => {
  const rows = [
    ['scenario', 'endpoint', 'admitted req/s', 'thresholds'],
    ...outcomes.map((o) => [o.scenario, o.endpoint, o.admitted, o.thresholds]),
  ];
  console.log(`\n${formatTable(rows, 'left')}`);
};

const main = async (): Promise<void> => {
  ensureK6();

  if (!singleInstance && (scenarioFilter === undefined || scenarioFilter === 'window_boundary')) {
    console.log(
      'Skipping window_boundary: it needs one instance. Restart the stack with INSTANCES=1 and run with INSTANCES=1.',
    );
  }

  const runs = selectRuns();
  if (runs.length === 0) {
    console.error('No run matches the SCENARIO and ENDPOINT filters.');
    process.exit(1);
  }

  const liveDashboard = runs.length === 1;
  if (liveDashboard) {
    console.log('Live dashboard: http://localhost:5665 (k6 waits until you close the tab)');
  }

  const outcomes: Outcome[] = [];
  for (const [index, run] of runs.entries()) {
    if (index > 0) await sleep(PAUSE_BETWEEN_RUNS_MS);

    const dir = resultsDir(run.scenario, run.endpoint);
    mkdirSync(dir, { recursive: true });
    console.log(`\n=== [${index + 1}/${runs.length}] ${run.scenario} ${run.endpoint} -> ${dir}`);

    const exitCode = runK6(run, dir, liveDashboard);
    const summary = existsSync(join(dir, RESULT_FILES.samples))
      ? await summarizeRun(dir)
      : undefined;
    if (summary) console.log(`\n${summary.text}`);
    const admitted = summary?.admitted ?? '-';
    outcomes.push({ ...run, admitted, thresholds: thresholdsResult(exitCode) });

    if (exitCode === EXIT_INTERRUPTED) {
      console.log('Interrupted, stopping the loop.');
      break;
    }
  }

  printTable(outcomes);
};

await main();

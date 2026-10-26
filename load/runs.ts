export const ENDPOINTS = ['/naive', '/basic', '/robust'] as const;
export type Endpoint = (typeof ENDPOINTS)[number];

export const SCENARIOS = [
  'normal_load',
  'burst_then_load',
  'window_boundary',
  'over_limit',
  'connections',
  'ramp',
  'redis_slow_below',
  'redis_slow_above',
  'redis_down',
] as const;
export type ScenarioName = (typeof SCENARIOS)[number];

export const REDIS_SCENARIOS = ['redis_slow_below', 'redis_slow_above', 'redis_down'] as const;

export const isRedisScenario = (scenario: ScenarioName): boolean =>
  REDIS_SCENARIOS.some((redisScenario) => redisScenario === scenario);

export const parseChoice = <T extends string>(
  name: string,
  value: string | undefined,
  choices: readonly T[],
): T => {
  const match = choices.find((choice) => choice === value);
  if (match === undefined) {
    throw new Error(`${name} must be one of ${choices.join(', ')}, got "${value ?? ''}"`);
  }
  return match;
};

export const RESULT_FILES = {
  samples: 'samples.csv.gz',
  report: 'report.html',
  summary: 'summary.txt',
  timeline: 'timeline.txt',
} as const;

export const resultsDir = (scenario: ScenarioName, endpoint: Endpoint): string =>
  `results/${scenario}-${endpoint.slice(1)}`;

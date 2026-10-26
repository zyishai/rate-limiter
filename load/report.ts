import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ENDPOINTS,
  type Endpoint,
  RESULT_FILES,
  resultsDir,
  SCENARIOS,
  type ScenarioName,
} from './runs.ts';

const REPORT_DIR = 'results/report';

interface ScenarioInfo {
  readonly title: string;
  readonly what: string;
  readonly load: string;
  readonly port: string;
  readonly instances: number;
  readonly limit: { readonly perSecond: number; readonly label: string };
  readonly expected: Partial<Record<Endpoint, string>>;
  readonly clients?: readonly { readonly scenario: string; readonly label: string }[];
}

const HTTP_PORT = '8080 (HAProxy http mode, balanced per request)';
const ONE_KEY_LIMIT = { perSecond: 100, label: 'limit 100 req/s' };

const SCENARIO_INFO: Record<ScenarioName, ScenarioInfo> = {
  normal_load: {
    title: 'Normal load',
    what: 'Steady traffic at the limit. Under normal load all three endpoints look fine.',
    load: '100 req/s for 30 s, one API key',
    port: HTTP_PORT,
    instances: 3,
    limit: ONE_KEY_LIMIT,
    expected: { '/naive': 'All allowed', '/basic': 'All allowed', '/robust': 'All allowed' },
  },
  burst_then_load: {
    title: 'Burst, then load',
    what: 'A burst lands on a fresh key, then steady traffic follows on the same key, so the load starts on an emptied bucket.',
    load: '100 requests fired together at about 2 s, then 100 req/s from 3 s for 30 s',
    port: HTTP_PORT,
    instances: 3,
    limit: ONE_KEY_LIMIT,
    expected: {
      '/naive': 'All 100 of the burst',
      '/basic': 'All 100 of the burst',
      '/robust': 'About 20 of the burst, then 100 req/s',
    },
  },
  window_boundary: {
    title: 'Window boundary',
    what: 'Two bursts straddle a second boundary of the fixed window, so both count in a fresh window.',
    load: '100 requests fired 100 ms before a second boundary, 100 more 50 ms after it',
    port: HTTP_PORT,
    instances: 1,
    limit: ONE_KEY_LIMIT,
    expected: {
      '/naive': 'All 200',
      '/basic': 'All 200 within 150 ms',
      '/robust': 'At most 40 (the burst of 20 plus 150 ms of refill)',
    },
  },
  over_limit: {
    title: 'Over the limit',
    what: 'Five times the limit on one key. An in-memory limiter enforces its limit once per instance.',
    load: '500 req/s for 30 s, one API key',
    port: HTTP_PORT,
    instances: 3,
    limit: ONE_KEY_LIMIT,
    expected: {
      '/naive': '500 req/s',
      '/basic': 'About 300 req/s (100 on each instance)',
      '/robust': 'About 100 req/s',
    },
  },
  connections: {
    title: 'One connection vs many',
    what: 'Two clients with their own keys run in parallel through the per connection frontend. One keeps a single connection busy, the other spreads its requests over 50 connections. The charts show each client separately.',
    load: 'one_connection: 1 connection sending as fast as it can. many_connections: 500 req/s over 50 connections. 30 s',
    port: '8081 (HAProxy tcp mode, balanced per connection)',
    instances: 3,
    limit: ONE_KEY_LIMIT,
    clients: [
      { scenario: 'one_connection', label: 'one connection' },
      { scenario: 'many_connections', label: '50 connections' },
    ],
    expected: {
      '/naive': 'Everything, for both clients',
      '/basic': 'About 100 req/s for one connection, about 300 req/s for 50',
      '/robust': 'About 100 req/s for each client',
    },
  },
  ramp: {
    title: 'Ramp',
    what: 'Traffic grows steadily, so each endpoint shows where it stops admitting more.',
    load: 'From 0 to 400 req/s over 60 s, one API key',
    port: HTTP_PORT,
    instances: 3,
    limit: ONE_KEY_LIMIT,
    expected: {
      '/naive': 'Never flattens',
      '/basic': 'Flattens at about 300 req/s',
      '/robust': 'Flattens at about 100 req/s',
    },
  },
  redis_slow_below: {
    title: 'Slow Redis, below the timeout',
    what: 'Redis replies are delayed, but by less than the 20 ms timeout, so Redis keeps deciding.',
    load: '300 req/s for 30 s, Redis replies delayed by 5 ms',
    port: HTTP_PORT,
    instances: 3,
    limit: ONE_KEY_LIMIT,
    expected: { '/robust': 'About 100 req/s, almost all global (at most 30 fallback)' },
  },
  redis_slow_above: {
    title: 'Slow Redis, above the timeout',
    what: 'Redis replies are delayed past the 20 ms timeout, so the local fallback decides and requests stay fast.',
    load: '300 req/s for 30 s, Redis replies delayed by 50 ms',
    port: HTTP_PORT,
    instances: 3,
    limit: ONE_KEY_LIMIT,
    expected: { '/robust': 'About 102 req/s (3 x 34), all fallback' },
  },
  redis_down: {
    title: 'Redis outage',
    what: 'Redis is cut off and comes back, so the outage and the recovery show on one timeline.',
    load: '300 req/s for 60 s, Redis cut off from 20 s to 40 s',
    port: HTTP_PORT,
    instances: 3,
    limit: ONE_KEY_LIMIT,
    expected: {
      '/robust': 'Global, then fallback from 20 s, then global again within a second of 40 s',
    },
  },
};

const ENDPOINT_COLORS: Record<Endpoint, string> = {
  '/naive': 'var(--series-1)',
  '/basic': 'var(--series-2)',
  '/robust': 'var(--series-3)',
};

// One color per deciding layer, so a layer looks the same in the allowed and rejected charts.
const LAYER_COLORS = {
  global: 'var(--series-1)',
  fallback: 'var(--series-2)',
  local: 'var(--series-3)',
} as const;

interface StackSeries {
  readonly column: string;
  readonly label: string;
  readonly color: string;
}

const ALLOWED_SERIES: readonly StackSeries[] = [
  { column: 'allowed_global', label: 'allowed, global', color: LAYER_COLORS.global },
  { column: 'allowed_fallback', label: 'allowed, fallback', color: LAYER_COLORS.fallback },
];

const REJECTED_SERIES: readonly StackSeries[] = [
  { column: 'limited_local', label: 'rejected (429), local', color: LAYER_COLORS.local },
  { column: 'limited_global', label: 'rejected (429), global', color: LAYER_COLORS.global },
  { column: 'limited_fallback', label: 'rejected (429), fallback', color: LAYER_COLORS.fallback },
];

const OFF_SCALE_RATIO = 3;

interface Timeline {
  readonly columns: readonly string[];
  readonly seconds: readonly Record<string, number>[];
  readonly admitted: string;
}

interface ThresholdResult {
  readonly metric: string;
  readonly expression: string;
  readonly passed: boolean;
  readonly observed: number | null;
}

interface EndpointRun {
  readonly endpoint: Endpoint;
  readonly timeline: Timeline | undefined;
  readonly thresholds: readonly ThresholdResult[] | undefined;
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const readIfExists = (path: string): string | undefined =>
  existsSync(path) ? readFileSync(path, 'utf8') : undefined;

const parseAdmitted = (totals: readonly string[]): string => {
  const start = totals.findIndex((line) => line.startsWith('admitted req/s:'));
  if (start === -1) return '-';

  const perScenario: string[] = [];
  for (const line of totals.slice(start + 1)) {
    if (!line.startsWith('  ')) break;
    perScenario.push(line.trim().replace(':', ''));
  }
  return perScenario.length > 1
    ? perScenario.join(', ')
    : (totals[start]?.split(':')[1]?.trim() ?? '-');
};

const parseTimeline = (text: string): Timeline => {
  const [table = '', totalsText = ''] = text.split('\n\n');
  const [header = '', ...rows] = table.split('\n');
  const columns = header.trim().split(/\s+/);
  const seconds = rows.map((row) => {
    const cells = row.trim().split(/\s+/).map(Number);
    return Object.fromEntries(columns.map((column, index) => [column, cells[index] ?? 0]));
  });
  return { columns, seconds, admitted: parseAdmitted(totalsText.split('\n')) };
};

// The last second of a run holds only the few requests that finished after the load stopped.
const chartSeconds = (timeline: Timeline): readonly Record<string, number>[] => {
  const { seconds } = timeline;
  const last = seconds.at(-1)?.['offered'] ?? 0;
  const previous = seconds.at(-2)?.['offered'] ?? 0;
  return last < previous / 2 ? seconds.slice(0, -1) : seconds;
};

const readRun = (scenario: ScenarioName, endpoint: Endpoint): EndpointRun => {
  const dir = resultsDir(scenario, endpoint);
  const timeline = readIfExists(join(dir, RESULT_FILES.timeline));
  const thresholds = readIfExists(join(dir, RESULT_FILES.thresholds));
  return {
    endpoint,
    timeline: timeline === undefined ? undefined : parseTimeline(timeline),
    thresholds: thresholds === undefined ? undefined : JSON.parse(thresholds),
  };
};

const thresholdsVerdict = (run: EndpointRun): string => {
  if (run.thresholds === undefined) return '-';
  return run.thresholds.every((threshold) => threshold.passed) ? 'passed' : 'failed';
};

const niceStep = (max: number): number => {
  const rough = max / 5;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].find((factor) => factor * magnitude >= rough) ?? 10;
  return step * magnitude;
};

const CHART = { width: 760, height: 280, top: 16, right: 120, bottom: 36, left: 52 } as const;
const PLOT_WIDTH = CHART.width - CHART.left - CHART.right;
const PLOT_HEIGHT = CHART.height - CHART.top - CHART.bottom;

interface Scales {
  readonly x: (second: number) => number;
  readonly y: (value: number) => number;
  readonly secondWidth: number;
}

const axes = (
  seconds: number,
  maxValue: number,
  yLabel: string,
): { svg: string; scales: Scales } => {
  const step = niceStep(Math.max(maxValue, 1));
  const yMax = Math.ceil(maxValue / step) * step || step;
  const secondWidth = PLOT_WIDTH / Math.max(seconds, 1);
  const scales: Scales = {
    x: (second) => CHART.left + second * secondWidth,
    y: (value) => CHART.top + PLOT_HEIGHT - (value / yMax) * PLOT_HEIGHT,
    secondWidth,
  };

  const yTicks = Array.from({ length: Math.round(yMax / step) + 1 }, (_, i) => i * step);
  const xStep = niceStep(Math.max(seconds, 1));
  const xTicks = Array.from({ length: Math.floor(seconds / xStep) + 1 }, (_, i) => i * xStep);

  const svg = [
    ...yTicks.map(
      (tick) =>
        `<line class="grid" x1="${CHART.left}" x2="${CHART.left + PLOT_WIDTH}" y1="${scales.y(tick)}" y2="${scales.y(tick)}"/>` +
        `<text class="tick" x="${CHART.left - 8}" y="${scales.y(tick) + 4}" text-anchor="end">${tick}</text>`,
    ),
    `<line class="axis" x1="${CHART.left}" x2="${CHART.left + PLOT_WIDTH}" y1="${scales.y(0)}" y2="${scales.y(0)}"/>`,
    ...xTicks.map(
      (tick) =>
        `<text class="tick" x="${scales.x(tick + 0.5)}" y="${CHART.top + PLOT_HEIGHT + 18}" text-anchor="middle">${tick}</text>`,
    ),
    `<text class="tick" x="${CHART.left + PLOT_WIDTH / 2}" y="${CHART.height - 4}" text-anchor="middle">second of the run</text>`,
    `<text class="tick" x="12" y="${CHART.top + PLOT_HEIGHT / 2}" text-anchor="middle" transform="rotate(-90 12 ${CHART.top + PLOT_HEIGHT / 2})">${escapeHtml(yLabel)}</text>`,
  ].join('');
  return { svg, scales };
};

const svgWrap = (label: string, body: string): string =>
  `<svg viewBox="0 0 ${CHART.width} ${CHART.height}" role="img" aria-label="${escapeHtml(label)}">${body}</svg>`;

const legend = (items: readonly { label: string; color: string; dashed?: boolean }[]): string =>
  `<ul class="legend">${items
    .map(
      (item) =>
        `<li><span class="swatch${item.dashed ? ' dashed' : ''}" style="--swatch:${item.color}"></span>${escapeHtml(item.label)}</li>`,
    )
    .join('')}</ul>`;

// Spreads end-of-line labels so they never overlap, keeping them above the x axis.
const spreadLabels = (positions: readonly number[], minGap: number, maxY: number): number[] => {
  const order = positions.map((y, index) => ({ y, index })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < order.length; i++) {
    const previous = order[i - 1];
    const current = order[i];
    if (previous && current) current.y = Math.max(current.y, previous.y + minGap);
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const current = order[i];
    const next = order[i + 1];
    if (current) current.y = Math.min(current.y, next ? next.y - minGap : maxY);
  }
  const spread = [...positions];
  for (const { y, index } of order) spread[index] = y;
  return spread;
};

const peak = (values: readonly number[]): number =>
  values.reduce((max, value) => Math.max(max, value), 0);

const median = (values: readonly number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

const allowedChart = (
  runs: readonly EndpointRun[],
  info: ScenarioInfo,
  column: string,
  ariaLabel: string,
): string => {
  const series = runs.flatMap((run) =>
    run.timeline
      ? [{ endpoint: run.endpoint, values: chartSeconds(run.timeline).map((s) => s[column] ?? 0) }]
      : [],
  );
  const seconds = series.reduce((max, s) => Math.max(max, s.values.length), 1);

  // A line far above the others would flatten them, so it is labeled instead of drawn.
  const [top, ...rest] = [...series].sort((a, b) => peak(b.values) - peak(a.values));
  const restPeak = rest.reduce((max, s) => Math.max(max, peak(s.values)), info.limit.perSecond);
  const offScale =
    top && rest.length > 0 && peak(top.values) > OFF_SCALE_RATIO * restPeak ? top : undefined;
  const yMax = offScale ? 2 * restPeak : Math.max(restPeak, top ? peak(top.values) : 0) * 1.08;
  const drawn = series.filter((s) => s !== offScale);
  const { svg: axesSvg, scales } = axes(seconds, yMax, 'allowed req/s');

  const lines = drawn.map(
    ({ endpoint, values }) =>
      `<polyline class="line" style="stroke:${ENDPOINT_COLORS[endpoint]}" points="${values
        .map((value, second) => `${scales.x(second + 0.5)},${scales.y(value)}`)
        .join(' ')}"/>`,
  );
  const limitY = scales.y(info.limit.perSecond);
  const labelY = spreadLabels(
    [...drawn.map(({ values }) => scales.y(values.at(-1) ?? 0) + 4), limitY + 4],
    13,
    CHART.top + PLOT_HEIGHT + 4,
  );
  const labels = drawn.map(
    ({ endpoint }, index) =>
      `<text class="direct" x="${CHART.left + PLOT_WIDTH + 6}" y="${labelY[index]}">${endpoint}</text>`,
  );
  const limit =
    `<line class="limit" x1="${CHART.left}" x2="${CHART.left + PLOT_WIDTH}" y1="${limitY}" y2="${limitY}"/>` +
    `<text class="tick" x="${CHART.left + PLOT_WIDTH + 6}" y="${labelY[drawn.length]}">${escapeHtml(info.limit.label)}</text>`;
  const offScaleText = offScale
    ? `about ${Math.round(median(offScale.values)).toLocaleString('en-US')} req/s, off scale`
    : '';
  const offScaleLabel = offScale
    ? `<line class="line" style="stroke:${ENDPOINT_COLORS[offScale.endpoint]}" x1="${CHART.left + 8}" x2="${CHART.left + 24}" y1="${CHART.top + 8}" y2="${CHART.top + 8}"/>` +
      `<text class="direct" x="${CHART.left + 30}" y="${CHART.top + 12}">${offScale.endpoint}: ${offScaleText}</text>`
    : '';
  const hover = Array.from({ length: seconds }, (_, second) => {
    const text = series
      .map(({ endpoint, values }) => `${endpoint} ${values[second] ?? 0}`)
      .join(', ');
    return `<rect class="hit" x="${scales.x(second)}" y="${CHART.top}" width="${scales.secondWidth}" height="${PLOT_HEIGHT}"><title>second ${second}: ${text}</title></rect>`;
  });

  return (
    legend([
      ...series.map(({ endpoint }) => ({
        label: endpoint === offScale?.endpoint ? `${endpoint} (${offScaleText})` : endpoint,
        color: ENDPOINT_COLORS[endpoint],
      })),
      { label: info.limit.label, color: 'var(--text-muted)', dashed: true },
    ]) +
    svgWrap(
      ariaLabel,
      axesSvg + limit + lines.join('') + labels.join('') + offScaleLabel + hover.join(''),
    )
  );
};

const stackedChart = (
  timeline: Timeline,
  series: readonly StackSeries[],
  yLabel: string,
  ariaLabel: string,
): string => {
  const rows = chartSeconds(timeline);
  const totals = rows.map((second) => series.reduce((sum, s) => sum + (second[s.column] ?? 0), 0));
  const { svg: axesSvg, scales } = axes(rows.length, Math.max(peak(totals), 1) * 1.05, yLabel);
  const barWidth = Math.max(scales.secondWidth - 2, 1);

  const bars = rows.map((second, index) => {
    let stacked = 0;
    const segments = series.map((s) => {
      const value = second[s.column] ?? 0;
      if (value === 0) return '';
      const y = scales.y(stacked + value);
      const height = scales.y(stacked) - y;
      stacked += value;
      return `<rect class="segment" x="${scales.x(index) + 1}" y="${y}" width="${barWidth}" height="${height}" style="fill:${s.color}"/>`;
    });
    const text = series.map((s) => `${s.label} ${second[s.column] ?? 0}`).join(', ');
    return `<g>${segments.join('')}<rect class="hit" x="${scales.x(index)}" y="${CHART.top}" width="${scales.secondWidth}" height="${PLOT_HEIGHT}"><title>second ${index}: ${text}</title></rect></g>`;
  });

  return (
    legend(series.map((s) => ({ label: s.label, color: s.color }))) +
    svgWrap(ariaLabel, axesSvg + bars.join(''))
  );
};

const formatObserved = (value: number | null): string =>
  value === null ? 'no data' : Number.isInteger(value) ? String(value) : value.toFixed(3);

const thresholdTable = (runs: readonly EndpointRun[]): string => {
  const withThresholds = runs.filter((run) => run.thresholds !== undefined);
  if (withThresholds.length === 0) return '<p>No thresholds recorded.</p>';

  const keys = [
    ...new Set(
      withThresholds.flatMap(
        (run) => run.thresholds?.map((t) => `${t.metric} ${t.expression}`) ?? [],
      ),
    ),
  ];
  const cell = (run: EndpointRun, key: string): string => {
    const result = run.thresholds?.find((t) => `${t.metric} ${t.expression}` === key);
    if (result === undefined) return '<td>-</td>';
    const status = result.passed ? 'passed' : 'failed';
    return `<td class="${status}"><span class="status">${result.passed ? '✓' : '✗'} ${status}</span> ${formatObserved(result.observed)}</td>`;
  };
  return `<table><thead><tr><th>Threshold</th>${withThresholds.map((run) => `<th>${run.endpoint}</th>`).join('')}</tr></thead><tbody>${keys
    .map(
      (key) =>
        `<tr><td><code>${escapeHtml(key)}</code></td>${withThresholds.map((run) => cell(run, key)).join('')}</tr>`,
    )
    .join('')}</tbody></table>`;
};

const columnLabel = (column: string): string =>
  column
    .replace(/^limited$/, 'rejected (429)')
    .replace(/^limited_(.+)$/, 'rejected (429), $1')
    .replace(/^allowed[_@](.+)$/, 'allowed, $1')
    .replace(/^p99_ms$/, 'p99 ms');

const dataTable = (run: EndpointRun): string => {
  if (run.timeline === undefined) return '';
  const { columns, seconds } = run.timeline;
  return `<details><summary>Per second data, ${run.endpoint}</summary><div class="scroll"><table class="numbers"><thead><tr>${columns
    .map((column) => `<th>${escapeHtml(columnLabel(column))}</th>`)
    .join('')}</tr></thead><tbody>${seconds
    .map(
      (second) => `<tr>${columns.map((column) => `<td>${second[column] ?? 0}</td>`).join('')}</tr>`,
    )
    .join('')}</tbody></table></div></details>`;
};

const STYLE = `
:root {
  color-scheme: light;
  --surface: #fcfcfb; --page: #f9f9f7; --text-primary: #0b0b0b; --text-secondary: #52514e;
  --text-muted: #898781; --grid: #e1e0d9; --axis: #c3c2b7; --border: rgba(11,11,11,0.10);
  --good: #006300; --critical: #d03b3b;
  --series-1: #2a78d6; --series-2: #eb6834; --series-3: #1baf7a; --series-4: #eda100; --series-5: #e87ba4;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --surface: #1a1a19; --page: #0d0d0d; --text-primary: #ffffff; --text-secondary: #c3c2b7;
    --text-muted: #898781; --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
    --good: #0ca30c; --critical: #e66767;
    --series-1: #3987e5; --series-2: #d95926; --series-3: #199e70; --series-4: #c98500; --series-5: #d55181;
  }
}
body { margin: 0; padding: 24px 16px 48px; background: var(--page); color: var(--text-primary);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 860px; margin: 0 auto; }
h1 { font-size: 24px; margin: 0 0 8px; } h2 { font-size: 18px; margin: 32px 0 8px; }
p, dd { color: var(--text-secondary); }
a { color: var(--series-1); }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 16px 0; }
dt { color: var(--text-muted); } dd { margin: 0; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin: 12px 0; }
svg { width: 100%; height: auto; display: block; }
svg text { font: 11px system-ui, -apple-system, "Segoe UI", sans-serif; }
.grid { stroke: var(--grid); stroke-width: 1; } .axis { stroke: var(--axis); stroke-width: 1; }
.tick { fill: var(--text-muted); } .direct { fill: var(--text-secondary); font-weight: 600; }
.line { fill: none; stroke-width: 2; stroke-linejoin: round; }
.limit { stroke: var(--text-muted); stroke-width: 1.5; stroke-dasharray: 6 4; }
.segment { stroke: var(--surface); stroke-width: 1; }
.hit { fill: transparent; } .hit:hover { fill: var(--grid); fill-opacity: 0.35; }
.legend { list-style: none; display: flex; flex-wrap: wrap; gap: 4px 16px; padding: 0; margin: 0 0 8px; color: var(--text-secondary); font-size: 13px; }
.legend li { display: flex; align-items: center; gap: 6px; }
.swatch { width: 14px; height: 4px; border-radius: 2px; background: var(--swatch); }
.swatch.dashed { background: repeating-linear-gradient(90deg, var(--swatch) 0 4px, transparent 4px 7px); }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
th { color: var(--text-muted); font-weight: 600; }
.numbers td, .numbers th { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.passed .status { color: var(--good); font-weight: 600; } .failed .status { color: var(--critical); font-weight: 600; }
.scroll { overflow-x: auto; } details { margin: 8px 0; } summary { cursor: pointer; color: var(--text-secondary); }
code { font-size: 12px; }
`;

const page = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;

const allowedSection = (runs: readonly EndpointRun[], info: ScenarioInfo): string =>
  info.clients === undefined
    ? `<h2>Allowed requests per second</h2><div class="card">${allowedChart(runs, info, 'allowed', 'Allowed requests per second by endpoint')}</div>`
    : info.clients
        .map(
          ({ scenario, label }) =>
            `<h2>Allowed requests per second, ${escapeHtml(label)}</h2><div class="card">${allowedChart(runs, info, `allowed@${scenario}`, `Allowed requests per second by endpoint, ${label}`)}</div>`,
        )
        .join('');

const robustSection = (timeline: Timeline): string =>
  `<h2>/robust allowed by deciding layer</h2><div class="card">${stackedChart(timeline, ALLOWED_SERIES, 'allowed req/s', 'Robust endpoint: allowed requests per second by deciding layer')}</div>` +
  `<h2>/robust rejected (429) by deciding layer</h2><div class="card">${stackedChart(timeline, REJECTED_SERIES, 'rejected (429) req/s', 'Robust endpoint: rejected (429) requests per second by deciding layer')}</div>`;

const scenarioPage = (scenario: ScenarioName, runs: readonly EndpointRun[]): string => {
  const info = SCENARIO_INFO[scenario];
  const robust = runs.find((run) => run.endpoint === '/robust')?.timeline;
  const expected = Object.entries(info.expected)
    .map(([endpoint, text]) => `<li><code>${endpoint}</code>: ${escapeHtml(text)}</li>`)
    .join('');

  return page(
    `${info.title}: rate limiter load test`,
    `<p><a href="index.html">All scenarios</a></p>
<h1>${escapeHtml(info.title)} <code>${scenario}</code></h1>
<p>${escapeHtml(info.what)}</p>
<dl><dt>Load</dt><dd>${escapeHtml(info.load)}</dd><dt>Port</dt><dd>${escapeHtml(info.port)}</dd><dt>API instances</dt><dd>${info.instances}</dd></dl>
<h2>Expected</h2><ul>${expected}</ul>
${allowedSection(runs, info)}
${robust ? robustSection(robust) : ''}
<h2>Thresholds</h2><div class="card scroll">${thresholdTable(runs)}</div>
<h2>Data</h2>${runs.map(dataTable).join('')}`,
  );
};

const indexPage = (
  pages: readonly { scenario: ScenarioName; runs: readonly EndpointRun[] }[],
): string => {
  const rows = pages.flatMap(({ scenario, runs }) =>
    runs.map(
      (run) =>
        `<tr><td><a href="${scenario}.html">${scenario}</a></td><td><code>${run.endpoint}</code></td><td>${escapeHtml(run.timeline?.admitted ?? '-')}</td><td class="${thresholdsVerdict(run)}"><span class="status">${thresholdsVerdict(run)}</span></td></tr>`,
    ),
  );
  return page(
    'Rate limiter load tests',
    `<h1>Rate limiter load tests</h1>
<p>Each scenario page charts allowed requests per second for every endpoint against the limit, how <code>/robust</code> decided, and every threshold with its observed value. A failed threshold on <code>/naive</code> or <code>/basic</code> is the expected result.</p>
<div class="card scroll"><table><thead><tr><th>Scenario</th><th>Endpoint</th><th>Admitted req/s</th><th>Thresholds</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`,
  );
};

export const buildReport = (): string => {
  mkdirSync(REPORT_DIR, { recursive: true });
  const pages = SCENARIOS.flatMap((scenario) => {
    const runs = ENDPOINTS.map((endpoint) => readRun(scenario, endpoint)).filter(
      (run) => run.timeline !== undefined || run.thresholds !== undefined,
    );
    return runs.length === 0 ? [] : [{ scenario, runs }];
  });

  for (const { scenario, runs } of pages) {
    writeFileSync(join(REPORT_DIR, `${scenario}.html`), scenarioPage(scenario, runs));
  }
  const indexPath = join(REPORT_DIR, 'index.html');
  writeFileSync(indexPath, indexPage(pages));
  return indexPath;
};

if (import.meta.main) {
  console.log(`Report: ${buildReport()}`);
}

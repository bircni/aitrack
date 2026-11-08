// Regenerate with `node --import tsx crates/core/tests/fixtures/display/generate.ts` while the 4.x library is in the tree.
// Records 4.x's terminal tables, CSV, heatmap figures, model names, and facts about the PNG and PDF it draws.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const lib = join(here, '../../../../../libs/aitrack-lib/src');
const fromLib = createRequire(join(lib, '../package.json'));
const modelIds = JSON.parse(readFileSync(join(here, '../js/model-ids.json'), 'utf8')) as string[][];

const dump = `
const RealDate = Date;
const FIXED = new RealDate('2026-03-10T12:00:00.000Z').getTime();
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length === 0 ? [FIXED] : args)); }
  static now() { return FIXED; }
};
const lib = ${JSON.stringify(lib)};
const { default: chalk } = await import(${JSON.stringify(fromLib.resolve('chalk'))});
const { inflateSync } = await import('node:zlib');
const names = await import(lib + '/display/modelNames.ts');
const stats = await import(lib + '/display/heatmap/stats.ts');
const intensity = await import(lib + '/display/heatmap/intensity.ts');
const { resolveProviderLayout } = await import(lib + '/display/heatmap/layout.ts');
const { providerStats } = await import(lib + '/display/heatmap/providerStats.ts');
const { buildProviderSectionViewModel } = await import(lib + '/display/heatmap/viewModel.ts');
const { renderTui, tuiStats } = await import(lib + '/display/tui.ts');
const { renderUsageReportCsv } = await import(lib + '/display/csv/report.ts');
const { renderToPng } = await import(lib + '/display/renderPng.ts');
const { renderReceiptPdf } = await import(lib + '/display/pdf/receipt.ts');
const { createCanvas, loadImage } = await import(${JSON.stringify(fromLib.resolve('@napi-rs/canvas'))});

let seed = 0x3c6ef372;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 2 ** 32; };
const shift = (date, days) => { const d = new RealDate(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const MODELS = {
  claude_code: ['claude-opus-4-1-20250805', 'claude-sonnet-4-5-20250929', 'claude-haiku-5-5', 'claude-opus-4-1-20250805-thinking-high'],
  codex: ['gpt-5', 'gpt-5.1-codex-max', 'gpt-5-mini'],
  cursor: ['auto', 'composer-2', 'grok-4-7-fast-high', 'claude-4.6-opus-high-thinking'],
  zed: ['mystery-model'],
};
const raw = {};
for (const [provider, models] of Object.entries(MODELS)) {
  const days = [];
  const count = provider === 'claude_code' ? 260 : provider === 'codex' ? 90 : 25;
  let date = provider === 'zed' ? '2025-06-01' : '2025-01-03';
  for (let i = 0; i < count; i++) {
    date = shift(date, provider === 'claude_code' && i > 240 ? 1 : 1 + Math.floor(random() * 3));
    if (date > '2026-03-10') break;
    const byModel = {};
    for (const model of models) {
      if (random() < 0.45) continue;
      const counts = { inputTokens: Math.floor(random() * 10 ** (3 + Math.floor(random() * 5))), outputTokens: Math.floor(random() * 50000) };
      if (provider !== 'zed' && random() < 0.85) counts.costUSD = Math.floor(random() * 1e6) / 1e5;
      byModel[model] = counts;
    }
    if (Object.keys(byModel).length === 0) byModel[models[0]] = { inputTokens: 0, outputTokens: 0 };
    days.push([date, byModel]);
  }
  raw[provider] = days;
}
raw.tie = [['2026-03-01', { 'b-model': { inputTokens: 10, outputTokens: 0 } }], ['2026-03-02', { 'a-model': { inputTokens: 6, outputTokens: 4 } }]];
const providerData = {};
for (const [provider, days] of Object.entries(raw)) {
  const map = new Map();
  for (const [date, byModel] of days) {
    const day = { inputTokens: 0, outputTokens: 0, byModel: {} };
    for (const [model, counts] of Object.entries(byModel)) {
      day.byModel[model] = { ...counts };
      day.inputTokens += counts.inputTokens;
      day.outputTokens += counts.outputTokens;
      if (counts.costUSD !== undefined) day.costUSD = (day.costUSD ?? 0) + counts.costUSD;
    }
    map.set(date, day);
  }
  providerData[provider] = map;
}

const grids = [null, 2026, 2025, 2028, 1999].map((year) => {
  const weeks = stats.buildDateGrid(year ?? undefined);
  return { year, weeks, labels: stats.monthLabels(weeks) };
});
const defaultGrid = new Set(grids[0].weeks.flat());
const perProvider = Object.fromEntries(Object.entries(providerData).map(([key, map]) => [key, {
  stats: providerStats(map),
  models: stats.computeModelStats(map),
  view: buildProviderSectionViewModel(key, map, defaultGrid),
  viewAll: buildProviderSectionViewModel(key, map),
}]));

const options = [{}, { all: true }, { year: 2025 }, { dark: true }, { year: 2030 }, { all: true, year: 2026 }];
const layouts = options.map((o) => resolveProviderLayout(providerData, o).keys);
const tui = [];
for (const level of [0, 1]) {
  chalk.level = level;
  for (const o of options) tui.push({ level, options: o, text: renderTui(providerData, o) });
  tui.push({ level, options: { only: 'codex' }, text: renderTui({ codex: providerData.codex }) });
}
chalk.level = 0;

const row = (model, tokens, cost, cached, unpriced) => ({ model, inputTokens: tokens - Math.min(7, tokens), outputTokens: Math.min(7, tokens), tokens, cachedInputTokens: cached ?? 0, hasCached: cached !== undefined, costUSD: cost ?? 0, hasCost: cost !== undefined, ...(unpriced && { hasUnpricedTokens: true }) });
const reports = [
  {
    windowLabel: 'last 7 days (2026-03-04 → 2026-03-10)',
    providers: [
      { key: 'claude_code', label: 'Claude Code', rows: [row('claude-opus-4-1-20250805-thinking-high-extra-long-name', 1234567, 12.5, 1000), row('=SUM(A1)', 99, 0.004), row('gpt "quoted", name', 5, undefined, undefined, true)], subtotalTokens: 1234671, subtotalCostUSD: 12.504, subtotalHasCost: true, hasUnpricedTokens: true },
      { key: 'codex', label: 'Codex é', rows: [row('-minus', 1000000, 1234.56789), row('@at', 12, 0)], subtotalTokens: 1000012, subtotalCostUSD: 1234.56789, subtotalHasCost: true },
    ],
    totals: { inputTokens: 2234669, outputTokens: 14, tokens: 2234683, cachedInputTokens: 1000, hasCached: true, costUSD: 1247.07189, hasCost: true, hasUnpricedTokens: true, unpricedModels: ['gpt "quoted", name', 'tab\\tname'] },
    rowCount: 5,
  },
  { windowLabel: 'today (3/10/2026 12:00:00 PM)', providers: [], totals: { inputTokens: 0, outputTokens: 0, tokens: 0, cachedInputTokens: 0, hasCached: false, costUSD: 0, hasCost: false }, rowCount: 0 },
  { windowLabel: 'all time ✓ in bircni/a-repository-with-a-much-longer-name-than-fits-on-the-receipt (Europe/Berlin)', providers: [{ key: 'zed', label: 'zed', rows: [row('x', 10), row('a'.repeat(50), 3), row('("quoted" [x]/y) ' + 'b'.repeat(40), 2), row('soft\u00adhyphen-model-with-a-long-name', 1)], subtotalTokens: 10, subtotalCostUSD: 0, subtotalHasCost: false, hasUnpricedTokens: true }], totals: { inputTokens: 3, outputTokens: 7, tokens: 10, cachedInputTokens: 0, hasCached: false, costUSD: 0, hasCost: false, hasUnpricedTokens: true, unpricedModels: ['x'] }, rowCount: 1 },
];
const csv = reports.map((r) => renderUsageReportCsv(r));

const pdf = [];
for (const report of reports) {
  const bytes = (await renderReceiptPdf(report, new RealDate('2026-03-10T12:34:56Z'))).toString('latin1');
  const height = Number(/MediaBox \\[0 0 360 (\\d+)\\]/.exec(bytes)[1]);
  const fragments = [];
  for (const m of bytes.matchAll(/stream\\r?\\n([\\s\\S]*?)endstream/g)) {
    let content;
    try { content = inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch { continue; }
    for (const t of content.matchAll(/1 0 0 1 ([\\d.-]+) ([\\d.-]+) Tm\\n\\/F(\\d) ([\\d.]+) Tf\\n\\[<([0-9a-f]*)> 0\\] TJ/g)) {
      fragments.push([Number(t[1]), Number(t[2]), t[3] === '2' ? 'bold' : 'regular', Number(t[4]), t[5]]);
    }
    for (const l of content.matchAll(/([\\d.]+) ([\\d.]+) m\\n([\\d.]+) ([\\d.]+) l/g)) fragments.push(['line', Number(l[2])]);
  }
  const titleRef = /\\/Title (\\d+) 0 R/.exec(bytes)[1];
  const title = bytes.split('\\n' + titleRef + ' 0 obj\\n')[1].split('\\nendobj')[0];
  pdf.push({ height, fragments, title });
}

const CELL = 12, STEP = 15, LEFT = 52, SECTION_H = 32 + 52 + 1 + 28 + 7 * STEP + 32 + 78 + 28;
const png = [];
for (const o of [{}, { dark: true, all: true }, { year: 2028 }, { year: 2025 }]) {
  const image = await loadImage(renderToPng(providerData, o));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const pixel = (x, y) => [...context.getImageData(x, y, 1, 1).data];
  const keys = resolveProviderLayout(providerData, o).keys;
  const weeks = stats.buildDateGrid(o.year).length;
  const samples = [[2, 2, pixel(2, 2)]];
  for (let s = 0; s < keys.length; s++) {
    const gridY = 24 + s * SECTION_H + 32 + 52 + 1 + 28;
    for (let i = 0; i < 40; i++) {
      const w = Math.floor(random() * weeks), d = Math.floor(random() * 7);
      const x = LEFT + w * STEP + CELL / 2, y = gridY + d * STEP + CELL / 2;
      samples.push([x, y, pixel(x, y)]);
    }
    const legendY = gridY + 7 * STEP;
    for (let level = 0; level <= 4; level++) {
      const x = LEFT + 38 + level * (CELL + 3) + CELL / 2, y = legendY + CELL / 2;
      samples.push([x, y, pixel(x, y)]);
    }
  }
  png.push({ options: o, width: image.width, height: image.height, samples });
}

console.log(JSON.stringify({
  data: raw,
  names: [...new Set([...${JSON.stringify(modelIds.map((r) => r[0]))}, 'cursor-grok-4-7', 'claude-3-7-sonnet-20250219', 'sonnet', 'claude-sonnet-4', 'gpt-5.1', 'grok-4', 'composer', 'composer-2-fast', 'auto', 'whatever-x'])].map((id) => [id, names.displayModelName(id), names.displayModelName(id, { effort: true })]),
  percentiles: [[], [5], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [10, 1, 100, 7, 7], [3, 3, 3]].map((v) => [v, intensity.percentile(v, 0.9)]),
  levels: [[0, 10], [5, 0], [1, 100], [10, 100], [34, 100], [35, 100], [64, 100], [65, 100], [500, 100]].map(([t, m]) => [t, m, intensity.tokenIntensityLevel(t, m)]),
  peakDates: ['2026-03-01', '2025-12-31', '0999-01-09'].map((d) => [d, stats.formatPeakDate(d), stats.formatMonthLabel(d.slice(0, 7))]),
  grids,
  perProvider,
  layouts,
  tuiStats: options.map((o) => tuiStats(providerData, o)),
  tui,
  reports,
  csv,
  pdf,
  png,
}));
`;
const home = mkdtempSync(join(tmpdir(), 'aitrack-display-golden-'));
const script = join(home, 'dump.mts');
writeFileSync(script, dump);
const output = execFileSync(process.execPath, ['--import', 'tsx', script], {
  cwd: join(here, '../../../../..'),
  maxBuffer: 64 * 1024 * 1024,
  env: {
    PATH: process.env.PATH,
    TZ: 'UTC',
    HOME: home,
    USERPROFILE: home,
    AITRACK_NO_PRICING_REFRESH: '1',
  },
}).toString();
writeFileSync(join(here, 'expected.json'), `${output.trim()}\n`);
rmSync(home, { recursive: true, force: true });

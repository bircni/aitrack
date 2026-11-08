// Regenerate with `node --import tsx crates/core/tests/fixtures/pricing/generate.ts` while the 4.x library is in the tree.
// Records 4.x's exact costs, as float bits, with the bundled tables and with a newer synthetic pack.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const lib = join(here, '../../../../../libs/aitrack-lib/src');

const { supplementFromTables } = await import(join(lib, 'pricing/supplementFromTables.ts'));
const supplement = supplementFromTables();
supplement.updatedAt = '2099-01-01T00:00:00.000Z';
supplement.claude.models['claude-opus-9-9'] = { inputPerMillion: 7, outputPerMillion: 35, cacheReadPerMillion: 0.7, cacheCreatePerMillion: 8.75 };
supplement.claude.overrides['claude-opus-4-1'] = [
  { before: '2026-03-08', pricing: { inputPerMillion: 30, outputPerMillion: 150, cacheReadPerMillion: 3, cacheCreatePerMillion: 37.5 } },
];
delete supplement.claude.models['claude-sonnet-4-5'];
supplement.codex.overrides['gpt-5'] = [{ before: '2026-01-01', pricing: { inputPerMillion: 2.5, outputPerMillion: 20 } }];
supplement.codex.familyFallback = [{ match: '-pro$', inputPerMillion: 15, outputPerMillion: 120 }, ...supplement.codex.familyFallback.slice(2)];
supplement.cursor.aliases = [{ pattern: '(?i)^Weird Model$', canonical: 'auto' }, ...supplement.cursor.aliases.slice(5)];
const compact = (models: Record<string, unknown>) => ({ retrievedAt: '2099-01-01T00:00:00.000Z', models });
const litellm = compact({
  'anthropic/claude-catalog-1': { i: 3, o: 15, cw: 3.75, cr: 0.3 },
  'claude-catalog-2': { i: 1, o: 5, cw: 1, cr: 0.1, cre: false, cwe: false },
  'bedrock/claude-catalog-2': { i: 9, o: 9, cw: 9, cr: 9 },
  'claude-catalog-6': { i: 2, o: 6, cw: 2, cr: 0.2 },
  'vercel_ai_gateway/anthropic/claude-catalog-4': { i: 4, o: 20, cw: 5, cr: 0.4 },
  'openai/gpt-catalog': { i: 2, o: 8, cw: 2, cr: 0.2 },
  'gpt-catalog-bare': { i: 1.1, o: 4.4, cw: 1.1, cr: 0.11 },
  'claude-catalog-7': { i: 7, o: 7, cw: 7, cr: 0.7 },
  'anthropic/claude-catalog-7': { i: 0.7, o: 0.7, cw: 0.7, cr: 0.07 },
  'vercel_ai_gateway/anthropic/claude-catalog-7': { i: 70, o: 70, cw: 70, cr: 7 },
});
const modelsDev = compact({ 'anthropic/claude-catalog-5': { i: 0.8, o: 4, cw: 1, cr: 0.08 }, 'openai/gpt-catalog-dev': { i: 0.5, o: 2, cw: 0.5, cr: 0.05 } });
const bodies = { supplement: JSON.stringify(supplement), litellm: JSON.stringify(litellm), modelsDev: JSON.stringify(modelsDev) };
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const manifest = JSON.stringify({
  schemaVersion: 1,
  updatedAt: '2099-01-01T00:00:00.000Z',
  files: { supplement: 'supplement.json', litellm: 'litellm.json', modelsDev: 'models_dev.json' },
  hashes: { supplement: sha(bodies.supplement), litellm: sha(bodies.litellm), modelsDev: sha(bodies.modelsDev) },
});
const pack = { 'supplement.json': bodies.supplement, 'litellm.json': bodies.litellm, 'models_dev.json': bodies.modelsDev, 'manifest.json': manifest };
writeFileSync(join(here, 'synthetic-pack.json'), `${JSON.stringify(pack)}\n`);

const dump = `
const lib = ${JSON.stringify(lib)};
const tables = (await import(lib + '/pricing/supplementFromTables.ts')).supplementFromTables();
const { estimateClaudeCostFromStoredCounts, estimateClaudeCostFromAggregateTokens } = await import(lib + '/pricing/claude.ts');
const { estimateCodexCostUSD } = await import(lib + '/pricing/codex.ts');
const { estimateCursorCostUSD } = await import(lib + '/pricing/cursor.ts');
const { createFallbackCollector } = await import(lib + '/pricing/fallback.ts');
const { currentModelPricing } = await import(lib + '/pricing/store.ts');
const bits = (x) => x === undefined ? null : Buffer.from(new Float64Array([x]).buffer).readBigUInt64LE().toString(16).padStart(16, '0');
const models = new Set([
  ...Object.keys(tables.claude.models), ...Object.keys(tables.codex.current), ...Object.keys(tables.codex.historical), ...Object.keys(tables.cursor.models),
  ...Object.keys(tables.cursor.fastMultipliers), ...tables.cursor.aliases.map((a) => a.canonical),
  'claude-opus-9-9', 'claude-catalog-7', 'claude-catalog-1', 'claude-catalog-2', 'claude-catalog-4', 'claude-catalog-5', 'claude-catalog-6', 'gpt-catalog', 'gpt-catalog-bare', 'gpt-catalog-dev',
  'Weird Model', 'weird model', 'Composer 2.5 (Auto, low)', 'Claude Opus 4.6 (Thinking)', 'GPT-5.5 (Auto)', 'claude-4.6-opus-high-thinking', 'grok-4-7-fast-low',
  'claude-opus-4-1-fast', 'claude-haiku-5-5-long-context', 'claude-3-7-sonnet-20250219', 'claude-unknown-family', 'claude-mythos-x', 'gpt-5-pro', 'gpt-7-nano', 'gpt-9',
  'o3-mini', 'something-else', 'constructor', '__proto__', '', 'gpt-5.1-codex-max-xhigh', 'gpt-5.1-codex-max-fast', 'auto-fast', '-fast',
]);
const counts = [
  { inputTokens: 1234567, outputTokens: 89012, rawInputTokens: 4567, cachedInputTokens: 1200000, cacheCreationInputTokens: 30000 },
  { inputTokens: 1000, outputTokens: 10, rawInputTokens: 100, cachedInputTokens: 800, cacheCreationInputTokens: 50, cacheCreation1hInputTokens: 50 },
  { inputTokens: 777, outputTokens: 333 },
  { inputTokens: 5000, outputTokens: 7, cachedInputTokens: 9000, cacheCreationInputTokens: 3 },
  { inputTokens: 0, outputTokens: 0, rawInputTokens: 0 },
];
const dates = ['2026-03-07', '2026-03-08', undefined, '2025-12-31', '2026-08-20'];
const rows = [];
for (const model of models) {
  for (let i = 0; i < counts.length; i++) {
    const c = counts[i]; const date = dates[i]; const fb = createFallbackCollector();
    rows.push([model, i, date ?? null,
      bits(estimateClaudeCostFromStoredCounts(model, c, date, fb)),
      bits(estimateClaudeCostFromAggregateTokens(model, c.inputTokens, c.outputTokens, date, fb)),
      bits(estimateCodexCostUSD(model, c.inputTokens, c.outputTokens, c.cachedInputTokens ?? 0, date, fb)),
      bits(estimateCursorCostUSD(model, c, date)),
      fb.drain()]);
  }
}
// Many count sets for a few priced models: term order only shows in the last bit for some inputs.
let seed = 0x9e3779b9;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 2 ** 32; };
const arithmetic = [];
for (let i = 0; i < 1000; i++) {
  const tokens = () => Math.floor(random() * 10 ** (1 + Math.floor(random() * 9)));
  const c = { inputTokens: tokens(), outputTokens: tokens() };
  if (random() < 0.8) c.rawInputTokens = tokens();
  if (random() < 0.8) c.cachedInputTokens = tokens();
  if (random() < 0.6) c.cacheCreationInputTokens = tokens();
  if (random() < 0.3) c.cacheCreation1hInputTokens = tokens();
  const model = ['claude-opus-4-1', 'claude-haiku-5-5', 'claude-fable-5-1', 'gpt-5', 'gpt-5.1-codex-mini', 'composer-2', 'auto'][i % 7];
  arithmetic.push([model, c, bits(estimateClaudeCostFromStoredCounts(model, c, '2026-03-08')), bits(estimateCodexCostUSD(model, c.inputTokens, c.outputTokens, c.cachedInputTokens ?? 0, '2026-03-08')), bits(estimateCursorCostUSD(model, c, '2026-03-08'))]);
}
console.log(JSON.stringify({ updatedAt: currentModelPricing().updatedAt, counts, rows, arithmetic }));
`;
const home = mkdtempSync(join(tmpdir(), 'aitrack-pricing-golden-'));
const script = join(home, 'dump.mts');
writeFileSync(script, dump);
for (const [name, withPack] of [['bundled', false], ['pack', true]] as const) {
  const scenarioHome = join(home, name);
  if (withPack) {
    mkdirSync(join(scenarioHome, '.config/aitrack/pricing'), { recursive: true });
    writeFileSync(join(scenarioHome, '.config/aitrack/pricing/pack.json'), JSON.stringify(pack));
  }
  const output = execFileSync(process.execPath, ['--import', 'tsx', script], {
    maxBuffer: 64 * 1024 * 1024,
    env: { PATH: process.env.PATH, TZ: 'UTC', HOME: scenarioHome, USERPROFILE: scenarioHome, AITRACK_NO_PRICING_REFRESH: '1' },
  }).toString();
  writeFileSync(join(here, `costs-${name}.json`), output);
}
rmSync(home, { recursive: true, force: true });

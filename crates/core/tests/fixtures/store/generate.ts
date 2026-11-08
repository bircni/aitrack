// Regenerate with `node --import tsx crates/core/tests/fixtures/store/generate.ts` while the 4.x library is in the tree.
// Records 4.x's machine-file validation, writer, merges, compaction and repricing as exact JSON.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const lib = join(here, '../../../../../libs/aitrack-lib/src');
const corpus = join(here, '../readers/corpus');

const dump = `
const lib = ${JSON.stringify(lib)};
const { checkRawMachineFile } = await import(lib + '/data/validate.ts');
const { encryptText } = await import(lib + '/store/encryption.ts');
const local = await import(lib + '/data/localData.ts');
const { compactDays } = await import(lib + '/data/compact.ts');
const { repriceMachineDays } = await import(lib + '/pricing/reprice.ts');
const { readClaudeData } = await import(lib + '/readers/claude.ts');
const { readCodexData } = await import(lib + '/readers/codex.ts');

let seed = 0x51ed2701;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 2 ** 32; };
const pick = (items) => items[Math.floor(random() * items.length)];
const pretty = (value) => JSON.stringify(value, null, 2);

// Validation: raw files 4.x reads, skips, or trims.
const counts = (i, o, extra = {}) => ({ inputTokens: i, outputTokens: o, ...extra });
const day = (models, extra = {}) => {
  const totals = { inputTokens: 0, outputTokens: 0 };
  let cost = 0, priced = true;
  for (const c of Object.values(models)) { totals.inputTokens += c.inputTokens; totals.outputTokens += c.outputTokens; if (c.costUSD === undefined) priced = false; else cost += c.costUSD; }
  if (priced && Object.keys(models).length) totals.costUSD = cost;
  return { byModel: models, totals, ...extra };
};
const file = (days, extra = {}) => ({ schemaVersion: 2, hostname: 'mb', timezone: 'Europe/Berlin', dayBucket: 'local', lastUpdated: '2026-03-08T10:00:00.000Z', days, ...extra });
const good = file({ '2026-03-07': { codex: day({ 'gpt-5': counts(10, 2, { cachedInputTokens: 4, costUSD: 0.0000045 }) }, { byProject: { 'o/r': counts(10, 2) } }) } });
const raws = [
  ['good', JSON.stringify(good)],
  ['pretty', pretty(good)],
  ['v1', JSON.stringify({ hostname: 'old', lastUpdated: 'x', days: { '2026-01-01': { claude_code: day({ m: counts(1, 1) }) } } })],
  ['v1-with-zone', JSON.stringify({ hostname: 'old', timezone: 'Asia/Tokyo', lastUpdated: 'x', days: {} })],
  ['future', JSON.stringify({ ...good, schemaVersion: 3 })],
  ['schema-string', JSON.stringify({ ...good, schemaVersion: '2' })],
  ['utc-bucket', JSON.stringify({ ...good, dayBucket: 'utc' })],
  ['bad-bucket', JSON.stringify({ ...good, dayBucket: 'weird', timezone: '' })],
  ['no-hostname', JSON.stringify({ ...good, hostname: '' })],
  ['no-days', JSON.stringify({ ...good, days: [] })],
  ['array', '[]'],
  ['bad-day-key', JSON.stringify(file({ '2026-02-30': {}, 'nope': {}, '2026-03-01': {} }))],
  ['day-not-object', JSON.stringify(file({ '2026-03-01': 5 }))],
  ['reserved-provider', JSON.stringify(file({ '2026-03-01': { constructor: day({}) } }))],
  ['reserved-model', '{"schemaVersion":2,"hostname":"h","lastUpdated":"x","days":{"2026-03-01":{"codex":{"byModel":{"__proto__":{"inputTokens":1,"outputTokens":1}},"totals":{"inputTokens":1,"outputTokens":1}}}}}'],
  ['by-cwd-stripped', JSON.stringify(file({ '2026-03-01': { codex: day({ m: counts(1, 1) }, { byCwd: { '/x': counts(1, 1) } }) } }))],
  ['bad-projects', JSON.stringify(file({ '2026-03-01': { codex: day({ m: counts(1, 1) }, { byProject: { a: { inputTokens: 'x' } } }) }, '2026-03-02': { codex: day({ m: counts(1, 1) }, { byProject: [] }) } }))],
  ['totals-mismatch', JSON.stringify(file({ '2026-03-01': { codex: { byModel: { m: counts(1, 1) }, totals: counts(2, 1) } } }))],
  ['cached-mismatch', JSON.stringify(file({ '2026-03-01': { codex: { byModel: { m: counts(1, 1, { cachedInputTokens: 1 }) }, totals: counts(1, 1, { cachedInputTokens: 2 }) } } }))],
  ['cost-mismatch', JSON.stringify(file({ '2026-03-01': { codex: { byModel: { m: counts(1, 1, { costUSD: 1 }) }, totals: counts(1, 1, { costUSD: 2 }) } } }))],
  ['cost-close-enough', JSON.stringify(file({ '2026-03-01': { codex: { byModel: { m: counts(1, 1, { costUSD: 0.1 }), n: counts(1, 1, { costUSD: 0.2 }) }, totals: counts(2, 2, { costUSD: 0.30000000000000004 }) } } }))],
  ['unpriced-flag-string', JSON.stringify(file({ '2026-03-01': { codex: { byModel: { m: counts(1, 1, { hasUnpricedTokens: 'yes' }) }, totals: counts(1, 1) } } }))],
  ['tokens-string', JSON.stringify(file({ '2026-03-01': { codex: { byModel: { m: { inputTokens: '1', outputTokens: 1 } }, totals: counts(1, 1) } } }))],
  ['totals-missing', JSON.stringify(file({ '2026-03-01': { codex: { byModel: {} } } }))],
  ['encrypted', encryptText(pretty(good), 'test pass')],
  ['encrypted-bad-format', JSON.stringify({ schemaVersion: 99, encrypted: 'aitrack-v9', salt: 'x', iv: 'x', tag: 'x', data: 'x' })],
];
const validation = [];
for (const [name, raw] of raws) {
  for (const allow of [false, true]) {
    const checked = checkRawMachineFile(raw, 'data/' + name + '.json', { allowInconsistentCostTotals: allow });
    validation.push({ name, allow, raw, machine: checked.machine && pretty(checked.machine), diagnostics: checked.diagnostics, failure: checked.failure ?? null, encrypted: checked.encrypted === true });
  }
}

// The writer, over the reader corpus priced with the bundled tables.
const maps = { claude_code: await readClaudeData(), codex: await readCodexData() };
const fixed = (machine) => pretty({ ...machine, lastUpdated: '2026-03-08T10:00:00.000Z' });
const built = { plain: fixed(local.buildMachineData('mb', maps)), withDirs: fixed(local.buildMachineData('mb', maps, { includeLocalDirs: true })) };

// Merges, rebucketing, compaction and repricing over random machine files.
const models = { claude_code: ['claude-opus-4-1', 'claude-haiku-5-5', 'claude-unknown', '(compacted)'], codex: ['gpt-5', 'gpt-5-mini', 'mystery'], other: ['x'] };
const randomCounts = () => {
  const c = counts(Math.floor(random() * 5000), Math.floor(random() * 500));
  if (random() < 0.7) c.rawInputTokens = Math.floor(c.inputTokens / 2);
  if (random() < 0.7) c.cachedInputTokens = c.inputTokens - (c.rawInputTokens ?? 0);
  if (random() < 0.5) c.costUSD = Math.floor(random() * 1e6) / 1e7;
  if (random() < 0.1) c.hasUnpricedTokens = random() < 0.8;
  return c;
};
const randomDays = (n) => {
  const days = {};
  for (let i = 0; i < n; i++) {
    const date = '2026-03-' + String(1 + Math.floor(random() * 20)).padStart(2, '0');
    days[date] ??= {};
    for (const provider of ['codex', 'claude_code', 'other', 'aaa']) {
      if (random() < 0.5) continue;
      const byModel = {};
      const modelCount = random() < 0.15 ? 1 : 1 + Math.floor(random() * 3);
      for (let m = 0; m < modelCount; m++) byModel[pick(models[provider] ?? ['z'])] = randomCounts();
      if (random() < 0.15) { for (const k of Object.keys(byModel)) delete byModel[k]; byModel['(compacted)'] = randomCounts(); }
      const totals = counts(0, 0);
      let cost = 0, priced = true, unpriced = false;
      for (const c of Object.values(byModel)) {
        totals.inputTokens += c.inputTokens; totals.outputTokens += c.outputTokens;
        for (const f of ['rawInputTokens', 'cachedInputTokens']) if (c[f] !== undefined) totals[f] = (totals[f] ?? 0) + c[f];
        if (c.costUSD === undefined) priced = false; else cost += c.costUSD;
        if (c.hasUnpricedTokens) unpriced = true;
      }
      if (priced) totals.costUSD = cost;
      if (unpriced) totals.hasUnpricedTokens = true;
      // In the key order 4.x's writer uses, as every real file has it.
      const canonical = Object.fromEntries(['inputTokens', 'outputTokens', 'rawInputTokens', 'cachedInputTokens', 'costUSD', 'hasUnpricedTokens'].filter((f) => totals[f] !== undefined).map((f) => [f, totals[f]]));
      const entry = { byModel, totals: canonical };
      if (random() < 0.4) entry.byProject = { 'b/b': counts(totals.inputTokens, totals.outputTokens, totals.costUSD === undefined ? {} : { costUSD: totals.costUSD }) };
      days[date][provider] = entry;
    }
  }
  return days;
};
const merges = [];
for (let i = 0; i < 50; i++) {
  const persisted = random() < 0.1 ? null : file(randomDays(5), { timezone: pick(['Europe/Berlin', 'Asia/Tokyo', 'unknown']) });
  const fresh = file(randomDays(4), { timezone: pick(['Europe/Berlin', 'Asia/Tokyo']) });
  const compactAfter = random() < 0.5 ? undefined : Math.floor(random() * 15);
  const repriced = structuredClone(persisted?.days ?? fresh.days);
  const repriceResult = repriceMachineDays(repriced);
  const compact = (value) => value;
  merges.push({
    persisted: persisted && compact(persisted),
    fresh: compact(fresh),
    compactAfter: compactAfter ?? null,
    merged: compact(local.mergePersistedDays(persisted?.days ?? null, fresh.days)),
    ratcheted: local.ratchetedProviderDays(persisted?.days ?? null, fresh.days),
    rebucketed: persisted && compact(local.rebucketPersistedDays(persisted, fresh)),
    canonical: compact(local.canonicalDays(fresh.days)),
    outgoing: compact(local.outgoingDays(persisted?.days ?? null, fresh.days, compactAfter, '2026-03-15')),
    compacted: compact(compactDays(fresh.days, 5, '2026-03-15')),
    repriced: compact(repriced),
    repriceResult,
  });
}
console.log(JSON.stringify({ validation, built, merges }));
`;
const home = mkdtempSync(join(tmpdir(), 'aitrack-store-golden-'));
const script = join(home, 'dump.mts');
writeFileSync(script, dump);
const output = execFileSync(process.execPath, ['--import', 'tsx', script], {
  maxBuffer: 256 * 1024 * 1024,
  env: {
    PATH: process.env.PATH,
    TZ: 'UTC',
    HOME: home,
    USERPROFILE: home,
    AITRACK_NO_CACHE: '1',
    AITRACK_NO_PRICING_REFRESH: '1',
    AITRACK_ENCRYPTION_PASSPHRASE: 'test pass',
    AITRACK_CLAUDE_PROJECTS_DIRS: join(corpus, 'claude'),
    AITRACK_CODEX_SESSION_DIRS: join(corpus, 'codex'),
  },
}).toString();
writeFileSync(join(here, 'expected.json'), output);
rmSync(home, { recursive: true, force: true });

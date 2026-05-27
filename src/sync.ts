import { mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { loadConfig, resolveMachineId } from './config.js';
import { readClaudeData } from './readers/claude.js';
import { readCodexData } from './readers/codex.js';
import { isCloned, LOCAL_REPO, pull, commitAndPush } from './git.js';
import { consumeClaudeFallbackHits } from './pricing/claude.js';
import { consumeCodexFallbackHits } from './pricing/codex.js';
import type { DayMap, MachineFile } from './types.js';

function buildMachineData(host: string, allProviders: Record<string, DayMap>): MachineFile {
  const days: MachineFile['days'] = {};
  for (const [providerKey, dayMap] of Object.entries(allProviders)) {
    for (const [date, day] of dayMap) {
      days[date] ??= {};
      days[date][providerKey] = {
        byModel: day.byModel,
        totals: {
          inputTokens: day.inputTokens,
          outputTokens: day.outputTokens,
          ...(day.cachedInputTokens !== undefined
            ? { cachedInputTokens: day.cachedInputTokens }
            : {}),
          ...(day.costUSD !== undefined ? { costUSD: day.costUSD } : {}),
        },
      };
    }
  }
  return { hostname: host, lastUpdated: new Date().toISOString(), days };
}

export async function syncCommand(): Promise<void> {
  const config = loadConfig();

  if (!isCloned()) {
    throw new Error('Repo not cloned. Run: npx aitrack init');
  }

  console.log('Pulling latest from remote...');
  pull();

  // Cursor usage is merged at `show` time only (local CSV export); it is never written to git.
  console.log('Reading local data...');
  const [claudeData, codexData] = await Promise.all([readClaudeData(), readCodexData()]);

  const totalDays = new Set([...claudeData.keys(), ...codexData.keys()]).size;

  if (totalDays === 0) {
    console.log('No local data found (Claude Code or Codex).');
    return;
  }

  const sources: string[] = [];
  if (claudeData.size > 0) sources.push(`Claude Code (${claudeData.size} days)`);
  if (codexData.size > 0) sources.push(`Codex (${codexData.size} days)`);
  console.log(`Found: ${sources.join(', ')}`);

  const host = resolveMachineId(config);
  const dataDir = join(LOCAL_REPO, 'data');
  mkdirSync(dataDir, { recursive: true });

  const freshData = buildMachineData(host, { claude_code: claudeData, codex: codexData });
  const dataFilePath = join(dataDir, `${host}.json`);

  // Only write if the usage data changed — avoids a spurious commit on every run
  // (lastUpdated would otherwise always make the file dirty)
  let existingDays: MachineFile['days'] | null = null;
  try {
    const raw = readFileSync(dataFilePath, 'utf8');
    existingDays = (JSON.parse(raw) as MachineFile).days;
  } catch {
    /* file doesn't exist yet */
  }

  if (JSON.stringify(existingDays) === JSON.stringify(freshData.days)) {
    console.log('No changes to push — data is already up to date.');
    return;
  }

  writeFileSync(dataFilePath, JSON.stringify(freshData, null, 2), 'utf8');

  const pushed = commitAndPush(host);
  if (!pushed) {
    console.log('No changes to push — data is already up to date.');
    return;
  }
  console.log(`Done! Pushed data/${host}.json (${totalDays} days)`);

  const fb = [...consumeClaudeFallbackHits(), ...consumeCodexFallbackHits()];
  if (fb.length > 0) {
    console.warn(
      `\nWarning: priced via family fallback (no exact pricing in src/pricing/): ${fb.join(', ')}`,
    );
    console.warn(
      '  These models may be wrong — please update src/pricing/ with the correct rates.',
    );
  }
}

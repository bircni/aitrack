import { readClaudeData } from './readers/claude.js';
import { readCodexData } from './readers/codex.js';
import type { DayMap, MachineFile, TokenCounts } from './types.js';

function tokenCountFields(counts: TokenCounts): TokenCounts {
  return {
    inputTokens: counts.inputTokens,
    outputTokens: counts.outputTokens,
    ...(counts.rawInputTokens !== undefined ? { rawInputTokens: counts.rawInputTokens } : {}),
    ...(counts.cachedInputTokens !== undefined ? { cachedInputTokens: counts.cachedInputTokens } : {}),
    ...(counts.cacheCreationInputTokens !== undefined
      ? { cacheCreationInputTokens: counts.cacheCreationInputTokens }
      : {}),
    ...(counts.costUSD !== undefined ? { costUSD: counts.costUSD } : {}),
  };
}

export function buildMachineData(
  machineId: string,
  allProviders: Record<string, DayMap>,
): MachineFile {
  const days: MachineFile['days'] = {};
  for (const [providerKey, dayMap] of Object.entries(allProviders)) {
    for (const [date, day] of dayMap) {
      days[date] ??= {};
      const byModel: Record<string, TokenCounts> = {};
      for (const [model, counts] of Object.entries(day.byModel)) {
        byModel[model] = tokenCountFields(counts);
      }
      days[date][providerKey] = {
        byModel,
        totals: tokenCountFields(day),
      };
    }
  }
  return { hostname: machineId, lastUpdated: new Date().toISOString(), days };
}

export function machineHasData(machine: MachineFile): boolean {
  return Object.keys(machine.days).length > 0;
}

export async function readLocalProviderMaps(): Promise<{
  claude_code: DayMap;
  codex: DayMap;
}> {
  const [claude_code, codex] = await Promise.all([readClaudeData(), readCodexData()]);
  return { claude_code, codex };
}

export async function buildLocalMachineFile(machineId: string): Promise<MachineFile> {
  const maps = await readLocalProviderMaps();
  return buildMachineData(machineId, maps);
}

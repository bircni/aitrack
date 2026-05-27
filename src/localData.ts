import { readClaudeData } from './readers/claude.js';
import { readCodexData } from './readers/codex.js';
import type { DayMap, MachineFile } from './types.js';

export function buildMachineData(
  machineId: string,
  allProviders: Record<string, DayMap>,
): MachineFile {
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

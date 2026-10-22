import { estimateMistralCostUSD } from '../pricing/mistral.js';
import { getVibePaths, listVibeSessionFiles, readVibeData } from '../readers/vibe.js';
import type { CheckResult } from './checkResult.js';
import type { SyncedProvider } from './types.js';

async function vibeCheck(): Promise<CheckResult> {
  const roots = getVibePaths();
  const sessions = await listVibeSessionFiles(roots);
  return sessions.length > 0
    ? {
        status: 'ok',
        label: 'Mistral Vibe source',
        detail: `${String(sessions.length)} session(s) across ${roots.join(', ')}`,
      }
    : {
        status: 'warn',
        label: 'Mistral Vibe source',
        detail: `no sessions found; checked ${roots.join(', ')}`,
      };
}

export const vibeProvider: SyncedProvider = {
  descriptor: {
    key: 'vibe',
    label: 'Mistral Vibe',
    aliases: ['vibe', 'mistral', 'mistral-vibe', 'mistral_vibe', 'mistralvibe'],
    costLabel: 'Est. cost',
  },
  heatmap: {
    light: ['#ebedf0', '#fbefc4', '#f3cf5c', '#d39b00', '#8a5a00'],
    dark: ['#1e1e24', '#3a2c05', '#6e5208', '#b8860b', '#f2c23a'],
  },
  pricing: {
    priceModelCost(model, counts, _usageDate, _mode, fallbacks) {
      return estimateMistralCostUSD(
        model,
        counts.inputTokens,
        counts.outputTokens,
        counts.cachedInputTokens,
        fallbacks,
      );
    },
  },
  reader: { readData: readVibeData },
  doctorCheck: vibeCheck,
};

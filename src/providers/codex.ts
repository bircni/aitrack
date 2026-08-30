import type { CheckResult } from '../display/checkResult.js';
import { CODEX_PRICING_BY_ID, estimateCodexCostUSD } from '../pricing/codex.js';
import { getCodexPaths, readCodexData } from '../readers/codex.js';
import { sourceCheck } from '../readers/paths.js';
import type { SyncedProvider } from './types.js';

export const codexProvider: SyncedProvider = {
  descriptor: {
    key: 'codex',
    label: 'Codex',
    aliases: ['codex'],
    synced: true,
    costLabel: 'Est. cost',
  },
  heatmap: {
    light: ['#ebedf0', '#cde4f8', '#7db9ea', '#2472c8', '#0b3d7a'],
    dark: ['#1e1e24', '#0c2240', '#0d4a8a', '#1a7fd4', '#4db8ff'],
  },
  pricing: {
    modelCount: Object.keys(CODEX_PRICING_BY_ID).length,
    priceModelCost(model, counts, usageDate, _mode, fallbacks) {
      return estimateCodexCostUSD(
        model,
        counts.inputTokens,
        counts.outputTokens,
        counts.cachedInputTokens ?? 0,
        usageDate,
        fallbacks,
      );
    },
  },
  reader: {
    // Wrapped rather than passed by reference so a test that partially mocks
    // `readers/codex.js` only trips the missing export if it actually calls in.
    readData: (fallbacks) => readCodexData(fallbacks),
  },
  doctorCheck: (): Promise<CheckResult> => sourceCheck('Codex source', getCodexPaths()),
};

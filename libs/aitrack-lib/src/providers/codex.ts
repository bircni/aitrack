import { estimateCodexCostUSD } from '../pricing/codex.js';
import { getCodexPaths, readCodexData } from '../readers/codex.js';
import { sourceCheck } from '../readers/paths.js';
import type { CheckResult } from './checkResult.js';
import type { SyncedProvider } from './types.js';

export const codexProvider: SyncedProvider = {
  descriptor: {
    key: 'codex',
    label: 'Codex',
    aliases: ['codex'],
    costLabel: 'Est. cost',
  },
  heatmap: {
    light: ['#ebedf0', '#cde4f8', '#7db9ea', '#2472c8', '#0b3d7a'],
    dark: ['#1e1e24', '#0c2240', '#0d4a8a', '#1a7fd4', '#4db8ff'],
  },
  pricing: {
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
  reader: { readData: readCodexData },
  doctorCheck: (): Promise<CheckResult> => sourceCheck('Codex source', getCodexPaths()),
};

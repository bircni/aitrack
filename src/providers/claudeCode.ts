import type { CheckResult } from '../display/checkResult.js';
import {
  CLAUDE_PRICING_BY_ID,
  estimateClaudeCostFromAggregateTokens,
  estimateClaudeCostFromStoredCounts,
} from '../pricing/claude.js';
import { getClaudePaths, readClaudeData } from '../readers/claude.js';
import { sourceCheck } from '../readers/paths.js';
import type { SyncedProvider } from './types.js';

export const claudeCodeProvider: SyncedProvider = {
  descriptor: {
    key: 'claude_code',
    label: 'Claude Code',
    aliases: ['claude', 'claude-code', 'claude_code', 'claudecode'],
    synced: true,
    costLabel: 'Est. cost',
  },
  heatmap: {
    light: ['#ebedf0', '#fde8cf', '#fbba77', '#e87820', '#b04b10'],
    dark: ['#1e1e24', '#3d1a06', '#7c3610', '#c4621a', '#f08030'],
  },
  pricing: {
    repriceRequiresBreakdown: true,
    modelCount: Object.keys(CLAUDE_PRICING_BY_ID).length,
    priceModelCost(model, counts, usageDate, mode, fallbacks) {
      if (mode === 'recompute') {
        return estimateClaudeCostFromStoredCounts(model, counts, usageDate, fallbacks);
      }
      return (
        estimateClaudeCostFromStoredCounts(model, counts, usageDate, fallbacks) ??
        estimateClaudeCostFromAggregateTokens(
          model,
          counts.inputTokens,
          counts.outputTokens,
          usageDate,
          fallbacks,
        )
      );
    },
  },
  reader: {
    // Wrapped rather than passed by reference so a test that partially mocks
    // `readers/claude.js` only trips the missing export if it actually calls in.
    readData: (fallbacks) => readClaudeData(fallbacks),
  },
  doctorCheck: (): Promise<CheckResult> => sourceCheck('Claude Code source', getClaudePaths()),
};

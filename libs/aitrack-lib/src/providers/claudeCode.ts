import {
  estimateClaudeCostFromAggregateTokens,
  estimateClaudeCostFromStoredCounts,
} from '../pricing/claude.js';
import { getClaudePaths, readClaudeData } from '../readers/claude.js';
import { sourceCheck } from '../readers/paths.js';
import type { CheckResult } from './checkResult.js';
import type { SyncedProvider } from './types.js';

export const claudeCodeProvider: SyncedProvider = {
  descriptor: {
    key: 'claude_code',
    label: 'Claude Code',
    aliases: ['claude', 'claude-code', 'claude_code', 'claudecode'],
    costLabel: 'Est. cost',
  },
  heatmap: {
    light: ['#ebedf0', '#fde8cf', '#fbba77', '#e87820', '#b04b10'],
    dark: ['#1e1e24', '#3d1a06', '#7c3610', '#c4621a', '#f08030'],
  },
  pricing: {
    repriceRequiresBreakdown: true,
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
  reader: { readData: readClaudeData },
  doctorCheck: (): Promise<CheckResult> => sourceCheck('Claude Code source', getClaudePaths()),
};

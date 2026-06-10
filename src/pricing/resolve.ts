import type { TokenCounts } from '../data/types.js';
import {
  estimateClaudeCostFromAggregateTokens,
  estimateClaudeCostFromStoredCounts,
} from '../readers/claude.js';
import { estimateCodexCostUSD } from './codex.js';

export type ResolveModelCostMode = 'merge' | 'recompute';

export function resolveModelCost(
  providerKey: string,
  model: string,
  counts: TokenCounts,
  usageDate?: string,
  mode: ResolveModelCostMode = 'merge',
): number | undefined {
  if (mode === 'merge' && counts.costUSD !== undefined) return counts.costUSD;

  if (providerKey === 'claude_code') {
    if (mode === 'recompute') {
      return estimateClaudeCostFromStoredCounts(model, counts, usageDate);
    }
    return estimateClaudeCostFromAggregateTokens(
      model,
      counts.inputTokens,
      counts.outputTokens,
      usageDate,
    );
  }

  if (providerKey === 'codex') {
    return estimateCodexCostUSD(
      model,
      counts.inputTokens,
      counts.outputTokens,
      counts.cachedInputTokens ?? 0,
      usageDate,
    );
  }

  return undefined;
}

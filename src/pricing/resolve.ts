import type { TokenCounts } from '../data/types.js';
import {
  estimateClaudeCostFromAggregateTokens,
  estimateClaudeCostFromStoredCounts,
} from './claude.js';
import { estimateCodexCostUSD } from './codex.js';
import type { FallbackCollector } from './fallback.js';

export type ResolveModelCostMode = 'merge' | 'recompute';

export function resolveModelCost(
  providerKey: string,
  model: string,
  counts: TokenCounts,
  usageDate?: string,
  mode: ResolveModelCostMode = 'merge',
  fallbacks?: FallbackCollector,
): number | undefined {
  if (mode === 'merge' && counts.costUSD !== undefined) return counts.costUSD;

  if (providerKey === 'claude_code') {
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
  }

  if (providerKey === 'codex') {
    return estimateCodexCostUSD(
      model,
      counts.inputTokens,
      counts.outputTokens,
      counts.cachedInputTokens ?? 0,
      usageDate,
      fallbacks,
    );
  }

  return undefined;
}

export interface CostTokenSortable {
  tokens: number;
  costUSD?: number;
  cost?: number | null;
}

export function costValue(entry: CostTokenSortable): number {
  return entry.costUSD ?? entry.cost ?? 0;
}

export function compareByCostThenTokens(a: CostTokenSortable, b: CostTokenSortable): number {
  return costValue(b) - costValue(a) || b.tokens - a.tokens;
}

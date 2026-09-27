export interface CostPoint {
  day: string;
  claude_code: number;
  codex: number;
  cursor: number;
}

export function stackedCost(
  days: ReadonlyArray<{ day: string; provider: string; costUsd: number }>,
  limit = 45,
): CostPoint[] {
  const byDay = new Map<string, CostPoint>();
  for (const row of days) {
    const current = byDay.get(row.day) ?? {
      day: row.day.slice(5),
      claude_code: 0,
      codex: 0,
      cursor: 0,
    };
    if (row.provider === 'claude_code') current.claude_code += row.costUsd;
    else if (row.provider === 'codex') current.codex += row.costUsd;
    else current.cursor += row.costUsd;
    byDay.set(row.day, current);
  }
  return [...byDay.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .slice(-limit)
    .map(([, value]) => value);
}

export function localDay(date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${String(date.getFullYear())}-${month}-${day}`;
}

export function money(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value > 0 && value < 0.01) return '<$0.01';
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

export function when(iso: string | null): string {
  if (iso === null) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function providerLabel(provider: string): string {
  if (provider === 'claude' || provider === 'claude_code') return 'Claude Code';
  if (provider === 'codex') return 'Codex';
  if (provider === 'cursor') return 'Cursor';
  return provider;
}

export function metricText(value: number | null, unit: string): string {
  if (value === null) return '—';
  if (unit === 'usd') return money(value);
  if (unit === 'ratio') return `${String(Math.round(value * 100))}%`;
  if (unit === 'minutes') return `${String(Math.round(value))} min`;
  if (unit === 'lines') return compact(value);
  return value.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

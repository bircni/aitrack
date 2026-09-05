/**
 * Whether rounding at `divisor` lands on 1000, i.e. past what the unit holds.
 * toFixed rounds up, so 999_999 scaled by 1e3 gives "1000.0" — which has to be
 * shown as "1.0M" rather than "1000.0K".
 */
function roundsPastUnit(n: number, divisor: number): boolean {
  return Number((n / divisor).toFixed(1)) >= 1000;
}

export function fmt(n: number): string {
  if (n >= 1e9 || roundsPastUnit(n, 1e6)) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6 || roundsPastUnit(n, 1e3)) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

/** Format a USD amount. Null/undefined/non-positive values render as an em dash. */
export function fmtUSD(n: number | null | undefined): string {
  if (n === null || n === undefined || n <= 0) return '—';
  if (n < 0.01) return '<$0.01';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Format a USD amount when cost is known to exist (e.g. heatmap stats). Zero shows as $0.00. */
export function fmtUSDCost(n: number): string {
  if (n > 0 && n < 0.01) return '<$0.01';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function pad(value: string, width: number, align: 'left' | 'right'): string {
  if (value.length >= width) return value;
  const padString = ' '.repeat(width - value.length);
  return align === 'left' ? value + padString : padString + value;
}

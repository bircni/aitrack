export type CostSpan = 'all' | 'today' | '7' | '30' | '90' | 'custom';

export interface DaySpan {
  from: string | null;
  to: string | null;
}

export interface CostWindow {
  currentLabel: string;
  previousLabel: string | null;
  current: DaySpan;
  previous: DaySpan | null;
  currentRule: string;
  previousRule: string | null;
}

const SPANS = ['all', 'today', '7', '30', '90', 'custom'] as const;

export function parseCostSpan(value: string): CostSpan | null {
  for (const span of SPANS) {
    if (value === span) return span;
  }
  return null;
}

export function costWindow(
  span: CostSpan,
  today: string,
  customFrom: string,
  customTo: string,
): CostWindow {
  switch (span) {
    case 'all': {
      return {
        currentLabel: 'All time',
        previousLabel: null,
        current: { from: null, to: null },
        previous: null,
        currentRule: 'Sum of every stored day total.',
        previousRule: null,
      };
    }
    case 'today': {
      const yesterday = shiftDay(today, -1);
      return {
        currentLabel: 'Today',
        previousLabel: 'Yesterday',
        current: { from: today, to: today },
        previous: { from: yesterday, to: yesterday },
        currentRule: 'Sum of day totals whose local date is today.',
        previousRule: 'Sum of day totals whose local date was yesterday.',
      };
    }
    case '7':
    case '30':
    case '90': {
      return rolling(span, today);
    }
    case 'custom': {
      return customWindow(customFrom, customTo);
    }
    default: {
      const unexpected: never = span;
      return unexpected;
    }
  }
}

export function daysIn<T extends { day: string }>(rows: readonly T[], span: DaySpan): T[] {
  return rows.filter((row) => {
    if (span.from !== null && row.day < span.from) return false;
    if (span.to !== null && row.day > span.to) return false;
    return true;
  });
}

export function sumCost(rows: ReadonlyArray<{ costUsd: number }>): number {
  return rows.reduce((sum, row) => sum + row.costUsd, 0);
}

function rolling(span: '7' | '30' | '90', today: string): CostWindow {
  let days: number;
  switch (span) {
    case '7': {
      days = 7;
      break;
    }
    case '30': {
      days = 30;
      break;
    }
    case '90': {
      days = 90;
      break;
    }
    default: {
      const unexpected: never = span;
      days = unexpected;
    }
  }
  const from = shiftDay(today, -days);
  return {
    currentLabel: `Last ${String(days)} days`,
    previousLabel: `Previous ${String(days)} days`,
    current: { from, to: today },
    previous: { from: shiftDay(today, -2 * days), to: shiftDay(today, -days - 1) },
    currentRule: `Sum of day totals whose local date falls in the last ${String(days)} days, including today.`,
    previousRule: `Sum of day totals from the ${String(days)} days before that window.`,
  };
}

function customWindow(customFrom: string, customTo: string): CostWindow {
  const start = customFrom === '' ? null : customFrom;
  const end = customTo === '' ? null : customTo;
  if (start === null || end === null) {
    return {
      currentLabel: 'Custom range',
      previousLabel: null,
      current: { from: start, to: end },
      previous: null,
      currentRule:
        'Sum of day totals inside the dates you set. Set both ends to compare a previous range.',
      previousRule: null,
    };
  }
  const from = start <= end ? start : end;
  const to = start <= end ? end : start;
  const length = dayCount(from, to);
  const previousTo = shiftDay(from, -1);
  const previousFrom = shiftDay(previousTo, -(length - 1));
  return {
    currentLabel: `${from} to ${to}`,
    previousLabel: 'Previous range',
    current: { from, to },
    previous: { from: previousFrom, to: previousTo },
    currentRule: `Sum of day totals from ${from} through ${to}.`,
    previousRule: `The same number of days immediately before ${from}.`,
  };
}

function dayCount(from: string, to: string): number {
  const start = parseDay(from);
  const end = parseDay(to);
  return Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
}

function shiftDay(day: string, delta: number): string {
  const value = parseDay(day);
  value.setDate(value.getDate() + delta);
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const date = String(value.getDate()).padStart(2, '0');
  return `${String(value.getFullYear())}-${month}-${date}`;
}

function parseDay(day: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(day);
  if (match === null) return new Date(Number.NaN);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

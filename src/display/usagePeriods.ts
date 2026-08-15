import { toLocalDateString } from '../data/dayMap.js';

export type UsagePeriod =
  | 'today'
  | 'yesterday'
  | 'week'
  | 'month'
  | 'year'
  | 'all'
  | 'thisweek'
  | 'lastweek'
  | 'thismonth'
  | 'lastmonth'
  | 'date'
  | 'range'
  | 'last';

export type UsagePeriodArgShape = 'none' | 'date' | 'range' | 'last';

export interface UsagePeriodDefinition {
  name: string;
  period: UsagePeriod;
  description: string;
  argShape: UsagePeriodArgShape;
}

/** Single registry for CLI registration, parsing, and validation. */
export const USAGE_PERIOD_DEFINITIONS = [
  {
    name: 'today',
    period: 'today',
    description: "Today's usage: provider / tokens / model / price",
    argShape: 'none',
  },
  { name: 'yesterday', period: 'yesterday', description: "Yesterday's usage", argShape: 'none' },
  {
    name: 'date <date>',
    period: 'date',
    description: 'Usage for a specific date (YYYY-MM-DD)',
    argShape: 'date',
  },
  {
    name: 'range <from> <to>',
    period: 'range',
    description: 'Usage for a custom date range (YYYY-MM-DD YYYY-MM-DD)',
    argShape: 'range',
  },
  {
    name: 'thisweek',
    period: 'thisweek',
    description: 'Usage for the current calendar week (Mon–Sun)',
    argShape: 'none',
  },
  {
    name: 'lastweek',
    period: 'lastweek',
    description: 'Usage for the previous calendar week (Mon–Sun)',
    argShape: 'none',
  },
  {
    name: 'week',
    period: 'week',
    description: 'Rolling 7-day usage ending today',
    argShape: 'none',
  },
  {
    name: 'thismonth',
    period: 'thismonth',
    description: 'Usage for the current calendar month',
    argShape: 'none',
  },
  {
    name: 'lastmonth',
    period: 'lastmonth',
    description: 'Usage for the previous calendar month',
    argShape: 'none',
  },
  {
    name: 'month',
    period: 'month',
    description: 'Rolling 30-day usage ending today',
    argShape: 'none',
  },
  {
    name: 'last <n>',
    period: 'last',
    description: 'Rolling N-day usage ending today, e.g. last 14',
    argShape: 'last',
  },
  {
    name: 'year',
    period: 'year',
    description: 'Usage for the current calendar year',
    argShape: 'none',
  },
  {
    name: 'all',
    period: 'all',
    description: 'All-time usage across every recorded day',
    argShape: 'none',
  },
] as const satisfies readonly UsagePeriodDefinition[];

/** Periods that need no extra arguments (unlike `date`, `range`, or `last`). */
export const NO_ARG_PERIODS = USAGE_PERIOD_DEFINITIONS.filter((def) => def.argShape === 'none').map(
  (def) => def.period,
) as ReadonlyArray<Exclude<UsagePeriod, 'date' | 'range' | 'last'>>;

export type NoArgPeriod = (typeof NO_ARG_PERIODS)[number];

export function isNoArgPeriod(value: string): value is NoArgPeriod {
  return (NO_ARG_PERIODS as readonly string[]).includes(value);
}

export function isUsagePeriod(value: string): value is UsagePeriod {
  return USAGE_PERIOD_DEFINITIONS.some((def) => def.period === value);
}

export interface UsageWindowOptions {
  period: UsagePeriod;
  from?: string;
  to?: string;
  n?: number;
}

export interface UsageWindow {
  start: string;
  end: string;
  label: string;
}

/*
 * Calendar arithmetic on YYYY-MM-DD strings.
 *
 * There is exactly one clock read in this module — `todayString()` — and every
 * window is derived from date strings after that. The helpers below go through
 * UTC purely because it has no DST discontinuities; the strings are local dates
 * and are never re-interpreted against a wall clock. Reading local fields
 * (today.getMonth()) while building with Date.UTC is what makes this kind of
 * code drift by a day, so the two are kept apart.
 */

/** Today as a local calendar date — the only place this module reads the clock. */
function todayString(): string {
  return toLocalDateString(new Date());
}

function parseDateString(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function formatDateString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function yearOf(date: string): number {
  return Number(date.slice(0, 4));
}

/** 1-based, to match how the string reads. */
function monthOf(date: string): number {
  return Number(date.slice(5, 7));
}

function dayOf(date: string): number {
  return Number(date.slice(8, 10));
}

function shiftDate(value: string, days: number): string {
  const date = parseDateString(value);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDateString(date);
}

/** First day of the month `offset` months from the one `date` falls in. */
function shiftMonthStart(date: string, offset: number): string {
  return formatDateString(new Date(Date.UTC(yearOf(date), monthOf(date) - 1 + offset, 1)));
}

/** Last day of the month `offset` months from the one `date` falls in. */
function shiftMonthEnd(date: string, offset: number): string {
  return formatDateString(new Date(Date.UTC(yearOf(date), monthOf(date) + offset, 0)));
}

/**
 * The same day of the month, `offset` months away, clamped to that month's
 * length — the 31st compared against a 30-day month lands on the 30th.
 */
function shiftMonthSameDay(date: string, offset: number): string {
  const start = shiftMonthStart(date, offset);
  const lastDay = dayOf(shiftMonthEnd(date, offset));
  return `${start.slice(0, 8)}${String(Math.min(dayOf(date), lastDay)).padStart(2, '0')}`;
}

/** The same month and day in another year, clamped so Feb 29 survives. */
function sameDayInYear(date: string, year: number): string {
  const target = `${String(year).padStart(4, '0')}${date.slice(4)}`;
  const lastDay = dayOf(shiftMonthEnd(target, 0));
  return `${target.slice(0, 8)}${String(Math.min(dayOf(date), lastDay)).padStart(2, '0')}`;
}

/** Day of the week a calendar date falls on, 0 = Sunday. */
function weekdayOf(date: string): number {
  return parseDateString(date).getUTCDay();
}

function inclusiveDayCount(start: string, end: string): number {
  const milliseconds = parseDateString(end).getTime() - parseDateString(start).getTime();
  return Math.floor(milliseconds / 86_400_000) + 1;
}

export function computePreviousUsageWindow(
  options: UsageWindowOptions,
  current: UsageWindow = computeUsageWindow(options),
): UsageWindow {
  if (options.period === 'all') {
    throw new Error('All-time usage does not have a comparable previous period.');
  }

  if (options.period === 'thisweek' || options.period === 'lastweek') {
    const start = shiftDate(current.start, -7);
    const end = shiftDate(current.end, -7);
    const prefix = options.period === 'thisweek' ? 'previous week to date' : 'week before';
    return { start, end, label: `${prefix} (${start} → ${end})` };
  }

  if (options.period === 'thismonth') {
    const start = shiftMonthStart(current.end, -1);
    const end = shiftMonthSameDay(current.end, -1);
    return { start, end, label: `previous month to date (${start} → ${end})` };
  }

  if (options.period === 'lastmonth') {
    const start = shiftMonthStart(current.start, -1);
    const end = shiftMonthEnd(current.start, -1);
    return { start, end, label: `month before (${start} → ${end})` };
  }

  if (options.period === 'year') {
    // The current window is the whole calendar year, so the comparable slice of
    // the previous one has to come from today rather than from `current.end`.
    const previousYear = yearOf(todayString()) - 1;
    const start = `${String(previousYear)}-01-01`;
    const end = sameDayInYear(todayString(), previousYear);
    return { start, end, label: `previous year to date (${start} → ${end})` };
  }

  const days = inclusiveDayCount(current.start, current.end);
  const end = shiftDate(current.start, -1);
  const start = shiftDate(end, -(days - 1));
  return { start, end, label: `previous period (${start} → ${end})` };
}

export function computeUsageWindow(options: UsageWindowOptions): UsageWindow {
  const today = todayString();

  /** The n days ending today, inclusive — what `last`, `week` and `month` all are. */
  const rollingWindow = (n: number): UsageWindow => {
    const start = shiftDate(today, -(n - 1));
    return { start, end: today, label: `last ${String(n)} days (${start} → ${today})` };
  };

  /** Monday of the week `today` falls in. */
  const thisMonday = (): string => shiftDate(today, -((weekdayOf(today) + 6) % 7));

  switch (options.period) {
    case 'today': {
      // The only place a wall-clock time is shown rather than a calendar date.
      const now = new Date();
      const label = `today (${now.toLocaleDateString()} ${now.toLocaleTimeString()})`;
      return { start: today, end: today, label };
    }

    case 'yesterday': {
      const date = shiftDate(today, -1);
      return { start: date, end: date, label: `yesterday (${date})` };
    }

    case 'date': {
      if (!options.from) throw new Error('from is required for date period');
      return { start: options.from, end: options.from, label: options.from };
    }

    case 'range': {
      if (!options.from || !options.to)
        throw new Error('from and to are required for range period');
      return { start: options.from, end: options.to, label: `${options.from} → ${options.to}` };
    }

    case 'thisweek': {
      const start = thisMonday();
      return { start, end: today, label: `this week (${start} → ${today})` };
    }

    case 'lastweek': {
      const monday = thisMonday();
      const start = shiftDate(monday, -7);
      const end = shiftDate(monday, -1);
      return { start, end, label: `last week (${start} → ${end})` };
    }

    case 'thismonth': {
      const start = shiftMonthStart(today, 0);
      return { start, end: today, label: `this month (${start} → ${today})` };
    }

    case 'lastmonth': {
      const start = shiftMonthStart(today, -1);
      const end = shiftMonthEnd(today, -1);
      return { start, end, label: `last month (${start} → ${end})` };
    }

    case 'last': {
      if (!options.n) throw new Error('n is required for last period');
      return rollingWindow(options.n);
    }

    case 'week':
      return rollingWindow(7);

    case 'month':
      return rollingWindow(30);

    case 'year': {
      const year = String(yearOf(today));
      return { start: `${year}-01-01`, end: `${year}-12-31`, label: year };
    }

    case 'all':
      return { start: '0000-01-01', end: '9999-12-31', label: 'all time' };
  }
}

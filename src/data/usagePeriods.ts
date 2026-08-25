import { toLocalDateString } from './dayMap.js';

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

/**
 * What a period's window function is allowed to look at.
 *
 * Deliberately not the full `UsageWindowOptions`: the period has already been
 * dispatched on by the time a window function runs, and leaving it out keeps
 * `UsagePeriod` from having to be known while the registry is being built.
 */
export interface UsageWindowInput {
  /** Today as a local calendar date, read once per call. */
  today: string;
  from?: string;
  to?: string;
  n?: number;
}

export interface UsagePeriodDefinition {
  name: string;
  period: UsagePeriod;
  description: string;
  argShape: UsagePeriodArgShape;
  /** How this period turns today's date into a window. */
  window: (input: UsageWindowInput) => UsageWindow;
}

/** Single registry for CLI registration, parsing, and validation. */
export const USAGE_PERIOD_DEFINITIONS = [
  {
    name: 'today',
    period: 'today',
    description: "Today's usage: provider / tokens / model / price",
    argShape: 'none',
    window: ({ today }) => {
      // The only place a wall-clock time is shown rather than a calendar date.
      const now = new Date();
      return {
        start: today,
        end: today,
        label: `today (${now.toLocaleDateString()} ${now.toLocaleTimeString()})`,
      };
    },
  },
  {
    name: 'yesterday',
    period: 'yesterday',
    description: "Yesterday's usage",
    argShape: 'none',
    window: ({ today }) => {
      const date = shiftDate(today, -1);
      return { start: date, end: date, label: `yesterday (${date})` };
    },
  },
  {
    name: 'date <date>',
    period: 'date',
    description: 'Usage for a specific date (YYYY-MM-DD)',
    argShape: 'date',
    window: ({ from }) => {
      if (!from) throw new Error('from is required for date period');
      return { start: from, end: from, label: from };
    },
  },
  {
    name: 'range <from> <to>',
    period: 'range',
    description: 'Usage for a custom date range (YYYY-MM-DD YYYY-MM-DD)',
    argShape: 'range',
    window: ({ from, to }) => {
      if (!from || !to) throw new Error('from and to are required for range period');
      return { start: from, end: to, label: `${from} → ${to}` };
    },
  },
  {
    name: 'thisweek',
    period: 'thisweek',
    description: 'Usage for the current calendar week (Mon–Sun)',
    argShape: 'none',
    window: ({ today }) => {
      const start = mondayOfWeek(today);
      return { start, end: today, label: `this week (${start} → ${today})` };
    },
  },
  {
    name: 'lastweek',
    period: 'lastweek',
    description: 'Usage for the previous calendar week (Mon–Sun)',
    argShape: 'none',
    window: ({ today }) => {
      const monday = mondayOfWeek(today);
      const start = shiftDate(monday, -7);
      const end = shiftDate(monday, -1);
      return { start, end, label: `last week (${start} → ${end})` };
    },
  },
  {
    name: 'week',
    period: 'week',
    description: 'Rolling 7-day usage ending today',
    argShape: 'none',
    window: ({ today }) => rollingWindow(today, 7),
  },
  {
    name: 'thismonth',
    period: 'thismonth',
    description: 'Usage for the current calendar month',
    argShape: 'none',
    window: ({ today }) => {
      const start = shiftMonthStart(today, 0);
      return { start, end: today, label: `this month (${start} → ${today})` };
    },
  },
  {
    name: 'lastmonth',
    period: 'lastmonth',
    description: 'Usage for the previous calendar month',
    argShape: 'none',
    window: ({ today }) => {
      const start = shiftMonthStart(today, -1);
      const end = shiftMonthEnd(today, -1);
      return { start, end, label: `last month (${start} → ${end})` };
    },
  },
  {
    name: 'month',
    period: 'month',
    description: 'Rolling 30-day usage ending today',
    argShape: 'none',
    window: ({ today }) => rollingWindow(today, 30),
  },
  {
    name: 'last <n>',
    period: 'last',
    description: 'Rolling N-day usage ending today, e.g. last 14',
    argShape: 'last',
    window: ({ today, n }) => {
      if (!n) throw new Error('n is required for last period');
      return rollingWindow(today, n);
    },
  },
  {
    name: 'year',
    period: 'year',
    description: 'Usage for the current calendar year',
    argShape: 'none',
    window: ({ today }) => {
      const year = String(yearOf(today));
      return { start: `${year}-01-01`, end: `${year}-12-31`, label: year };
    },
  },
  {
    name: 'all',
    period: 'all',
    description: 'All-time usage across every recorded day',
    argShape: 'none',
    window: () => ({ start: '0000-01-01', end: '9999-12-31', label: 'all time' }),
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

/** The n days ending `today`, inclusive — what `last`, `week` and `month` all are. */
function rollingWindow(today: string, n: number): UsageWindow {
  const start = shiftDate(today, -(n - 1));
  return { start, end: today, label: `last ${String(n)} days (${start} → ${today})` };
}

/** Monday of the week `date` falls in. */
function mondayOfWeek(date: string): string {
  return shiftDate(date, -((weekdayOf(date) + 6) % 7));
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

/**
 * Resolve a period to its window.
 *
 * The period list used to be spelled out three times — once in the registry,
 * once as a 13-case switch here, and partly again in
 * `computePreviousUsageWindow`. Each period now carries its own window
 * function, so adding one is a single entry.
 */
export function computeUsageWindow(options: UsageWindowOptions): UsageWindow {
  const definition = USAGE_PERIOD_DEFINITIONS.find((def) => def.period === options.period);
  if (!definition) {
    throw new Error(`Unknown usage period: ${options.period}`);
  }
  return definition.window({
    today: todayString(),
    from: options.from,
    to: options.to,
    n: options.n,
  });
}

/**
 * Fails to compile if a `UsagePeriod` has no registry entry, or an entry names
 * a period the union does not declare — the two can no longer drift apart.
 */
type RegisteredPeriod = (typeof USAGE_PERIOD_DEFINITIONS)[number]['period'];
type AssertSame<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _everyPeriodIsRegistered: AssertSame<UsagePeriod, RegisteredPeriod> = true;
void _everyPeriodIsRegistered;

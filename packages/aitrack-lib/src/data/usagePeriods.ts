import { isDayKey } from '../constants.js';
import {
  inclusiveDayCount,
  mondayOfWeek,
  sameDayInYear,
  shiftDate,
  shiftMonthEnd,
  shiftMonthSameDay,
  shiftMonthStart,
  yearOf,
} from './calendar.js';
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

export interface UsagePeriodArgs {
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
  /** Comparable window immediately before `current`. */
  previous: (input: UsageWindowInput, current: UsageWindow) => UsageWindow;
  /** Extra CLI args for this period (`date`, `range`, `last`), or none. */
  parseArgs: (args: string[]) => UsagePeriodArgs;
}

function parseNoArgs(period: UsagePeriod): (args: string[]) => UsagePeriodArgs {
  return (args) => {
    if (args.length > 0) {
      throw new Error(`Period "${period}" does not accept extra arguments.`);
    }
    return {};
  };
}

function parseDateArgs(args: string[]): UsagePeriodArgs {
  const [from, ...rest] = args;
  if (from === undefined || rest.length > 0) {
    throw new Error('Period "date" expects a single date (YYYY-MM-DD).');
  }
  if (!isDayKey(from)) throw new Error(`Invalid date: "${from}". Expected YYYY-MM-DD.`);
  return { from };
}

function parseRangeArgs(args: string[]): UsagePeriodArgs {
  const [from, to, ...rest] = args;
  if (from === undefined || to === undefined || rest.length > 0) {
    throw new Error('Period "range" expects two dates (YYYY-MM-DD YYYY-MM-DD).');
  }
  if (!isDayKey(from)) throw new Error(`Invalid date: "${from}". Expected YYYY-MM-DD.`);
  if (!isDayKey(to)) throw new Error(`Invalid date: "${to}". Expected YYYY-MM-DD.`);
  if (from > to) {
    throw new Error(`Start date "${from}" must not be after end date "${to}".`);
  }
  return { from, to };
}

function parseLastArgs(args: string[]): UsagePeriodArgs {
  const [n, ...rest] = args;
  if (n === undefined || rest.length > 0) {
    throw new Error('Period "last" expects a positive integer day count.');
  }
  if (!/^\d+$/u.test(n)) {
    throw new Error(`Invalid number of days: "${n}". Expected a positive integer.`);
  }
  const parsed = Number(n);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid number of days: "${n}". Expected a positive integer.`);
  }
  return { n: parsed };
}

/** A window of the same length ending the day before `current` starts. */
function previousEqualSpan(_input: UsageWindowInput, current: UsageWindow): UsageWindow {
  const days = inclusiveDayCount(current.start, current.end);
  const end = shiftDate(current.start, -1);
  const start = shiftDate(end, -(days - 1));
  return { start, end, label: `previous period (${start} → ${end})` };
}

function previousShiftedWeek(labelPrefix: string) {
  return (_input: UsageWindowInput, current: UsageWindow): UsageWindow => {
    const start = shiftDate(current.start, -7);
    const end = shiftDate(current.end, -7);
    return { start, end, label: `${labelPrefix} (${start} → ${end})` };
  };
}

/** Single registry for CLI registration, parsing, and validation. */
export const USAGE_PERIOD_DEFINITIONS = [
  {
    name: 'today',
    period: 'today',
    description: "Today's usage: provider / tokens / model / price",
    argShape: 'none',
    parseArgs: parseNoArgs('today'),
    previous: previousEqualSpan,
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
    parseArgs: parseNoArgs('yesterday'),
    previous: previousEqualSpan,
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
    parseArgs: parseDateArgs,
    previous: previousEqualSpan,
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
    parseArgs: parseRangeArgs,
    previous: previousEqualSpan,
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
    parseArgs: parseNoArgs('thisweek'),
    previous: previousShiftedWeek('previous week to date'),
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
    parseArgs: parseNoArgs('lastweek'),
    previous: previousShiftedWeek('week before'),
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
    parseArgs: parseNoArgs('week'),
    previous: previousEqualSpan,
    window: ({ today }) => rollingWindow(today, 7),
  },
  {
    name: 'thismonth',
    period: 'thismonth',
    description: 'Usage for the current calendar month',
    argShape: 'none',
    parseArgs: parseNoArgs('thismonth'),
    previous: (_input, current) => {
      const start = shiftMonthStart(current.end, -1);
      const end = shiftMonthSameDay(current.end, -1);
      return { start, end, label: `previous month to date (${start} → ${end})` };
    },
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
    parseArgs: parseNoArgs('lastmonth'),
    previous: (_input, current) => {
      const start = shiftMonthStart(current.start, -1);
      const end = shiftMonthEnd(current.start, -1);
      return { start, end, label: `month before (${start} → ${end})` };
    },
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
    parseArgs: parseNoArgs('month'),
    previous: previousEqualSpan,
    window: ({ today }) => rollingWindow(today, 30),
  },
  {
    name: 'last <n>',
    period: 'last',
    description: 'Rolling N-day usage ending today, e.g. last 14',
    argShape: 'last',
    parseArgs: parseLastArgs,
    previous: previousEqualSpan,
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
    parseArgs: parseNoArgs('year'),
    previous: ({ today }) => {
      // The current window is the whole calendar year, so the comparable slice
      // of the previous one has to come from today rather than from `current.end`.
      const previousYear = yearOf(today) - 1;
      const start = `${String(previousYear)}-01-01`;
      const end = sameDayInYear(today, previousYear);
      return { start, end, label: `previous year to date (${start} → ${end})` };
    },
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
    parseArgs: parseNoArgs('all'),
    previous: () => {
      throw new Error('All-time usage does not have a comparable previous period.');
    },
    window: () => ({ start: '0000-01-01', end: '9999-12-31', label: 'all time' }),
  },
] as const satisfies readonly UsagePeriodDefinition[];

export function isUsagePeriod(value: string): value is UsagePeriod {
  return USAGE_PERIOD_DEFINITIONS.some((def) => def.period === value);
}

export function usagePeriodDefinition(period: UsagePeriod): UsagePeriodDefinition {
  const definition = USAGE_PERIOD_DEFINITIONS.find((def) => def.period === period);
  if (!definition) {
    throw new Error(`Unknown usage period: ${period}`);
  }
  return definition;
}

/**
 * Calendar arithmetic lives in `./calendar.ts`; this module only turns periods
 * into windows. `todayString()` is the one place either module reads the clock —
 * every window is derived from date strings after that.
 */

/** Today as a local calendar date — the only place this module reads the clock. */
function todayString(): string {
  return toLocalDateString(new Date());
}

/** The n days ending `today`, inclusive — what `last`, `week` and `month` all are. */
function rollingWindow(today: string, n: number): UsageWindow {
  const start = shiftDate(today, -(n - 1));
  return { start, end: today, label: `last ${String(n)} days (${start} → ${today})` };
}

export function computePreviousUsageWindow(
  options: UsageWindowOptions,
  current?: UsageWindow,
  today = todayString(),
): UsageWindow {
  const window = current ?? computeUsageWindow(options, today);
  return usagePeriodDefinition(options.period).previous(
    {
      today,
      from: options.from,
      to: options.to,
      n: options.n,
    },
    window,
  );
}

/**
 * Resolve a period to its window.
 *
 * Each period carries window, previous-window, and arg-parse functions, so
 * adding one is a single registry entry.
 */
export function computeUsageWindow(
  options: UsageWindowOptions,
  today = todayString(),
): UsageWindow {
  return usagePeriodDefinition(options.period).window({
    today,
    from: options.from,
    to: options.to,
    n: options.n,
  });
}

/** Periods whose window moves with "today". `date`, `range`, and `all` do not. */
export function periodAnchorsOnToday(period: UsagePeriod): boolean {
  return period !== 'date' && period !== 'range' && period !== 'all';
}

/**
 * Fails to compile if a `UsagePeriod` has no registry entry, or an entry names
 * a period the union does not declare — the two can no longer drift apart.
 */
type RegisteredPeriod = (typeof USAGE_PERIOD_DEFINITIONS)[number]['period'];
type AssertSame<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _everyPeriodIsRegistered: AssertSame<UsagePeriod, RegisteredPeriod> = true;
void _everyPeriodIsRegistered;

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

function parseDateString(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function formatDateString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function shiftDate(value: string, days: number): string {
  const date = parseDateString(value);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDateString(date);
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
    const currentEnd = parseDateString(current.end);
    const previousMonth = new Date(
      Date.UTC(currentEnd.getUTCFullYear(), currentEnd.getUTCMonth() - 1, 1),
    );
    const previousMonthEnd = new Date(
      Date.UTC(currentEnd.getUTCFullYear(), currentEnd.getUTCMonth(), 0),
    );
    const comparableDay = Math.min(currentEnd.getUTCDate(), previousMonthEnd.getUTCDate());
    const end = formatDateString(
      new Date(
        Date.UTC(previousMonth.getUTCFullYear(), previousMonth.getUTCMonth(), comparableDay),
      ),
    );
    const start = formatDateString(previousMonth);
    return { start, end, label: `previous month to date (${start} → ${end})` };
  }

  if (options.period === 'lastmonth') {
    const currentStart = parseDateString(current.start);
    const previousStart = new Date(
      Date.UTC(currentStart.getUTCFullYear(), currentStart.getUTCMonth() - 1, 1),
    );
    const previousEnd = new Date(
      Date.UTC(currentStart.getUTCFullYear(), currentStart.getUTCMonth(), 0),
    );
    const start = formatDateString(previousStart);
    const end = formatDateString(previousEnd);
    return { start, end, label: `month before (${start} → ${end})` };
  }

  if (options.period === 'year') {
    const today = new Date();
    const year = today.getFullYear() - 1;
    const previousMonthEnd = new Date(Date.UTC(year, today.getMonth() + 1, 0)).getUTCDate();
    const day = Math.min(today.getDate(), previousMonthEnd);
    const end = formatDateString(new Date(Date.UTC(year, today.getMonth(), day)));
    return {
      start: `${String(year)}-01-01`,
      end,
      label: `previous year to date (${String(year)}-01-01 → ${end})`,
    };
  }

  const days = inclusiveDayCount(current.start, current.end);
  const end = shiftDate(current.start, -1);
  const start = shiftDate(end, -(days - 1));
  return { start, end, label: `previous period (${start} → ${end})` };
}

export function computeUsageWindow(options: UsageWindowOptions): UsageWindow {
  const today = new Date();
  const todayString = toLocalDateString(today);

  /** The n days ending today, inclusive — what `last`, `week` and `month` all are. */
  const rollingWindow = (n: number): UsageWindow => {
    const from = new Date(today);
    from.setDate(today.getDate() - (n - 1));
    const start = toLocalDateString(from);
    return { start, end: todayString, label: `last ${String(n)} days (${start} → ${todayString})` };
  };

  switch (options.period) {
    case 'today': {
      const localDate = today.toLocaleDateString();
      const localTime = today.toLocaleTimeString();
      return { start: todayString, end: todayString, label: `today (${localDate} ${localTime})` };
    }

    case 'yesterday': {
      const d = new Date(today);
      d.setDate(d.getDate() - 1);
      const s = toLocalDateString(d);
      return { start: s, end: s, label: `yesterday (${s})` };
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
      const daysFromMon = (today.getDay() + 6) % 7;
      const mon = new Date(today);
      mon.setDate(today.getDate() - daysFromMon);
      const start = toLocalDateString(mon);
      return { start, end: todayString, label: `this week (${start} → ${todayString})` };
    }

    case 'lastweek': {
      const daysFromMon = (today.getDay() + 6) % 7;
      const thisMon = new Date(today);
      thisMon.setDate(today.getDate() - daysFromMon);
      const lastSun = new Date(thisMon);
      lastSun.setDate(thisMon.getDate() - 1);
      const lastMon = new Date(thisMon);
      lastMon.setDate(thisMon.getDate() - 7);
      const start = toLocalDateString(lastMon);
      const end = toLocalDateString(lastSun);
      return { start, end, label: `last week (${start} → ${end})` };
    }

    case 'thismonth': {
      const start = toLocalDateString(new Date(today.getFullYear(), today.getMonth(), 1));
      return { start, end: todayString, label: `this month (${start} → ${todayString})` };
    }

    case 'lastmonth': {
      const firstDay = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const lastDay = new Date(today.getFullYear(), today.getMonth(), 0);
      const start = toLocalDateString(firstDay);
      const end = toLocalDateString(lastDay);
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
      const year = today.getFullYear();
      return { start: `${year}-01-01`, end: `${year}-12-31`, label: String(year) };
    }

    case 'all':
      return { start: '0000-01-01', end: '9999-12-31', label: 'all time' };
  }
}

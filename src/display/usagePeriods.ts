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

/**
 * Periods that need no extra arguments (unlike `date`/`range`/`last`). These are
 * the only periods the `export` command accepts.
 */
export const NO_ARG_PERIODS = [
  'today',
  'yesterday',
  'thisweek',
  'lastweek',
  'week',
  'thismonth',
  'lastmonth',
  'month',
  'year',
  'all',
] as const satisfies readonly UsagePeriod[];

export type NoArgPeriod = (typeof NO_ARG_PERIODS)[number];

export function isNoArgPeriod(value: string): value is NoArgPeriod {
  return (NO_ARG_PERIODS as readonly string[]).includes(value);
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

export function computeUsageWindow(opts: UsageWindowOptions): UsageWindow {
  const today = new Date();
  const todayStr = toLocalDateString(today);

  switch (opts.period) {
    case 'today': {
      const localDate = today.toLocaleDateString();
      const localTime = today.toLocaleTimeString();
      return { start: todayStr, end: todayStr, label: `today (${localDate} ${localTime})` };
    }

    case 'yesterday': {
      const d = new Date(today);
      d.setDate(d.getDate() - 1);
      const s = toLocalDateString(d);
      return { start: s, end: s, label: `yesterday (${s})` };
    }

    case 'date': {
      if (!opts.from) throw new Error('from is required for date period');
      return { start: opts.from, end: opts.from, label: opts.from };
    }

    case 'range': {
      if (!opts.from || !opts.to) throw new Error('from and to are required for range period');
      return { start: opts.from, end: opts.to, label: `${opts.from} → ${opts.to}` };
    }

    case 'thisweek': {
      const daysFromMon = (today.getDay() + 6) % 7;
      const mon = new Date(today);
      mon.setDate(today.getDate() - daysFromMon);
      const start = toLocalDateString(mon);
      return { start, end: todayStr, label: `this week (${start} → ${todayStr})` };
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
      const y = today.getFullYear();
      const m = String(today.getMonth() + 1).padStart(2, '0');
      const start = `${y}-${m}-01`;
      return { start, end: todayStr, label: `this month (${start} → ${todayStr})` };
    }

    case 'lastmonth': {
      const firstDay = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const lastDay = new Date(today.getFullYear(), today.getMonth(), 0);
      const start = toLocalDateString(firstDay);
      const end = toLocalDateString(lastDay);
      return { start, end, label: `last month (${start} → ${end})` };
    }

    case 'last': {
      if (!opts.n) throw new Error('n is required for last period');
      const d = new Date(today);
      d.setDate(today.getDate() - (opts.n - 1));
      const start = toLocalDateString(d);
      return { start, end: todayStr, label: `last ${opts.n} days (${start} → ${todayStr})` };
    }

    case 'week': {
      const d = new Date(today);
      d.setDate(today.getDate() - 6);
      const start = toLocalDateString(d);
      return { start, end: todayStr, label: `last 7 days (${start} → ${todayStr})` };
    }

    case 'month': {
      const d = new Date(today);
      d.setDate(today.getDate() - 29);
      const start = toLocalDateString(d);
      return { start, end: todayStr, label: `last 30 days (${start} → ${todayStr})` };
    }

    case 'year': {
      const year = today.getFullYear();
      return { start: `${year}-01-01`, end: `${year}-12-31`, label: `${year}` };
    }

    case 'all':
      return { start: '0000-01-01', end: '9999-12-31', label: 'all time' };
  }
}

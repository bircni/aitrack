import { toLocalDateString } from '../../data/dayMap.js';
import type { DayMap } from '../../data/types.js';
import { HEATMAP_WEEKS, MS_PER_DAY, RECENT_WINDOW_DAYS } from './constants.js';

export const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

function dateKey(d: Date): string {
  return toLocalDateString(d);
}

function hasActivity(dayMap: DayMap, key: string): boolean {
  const v = dayMap.get(key);
  return v !== undefined && v.inputTokens + v.outputTokens > 0;
}

export function currentStreak(dayMap: DayMap): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const current = new Date(today);
  // Today is still in progress. Counting from it would report 0 all morning
  // and then jump to the full streak after the first request of the day, so
  // start from yesterday when today has no activity yet.
  if (!hasActivity(dayMap, dateKey(current))) {
    current.setDate(current.getDate() - 1);
  }
  let streak = 0;
  while (hasActivity(dayMap, dateKey(current))) {
    streak++;
    current.setDate(current.getDate() - 1);
  }
  return streak;
}

export function longestStreak(dayMap: DayMap): number {
  const activeDates = [...dayMap]
    .filter(([, v]) => v.inputTokens + v.outputTokens > 0)
    .map(([d]) => d)
    .toSorted((a, b) => a.localeCompare(b));
  if (activeDates.length === 0) return 0;

  let longest = 1;
  let current = 1;
  for (let index = 1; index < activeDates.length; index++) {
    const previous = new Date(`${activeDates[index - 1]}T12:00:00`);
    const current_ = new Date(`${activeDates[index]}T12:00:00`);
    const diffDays = Math.round((current_.getTime() - previous.getTime()) / MS_PER_DAY);
    if (diffDays === 1) {
      current++;
      longest = Math.max(longest, current);
    } else if (diffDays > 1) {
      current = 1;
    }
  }
  return longest;
}

export function peakMonth(dayMap: DayMap): { month: string; tokens: number } | null {
  const months = new Map<string, number>();
  for (const [date, day] of dayMap) {
    const total = day.inputTokens + day.outputTokens;
    if (total === 0) continue;
    const month = date.slice(0, 7);
    months.set(month, (months.get(month) ?? 0) + total);
  }
  let best: { month: string; tokens: number } | null = null;
  for (const [month, tokens] of months) {
    if (!best || tokens > best.tokens) best = { month, tokens };
  }
  return best;
}

interface ModelTop {
  model: string;
  tokens: number;
}
interface PeakDay {
  date: string;
  tokens: number;
}
export interface ModelStats {
  topAllTime: ModelTop | null;
  topRecent: ModelTop | null;
  peak: PeakDay | null;
}

function recentWindowStart(): string {
  const d = new Date();
  d.setDate(d.getDate() - RECENT_WINDOW_DAYS);
  return toLocalDateString(d);
}

function bumpModelTotal(
  table: Map<string, number>,
  model: string,
  delta: number,
  track: ModelTop | null,
): ModelTop {
  const next = (table.get(model) ?? 0) + delta;
  table.set(model, next);
  if (!track || next > track.tokens || (next === track.tokens && model < track.model)) {
    return { model, tokens: next };
  }
  return track;
}

export function computeModelStats(dayMap: DayMap): ModelStats {
  const since = recentWindowStart();
  const allTime = new Map<string, number>();
  const recent = new Map<string, number>();
  let topAll: ModelTop | null = null;
  let topRec: ModelTop | null = null;
  let peak: PeakDay | null = null;

  for (const [date, data] of dayMap) {
    const dayTotal = data.inputTokens + data.outputTokens;
    if (dayTotal > 0 && (!peak || dayTotal > peak.tokens)) {
      peak = { date, tokens: dayTotal };
    }
    const isRecent = date >= since;
    for (const [model, counts] of Object.entries(data.byModel)) {
      const tokens = counts.inputTokens + counts.outputTokens;
      if (tokens === 0) continue;
      topAll = bumpModelTotal(allTime, model, tokens, topAll);
      if (isRecent) topRec = bumpModelTotal(recent, model, tokens, topRec);
    }
  }

  return { topAllTime: topAll, topRecent: topRec, peak };
}

export function formatPeakDate(date: string): string {
  const [y = '', m = '', d = ''] = date.split('-');
  const monthIndex = Number.parseInt(m, 10) - 1;
  return `${MONTHS[monthIndex] ?? m} ${String(Number.parseInt(d, 10))}, ${y}`;
}

export function formatMonthLabel(month: string): string {
  const [y = '', m = ''] = month.split('-');
  const monthIndex = Number.parseInt(m, 10) - 1;
  return `${MONTHS[monthIndex] ?? m} ${y}`;
}

export function buildDateGrid(year?: number): Array<Array<string | null>> {
  if (year !== undefined) {
    return buildYearGrid(year);
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - today.getDay() - HEATMAP_WEEKS * 7);
  const weeks: Array<Array<string | null>> = [];
  const current = new Date(start);
  while (current <= today) {
    const week: Array<string | null> = [];
    for (let d = 0; d < 7; d++) {
      if (current <= today) {
        week.push(toLocalDateString(current));
      } else {
        week.push(null);
      }
      current.setDate(current.getDate() + 1);
    }
    weeks.push(week);
  }
  return weeks;
}

function buildYearGrid(year: number): Array<Array<string | null>> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(year, 0, 1);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay());
  const end = year === today.getFullYear() ? today : new Date(year, 11, 31);
  end.setHours(0, 0, 0, 0);

  const weeks: Array<Array<string | null>> = [];
  const current = new Date(start);
  do {
    const week: Array<string | null> = [];
    for (let d = 0; d < 7; d++) {
      if (current <= end && current.getFullYear() === year) {
        week.push(toLocalDateString(current));
      } else {
        week.push(null);
      }
      current.setDate(current.getDate() + 1);
    }
    weeks.push(week);
  } while (current <= end || current.getDay() !== 0);
  return weeks;
}

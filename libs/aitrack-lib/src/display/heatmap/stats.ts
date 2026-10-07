import { inclusiveDayCount, shiftDate, weekdayOf, yearOf } from '../../data/calendar.js';
import type { DayMap } from '../../data/types.js';
import { rollingWindow, todayString } from '../../data/usagePeriods.js';
import { HEATMAP_WEEKS, RECENT_WINDOW_DAYS } from './constants.js';

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

function hasActivity(dayMap: DayMap, key: string): boolean {
  const v = dayMap.get(key);
  return v !== undefined && v.inputTokens + v.outputTokens > 0;
}

export function currentStreak(dayMap: DayMap): number {
  const today = todayString();
  // Today is still in progress, so an idle today does not break the streak.
  let day = hasActivity(dayMap, today) ? today : shiftDate(today, -1);
  let streak = 0;
  while (hasActivity(dayMap, day)) {
    streak++;
    day = shiftDate(day, -1);
  }
  return streak;
}

export function longestStreak(dayMap: DayMap): number {
  const activeDates = [...dayMap]
    .filter(([, v]) => v.inputTokens + v.outputTokens > 0)
    .map(([d]) => d)
    .toSorted((a, b) => a.localeCompare(b));
  let longest = 0;
  let current = 0;
  let previous: string | undefined;
  for (const date of activeDates) {
    current = previous !== undefined && shiftDate(previous, 1) === date ? current + 1 : 1;
    longest = Math.max(longest, current);
    previous = date;
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
  const since = rollingWindow(todayString(), RECENT_WINDOW_DAYS).start;
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
  const today = todayString();
  let first: string;
  let last: string;
  if (year === undefined) {
    first = shiftDate(today, -weekdayOf(today) - HEATMAP_WEEKS * 7);
    last = today;
  } else {
    const yearKey = String(year).padStart(4, '0');
    first = `${yearKey}-01-01`;
    last = year === yearOf(today) ? today : `${yearKey}-12-31`;
  }
  const lead = weekdayOf(first);
  const end = lead + inclusiveDayCount(first, last); // Counted, not compared: past 9999 the keys stop sorting.
  return Array.from({ length: Math.ceil(end / 7) }, (_, week) =>
    Array.from({ length: 7 }, (_, weekday) => {
      const index = week * 7 + weekday;
      return index >= lead && index < end ? shiftDate(first, index - lead) : null;
    }),
  );
}

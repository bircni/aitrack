import { toLocalDateString } from '../../data/dayMap.js';
import type { DayMap } from '../../data/types.js';

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
  const cur = new Date(today);
  let streak = 0;
  for (;;) {
    if (!hasActivity(dayMap, dateKey(cur))) break;
    streak++;
    cur.setDate(cur.getDate() - 1);
  }
  return streak;
}

export function longestStreak(dayMap: DayMap): number {
  const activeDates = [...dayMap.entries()]
    .filter(([, v]) => v.inputTokens + v.outputTokens > 0)
    .map(([d]) => d)
    .sort();
  if (activeDates.length === 0) return 0;

  let longest = 1;
  let current = 1;
  for (let i = 1; i < activeDates.length; i++) {
    const prev = new Date(`${activeDates[i - 1]}T12:00:00`);
    const cur = new Date(`${activeDates[i]}T12:00:00`);
    const diffDays = Math.round((cur.getTime() - prev.getTime()) / 86_400_000);
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

function since30Days(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return toLocalDateString(d);
}

export function computeModelStats(dayMap: DayMap): ModelStats {
  const since = since30Days();
  const allTime = new Map<string, number>();
  const recent = new Map<string, number>();
  let topAll: ModelTop | null = null;
  let topRec: ModelTop | null = null;
  let peak: PeakDay | null = null;

  const bump = (
    table: Map<string, number>,
    model: string,
    delta: number,
    track: ModelTop | null,
  ): ModelTop => {
    const next = (table.get(model) ?? 0) + delta;
    table.set(model, next);
    if (!track || next > track.tokens || (next === track.tokens && model < track.model)) {
      return { model, tokens: next };
    }
    return track;
  };

  for (const [date, data] of dayMap) {
    const dayTotal = data.inputTokens + data.outputTokens;
    if (dayTotal > 0 && (!peak || dayTotal > peak.tokens)) {
      peak = { date, tokens: dayTotal };
    }
    const isRecent = date >= since;
    for (const [model, counts] of Object.entries(data.byModel)) {
      const tokens = counts.inputTokens + counts.outputTokens;
      if (tokens === 0) continue;
      topAll = bump(allTime, model, tokens, topAll);
      if (isRecent) topRec = bump(recent, model, tokens, topRec);
    }
  }

  return { topAllTime: topAll, topRecent: topRec, peak };
}

export function formatPeakDate(date: string): string {
  const [y = '', m = '', d = ''] = date.split('-');
  const monthIdx = parseInt(m, 10) - 1;
  return `${MONTHS[monthIdx] ?? m} ${parseInt(d, 10)}, ${y}`;
}

export function formatMonthLabel(month: string): string {
  const [y = '', m = ''] = month.split('-');
  const monthIdx = parseInt(m, 10) - 1;
  return `${MONTHS[monthIdx] ?? m} ${y}`;
}

export function buildHeatmapWeeks(year?: number): Array<Array<string | null>> {
  return buildDateGrid(year);
}

export function buildDateGrid(year?: number): Array<Array<string | null>> {
  if (year !== undefined) {
    return buildYearGrid(year);
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - today.getDay() - 52 * 7);
  const weeks: Array<Array<string | null>> = [];
  const cur = new Date(start);
  while (cur <= today) {
    const week: Array<string | null> = [];
    for (let d = 0; d < 7; d++) {
      if (cur <= today) {
        week.push(toLocalDateString(cur));
      } else {
        week.push(null);
      }
      cur.setDate(cur.getDate() + 1);
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
  const cur = new Date(start);
  do {
    const week: Array<string | null> = [];
    for (let d = 0; d < 7; d++) {
      if (cur <= end && cur.getFullYear() === year) {
        week.push(toLocalDateString(cur));
      } else {
        week.push(null);
      }
      cur.setDate(cur.getDate() + 1);
    }
    weeks.push(week);
  } while (cur <= end || cur.getDay() !== 0);
  return weeks;
}

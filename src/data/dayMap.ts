import type { DayEntry, DayMap, ProviderData } from './types.js';

export function getOrCreateDay(dayMap: DayMap, date: string): DayEntry {
  let day = dayMap.get(date);
  if (day === undefined) {
    day = { inputTokens: 0, outputTokens: 0, byModel: {} };
    dayMap.set(date, day);
  }
  return day;
}

export function toLocalDateString(ts: string | Date): string {
  const d = typeof ts === 'string' ? new Date(ts) : ts;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Day key for a timestamp, or null when it cannot be parsed.
 *
 * toLocalDateString on an unparseable value yields the string "NaN-NaN-NaN",
 * which is a perfectly usable Map key: it would be written to the synced
 * machine file, counted in all-time totals, and skipped by every year or
 * window filter. Readers use this instead so bad input is dropped at the edge.
 */
export function tryLocalDateString(ts: string | Date): string | null {
  const d = typeof ts === 'string' ? new Date(ts) : ts;
  return Number.isNaN(d.getTime()) ? null : toLocalDateString(d);
}

export function filterDayMapByYear(dayMap: DayMap, year: number): DayMap {
  const prefix = `${year}-`;
  return new Map([...dayMap].filter(([date]) => date.startsWith(prefix)));
}

export function filterProviderDataByYear(data: ProviderData, year: number): ProviderData {
  const filtered: ProviderData = {};
  for (const [providerKey, dayMap] of Object.entries(data)) {
    const next = filterDayMapByYear(dayMap, year);
    if (next.size > 0) filtered[providerKey] = next;
  }
  return filtered;
}

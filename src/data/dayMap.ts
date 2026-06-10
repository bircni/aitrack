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

import type { UsageDay } from './types';

export function YearHeatmap({ days }: { days: UsageDay[] }) {
  const year = new Date().getFullYear();
  const totals = new Map<string, number>();
  for (const day of days) {
    if (!day.day.startsWith(String(year))) continue;
    totals.set(day.day, (totals.get(day.day) ?? 0) + day.costUsd);
  }
  const values = [...totals.values()].filter((value) => value > 0).toSorted((a, b) => a - b);
  const p90 = values[Math.floor(values.length * 0.9)] ?? 1;
  const start = new Date(year, 0, 1);
  const startWeekday = start.getDay();
  const cells: Array<{ date: string; cost: number }> = [];
  for (let index = 0; index < 371; index += 1) {
    const date = new Date(year, 0, 1 - startWeekday + index);
    if (date.getFullYear() !== year) {
      cells.push({ date: '', cost: 0 });
      continue;
    }
    const key = `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    cells.push({ date: key, cost: totals.get(key) ?? 0 });
  }
  const weeks: Array<Array<{ date: string; cost: number }>> = [];
  for (let index = 0; index < cells.length; index += 7) weeks.push(cells.slice(index, index + 7));

  return (
    <div className="flex gap-[3px]" aria-label={`${String(year)} cost heatmap`}>
      {weeks.map((week, weekIndex) => (
        <div key={weekIndex} className="flex flex-col gap-[3px]">
          {week.map((cell, dayIndex) => {
            const strength = cell.cost <= 0 || cell.date === '' ? 0 : Math.min(1, cell.cost / p90);
            return (
              <div
                key={`${String(weekIndex)}-${String(dayIndex)}`}
                title={cell.date === '' ? '' : `${cell.date}  $${cell.cost.toFixed(2)}`}
                className="h-[11px] w-[11px] rounded-[3px]"
                style={{
                  background:
                    cell.date === ''
                      ? 'transparent'
                      : `color-mix(in oklch, var(--claude) ${String(Math.round(18 + strength * 78))}%, oklch(1 0 0 / 0.08))`,
                }}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

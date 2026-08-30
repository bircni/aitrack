import { aggregateModelsByDayMap } from '../../data/aggregate.js';
import { toLocalDateString } from '../../data/dayMap.js';
import { compareByCostThenTokens } from '../../data/sort.js';
import type { DayMap, ProviderData } from '../../data/types.js';
import { fmt, fmtUSD, fmtUSDCost } from '../format.js';
import { tokenIntensityLevel } from '../heatmap/intensity.js';
import { displayModelName } from '../heatmap/modelNames.js';
import { MONTHS } from '../heatmap/stats.js';
import { getProviderTheme } from '../heatmap/themes.js';
import { buildProviderSectionViewModel } from '../heatmap/viewModel.js';
import { costColumnLabel, providerLabel } from '../providers.js';
import { escapeHtml } from './escape.js';

function renderMonthLabels(weeks: Array<Array<string | null>>): string {
  let lastMonth = -1;
  const labels: string[] = [];
  for (const [w, week] of weeks.entries()) {
    const first = week.find((d) => d !== null);
    if (!first) continue;
    const month = Number.parseInt(first.slice(5, 7), 10) - 1;
    if (month !== lastMonth) {
      labels.push(
        `<span class="month-label" style="grid-column:${String(w + 1)}">${escapeHtml(MONTHS[month] ?? '')}</span>`,
      );
      lastMonth = month;
    }
  }
  return labels.join('');
}

function renderHeatmapCells(
  providerKey: string,
  dayMap: DayMap,
  weeks: Array<Array<string | null>>,
  maxTokens: number,
  dark: boolean,
): string {
  const theme = getProviderTheme(providerKey, dark);
  const cells: string[] = [];
  for (const [w, week] of weeks.entries()) {
    for (let d = 0; d < 7; d++) {
      const dateString = week[d] ?? null;
      const rec = dateString ? dayMap.get(dateString) : null;
      const tokens = rec ? rec.inputTokens + rec.outputTokens : 0;
      const level = dateString ? tokenIntensityLevel(tokens, maxTokens) : 0;
      const color = theme.cells[level];
      const title =
        dateString && tokens > 0 ? `${dateString} — ${fmt(tokens)} tokens` : (dateString ?? '');
      const style = `grid-column:${String(w + 1)};grid-row:${String(d + 1)};background:${color}`;
      const titleAttribute = title ? ` title="${escapeHtml(title)}"` : '';
      cells.push(`<div class="cell"${titleAttribute} style="${style}"></div>`);
    }
  }
  return cells.join('');
}

function renderLegend(providerKey: string, dark: boolean): string {
  const theme = getProviderTheme(providerKey, dark);
  return theme.cells
    .map((color) => `<span class="legend-cell" style="background:${color}"></span>`)
    .join('');
}

export function renderTodaySection(providerData: ProviderData): string {
  const today = toLocalDateString(new Date());
  interface TodayRow {
    name: string;
    inputTokens: number;
    outputTokens: number;
    cost: number;
    hasCost: boolean;
  }

  const rows: TodayRow[] = [];
  for (const [key, dayMap] of Object.entries(providerData)) {
    const day = dayMap.get(today);
    if (!day) continue;
    rows.push({
      name: providerLabel(key),
      inputTokens: day.inputTokens,
      outputTokens: day.outputTokens,
      cost: day.costUSD ?? 0,
      hasCost: day.costUSD !== undefined,
    });
  }

  if (rows.length === 0) {
    return `<section class="today-section">
  <div class="today-header"><h2>Today</h2><span class="today-date">${escapeHtml(today)}</span></div>
  <p class="today-empty">No usage recorded yet today.</p>
</section>`;
  }

  rows.sort(
    (a, b) => b.cost - a.cost || b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
  );

  const totalIn = rows.reduce((s, r) => s + r.inputTokens, 0);
  const totalOut = rows.reduce((s, r) => s + r.outputTokens, 0);
  const totalCost = rows.reduce((s, r) => s + r.cost, 0);
  const isAnyCost = rows.some((r) => r.hasCost);

  const cards = rows
    .map(
      (r) =>
        `<div class="today-card"><div class="today-card-name">${escapeHtml(r.name)}</div><div class="today-card-tokens">${escapeHtml(fmt(r.inputTokens + r.outputTokens))}<span class="today-card-unit"> tokens</span></div><div class="today-card-cost">${escapeHtml(r.hasCost ? fmtUSDCost(r.cost) : '—')}</div></div>`,
    )
    .join('');

  const totalLine = `<div class="today-totals"><span><strong>${escapeHtml(fmt(totalIn + totalOut))}</strong> tokens total</span><span><strong>${escapeHtml(fmt(totalIn))}</strong> in / <strong>${escapeHtml(fmt(totalOut))}</strong> out</span>${isAnyCost ? `<span><strong>${escapeHtml(fmtUSDCost(totalCost))}</strong> est. cost</span>` : ''}</div>`;

  return `<section class="today-section">
  <div class="today-header"><h2>Today</h2><span class="today-date">${escapeHtml(today)}</span></div>
  <div class="today-cards">${cards}</div>
  ${totalLine}
</section>`;
}

function renderUsageTable(providerKey: string, dayMap: DayMap): string {
  const byModel = aggregateModelsByDayMap(dayMap);
  const rows = [...byModel]
    .map(([model, agg]) => ({
      model,
      tokens: agg.inputTokens + agg.outputTokens,
      cost: agg.costUSD,
      hasCost: agg.hasCost,
    }))
    .filter((r) => r.tokens > 0 || r.hasCost)
    .toSorted((a, b) => compareByCostThenTokens(a, b));

  if (rows.length === 0) return '';

  const isAnyCost = rows.some((r) => r.hasCost);
  const totalTokens = rows.reduce((s, r) => s + r.tokens, 0);
  const totalCost = rows.reduce((s, r) => s + r.cost, 0);
  const costLabel = costColumnLabel(providerKey);

  const bodyRows = rows
    .map(
      (r) =>
        `<tr><td>${escapeHtml(displayModelName(r.model))}</td><td class="num">${escapeHtml(fmt(r.tokens))}</td><td class="num">${escapeHtml(r.hasCost ? fmtUSD(r.cost) : '—')}</td></tr>`,
    )
    .join('');

  return `<details class="usage-table" open>
  <summary>Usage by model</summary>
  <table>
    <thead><tr><th>Model</th><th class="num">Tokens</th><th class="num">${escapeHtml(costLabel)}</th></tr></thead>
    <tbody>${bodyRows}</tbody>
    <tfoot><tr><td>Total</td><td class="num">${escapeHtml(fmt(totalTokens))}</td><td class="num">${escapeHtml(isAnyCost ? fmtUSD(totalCost) : '—')}</td></tr></tfoot>
  </table>
</details>`;
}

export function renderProviderSection(
  providerKey: string,
  dayMap: DayMap,
  weeks: Array<Array<string | null>>,
  dark: boolean,
): string {
  const vm = buildProviderSectionViewModel(providerKey, dayMap);

  const statHtml = vm.headerStats
    .map(
      (col) =>
        `<div class="stat-col"><div class="stat-label">${escapeHtml(col.label)}</div><div class="stat-value">${escapeHtml(col.value)}</div></div>`,
    )
    .join('');

  const bottomHtml = vm.bottomStats
    .map(
      (stat) =>
        `<div class="bottom-stat"><div class="stat-label">${escapeHtml(stat.label)}</div><div class="stat-value-sm">${escapeHtml(stat.value)}${stat.sub === undefined ? '' : ` <span class="stat-sub">${escapeHtml(stat.sub)}</span>`}</div></div>`,
    )
    .join('');

  return `<section class="provider-section">
  <div class="section-header">
    <h2>${escapeHtml(vm.name)}</h2>
    <div class="header-stats">${statHtml}</div>
  </div>
  <div class="heatmap-wrap">
    <div class="day-labels">
      <span style="grid-row:2">Mon</span>
      <span style="grid-row:4">Wed</span>
      <span style="grid-row:6">Fri</span>
    </div>
    <div class="heatmap-area" style="--weeks:${String(Math.max(53, weeks.length))}">
      <div class="month-row">${renderMonthLabels(weeks)}</div>
      <div class="heatmap-grid">${renderHeatmapCells(providerKey, dayMap, weeks, vm.maxTokens, dark)}</div>
      <div class="legend">
        <span class="legend-label">LESS</span>
        ${renderLegend(providerKey, dark)}
        <span class="legend-label">MORE</span>
      </div>
    </div>
  </div>
  <div class="bottom-stats">${bottomHtml}</div>
  ${renderUsageTable(providerKey, dayMap)}
</section>`;
}

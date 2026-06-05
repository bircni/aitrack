import { filterProviderDataByYear } from './dayMap.js';
import type { DayMap, ProviderData, RenderOptions } from './types.js';
import {
  buildHeatmapWeeks,
  computeModelStats,
  currentStreak,
  displayModelName,
  fmt,
  fmtUSD,
  formatMonthLabel,
  formatPeakDate,
  getProviderTheme,
  longestStreak,
  mergeAllProviderDayMaps,
  MONTHS,
  peakMonth,
  percentile,
  PROVIDER_ORDER,
  tokenIntensityLevel,
} from './render.js';

export interface HtmlRenderOptions extends RenderOptions {
  lastUpdated?: Date;
  emptyMessage?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function activeProviders(layoutData: ProviderData, all: boolean): string[] {
  if (all) {
    return (layoutData.all?.size ?? 0) > 0 ? ['all'] : [];
  }
  const active = PROVIDER_ORDER.filter((k) => (layoutData[k]?.size ?? 0) > 0);
  for (const k of Object.keys(layoutData)) {
    if (!active.includes(k) && (layoutData[k]?.size ?? 0) > 0) active.push(k);
  }
  return active;
}

function renderMonthLabels(weeks: Array<Array<string | null>>): string {
  let lastMonth = -1;
  const labels: string[] = [];
  for (let w = 0; w < weeks.length; w++) {
    const first = weeks[w].find((d) => d !== null);
    if (!first) continue;
    const month = parseInt(first.slice(5, 7), 10) - 1;
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
  for (let w = 0; w < weeks.length; w++) {
    for (let d = 0; d < 7; d++) {
      const dateStr = weeks[w][d] ?? null;
      const rec = dateStr ? dayMap.get(dateStr) : null;
      const tokens = rec ? rec.inputTokens + rec.outputTokens : 0;
      const level = dateStr ? tokenIntensityLevel(tokens, maxTokens) : 0;
      const color = theme.cells[level];
      const title = dateStr && tokens > 0 ? `${dateStr} — ${fmt(tokens)} tokens` : (dateStr ?? '');
      const style = `grid-column:${String(w + 1)};grid-row:${String(d + 1)};background:${color}`;
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      cells.push(`<div class="cell"${titleAttr} style="${style}"></div>`);
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

interface ModelAgg {
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  hasCost: boolean;
}

function aggregateByModel(dayMap: DayMap): Map<string, ModelAgg> {
  const byModel = new Map<string, ModelAgg>();
  for (const day of dayMap.values()) {
    for (const [model, counts] of Object.entries(day.byModel)) {
      let agg = byModel.get(model);
      if (!agg) {
        agg = { inputTokens: 0, outputTokens: 0, costUSD: 0, hasCost: false };
        byModel.set(model, agg);
      }
      agg.inputTokens += counts.inputTokens;
      agg.outputTokens += counts.outputTokens;
      if (counts.costUSD !== undefined) {
        agg.costUSD += counts.costUSD;
        agg.hasCost = true;
      }
    }
  }
  return byModel;
}

function renderUsageTable(providerKey: string, dayMap: DayMap): string {
  const byModel = aggregateByModel(dayMap);
  const rows = [...byModel.entries()]
    .map(([model, agg]) => ({
      model,
      tokens: agg.inputTokens + agg.outputTokens,
      cost: agg.costUSD,
      hasCost: agg.hasCost,
    }))
    .filter((r) => r.tokens > 0 || r.hasCost)
    .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);

  if (rows.length === 0) return '';

  const anyCost = rows.some((r) => r.hasCost);
  const totalTokens = rows.reduce((s, r) => s + r.tokens, 0);
  const totalCost = rows.reduce((s, r) => s + r.cost, 0);

  const bodyRows = rows
    .map(
      (r) =>
        `<tr><td>${escapeHtml(displayModelName(r.model))}</td><td class="num">${escapeHtml(fmt(r.tokens))}</td><td class="num">${escapeHtml(r.hasCost ? fmtUSD(r.cost) : '—')}</td></tr>`,
    )
    .join('');

  const costLabel = providerKey === 'cursor' ? 'Cost' : 'Est. cost';

  return `<details class="usage-table" open>
  <summary>Usage by model</summary>
  <table>
    <thead><tr><th>Model</th><th class="num">Tokens</th><th class="num">${escapeHtml(costLabel)}</th></tr></thead>
    <tbody>${bodyRows}</tbody>
    <tfoot><tr><td>Total</td><td class="num">${escapeHtml(fmt(totalTokens))}</td><td class="num">${escapeHtml(anyCost ? fmtUSD(totalCost) : '—')}</td></tr></tfoot>
  </table>
</details>`;
}

function renderProviderSection(
  providerKey: string,
  dayMap: DayMap,
  weeks: Array<Array<string | null>>,
  dark: boolean,
): string {
  const theme = getProviderTheme(providerKey, dark);
  let totalIn = 0;
  let totalOut = 0;
  let totalCost = 0;
  let hasCost = false;
  const dayTotals: number[] = [];

  for (const v of dayMap.values()) {
    const total = v.inputTokens + v.outputTokens;
    if (total > 0) dayTotals.push(total);
    totalIn += v.inputTokens;
    totalOut += v.outputTokens;
    if (v.costUSD !== undefined) {
      totalCost += v.costUSD;
      hasCost = true;
    }
  }

  const maxTokens = percentile(dayTotals, 0.9) || 1;
  const costLabel = providerKey === 'cursor' ? 'COST' : 'EST. COST';
  const costValue = hasCost ? fmtUSD(totalCost) : '—';

  const { topAllTime, topRecent, peak } = computeModelStats(dayMap);
  const cs = currentStreak(dayMap);
  const ls = longestStreak(dayMap);
  const peakMo = peakMonth(dayMap);

  const bottomStats = [
    {
      label: 'MOST USED MODEL',
      value: topAllTime ? `${displayModelName(topAllTime.model)} (${fmt(topAllTime.tokens)})` : '—',
    },
    {
      label: 'RECENT USE (LAST 30 DAYS)',
      value: topRecent ? `${displayModelName(topRecent.model)} (${fmt(topRecent.tokens)})` : '—',
    },
    {
      label: 'PEAK DAY',
      value: peak ? `${formatPeakDate(peak.date)} (${fmt(peak.tokens)})` : '—',
    },
    {
      label: 'PEAK MONTH',
      value: peakMo ? `${formatMonthLabel(peakMo.month)} (${fmt(peakMo.tokens)})` : '—',
    },
    { label: 'CURRENT STREAK', value: `${String(cs)} day${cs !== 1 ? 's' : ''}` },
    { label: 'LONGEST STREAK', value: `${String(ls)} day${ls !== 1 ? 's' : ''}` },
  ];

  const statCols = [
    { label: 'INPUT TOKENS', value: fmt(totalIn) },
    { label: 'OUTPUT TOKENS', value: fmt(totalOut) },
    { label: 'TOTAL TOKENS', value: fmt(totalIn + totalOut) },
    { label: costLabel, value: costValue },
  ];

  const statHtml = statCols
    .map(
      (col) =>
        `<div class="stat-col"><div class="stat-label">${escapeHtml(col.label)}</div><div class="stat-value">${escapeHtml(col.value)}</div></div>`,
    )
    .join('');

  const bottomHtml = bottomStats
    .map(
      (stat) =>
        `<div class="bottom-stat"><div class="stat-label">${escapeHtml(stat.label)}</div><div class="stat-value-sm">${escapeHtml(stat.value)}</div></div>`,
    )
    .join('');

  return `<section class="provider-section">
  <div class="section-header">
    <h2>${escapeHtml(theme.name)}</h2>
    <div class="header-stats">${statHtml}</div>
  </div>
  <div class="heatmap-wrap">
    <div class="day-labels">
      <span style="grid-row:2">Mon</span>
      <span style="grid-row:4">Wed</span>
      <span style="grid-row:6">Fri</span>
    </div>
    <div class="heatmap-area">
      <div class="month-row">${renderMonthLabels(weeks)}</div>
      <div class="heatmap-grid">${renderHeatmapCells(providerKey, dayMap, weeks, maxTokens, dark)}</div>
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

function pageStyles(dark: boolean): string {
  const palette = dark
    ? {
        bg: '#0d1117',
        text: '#e6edf3',
        muted: '#7d8590',
        divider: '#30363d',
        sectionBg: '#161b22',
        tableHeaderBg: '#1f2630',
        tableRowAlt: '#1a2027',
      }
    : {
        bg: '#ffffff',
        text: '#1c1c1e',
        muted: '#888888',
        divider: '#e0e0e0',
        sectionBg: '#fafafa',
        tableHeaderBg: '#f0f0f0',
        tableRowAlt: '#f6f6f6',
      };

  return `:root {
  --bg: ${palette.bg};
  --text: ${palette.text};
  --muted: ${palette.muted};
  --divider: ${palette.divider};
  --section-bg: ${palette.sectionBg};
  --table-header-bg: ${palette.tableHeaderBg};
  --table-row-alt: ${palette.tableRowAlt};
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
  background: var(--bg);
  color: var(--text);
  padding: 24px;
  line-height: 1.4;
}
.page-header {
  margin-bottom: 24px;
  border-bottom: 1px solid var(--divider);
  padding-bottom: 16px;
}
.page-header h1 { font-size: 24px; font-weight: 700; }
.page-meta { color: var(--muted); font-size: 13px; margin-top: 6px; }
.empty-state {
  padding: 48px 24px;
  text-align: center;
  color: var(--muted);
  font-size: 15px;
}
.provider-section {
  background: var(--section-bg);
  border: 1px solid var(--divider);
  border-radius: 8px;
  padding: 24px;
  margin-bottom: 24px;
}
.section-header {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 16px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--divider);
}
.section-header h2 { font-size: 20px; font-weight: 700; }
.header-stats { display: flex; gap: 24px; flex-wrap: wrap; }
.stat-col { text-align: center; min-width: 90px; }
.stat-label { font-size: 9px; color: var(--muted); letter-spacing: 0.04em; }
.stat-value { font-size: 16px; font-weight: 700; margin-top: 4px; }
.stat-value-sm { font-size: 13px; font-weight: 700; margin-top: 4px; }
.heatmap-wrap { display: flex; gap: 8px; overflow-x: auto; }
.day-labels {
  display: grid;
  grid-template-rows: repeat(7, 12px);
  row-gap: 3px;
  font-size: 10px;
  color: var(--muted);
  padding-top: 28px;
  width: 28px;
  text-align: right;
  align-items: center;
}
.heatmap-area { flex: 1; min-width: 0; }
.month-row {
  display: grid;
  grid-template-columns: repeat(53, 12px);
  gap: 3px;
  height: 20px;
  margin-bottom: 8px;
  font-size: 11px;
  color: var(--muted);
}
.month-label { white-space: nowrap; }
.heatmap-grid {
  display: grid;
  grid-template-columns: repeat(53, 12px);
  grid-template-rows: repeat(7, 12px);
  gap: 3px;
}
.cell { width: 12px; height: 12px; border-radius: 2px; }
.legend {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 12px;
  font-size: 10px;
  color: var(--muted);
}
.legend-cell { width: 12px; height: 12px; border-radius: 2px; }
.legend-label { margin: 0 4px; }
.bottom-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--divider);
}
.bottom-stat .stat-label { margin-bottom: 4px; }
.usage-table {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--divider);
}
.usage-table summary {
  cursor: pointer;
  font-size: 11px;
  color: var(--muted);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  margin-bottom: 12px;
}
.usage-table table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.usage-table th, .usage-table td {
  padding: 6px 12px;
  text-align: left;
  border-bottom: 1px solid var(--divider);
}
.usage-table th {
  background: var(--table-header-bg);
  font-weight: 600;
  font-size: 11px;
  color: var(--muted);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.usage-table tbody tr:nth-child(even) { background: var(--table-row-alt); }
.usage-table tfoot td {
  font-weight: 700;
  border-top: 2px solid var(--divider);
  border-bottom: none;
}
.usage-table .num { text-align: right; font-variant-numeric: tabular-nums; }`;
}

function pageShell(title: string, dark: boolean, updatedLine: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en"${dark ? ' class="dark"' : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${pageStyles(dark)}</style>
</head>
<body>
<header class="page-header">
  <h1>${escapeHtml(title)}</h1>
  ${updatedLine ? `<p class="page-meta">${escapeHtml(updatedLine)}</p>` : ''}
</header>
${body}
</body>
</html>`;
}

export function renderToHtml(
  providerData: ProviderData,
  { dark = false, all = false, year, lastUpdated, emptyMessage }: HtmlRenderOptions = {},
): string {
  const filtered = year !== undefined ? filterProviderDataByYear(providerData, year) : providerData;
  const weeks = buildHeatmapWeeks(year);
  const layoutData: ProviderData = all ? { all: mergeAllProviderDayMaps(filtered) } : filtered;
  const providers = activeProviders(layoutData, all);

  const title = year !== undefined ? `aitrack (${String(year)})` : 'aitrack';
  const updatedLine = lastUpdated ? `Last updated: ${lastUpdated.toLocaleString()}` : '';

  if (providers.length === 0) {
    const message = emptyMessage ?? 'No usage data found.';
    return pageShell(
      title,
      dark,
      updatedLine,
      `<div class="empty-state">${escapeHtml(message)}</div>`,
    );
  }

  const sections = providers
    .map((key) => {
      const dayMap = layoutData[key];
      if (dayMap === undefined) return '';
      return renderProviderSection(key, dayMap, weeks, dark);
    })
    .join('');

  return pageShell(title, dark, updatedLine, sections);
}

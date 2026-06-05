import { filterProviderDataByYear } from './dayMap.js';
import type { DayMap, MachineFile, ProviderData, RenderOptions } from './types.js';
import {
  buildHeatmapWeeks,
  computeModelStats,
  currentStreak,
  displayModelName,
  formatMonthLabel,
  getProviderTheme,
  longestStreak,
  mergeAllProviderDayMaps,
  peakMonth,
  percentile,
  tokenIntensityLevel,
} from './render.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const PROVIDER_ORDER = ['claude_code', 'codex', 'cursor', 'gemini', 'opencode'];

export interface HtmlRenderOptions extends RenderOptions {
  lastUpdated?: Date;
  emptyMessage?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmt(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function fmtUSD(n: number): string {
  if (n > 0 && n < 0.01) return '<$0.01';
  return `$${n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatPeakDate(date: string): string {
  const [y, m, d] = date.split('-');
  const monthIdx = parseInt(m, 10) - 1;
  const monthShort = [
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
  ];
  return `${monthShort[monthIdx] ?? m} ${parseInt(d, 10)}, ${y}`;
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
      <span>Mon</span>
      <span>Wed</span>
      <span>Fri</span>
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
      }
    : {
        bg: '#ffffff',
        text: '#1c1c1e',
        muted: '#888888',
        divider: '#e0e0e0',
        sectionBg: '#fafafa',
      };

  return `:root {
  --bg: ${palette.bg};
  --text: ${palette.text};
  --muted: ${palette.muted};
  --divider: ${palette.divider};
  --section-bg: ${palette.sectionBg};
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
  display: flex;
  flex-direction: column;
  justify-content: space-around;
  font-size: 10px;
  color: var(--muted);
  padding-top: 28px;
  height: calc(28px + 7 * 15px);
  width: 28px;
  text-align: right;
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
.bottom-stat .stat-label { margin-bottom: 4px; }`;
}

export function renderToHtml(
  providerData: ProviderData,
  _machineData: MachineFile[],
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
<div class="empty-state">${escapeHtml(message)}</div>
</body>
</html>`;
  }

  const sections = providers
    .map((key) => {
      const dayMap = layoutData[key];
      if (dayMap === undefined) return '';
      return renderProviderSection(key, dayMap, weeks, dark);
    })
    .join('');

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
${sections}
</body>
</html>`;
}

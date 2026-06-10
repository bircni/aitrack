import { pagePalette } from '../heatmap/themes.js';

export function pageStyles(dark: boolean): string {
  const palette = pagePalette(dark);

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
  line-height: 1.4;
}
.page {
  max-width: 1100px;
  margin: 0 auto;
  padding: 24px;
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
  background: var(--section-bg);
  border: 1px dashed var(--divider);
  border-radius: 8px;
}
.empty-state p { max-width: 36em; margin: 0 auto; }
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
  border-collapse: collapse;
  font-size: 13px;
}
.usage-table th, .usage-table td { white-space: nowrap; }
.usage-table th:first-child, .usage-table td:first-child { padding-right: 48px; }
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
.usage-table .num { text-align: right; font-variant-numeric: tabular-nums; }
.today-section {
  background: var(--section-bg);
  border: 1px solid var(--divider);
  border-radius: 8px;
  padding: 20px 24px;
  margin-bottom: 24px;
}
.today-header {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 16px;
}
.today-header h2 { font-size: 18px; font-weight: 700; }
.today-date { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
.today-empty { color: var(--muted); font-size: 14px; }
.today-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
  margin-bottom: 14px;
}
.today-card {
  border: 1px solid var(--divider);
  border-radius: 6px;
  padding: 12px 14px;
  background: var(--bg);
}
.today-card-name {
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 6px;
}
.today-card-tokens {
  font-size: 18px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.today-card-unit { font-size: 11px; font-weight: 400; color: var(--muted); }
.today-card-cost {
  margin-top: 4px;
  font-size: 13px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.today-totals {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  padding-top: 12px;
  border-top: 1px solid var(--divider);
  font-size: 13px;
  color: var(--muted);
}
.today-totals strong { color: var(--text); font-variant-numeric: tabular-nums; }`;
}

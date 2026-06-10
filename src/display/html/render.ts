import { filterProviderDataByYear } from '../../data/dayMap.js';
import type { ProviderData, RenderOptions } from '../../data/types.js';
import { mergeAllProviderDayMaps } from '../heatmap/merge.js';
import { buildHeatmapWeeks } from '../heatmap/stats.js';
import { activeProviderKeys } from '../providers.js';
import { escapeHtml } from './escape.js';
import { renderProviderSection, renderTodaySection } from './sections.js';
import { pageStyles } from './styles.js';

export interface HtmlRenderOptions extends RenderOptions {
  lastUpdated?: Date;
  emptyMessage?: string;
  /** When set (e.g. by the daemon), adds a browser refresh meta tag. */
  refreshIntervalSeconds?: number;
}

function formatRefreshHint(seconds: number): string {
  if (seconds < 60) return `every ${String(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? 'every minute' : `every ${String(minutes)} minutes`;
}

function pageShell(
  title: string,
  dark: boolean,
  metaLines: string[],
  body: string,
  refreshIntervalSeconds?: number,
): string {
  const refreshMeta =
    refreshIntervalSeconds !== undefined && refreshIntervalSeconds > 0
      ? `<meta http-equiv="refresh" content="${String(refreshIntervalSeconds)}">\n`
      : '';
  const metaHtml = metaLines
    .filter((line) => line.length > 0)
    .map((line) => `<p class="page-meta">${escapeHtml(line)}</p>`)
    .join('\n  ');

  return `<!DOCTYPE html>
<html lang="en"${dark ? ' class="dark"' : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refreshMeta}<title>${escapeHtml(title)}</title>
<style>${pageStyles(dark)}</style>
</head>
<body>
<div class="page">
<header class="page-header">
  <h1>${escapeHtml(title)}</h1>
  ${metaHtml}
</header>
${body}
</div>
</body>
</html>`;
}

export function renderToHtml(
  providerData: ProviderData,
  {
    dark = false,
    all = false,
    year,
    lastUpdated,
    emptyMessage,
    refreshIntervalSeconds,
  }: HtmlRenderOptions = {},
): string {
  const filtered = year === undefined ? providerData : filterProviderDataByYear(providerData, year);
  const weeks = buildHeatmapWeeks(year);
  const layoutData: ProviderData = all ? { all: mergeAllProviderDayMaps(filtered) } : filtered;
  const providers = all
    ? (layoutData.all?.size ?? 0) > 0
      ? ['all']
      : []
    : activeProviderKeys(layoutData);

  const title = year === undefined ? 'aitrack' : `aitrack (${String(year)})`;
  const metaLines: string[] = [];
  if (lastUpdated) metaLines.push(`Last updated: ${lastUpdated.toLocaleString()}`);
  if (refreshIntervalSeconds !== undefined && refreshIntervalSeconds > 0) {
    metaLines.push(`Auto-refreshes ${formatRefreshHint(refreshIntervalSeconds)}`);
  }
  if (providers.length > 0) {
    const label = providers.length === 1 ? '1 provider' : `${String(providers.length)} providers`;
    metaLines.push(`Showing ${label}${year === undefined ? '' : ` in ${String(year)}`}`);
  }

  if (providers.length === 0) {
    const message = emptyMessage ?? 'No usage data found.';
    return pageShell(
      title,
      dark,
      metaLines,
      `<div class="empty-state"><p>${escapeHtml(message)}</p></div>`,
      refreshIntervalSeconds,
    );
  }

  const todayHtml = renderTodaySection(layoutData, dark);

  const sections = providers
    .map((key) => {
      const dayMap = layoutData[key];
      if (dayMap === undefined) return '';
      return renderProviderSection(key, dayMap, weeks, dark);
    })
    .join('');

  return pageShell(title, dark, metaLines, todayHtml + sections, refreshIntervalSeconds);
}

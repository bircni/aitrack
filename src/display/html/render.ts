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
<div class="page">
<header class="page-header">
  <h1>${escapeHtml(title)}</h1>
  ${updatedLine ? `<p class="page-meta">${escapeHtml(updatedLine)}</p>` : ''}
</header>
${body}
</div>
</body>
</html>`;
}

export function renderToHtml(
  providerData: ProviderData,
  { dark = false, all = false, year, lastUpdated, emptyMessage }: HtmlRenderOptions = {},
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

  const todayHtml = renderTodaySection(providerData, dark);

  const sections = providers
    .map((key) => {
      const dayMap = layoutData[key];
      if (dayMap === undefined) return '';
      return renderProviderSection(key, dayMap, weeks, dark);
    })
    .join('');

  return pageShell(title, dark, updatedLine, todayHtml + sections);
}

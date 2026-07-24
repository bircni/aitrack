import { formatUsageEmptyMessage } from '../../data/emptyState.js';
import type { ProviderData, RenderOptions } from '../../data/types.js';
import { resolveProviderLayout } from '../heatmap/layout.js';
import { buildHeatmapWeeks } from '../heatmap/stats.js';
import { escapeHtml } from './escape.js';
import { renderProviderSection, renderTodaySection } from './sections.js';
import { pageStyles } from './styles.js';

export interface HtmlRenderOptions extends RenderOptions {
  lastUpdated?: Date;
  emptyMessage?: string;
  /** When set (e.g. by the daemon), adds a browser refresh meta tag. */
  refreshIntervalSeconds?: number;
  operationalStatus?: HtmlOperationalStatus;
}

export interface HtmlOperationalStatus {
  refreshInProgress: boolean;
  syncEnabled: boolean;
  lastRefreshSuccessAt: string | null;
  lastSyncSuccessAt: string | null;
  nextRefreshAt: string | null;
  lastError: {
    phase: 'sync' | 'refresh';
    message: string;
    at: string;
  } | null;
}

function formatRefreshHint(seconds: number): string {
  if (seconds < 60) return `every ${String(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? 'every minute' : `every ${String(minutes)} minutes`;
}

function formatStatusTime(value: string): string {
  return new Date(value).toLocaleString();
}

function renderOperationalStatus(status: HtmlOperationalStatus | undefined): string {
  if (status === undefined) return '';

  const state = status.refreshInProgress
    ? 'Refreshing'
    : status.lastError
      ? 'Degraded'
      : status.lastRefreshSuccessAt
        ? 'Healthy'
        : 'Starting';
  const stateClass = status.lastError
    ? 'degraded'
    : status.refreshInProgress
      ? 'active'
      : 'healthy';
  const details: string[] = [];
  if (status.lastRefreshSuccessAt) {
    details.push(`Last refresh: ${formatStatusTime(status.lastRefreshSuccessAt)}`);
  }
  if (status.syncEnabled) {
    details.push(
      status.lastSyncSuccessAt
        ? `Last sync: ${formatStatusTime(status.lastSyncSuccessAt)}`
        : 'Sync: waiting for first success',
    );
  } else {
    details.push('Sync: disabled');
  }
  if (status.nextRefreshAt) {
    details.push(`Next refresh: ${formatStatusTime(status.nextRefreshAt)}`);
  }
  const errorHtml =
    status.lastError === null
      ? ''
      : `<p class="daemon-status-error" role="alert">Last ${escapeHtml(status.lastError.phase)} failed at ${escapeHtml(formatStatusTime(status.lastError.at))}: ${escapeHtml(status.lastError.message)}</p>`;

  return `<section class="daemon-status daemon-status-${stateClass}" aria-label="Daemon status">
  <div class="daemon-status-heading"><span class="daemon-status-dot"></span><strong>${state}</strong></div>
  <p class="daemon-status-details">${details.map((detail) => escapeHtml(detail)).join(' · ')}</p>
  ${errorHtml}
</section>`;
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
    operationalStatus,
  }: HtmlRenderOptions = {},
): string {
  const { layoutData, keys: providers } = resolveProviderLayout(providerData, { all, year });
  const weeks = buildHeatmapWeeks(year);

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
    const message = emptyMessage ?? formatUsageEmptyMessage('no-data');
    return pageShell(
      title,
      dark,
      metaLines,
      `${renderOperationalStatus(operationalStatus)}
<div class="empty-state"><p>${escapeHtml(message)}</p></div>`,
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

  return pageShell(
    title,
    dark,
    metaLines,
    renderOperationalStatus(operationalStatus) + todayHtml + sections,
    refreshIntervalSeconds,
  );
}

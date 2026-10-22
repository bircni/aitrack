import './libVersion.js';
import {
  Action,
  ActionPanel,
  getPreferenceValues,
  Icon,
  Keyboard,
  List,
  openCommandPreferences,
  showToast,
  Toast,
} from '@raycast/api';
import { useCachedPromise } from '@raycast/utils';
import { isUsageNotConfigured } from 'aitrack-lib/data/emptyState';
import { loadMergedProviderData } from 'aitrack-lib/data/usageData';
import type { UsageWindowOptions } from 'aitrack-lib/data/usagePeriods';
import {
  buildUsageReportsFromLoaded,
  type UsageReport,
  type UsageReportProvider,
} from 'aitrack-lib/data/usageReport';
import { fmt, fmtUSD, unpricedFootnote } from 'aitrack-lib/display/format';
import { errorMessage } from 'aitrack-lib/errors';
import { pull } from 'aitrack-lib/git';
import type { QuotaProviderKey } from 'aitrack-lib/quota/types';
import { useState } from 'react';

import { preferences } from './preferences.js';

const PERIODS = [
  { id: 'today', title: 'Today', window: { period: 'today' } },
  { id: 'yesterday', title: 'Yesterday', window: { period: 'yesterday' } },
  { id: 'thisweek', title: 'This Week', window: { period: 'thisweek' } },
  { id: 'week', title: 'Last 7 Days', window: { period: 'week' } },
  { id: 'thismonth', title: 'This Month', window: { period: 'thismonth' } },
  { id: 'month', title: 'Last 30 Days', window: { period: 'month' } },
  { id: 'last90', title: 'Last 90 Days', window: { period: 'last', n: 90 } },
  { id: 'lastmonth', title: 'Last Month', window: { period: 'lastmonth' } },
  { id: 'all', title: 'All Time', window: { period: 'all' } },
] as const satisfies ReadonlyArray<{ id: string; title: string; window: UsageWindowOptions }>;

type Period = (typeof PERIODS)[number]['id'];

interface UsagePreferences {
  defaultPeriod: Period;
  pullSyncedData: boolean;
}

interface Usage {
  reports: Partial<Record<Period, UsageReport>>;
  notConfigured: boolean;
}

const GIT_TIMEOUT_MS = 60_000;

/** Same loader and report builder as `aitrack usage` and opentrack, so the numbers match. */
async function loadUsage(providers: QuotaProviderKey[], pullSynced: boolean): Promise<Usage> {
  const notConfigured = isUsageNotConfigured();
  // Pulls while this machine's logs are parsed; only the synced files wait for it.
  const pulled =
    pullSynced && !notConfigured
      ? pull({ timeoutMs: GIT_TIMEOUT_MS }).catch((error: unknown) => {
          void showToast({
            style: Toast.Style.Failure,
            title: 'Could not pull synced data',
            message: errorMessage(error),
          });
        })
      : undefined;
  const loaded = await loadMergedProviderData({ providers, syncedReady: pulled });
  const reports = loaded
    ? buildUsageReportsFromLoaded(
        loaded,
        PERIODS.map(({ window }) => window),
      )
    : [];
  return {
    reports: Object.fromEntries(PERIODS.map(({ id }, index) => [id, reports[index]])),
    notConfigured,
  };
}

/** Unpriced tokens are not free, so a partly priced cost says so. */
function costLabel(cost: number, hasCost: boolean, hasUnpricedTokens?: boolean): string {
  if (!hasCost) return '—';
  return `${fmtUSD(cost)}${hasUnpricedTokens ? ' (partial)' : ''}`;
}

function providerMarkdown(provider: UsageReportProvider): string {
  const rows = provider.rows.map(
    (row) =>
      `| ${row.model} | ${fmt(row.tokens)} | ${costLabel(row.costUSD, row.hasCost, row.hasUnpricedTokens)} |`,
  );
  const unpriced = unpricedFootnote(
    provider.rows
      .filter((row) => row.hasUnpricedTokens === true || !row.hasCost)
      .map((row) => row.model),
  );
  return [
    `## ${provider.label}`,
    '| Model | Tokens | Cost |',
    '| --- | ---: | ---: |',
    ...rows,
    ...(unpriced ? ['', `_${unpriced}_`] : []),
  ].join('\n');
}

export default function Command() {
  const { providers } = preferences();
  const { defaultPeriod, pullSyncedData } = getPreferenceValues<UsagePreferences>();
  const [period, setPeriod] = useState<Period>(defaultPeriod);
  const { data, isLoading, revalidate } = useCachedPromise(loadUsage, [providers, pullSyncedData]);
  const report = data?.reports[period];
  const rows = report?.providers.filter((provider) => provider.subtotalTokens > 0) ?? [];
  const common = (
    <>
      <Action
        title="Refresh"
        icon={Icon.ArrowClockwise}
        shortcut={Keyboard.Shortcut.Common.Refresh}
        onAction={revalidate}
      />
      <Action
        title="Open Command Preferences"
        icon={Icon.Gear}
        shortcut={{ modifiers: ['cmd'], key: ',' }}
        onAction={() => void openCommandPreferences()}
      />
    </>
  );

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={rows.length > 0}
      navigationTitle={report?.windowLabel}
      searchBarAccessory={
        <List.Dropdown
          tooltip="Period"
          value={period}
          onChange={(value) => {
            setPeriod(value as Period);
          }}
        >
          {PERIODS.map(({ id, title }) => (
            <List.Dropdown.Item key={id} value={id} title={title} />
          ))}
        </List.Dropdown>
      }
    >
      <List.EmptyView
        icon={Icon.BarChart}
        title={report ? `No usage recorded for ${report.windowLabel}` : 'No usage data found'}
        description={
          data?.notConfigured
            ? 'Showing this Mac only. Run `npx aitrack init` to sync across machines.'
            : undefined
        }
        actions={<ActionPanel>{common}</ActionPanel>}
      />
      {rows.map((provider) => {
        const cost = costLabel(
          provider.subtotalCostUSD,
          provider.subtotalHasCost,
          provider.hasUnpricedTokens,
        );
        return (
          <List.Item
            key={provider.key}
            title={provider.label}
            accessories={[{ text: `${fmt(provider.subtotalTokens)} tokens` }, { text: cost }]}
            detail={<List.Item.Detail markdown={providerMarkdown(provider)} />}
            actions={
              <ActionPanel>
                {common}
                <Action.CopyToClipboard title="Copy Cost" content={cost} />
              </ActionPanel>
            }
          />
        );
      })}
    </List>
  );
}

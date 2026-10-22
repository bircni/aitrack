import './libVersion.js';
import { Action, ActionPanel, Icon, Keyboard, List } from '@raycast/api';
import { useCachedPromise } from '@raycast/utils';
import { isUsageNotConfigured } from 'aitrack-lib/data/emptyState';
import { loadMergedProviderData } from 'aitrack-lib/data/usageData';
import type { UsagePeriod } from 'aitrack-lib/data/usagePeriods';
import {
  buildUsageReportsFromLoaded,
  type UsageReport,
  type UsageReportProvider,
} from 'aitrack-lib/data/usageReport';
import { fmt, fmtUSD, unpricedFootnote } from 'aitrack-lib/display/format';
import { useState } from 'react';

const PERIODS = [
  { id: 'today', title: 'Today' },
  { id: 'yesterday', title: 'Yesterday' },
  { id: 'week', title: 'Last 7 Days' },
  { id: 'month', title: 'Last 30 Days' },
  { id: 'all', title: 'All Time' },
] as const satisfies ReadonlyArray<{ id: UsagePeriod; title: string }>;

type Period = (typeof PERIODS)[number]['id'];

interface Usage {
  reports: Partial<Record<Period, UsageReport>>;
  notConfigured: boolean;
}

/** Same loader and report builder as `aitrack usage` and opentrack, so the numbers match. */
async function loadUsage(): Promise<Usage> {
  const loaded = await loadMergedProviderData();
  const reports = loaded
    ? buildUsageReportsFromLoaded(
        loaded,
        PERIODS.map(({ id }) => ({ period: id })),
      )
    : [];
  return {
    reports: Object.fromEntries(PERIODS.map(({ id }, index) => [id, reports[index]])),
    notConfigured: isUsageNotConfigured(),
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
  const [period, setPeriod] = useState<Period>('today');
  const { data, isLoading, revalidate } = useCachedPromise(loadUsage);
  const report = data?.reports[period];
  const providers = report?.providers.filter((provider) => provider.subtotalTokens > 0) ?? [];
  const refresh = (
    <Action
      title="Refresh"
      icon={Icon.ArrowClockwise}
      shortcut={Keyboard.Shortcut.Common.Refresh}
      onAction={revalidate}
    />
  );

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={providers.length > 0}
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
        actions={<ActionPanel>{refresh}</ActionPanel>}
      />
      {providers.map((provider) => (
        <List.Item
          key={provider.key}
          title={provider.label}
          accessories={[
            { text: `${fmt(provider.subtotalTokens)} tokens` },
            {
              text: costLabel(
                provider.subtotalCostUSD,
                provider.subtotalHasCost,
                provider.hasUnpricedTokens,
              ),
            },
          ]}
          detail={<List.Item.Detail markdown={providerMarkdown(provider)} />}
          actions={
            <ActionPanel>
              {refresh}
              <Action.CopyToClipboard
                title="Copy Cost"
                content={costLabel(
                  provider.subtotalCostUSD,
                  provider.subtotalHasCost,
                  provider.hasUnpricedTokens,
                )}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}

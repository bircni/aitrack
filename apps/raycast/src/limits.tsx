import './libVersion.js';
import { Action, ActionPanel, Color, Icon, Keyboard, List } from '@raycast/api';
import { useCachedPromise } from '@raycast/utils';
import { fmtUSDCost } from 'aitrack-lib/display/format';
import { providerLabel } from 'aitrack-lib/providers/registry';
import { fetchQuota, QUOTA_PROVIDERS } from 'aitrack-lib/quota/index';
import { projectPace } from 'aitrack-lib/quota/pacing';
import type { QuotaProviderKey, QuotaResult, QuotaValue } from 'aitrack-lib/quota/types';

import {
  formatLimitValue,
  formatReset,
  paceLabel,
  problemText,
  type Tone,
  windowTone,
} from './format.js';

interface ProviderLimits {
  key: QuotaProviderKey;
  result: QuotaResult;
}

const TINT: Record<Tone, Color> = { calm: Color.Green, warn: Color.Yellow, crit: Color.Red };

function loadLimits(): Promise<ProviderLimits[]> {
  return Promise.all(QUOTA_PROVIDERS.map(async (key) => ({ key, result: await fetchQuota(key) })));
}

function formatValue(value: QuotaValue): string {
  return value.format === 'dollars' ? fmtUSDCost(value.value) : value.value.toLocaleString();
}

function summary(limits: ProviderLimits[], now: number): string {
  return limits
    .flatMap(({ key, result }) => {
      const label = providerLabel(key);
      if (!result.ok) return [`${label}: ${problemText(result.error)}`];
      return result.snapshot.windows.map((window) =>
        [`${label} ${window.label}: ${formatLimitValue(window)}`, formatReset(window.resetsAt, now)]
          .filter(Boolean)
          .join(', '),
      );
    })
    .join('\n');
}

export default function Command() {
  const { data, isLoading, revalidate } = useCachedPromise(loadLimits);
  const now = Date.now();
  const actions = (
    <ActionPanel>
      <Action
        title="Refresh"
        icon={Icon.ArrowClockwise}
        shortcut={Keyboard.Shortcut.Common.Refresh}
        onAction={revalidate}
      />
      {data && <Action.CopyToClipboard title="Copy Summary" content={summary(data, now)} />}
    </ActionPanel>
  );

  return (
    <List isLoading={isLoading}>
      {data?.map(({ key, result }) => (
        <List.Section
          key={key}
          title={providerLabel(key)}
          subtitle={result.ok ? result.snapshot.plan : undefined}
        >
          {result.ok ? (
            <>
              {result.snapshot.windows.map((window) => {
                const pace = projectPace(window, now);
                const reset = formatReset(window.resetsAt, now);
                const note = paceLabel(pace, now);
                return (
                  <List.Item
                    key={window.id}
                    title={window.label}
                    icon={{
                      source: Icon.CircleProgress,
                      tintColor: TINT[windowTone(window, pace)],
                    }}
                    subtitle={note}
                    accessories={[
                      ...(reset ? [{ text: reset, icon: Icon.Clock }] : []),
                      {
                        tag: {
                          value: formatLimitValue(window),
                          color: TINT[windowTone(window, pace)],
                        },
                      },
                    ]}
                    actions={actions}
                  />
                );
              })}
              {result.snapshot.values.map((value) => (
                <List.Item
                  key={value.id}
                  title={value.label}
                  icon={Icon.Coins}
                  accessories={[{ text: formatValue(value) }]}
                  actions={actions}
                />
              ))}
            </>
          ) : (
            <List.Item
              title={problemText(result.error)}
              subtitle={result.error.message}
              icon={{ source: Icon.Warning, tintColor: Color.SecondaryText }}
              actions={actions}
            />
          )}
        </List.Section>
      ))}
    </List>
  );
}

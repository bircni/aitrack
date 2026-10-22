import './libVersion.js';
import {
  Action,
  ActionPanel,
  Color,
  Icon,
  Keyboard,
  List,
  openExtensionPreferences,
} from '@raycast/api';
import { useCachedPromise } from '@raycast/utils';
import { fmtUSDCost } from 'aitrack-lib/display/format';
import { providerLabel } from 'aitrack-lib/providers/registry';
import { fetchQuota } from 'aitrack-lib/quota/index';
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
import { type Preferences, preferences } from './preferences.js';

interface ProviderLimits {
  key: QuotaProviderKey;
  result: QuotaResult;
}

const TINT: Record<Tone, Color> = { calm: Color.Green, warn: Color.Yellow, crit: Color.Red };

function loadLimits(providers: QuotaProviderKey[]): Promise<ProviderLimits[]> {
  return Promise.all(providers.map(async (key) => ({ key, result: await fetchQuota(key) })));
}

function formatValue(value: QuotaValue): string {
  return value.format === 'dollars' ? fmtUSDCost(value.value) : value.value.toLocaleString();
}

function summary(limits: ProviderLimits[], prefs: Preferences, now: number): string {
  return limits
    .flatMap(({ key, result }) => {
      const label = providerLabel(key);
      if (!result.ok) return [`${label}: ${problemText(result.error)}`];
      return result.snapshot.windows.map((window) =>
        [
          `${label} ${window.label}: ${formatLimitValue(window, prefs.display)}`,
          formatReset(window.resetsAt, now, prefs.resetDisplay),
        ]
          .filter(Boolean)
          .join(', '),
      );
    })
    .join('\n');
}

export default function Command() {
  const prefs = preferences();
  const { data, isLoading, revalidate } = useCachedPromise(loadLimits, [prefs.providers]);
  const now = Date.now();
  const actions = (
    <ActionPanel>
      <Action
        title="Refresh"
        icon={Icon.ArrowClockwise}
        shortcut={Keyboard.Shortcut.Common.Refresh}
        onAction={revalidate}
      />
      {data && <Action.CopyToClipboard title="Copy Summary" content={summary(data, prefs, now)} />}
      <Action
        title="Open Extension Preferences"
        icon={Icon.Gear}
        shortcut={{ modifiers: ['cmd'], key: ',' }}
        onAction={() => void openExtensionPreferences()}
      />
    </ActionPanel>
  );

  return (
    <List isLoading={isLoading}>
      <List.EmptyView
        icon={Icon.Gauge}
        title={prefs.providers.length === 0 ? 'No providers selected' : 'No limits yet'}
        description="Choose providers in the extension preferences."
        actions={actions}
      />
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
                const tint = TINT[windowTone(window, pace)];
                const reset = formatReset(window.resetsAt, now, prefs.resetDisplay);
                return (
                  <List.Item
                    key={window.id}
                    title={window.label}
                    icon={{ source: Icon.CircleProgress, tintColor: tint }}
                    subtitle={paceLabel(pace, now)}
                    accessories={[
                      ...(reset ? [{ text: reset, icon: Icon.Clock }] : []),
                      { tag: { value: formatLimitValue(window, prefs.display), color: tint } },
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

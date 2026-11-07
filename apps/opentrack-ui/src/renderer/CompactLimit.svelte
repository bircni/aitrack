<script lang="ts">
  import type { AppState, QuotaWindow, Settings } from '../shared/types.js';
  import { formatUpdated } from './format.js';
  import LimitMeter from './LimitMeter.svelte';
  import ProviderIcon from './ProviderIcon.svelte';

  interface Props {
    appState: AppState;
    settings: Settings;
    now: number;
    onPatch: (patch: Partial<Settings>) => void;
  }

  let { appState, settings, now, onPatch }: Props = $props();

  // Same choice as the tray icon: the followed provider, else the one closest to its session limit.
  const session = $derived.by(() => {
    const withSession = appState.providers.flatMap((provider) => {
      const window: QuotaWindow | undefined = provider.quota?.windows.find(({ id }) => id === 'session');
      return window ? [{ provider, window }] : [];
    });
    const followed = withSession.find(({ provider }) => provider.key === settings.trayProvider);
    if (followed) return followed;
    return withSession.reduce<(typeof withSession)[number] | undefined>(
      (best, entry) => (!best || entry.window.usedPercent > best.window.usedPercent ? entry : best),
      undefined,
    );
  });
</script>

<section class="compact" aria-label="Session limit">
  {#if session}
    <header class="c-head">
      <ProviderIcon provider={session.provider.key} size={16} />
      <span class="c-name">{session.provider.label}</span>
      <span class="c-plan">{session.provider.quota?.plan ?? ''}</span>
    </header>
    <LimitMeter
      window={session.window}
      {settings}
      {now}
      onToggleUsage={() => onPatch({ display: settings.display === 'used' ? 'left' : 'used' })}
      onToggleReset={() =>
        onPatch({ resetDisplay: settings.resetDisplay === 'relative' ? 'absolute' : 'relative' })}
    />
  {:else}
    <p class="empty">No session limit to show yet.</p>
  {/if}
  <footer class="c-foot">
    <span>{appState.syncing ? 'Syncing…' : appState.refreshing ? 'Updating…' : formatUpdated(appState.updatedAt, now)}</span>
    <button class="link" type="button" onclick={() => onPatch({ compact: false })}>Full view</button>
  </footer>
</section>

<style>
  .compact {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px 16px;
  }
  .c-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .c-name {
    font-weight: 600;
  }
  .c-plan {
    color: var(--muted, #888);
    font-size: 12px;
  }
  .c-foot {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 12px;
    color: var(--muted, #888);
  }
  .empty {
    margin: 0;
    color: var(--muted, #888);
  }
</style>

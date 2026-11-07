<script lang="ts">
  import type { AppState, Settings } from '../shared/types.js';
  import LimitMeter from './LimitMeter.svelte';
  import ProviderIcon from './ProviderIcon.svelte';

  interface Props {
    appState: AppState;
    settings: Settings;
    now: number;
    onPatch: (patch: Partial<Settings>) => void;
  }

  let { appState, settings, now, onPatch }: Props = $props();

  // Shown in the order of the full view, only for the providers chosen in Settings.
  const chosen = $derived(
    appState.providers.filter((provider) => settings.compactProviders.includes(provider.key)),
  );
</script>

<section class="compact" aria-label="Session limits">
  {#each chosen as provider (provider.key)}
    {@const session = provider.quota?.windows.find(({ id }) => id === 'session')}
    <div class="c-block">
      <header class="c-head">
        <ProviderIcon provider={provider.key} size={16} />
        <span class="c-name">{provider.label}</span>
        {#if provider.quota?.plan}<span class="c-plan">{provider.quota.plan}</span>{/if}
      </header>
      {#if session}
        <LimitMeter
          window={session}
          {settings}
          {now}
          onToggleUsage={() => onPatch({ display: settings.display === 'used' ? 'left' : 'used' })}
          onToggleReset={() =>
            onPatch({ resetDisplay: settings.resetDisplay === 'relative' ? 'absolute' : 'relative' })}
        />
      {:else}
        <p class="empty">No session limit yet.</p>
      {/if}
    </div>
  {:else}
    <p class="empty">
      {settings.compactProviders.length === 0
        ? 'Choose providers for the compact view in Settings.'
        : 'The providers chosen for compact view are turned off or not loaded yet.'}
    </p>
  {/each}
</section>

<style>
  .compact {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 14px 16px;
  }
  .c-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }
  .c-name {
    font-weight: 600;
  }
  .c-plan {
    color: var(--ink-3);
    font-size: 12px;
  }
  .empty {
    margin: 0;
    color: var(--ink-3);
  }
</style>

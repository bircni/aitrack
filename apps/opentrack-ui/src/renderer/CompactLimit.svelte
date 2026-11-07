<script lang="ts">
  import type { AppState, Settings } from '../shared/types.js';
  import { toggledDisplay, toggledResetDisplay } from './format.js';
  import LimitMeter from './LimitMeter.svelte';
  import ProviderIcon from './ProviderIcon.svelte';

  interface Props {
    appState: AppState;
    settings: Settings;
    now: number;
    serviceDown: boolean;
    onPatch: (patch: Partial<Settings>) => void;
  }

  let { appState, settings, now, serviceDown, onPatch }: Props = $props();

  const compactKeys = $derived(
    new Set(settings.providers.filter((entry) => entry.compact).map((entry) => entry.key)),
  );
  // In the order of the full view.
  const chosen = $derived(appState.providers.filter((provider) => compactKeys.has(provider.key)));
</script>

<section class="compact" aria-label="Session limits">
  {#each chosen as provider (provider.key)}
    {@const session = provider.quota?.windows.find(({ id }) => id === 'session')}
    <div class="provider provider--{provider.key}">
      <header class="c-head">
        <span class="p-mark"><ProviderIcon provider={provider.key} size={18} /></span>
        <span class="p-identity">
          <span class="p-name">{provider.label}</span>
          {#if provider.quota?.plan}<span class="p-plan">{provider.quota.plan}</span>{/if}
        </span>
      </header>
      {#if session}
        <LimitMeter
          window={session}
          {settings}
          {now}
          stale={serviceDown || provider.quotaError !== undefined}
          onToggleUsage={() => onPatch(toggledDisplay(settings))}
          onToggleReset={() => onPatch(toggledResetDisplay(settings))}
        />
      {:else}
        <p class="empty">No session limit yet.</p>
      {/if}
    </div>
  {:else}
    <p class="empty">
      {compactKeys.size === 0
        ? 'Choose providers for the compact view in Settings.'
        : 'The providers chosen for compact view are turned off or not loaded yet.'}
    </p>
  {/each}
</section>

<script lang="ts">
  import type { AppState, Settings } from '../shared/types.js';
  import { problemLine, toggledDisplay, toggledResetDisplay } from './format.js';
  import LimitMeter from './LimitMeter.svelte';
  import ProviderHeading from './ProviderHeading.svelte';

  interface Props {
    appState: AppState;
    settings: Settings;
    now: number;
    serviceDown: boolean;
    onPatch: (patch: Partial<Settings>) => void;
  }

  let { appState, settings, now, serviceDown, onPatch }: Props = $props();
</script>

<section class="compact" aria-label="Session limits">
  {#each appState.providers as provider (provider.key)}
    {@const windows = provider.quota?.windows ?? []}
    {@const session = windows.find(({ id }) => id === 'session') ?? windows.find(({ id }) => id === 'weekly') ?? windows[0]}
    <div class="provider provider--{provider.key}">
      <header class="c-head"><ProviderHeading {provider} /></header>
      {#if provider.quotaError}
        <div class="state">{problemLine(provider.quotaError, now, provider.retryAt).text}</div>
      {/if}
      {#if session}
        <LimitMeter
          window={session}
          {settings}
          {now}
          stale={serviceDown || provider.quotaError !== undefined}
          onToggleUsage={() => onPatch(toggledDisplay(settings))}
          onToggleReset={() => onPatch(toggledResetDisplay(settings))}
        />
      {:else if !provider.quotaError}
        <p class="empty">No limits yet.</p>
      {/if}
    </div>
  {:else}
    <p class="empty">No providers are turned on.</p>
  {/each}
</section>

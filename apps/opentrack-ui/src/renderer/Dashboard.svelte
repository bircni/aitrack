<script lang="ts">
  import type { AppState, Settings } from '../shared/types.js';
  import { formatUpdated, type Period } from './format.js';
  import ProviderSection from './ProviderSection.svelte';
  import Summary from './Summary.svelte';

  interface Props {
    appState: AppState;
    settings: Settings;
    now: number;
    period: Period;
    onPeriod: (period: Period) => void;
    onPatch: (patch: Partial<Settings>) => void;
  }

  let { appState, settings, now, period, onPeriod, onPatch }: Props = $props();
</script>

<Summary
  providers={appState.providers}
  machineCount={appState.machineCount}
  {period}
  {onPeriod}
/>

{#if appState.pullError}
  <p class="banner">{appState.pullError}</p>
{/if}
{#if appState.usageError && appState.usageUpdatedAt}
  <p class="banner">Cached usage: {formatUpdated(appState.usageUpdatedAt, now)}</p>
{/if}
{#if appState.usageError}
  <p class="banner">{appState.usageError}</p>
{/if}
{#if appState.syncResult && !appState.syncResult.ok}
  <p class="banner">Sync failed: {appState.syncResult.message}</p>
{/if}

{#each appState.providers as provider (provider.key)}
  <ProviderSection {provider} {settings} {now} {period} {onPatch} />
{:else}
  <p class="empty">No providers are turned on. Choose some in Settings.</p>
{/each}

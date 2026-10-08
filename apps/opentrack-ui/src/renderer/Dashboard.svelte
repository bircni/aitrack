<script lang="ts">
  import type { AppState, DashboardView, QuotaProviderKey, Settings } from '../shared/types.js';
  import { formatUpdated, type Period } from './format.js';
  import Machines from './Machines.svelte';
  import ProviderSection from './ProviderSection.svelte';
  import Summary from './Summary.svelte';

  interface Props {
    appState: AppState;
    settings: Settings;
    now: number;
    period: Period;
    view: DashboardView;
    onPeriod: (period: Period) => void;
    onView: (view: DashboardView) => void;
    onPatch: (patch: Partial<Settings>) => void;
    onRefresh: () => void;
    onSync: () => void;
    onOpenDashboard: (provider: QuotaProviderKey) => void;
  }

  let {
    appState,
    settings,
    now,
    period,
    view,
    onPeriod,
    onView,
    onPatch,
    onRefresh,
    onSync,
    onOpenDashboard,
  }: Props = $props();

  const machines = $derived(appState.machines ?? []);
  const showMachines = $derived(view === 'machines' && machines.length > 0);
</script>

<Summary
  providers={appState.providers}
  machineCount={appState.machineCount}
  {period}
  {onPeriod}
  onMachines={machines.length > 1 ? () => onView('machines') : undefined}
/>

{#if appState.pullError}
  <p class="banner">
    {appState.pullError}
    <button class="link" type="button" aria-label="Retry pull" onclick={onRefresh}>Retry</button>
  </p>
{/if}
{#if appState.usageError && appState.usageUpdatedAt}
  <p class="banner">Cached usage: {formatUpdated(appState.usageUpdatedAt, now)}</p>
{/if}
{#if appState.usageError}
  <p class="banner">
    {appState.usageError}
    <button class="link" type="button" aria-label="Retry usage" onclick={onRefresh}>Retry</button>
  </p>
{/if}
{#if appState.syncResult && !appState.syncResult.ok}
  <p class="banner">
    Sync failed: {appState.syncResult.message}
    <button class="link" type="button" aria-label="Retry sync" onclick={onSync}>Retry</button>
  </p>
{/if}

{#if machines.length > 0 && appState.providers.length > 0}
  <div class="tabs" role="tablist" aria-label="Group usage by">
    <button
      type="button"
      role="tab"
      aria-selected={!showMachines}
      onclick={() => onView('providers')}>Providers</button
    >
    <button type="button" role="tab" aria-selected={showMachines} onclick={() => onView('machines')}
      >Machines <span class="tab-count">{machines.length}</span></button
    >
  </div>
{/if}

{#if showMachines}
  <Machines
    {machines}
    accountUsage={appState.accountUsage}
    providers={appState.providers}
    {period}
    {now}
  />
{:else}
  {#each appState.providers as provider (provider.key)}
    <ProviderSection {provider} {settings} {now} {period} {onPatch} {onRefresh} {onOpenDashboard} />
  {:else}
    <p class="empty">No providers are turned on. Choose some in Settings.</p>
  {/each}
{/if}

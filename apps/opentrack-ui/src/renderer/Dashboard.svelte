<script lang="ts">
  import type { AppState, DashboardView, QuotaProviderKey, Settings } from '../shared/types.js';
  import { formatUpdated, type Period } from './format.js';
  import History from './History.svelte';
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
  const showHistory = $derived(view === 'history');
  const active = $derived<DashboardView>(
    showHistory ? 'history' : showMachines ? 'machines' : 'providers',
  );
  const tabs = $derived<Array<{ view: DashboardView; label: string; count?: number }>>([
    { view: 'providers', label: 'Providers' },
    { view: 'history', label: 'History' },
    ...(machines.length > 0
      ? [{ view: 'machines' as const, label: 'Machines', count: machines.length }]
      : []),
  ]);

  function onTabKey(event: KeyboardEvent): void {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const index = (tabs.findIndex((tab) => tab.view === active) + step + tabs.length) % tabs.length;
    const next = tabs[index];
    if (!next) return;
    onView(next.view);
    const list = event.currentTarget;
    if (list instanceof HTMLElement) list.querySelectorAll<HTMLElement>('[role="tab"]')[index]?.focus();
  }
</script>

<Summary
  providers={appState.providers}
  machineCount={appState.machineCount}
  {period}
  {onPeriod}
  onMachines={machines.length > 1 ? () => onView('machines') : undefined}
/>

{#if appState.pullError}
  <p class="banner" role="status">
    {appState.pullError}
    <button class="link" type="button" aria-label="Retry pull" onclick={onRefresh}>Retry</button>
  </p>
{/if}
{#if appState.usageError && appState.usageUpdatedAt}
  <p class="banner" role="status">Cached usage: {formatUpdated(appState.usageUpdatedAt, now)}</p>
{/if}
{#if appState.usageError}
  <p class="banner" role="status">
    {appState.usageError}
    <button class="link" type="button" aria-label="Retry usage" onclick={onRefresh}>Retry</button>
  </p>
{/if}
{#if appState.syncResult && !appState.syncResult.ok}
  <p class="banner" role="status">
    Sync failed: {appState.syncResult.message}
    <button class="link" type="button" aria-label="Retry sync" onclick={onSync}>Retry</button>
  </p>
{/if}

{#if appState.providers.length > 0}
  <div class="tabs" role="tablist" aria-label="Usage view" tabindex="-1" onkeydown={onTabKey}>
    {#each tabs as tab (tab.view)}
      <button
        type="button"
        role="tab"
        aria-selected={active === tab.view}
        tabindex={active === tab.view ? 0 : -1}
        onclick={() => onView(tab.view)}
        >{tab.label}{#if tab.count !== undefined}
          <span class="tab-count">{tab.count}</span>{/if}</button
      >
    {/each}
  </div>
{/if}

{#if showHistory}
  <History providers={appState.providers} />
{:else if showMachines}
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

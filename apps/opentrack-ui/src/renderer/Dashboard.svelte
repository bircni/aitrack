<script lang="ts">
  import type { AppState, DashboardView, QuotaProviderKey, Settings } from '../shared/types.js';
  import {
    emptyUsageGuidance,
    formatUpdated,
    type HistoryBucket,
    type HistoryRange,
    type Period,
    USAGE_NOTES,
    usageAvailability,
  } from './format.js';
  import History from './History.svelte';
  import Machines from './Machines.svelte';
  import Projects from './Projects.svelte';
  import ProviderSection from './ProviderSection.svelte';
  import Summary from './Summary.svelte';

  interface Props {
    appState: AppState;
    settings: Settings;
    now: number;
    period: Period;
    view: DashboardView;
    historyRange?: HistoryRange;
    historyBucket?: HistoryBucket;
    serviceDown?: boolean;
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
    historyRange = $bindable(30),
    historyBucket = $bindable('day'),
    serviceDown = false,
    onPeriod,
    onView,
    onPatch,
    onRefresh,
    onSync,
    onOpenDashboard,
  }: Props = $props();

  const machines = $derived(appState.machines ?? []);
  const availability = $derived(usageAvailability(appState));
  const active = $derived<DashboardView>(
    view === 'machines' && machines.length === 0 ? 'providers' : view,
  );
  const tabs = $derived<Array<{ view: DashboardView; label: string; count?: number }>>([
    { view: 'providers', label: 'Providers' },
    { view: 'history', label: 'History' },
    { view: 'projects', label: 'Projects' },
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
  machineCount={machines.length}
  {availability}
  {period}
  {onPeriod}
  onMachines={machines.length > 1 ? () => onView('machines') : undefined}
/>

{#if availability === 'empty'}
  <p class="banner">{emptyUsageGuidance(appState.providers)}</p>
{/if}
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

{#if availability === 'off'}
  <p class="empty">{USAGE_NOTES.off}. Choose some in Settings.</p>
{:else}
  <div class="tabs" role="tablist" aria-label="Usage view" tabindex="-1" onkeydown={onTabKey}>
    {#each tabs as tab (tab.view)}
      <button
        id="tab-{tab.view}"
        type="button"
        role="tab"
        aria-selected={active === tab.view}
        aria-controls="usage-panel"
        tabindex={active === tab.view ? 0 : -1}
        onclick={() => onView(tab.view)}
        >{tab.label}{#if tab.count !== undefined}
          <span class="tab-count">{tab.count}</span>{/if}</button
      >
    {/each}
  </div>

  <div id="usage-panel" role="tabpanel" aria-labelledby="tab-{active}">
    {#if active === 'providers'}
      {#each appState.providers as provider (provider.key)}
        <ProviderSection
          {provider}
          {settings}
          {now}
          {period}
          {serviceDown}
          {onPatch}
          {onRefresh}
          {onOpenDashboard}
        />
      {/each}
    {:else if active === 'machines'}
      <Machines
        {machines}
        accountUsage={appState.accountUsage}
        providers={appState.providers}
        {period}
        {now}
      />
    {:else if availability !== 'ready'}
      <p class="empty">{USAGE_NOTES[availability]}.</p>
    {:else if active === 'history'}
      <History providers={appState.providers} bind:range={historyRange} bind:bucket={historyBucket} />
    {:else}
      <Projects
        projects={appState.projects}
        {period}
        cursorEnabled={appState.providers.some((provider) => provider.key === 'cursor')}
      />
    {/if}
  </div>
{/if}

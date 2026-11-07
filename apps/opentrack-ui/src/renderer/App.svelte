<script lang="ts">
  import { errorMessage } from 'aitrack-lib/errors';
  import { onMount, tick } from 'svelte';

  import type {
    AppState,
    DashboardView,
    QuotaProviderKey,
    Screen,
    Settings,
  } from '../shared/types.js';
  import { api, type ServiceStatus } from './api.js';
  import Dashboard from './Dashboard.svelte';
  import {
    freshnessLine,
    type HistoryBucket,
    type HistoryRange,
    type Period,
    refreshOutcome,
  } from './format.js';
  import Icon from './Icon.svelte';
  import SettingsScreen from './SettingsScreen.svelte';

  let appState = $state.raw<AppState | undefined>(); // Replaced whole on every push, never mutated.
  let settings = $state<Settings | undefined>();
  let screen = $state<Screen>('dashboard');
  // Here so a visit to Settings keeps them.
  let period = $state<Period>('today');
  let view = $state<DashboardView>('providers');
  let historyRange = $state<HistoryRange>(30);
  let historyBucket = $state<HistoryBucket>('day');
  let now = $state(Date.now());
  let content = $state<HTMLElement | undefined>();
  let footer = $state<HTMLElement | undefined>();
  let scroller = $state<HTMLElement | undefined>();
  let settingsButton = $state<HTMLElement | undefined>();
  let moreBelow = $state(false);
  let service = $state.raw<ServiceStatus>({ state: 'running', message: null });
  const serviceDown = $derived(service.state === 'down');

  function measureScroll(): void {
    if (scroller) moreBelow = scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1;
  }

  // The window is capped below tall screens, and an overlay scrollbar is invisible until scrolled.
  $effect(() => {
    if (!scroller || !content) return;
    const observer = new ResizeObserver(measureScroll);
    observer.observe(scroller);
    observer.observe(content);
    return () => {
      observer.disconnect();
    };
  });

  // The window takes its height from what is shown, so there is no empty space below.
  $effect(() => {
    const parts = [content, footer].filter((part) => part instanceof HTMLElement);
    if (parts.length === 0) return;
    const report = () => {
      // Unrounded, so a fractional pixel never leaves the content a pixel short of fitting.
      api.fitHeight(parts.reduce((sum, part) => sum + part.getBoundingClientRect().height, 0));
    };
    const observer = new ResizeObserver(report);
    for (const part of parts) observer.observe(part);
    return () => {
      observer.disconnect();
    };
  });

  let announcement = $state('');
  let wasBusy: 'sync' | 'refresh' | undefined;
  // A state push does not say who started a run, and background cycles should stay silent.
  let userRun: 'sync' | 'refresh' | undefined;
  let syncNote = $state<string | undefined>();
  let syncNoteTimer: ReturnType<typeof setTimeout> | undefined;

  function showSyncNote(message: string): void {
    syncNote = message;
    clearTimeout(syncNoteTimer);
    syncNoteTimer = setTimeout(() => (syncNote = undefined), 6000);
  }

  // A polite live region, since the footer text only changes visually.
  $effect(() => {
    if (!appState) return;
    const busy = appState.syncing ? 'sync' : appState.refreshing ? 'refresh' : undefined;
    if (busy) {
      if (userRun) announcement = busy === 'sync' ? 'Syncing…' : 'Updating…';
    } else if (wasBusy && userRun) {
      const result = appState.syncResult;
      if (userRun === 'refresh') announcement = refreshOutcome(appState);
      else if (result?.ok) {
        announcement = result.message;
        showSyncNote(result.message);
      } else announcement = result ? `Sync failed: ${result.message}` : 'Sync finished';
      userRun = undefined;
    }
    wasBusy = busy;
  });

  let shownScreen: Screen = 'dashboard';

  // The control that opened a screen is gone once it is switched, which would drop focus to the body.
  $effect(() => {
    const next = screen;
    if (next === shownScreen) return;
    shownScreen = next;
    if (scroller) scroller.scrollTop = 0;
    void tick().then(() => {
      (next === 'settings' ? content?.querySelector<HTMLElement>('h1') : settingsButton)?.focus();
    });
  });

  // Its banner renders at the top, out of view when the control just changed is further down.
  $effect(() => {
    if (settingsError && scroller) scroller.scrollTop = 0;
  });

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    // Escape also closes a select's open list, and that state cannot be read from here.
    const { target } = event;
    if (target instanceof HTMLSelectElement) return;
    if (target instanceof HTMLInputElement && target.type === 'text') return;
    if (screen === 'settings') screen = 'dashboard';
    else if (settings?.windowMode !== 'floating') api.hideWindow();
  }

  function updateNow(): void {
    now = Date.now();
  }

  // One save in flight and only the newest change queued behind it, so no echo is ever stale.
  let saving = false;
  let settingsError = $state<string | undefined>();
  let commandError = $state.raw<{ label: string; action: () => Promise<void>; message: string } | undefined>();
  let loadError = $state<string | undefined>();
  const isLoadFailed = $derived(loadError !== undefined && !(appState && settings)); // Pushed state can fill in what a failed load missed.
  let update = $state<string | null>(null);
  let installing = $state(false);
  let updateError = $state<string | undefined>();

  // Kept apart from commandError so a later Refresh or Sync can't clear the only way out of "Loading".
  async function load(): Promise<void> {
    loadError = undefined;
    const [state, saved] = await Promise.allSettled([api.getState(), api.getSettings()]);
    if (state.status === 'fulfilled') appState ??= state.value;
    if (saved.status === 'fulfilled') settings ??= saved.value;
    const failure = [state, saved].find((result) => result.status === 'rejected');
    if (failure) loadError = errorMessage(failure.reason);
  }

  async function runCommand(label: string, action: () => Promise<void>): Promise<void> {
    commandError = undefined;
    try {
      await action();
    } catch (error) {
      userRun = undefined;
      commandError = { label, action, message: errorMessage(error) };
    }
  }
  function refresh(): void {
    void runCommand('Refresh', () => {
      userRun = 'refresh';
      return api.refresh();
    });
  }

  function sync(): void {
    void runCommand('Sync', () => {
      userRun = 'sync';
      return api.sync();
    });
  }

  function openDashboard(provider: QuotaProviderKey): void {
    void runCommand('Open dashboard', () => api.openDashboard(provider));
  }

  // Success never returns here: the app restarts into the new version.
  async function installUpdate(): Promise<void> {
    installing = true;
    updateError = undefined;
    try {
      await api.installUpdate();
    } catch (error) {
      updateError = errorMessage(error);
    } finally {
      installing = false;
    }
  }

  let queued: Settings | undefined;

  function patch(change: Partial<Settings>): void {
    if (!settings) return;
    // Applied now so a second change made before the sidecar replies builds on this one.
    settings = { ...settings, ...change };
    // Plain data for the shell, not Svelte's state proxies.
    queued = $state.snapshot(settings);
    if (!saving) void flushSettings();
  }

  async function flushSettings(): Promise<void> {
    saving = true;
    try {
      while (queued) {
        const next = queued;
        queued = undefined;
        try {
          const saved = await api.saveSettings(next);
          settingsError = undefined;
          if (!queued) settings = saved;
        } catch (error) {
          queued ??= next;
          settingsError = errorMessage(error);
          break;
        }
      }
    } finally {
      saving = false;
    }
  }

  onMount(() => {
    void load();
    const offState = api.onState((value) => {
      appState = value;
    });
    const offSettings = api.onSettings((value) => {
      if (!saving && !queued) settings = value;
    });
    const offScreen = api.onScreen((value) => {
      screen = value;
    });
    void api.availableUpdate().then(
      (version) => (update = version),
      () => undefined,
    );
    const offUpdate = api.onUpdate((version) => {
      update = version;
      if (version === null) updateError = undefined;
    });
    const offService = api.onServiceStatus((status) => {
      const recovered = service.state === 'down' && status.state === 'running';
      service = status;
      if (recovered && !(appState && settings)) void load();
    });
    void api.serviceStatus().then(
      (status) => (service = status),
      () => undefined,
    );
    const timer = setInterval(updateNow, 15_000);
    window.addEventListener('focus', updateNow);
    return () => {
      offState();
      offSettings();
      offScreen();
      offUpdate();
      offService();
      clearInterval(timer);
      clearTimeout(syncNoteTimer);
      window.removeEventListener('focus', updateNow);
    };
  });
</script>

<svelte:window onkeydown={onKeydown} />

<main class="pop">
  <p class="sr-only" role="status" aria-live="polite">{announcement}</p>
  <div class="scroll-frame">
    <div class="scroll" bind:this={scroller} onscroll={measureScroll}>
      <div class="content" bind:this={content}>
        {#if isLoadFailed}
          <p class="banner" role="alert">
            Could not load dashboard: {loadError}
            <button class="link" type="button" onclick={() => void load()}>Retry</button>
          </p>
        {/if}
        {#if serviceDown && !isLoadFailed}
          <p class="banner" role="alert">
            {appState ? 'Showing the last numbers. ' : ''}{service.message ??
              'The background service stopped.'}
          </p>
        {/if}
        {#if commandError}
          <p class="banner" role="alert">
            {commandError.label} could not be sent: {commandError.message}
            <button
              class="link"
              type="button"
              onclick={() => {
                if (commandError) void runCommand(commandError.label, commandError.action);
              }}>Retry</button
            >
          </p>
        {/if}
        <!-- Settings shows the update in its About section instead. -->
        {#if update && screen === 'dashboard'}
          <p class="banner" role={updateError ? 'alert' : 'status'}>
            {#if installing}
              Installing opentrack {update}…
            {:else}
              {updateError
                ? `Could not install opentrack ${update}: ${updateError}`
                : `opentrack ${update} is available.`}
              <button class="link" type="button" onclick={() => void installUpdate()}
                >{updateError ? 'Retry' : 'Install and restart'}</button
              >
            {/if}
          </p>
        {/if}
        {#if settingsError}
          <p class="banner" role="alert">
            Could not save settings: {settingsError}
            <button
              class="link"
              type="button"
              onclick={() => {
                if (!saving) void flushSettings();
              }}>Retry</button
            >
          </p>
        {/if}
        {#if appState && settings}
          {#if screen === 'settings'}
            <SettingsScreen
              {settings}
              {update}
              {installing}
              {updateError}
              onInstallUpdate={() => void installUpdate()}
              onPatch={patch}
              onBack={() => (screen = 'dashboard')}
            />
          {:else}
            <Dashboard
              {appState}
              {settings}
              {now}
              {period}
              {view}
              {serviceDown}
              bind:historyRange
              bind:historyBucket
              onPeriod={(next) => (period = next)}
              onView={(next) => (view = next)}
              onPatch={patch}
              onRefresh={refresh}
              onSync={sync}
              onOpenDashboard={openDashboard}
            />
          {/if}
        {:else if !isLoadFailed}
          <p class="empty">Loading…</p>
        {/if}
      </div>
    </div>
    {#if moreBelow}<div class="scroll-more" aria-hidden="true"></div>{/if}
  </div>

  {#if screen === 'dashboard' && settings}
    {@const floating = settings.windowMode === 'floating'}
    <!-- The floating window has no title bar; its footer is the handle. -->
    <footer
      class="foot"
      bind:this={footer}
      data-tauri-drag-region={floating ? '' : undefined}
    >
      <span data-tauri-drag-region={floating ? '' : undefined}
        >{serviceDown
          ? 'Background service stopped'
          : appState?.syncing
            ? 'Syncing…'
            : appState?.refreshing
              ? 'Updating…'
              : (syncNote ?? (appState ? freshnessLine(appState, now) : 'Not updated yet'))}</span
      >
      <button
        class="icon"
        type="button"
        aria-label="Sync this machine"
        title={appState?.syncResult?.message ?? 'Sync this machine (aitrack sync)'}
        disabled={serviceDown || appState?.syncing || appState?.refreshing}
        onclick={sync}
        ><span class:pulsing={appState?.syncing}><Icon name="sync" size={15} /></span></button
      >
      <button
        class="icon"
        type="button"
        aria-label="Refresh"
        title="Refresh"
        disabled={serviceDown || appState?.refreshing || appState?.syncing}
        onclick={refresh}
        ><span class:spinning={appState?.refreshing}><Icon name="refresh" size={15} /></span></button
      >
      <button
        class="icon"
        class:active={floating}
        type="button"
        aria-label="Keep open"
        aria-pressed={floating}
        title={floating ? 'Close with the tray again' : 'Keep open'}
        onclick={() => patch({ windowMode: floating ? 'popup' : 'floating' })}
        ><Icon name={floating ? 'pin-filled' : 'pin'} size={15} /></button
      >
      <button
        class="icon"
        type="button"
        aria-label="Settings"
        title="Settings"
        bind:this={settingsButton}
        onclick={() => (screen = 'settings')}><Icon name="sliders" size={15} /></button
      >
    </footer>
  {/if}
</main>

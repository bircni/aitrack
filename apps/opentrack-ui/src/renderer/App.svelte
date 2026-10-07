<script lang="ts">
  import { errorMessage } from 'aitrack-lib/errors';
  import { onMount } from 'svelte';

  import type { AppState, QuotaProviderKey, Screen, Settings } from '../shared/types.js';
  import { api } from './api.js';
  import Dashboard from './Dashboard.svelte';
  import { formatUpdated, type Period } from './format.js';
  import Icon from './Icon.svelte';
  import SettingsScreen from './SettingsScreen.svelte';

  let appState = $state.raw<AppState | undefined>(); // Replaced whole on every push, never mutated.
  let settings = $state<Settings | undefined>();
  let screen = $state<Screen>('dashboard');
  let period = $state<Period>('today'); // Here so a visit to Settings keeps it.
  let now = $state(Date.now());
  let content = $state<HTMLElement | undefined>();
  let footer = $state<HTMLElement | undefined>();

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

  function tick(): void {
    now = Date.now();
  }

  // One save in flight and only the newest change queued behind it, so no echo is ever stale.
  let saving = false;
  let settingsError = $state<string | undefined>();
  let commandError = $state.raw<{ label: string; action: () => Promise<void>; message: string } | undefined>();
  let loadError = $state<string | undefined>();
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
      commandError = { label, action, message: errorMessage(error) };
    }
  }
  function refresh(): void {
    void runCommand('Refresh', () => api.refresh());
  }

  function sync(): void {
    void runCommand('Sync', () => api.sync());
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
    });
    const timer = setInterval(tick, 15_000);
    window.addEventListener('focus', tick);
    return () => {
      offState();
      offSettings();
      offScreen();
      offUpdate();
      clearInterval(timer);
      window.removeEventListener('focus', tick);
    };
  });
</script>

<main class="pop">
  <div class="scroll">
    <div class="content" bind:this={content}>
      {#if loadError && !(appState && settings)}
        <p class="banner" role="alert">
          Could not load dashboard: {loadError}
          <button class="link" type="button" onclick={() => void load()}>Retry</button>
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
            onPeriod={(next) => (period = next)}
            onPatch={patch}
            onRefresh={refresh}
            onSync={sync}
            onOpenDashboard={openDashboard}
          />
        {/if}
      {:else}
        <p class="empty">Loading…</p>
      {/if}
    </div>
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
        >{appState?.syncing
          ? 'Syncing…'
          : appState?.refreshing
            ? 'Updating…'
            : formatUpdated(appState?.updatedAt, now)}</span
      >
      <button
        class="icon"
        type="button"
        aria-label="Sync this machine"
        title={appState?.syncResult?.message ?? 'Sync this machine (aitrack sync)'}
        disabled={appState?.syncing || appState?.refreshing}
        onclick={sync}
        ><span class:pulsing={appState?.syncing}><Icon name="sync" size={15} /></span></button
      >
      <button
        class="icon"
        type="button"
        aria-label="Refresh"
        title="Refresh"
        disabled={appState?.refreshing || appState?.syncing}
        onclick={refresh}
        ><span class:spinning={appState?.refreshing}><Icon name="refresh" size={15} /></span></button
      >
      <button
        class="icon"
        class:active={floating}
        type="button"
        aria-label={floating ? 'Close with the tray again' : 'Keep open'}
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
        onclick={() => (screen = 'settings')}><Icon name="sliders" size={15} /></button
      >
    </footer>
  {/if}
</main>

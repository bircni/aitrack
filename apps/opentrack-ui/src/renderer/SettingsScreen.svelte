<script lang="ts">
  import { errorMessage } from 'aitrack-lib/errors';
  import { onMount } from 'svelte';

  import type { QuotaProviderKey, SettingErrors, Settings } from '../shared/types.js';
  import { api } from './api.js';
  import Icon from './Icon.svelte';
  import ProviderIcon from './ProviderIcon.svelte';

  type UpdateCheck =
    | { status: 'idle' | 'checking' | 'current' }
    | { status: 'failed'; error: string };

  interface Props {
    settings: Settings;
    /** A newer version found by the shell, with the state of installing it. */
    update: string | null;
    installing: boolean;
    updateError: string | undefined;
    onInstallUpdate: () => void;
    onPatch: (patch: Partial<Settings>) => void;
    onBack: () => void;
  }

  let { settings, update, installing, updateError, onInstallUpdate, onPatch, onBack }: Props =
    $props();
  // The tray falls back to the most used provider when its choice is turned off.
  const enabled = $derived(settings.providers.filter((provider) => provider.enabled));

  let errors = $state<SettingErrors>({});
  let version = $state<string | undefined>();
  let check = $state<UpdateCheck>({ status: 'idle' });
  const updateStatus = $derived.by(() => {
    if (update) {
      if (installing) return `Installing ${update}…`;
      return updateError ? `Could not install ${update}: ${updateError}` : `${update} is available`;
    }
    if (check.status === 'checking') return 'Checking…';
    if (check.status === 'failed') return `Could not check: ${check.error}`;
    return check.status === 'current' ? 'Up to date' : 'Checked every 6 hours';
  });

  async function checkForUpdate(): Promise<void> {
    check = { status: 'checking' };
    try {
      // A found version reaches App through the update event and comes back as `update`.
      check = { status: (await api.checkForUpdate()) ? 'idle' : 'current' };
    } catch (error) {
      check = { status: 'failed', error: errorMessage(error) };
    }
  }

  onMount(() => {
    void api.appVersion().then(
      (value) => (version = value),
      () => undefined,
    );
    void api.settingErrors().then(
      (value) => (errors = value),
      () => undefined,
    );
    return api.onSettingErrors((value) => {
      errors = value;
    });
  });

  function move(index: number, offset: number): void {
    const target = index + offset;
    const providers = [...settings.providers];
    const [moved] = providers.splice(index, 1);
    if (!moved || target < 0 || target > providers.length) return;
    providers.splice(target, 0, moved);
    onPatch({ providers });
  }

  function describedBy(key: keyof SettingErrors): string | undefined {
    return errors[key] === undefined ? undefined : `${key}-error`;
  }

  function toggleProvider(key: QuotaProviderKey, enabled: boolean): void {
    onPatch({
      providers: settings.providers.map((entry) => (entry.key === key ? { ...entry, enabled } : entry)),
    });
  }
</script>

{#snippet rowLabel(label: string, key: keyof SettingErrors)}
  <span class="row-text"
    >{label}{#if errors[key]}<small id="{key}-error" class="row-error">{errors[key]}</small>{/if}</span
  >
{/snippet}

<header class="s-head">
  <button class="icon" type="button" aria-label="Back" onclick={onBack}
    ><Icon name="back" size={16} /></button
  >
  <h1>Settings</h1>
</header>

<section class="group" aria-labelledby="g-providers">
  <h2 id="g-providers">Providers</h2>
  {#each settings.providers as provider, index (provider.key)}
    <div class="row">
      <span class="row-label"
        ><ProviderIcon provider={provider.key} size={14} />{provider.label}</span
      >
      <span class="row-controls">
        <button
          class="icon icon-sm"
          type="button"
          aria-label="Move {provider.label} up"
          disabled={index === 0}
          onclick={() => move(index, -1)}><Icon name="chevron-up" size={13} /></button
        >
        <button
          class="icon icon-sm"
          type="button"
          aria-label="Move {provider.label} down"
          disabled={index === settings.providers.length - 1}
          onclick={() => move(index, 1)}><Icon name="chevron-down" size={13} /></button
        >
        <input
          class="switch"
          type="checkbox"
          aria-label="Show {provider.label}"
          checked={provider.enabled}
          onchange={(event) => toggleProvider(provider.key, event.currentTarget.checked)}
        />
      </span>
    </div>
  {/each}
</section>

<section class="group" aria-labelledby="g-display">
  <h2 id="g-display">Display</h2>
  <label class="row" for="set-theme">
    <span>Theme</span>
    <select
      id="set-theme"
      value={settings.theme}
      onchange={(event) => onPatch({ theme: event.currentTarget.value as Settings['theme'] })}
    >
      <option value="system">System</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>
  </label>
  <label class="row" for="set-display">
    <span>Limits show</span>
    <select
      id="set-display"
      value={settings.display}
      onchange={(event) => onPatch({ display: event.currentTarget.value as Settings['display'] })}
    >
      <option value="used">Used</option>
      <option value="left">Left</option>
    </select>
  </label>
  <label class="row" for="set-reset">
    <span>Reset times</span>
    <select
      id="set-reset"
      value={settings.resetDisplay}
      onchange={(event) =>
        onPatch({ resetDisplay: event.currentTarget.value as Settings['resetDisplay'] })}
    >
      <option value="absolute">Clock time</option>
      <option value="relative">Countdown</option>
    </select>
  </label>
  <label class="row" for="set-tray-provider">
    <span>Tray provider</span>
    <select
      id="set-tray-provider"
      value={enabled.some(({ key }) => key === settings.trayProvider) ? settings.trayProvider : 'auto'}
      onchange={(event) =>
        onPatch({ trayProvider: event.currentTarget.value as Settings['trayProvider'] })}
    >
      <option value="auto">{settings.trayStyle === 'bars' ? 'All providers' : 'Most used'}</option>
      {#each enabled as provider (provider.key)}
        <option value={provider.key}>{provider.label}</option>
      {/each}
    </select>
  </label>
  {#if settings.trayStyle === 'icon'}
    <label class="row" for="set-tray-window">
      <span>Tray limit</span>
      <select
        id="set-tray-window"
        value={settings.trayWindow}
        onchange={(event) =>
          onPatch({ trayWindow: event.currentTarget.value as Settings['trayWindow'] })}
      >
        <option value="highest">Most used</option>
        <option value="session">Session</option>
        <option value="weekly">Weekly</option>
      </select>
    </label>
  {/if}
  <label class="row" for="set-tray-style">
    <span>Tray style</span>
    <select
      id="set-tray-style"
      value={settings.trayStyle}
      onchange={(event) => onPatch({ trayStyle: event.currentTarget.value as Settings['trayStyle'] })}
    >
      <option value="icon">Icon</option>
      <option value="bars">Bars</option>
    </select>
  </label>
  <label class="row" for="set-tray-colored">
    <span>Colored tray icon</span>
    <input
      id="set-tray-colored"
      class="switch"
      type="checkbox"
      checked={settings.trayColored}
      onchange={(event) => onPatch({ trayColored: event.currentTarget.checked })}
    />
  </label>
</section>

<section class="group" aria-labelledby="g-general">
  <h2 id="g-general">General</h2>
  <label class="row" for="set-alerts">
    <span class="row-text">Alerts<small>When a limit is almost used up or will run out</small></span>
    <input
      id="set-alerts"
      class="switch"
      type="checkbox"
      checked={settings.notifications}
      onchange={(event) => onPatch({ notifications: event.currentTarget.checked })}
    />
  </label>
  <label class="row" for="set-pull">
    <span class="row-text">Include other machines<small>Pulls your aitrack data repo</small></span>
    <input
      id="set-pull"
      class="switch"
      type="checkbox"
      checked={settings.pullSyncedData}
      onchange={(event) => onPatch({ pullSyncedData: event.currentTarget.checked })}
    />
  </label>
  <label class="row" for="set-login">
    {@render rowLabel('Start at login', 'launchAtLogin')}
    <input
      id="set-login"
      class="switch"
      type="checkbox"
      aria-invalid={errors.launchAtLogin !== undefined}
      aria-describedby={describedBy('launchAtLogin')}
      checked={settings.launchAtLogin}
      onchange={(event) => onPatch({ launchAtLogin: event.currentTarget.checked })}
    />
  </label>
  <label class="row" for="set-shortcut">
    {@render rowLabel('Shortcut', 'globalShortcut')}
    <input
      id="set-shortcut"
      type="text"
      placeholder="Ctrl+Shift+U"
      aria-invalid={errors.globalShortcut !== undefined}
      aria-describedby={describedBy('globalShortcut')}
      value={settings.globalShortcut}
      onchange={(event) => onPatch({ globalShortcut: event.currentTarget.value })}
    />
  </label>
</section>

<section class="group" aria-labelledby="g-about">
  <h2 id="g-about">About</h2>
  <div class="row">
    <span>Version</span>
    <span class="row-value">{version ?? '…'}</span>
  </div>
  <div class="row">
    <span class="row-text"
      >Updates<small class:row-error={updateError || check.status === 'failed'}
        >{updateStatus}</small
      ></span
    >
    {#if update && !installing}
      <button class="link" type="button" onclick={onInstallUpdate}
        >{updateError ? 'Retry' : 'Install and restart'}</button
      >
    {:else if !update}
      <button
        class="link"
        type="button"
        disabled={check.status === 'checking'}
        onclick={() => void checkForUpdate()}>Check now</button
      >
    {/if}
  </div>
</section>

<button class="quit" type="button" onclick={() => void api.quit()}>Quit opentrack</button>

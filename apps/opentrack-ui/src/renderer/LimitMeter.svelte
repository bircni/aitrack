<script lang="ts">
  import { clampPercent, projectPace } from 'aitrack-lib/quota/pacing';

  import { meterTone } from '../shared/pace.js';
  import type { QuotaWindow, Settings } from '../shared/types.js';
  import { fillPercent, formatLimitValue, formatReset, paceLabel } from './format.js';

  interface Props {
    window: QuotaWindow;
    settings: Settings;
    now: number;
    onToggleUsage: () => void;
    onToggleReset: () => void;
  }

  let { window, settings, now, onToggleUsage, onToggleReset }: Props = $props();

  const pace = $derived(projectPace(window, now));
  const label = $derived(paceLabel(pace, now));
  const reset = $derived(formatReset(window.resetsAt, now, settings.resetDisplay));
  const tick = $derived(
    label === undefined || pace.evenPacePercent === null
      ? null
      : settings.display === 'left'
        ? 100 - pace.evenPacePercent
        : pace.evenPacePercent,
  );
</script>

<div class="limit tone-{meterTone(window, pace)}">
  <div class="l-row">
    <span class="l-name">{window.label}</span>
    <button class="l-value" type="button" title="Show used or left" onclick={onToggleUsage}
      >{formatLimitValue(window, settings.display)}</button
    >
  </div>
  <div
    class="track"
    role="meter"
    aria-label="{window.label} used"
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={Math.round(clampPercent(window.usedPercent))}
  >
    <div class="fill" style:width="{fillPercent(window, settings.display)}%"></div>
    {#if tick !== null}
      <span class="tick" style:left="{clampPercent(tick)}%" title="Even pace"></span>
    {/if}
  </div>
  {#if reset || label}
    <div class="l-meta">
      {#if reset}
        <button type="button" title="Show time or countdown" onclick={onToggleReset}>{reset}</button>
      {:else}
        <span></span>
      {/if}
      {#if label}<span class="l-pace">{label}</span>{/if}
    </div>
  {/if}
</div>

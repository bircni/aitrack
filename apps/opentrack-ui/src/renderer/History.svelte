<script lang="ts">
  import type { ProviderState } from '../shared/types.js';
  import {
    buildHistory,
    formatCost,
    formatDay,
    type HistoryBucket,
    type HistoryRange,
  } from './format.js';
  import ProviderIcon from './ProviderIcon.svelte';

  interface Props {
    providers: ProviderState[];
    /** Bound by App, so a visit to another tab or Settings keeps them. */
    range?: HistoryRange;
    bucket?: HistoryBucket;
  }

  let { providers, range = $bindable(30), bucket = $bindable('day') }: Props = $props();

  const WIDTH = 320;
  const HEIGHT = 96;
  const history = $derived(buildHistory(providers, range, bucket));
  const peak = $derived(history.peakUSD);
  const slot = $derived(WIDTH / Math.max(1, history.bars.length));
  const gap = $derived(Math.min(2, slot * 0.2));
  const ranges: Array<{ value: HistoryRange; label: string }> = [
    { value: 30, label: '30 days' },
    { value: 90, label: '90 days' },
  ];
  const buckets: Array<{ value: HistoryBucket; label: string }> = [
    { value: 'day', label: 'Day' },
    { value: 'week', label: 'Week' },
  ];
  const partial = $derived(history.hasUnpricedTokens ? ' (partial)' : '');
  const chartLabel = $derived(
    `Estimated cost per ${bucket}, last ${String(range)} days, peak ${formatCost(peak)} on ${formatDay(history.busiest)}`,
  );
  const busiestLabel = $derived(`Busiest ${bucket}`);
  const emptyText = $derived(`No priced usage in the last ${String(range)} days.`);
  const bars = $derived(
    history.bars.map((bar) => {
      const split = bar.parts
        .filter((part) => part.costUSD > 0)
        .map((part) => `${part.label} ${formatCost(part.costUSD)}`)
        .join(', ');
      return {
        start: bar.start,
        title: `${bucket === 'day' ? 'Day' : 'Week of'} ${formatDay(bar.start)} · ${formatCost(bar.totalUSD)}${split ? ` (${split})` : ''}`,
        layers: layers(bar.parts),
      };
    }),
  );

  function layers(parts: Array<{ key: string; costUSD: number }>) {
    let offset = 0;
    return parts
      .filter((part) => part.costUSD > 0)
      .map((part) => {
        const height = (part.costUSD / peak) * HEIGHT;
        offset += height;
        return { key: part.key, className: `h-bar h-bar--${part.key}`, y: HEIGHT - offset, height };
      });
  }
</script>

<section class="history" aria-label="Estimated cost history">
  <div class="summary-top">
    <h2 class="eyebrow">History</h2>
    <div class="h-controls">
      <div class="seg" role="group" aria-label="Range">
        {#each ranges as option (option.value)}
          <button
            type="button"
            aria-pressed={range === option.value}
            onclick={() => (range = option.value)}>{option.label}</button
          >
        {/each}
      </div>
      <div class="seg" role="group" aria-label="Group by">
        {#each buckets as option (option.value)}
          <button
            type="button"
            aria-pressed={bucket === option.value}
            onclick={() => (bucket = option.value)}>{option.label}</button
          >
        {/each}
      </div>
    </div>
  </div>

  {#if peak > 0}
    <svg
      class="h-chart"
      viewBox="0 0 {WIDTH} {HEIGHT}"
      preserveAspectRatio="none"
      role="img"
      aria-label={chartLabel}
    >
      {#each bars as bar, index (bar.start)}
        <g>
          <title>{bar.title}</title>
          {#each bar.layers as layer (layer.key)}
            <rect
              class={layer.className}
              x={index * slot + gap / 2}
              y={layer.y}
              width={Math.max(0.5, slot - gap)}
              height={layer.height}
            />
          {/each}
        </g>
      {/each}
    </svg>
    <div class="h-axis">
      <span>{formatDay(history.from)}</span>
      <span>peak {formatCost(peak)}</span>
      <span>{formatDay(history.to)}</span>
    </div>

    <div class="h-stats">
      <div><span class="sub">Total{partial}</span><strong>{formatCost(history.totalUSD)}</strong></div>
      <div><span class="sub">Per day{partial}</span><strong>{formatCost(history.averageUSD)}</strong></div>
      <div>
        <span class="sub">{busiestLabel}</span><strong>{formatDay(history.busiest)}</strong>
      </div>
    </div>

    <div class="summary-providers" role="group" aria-label="Estimated cost by provider">
      {#each history.byProvider as part (part.key)}
        <div class="summary-provider">
          <span class="summary-provider-name">
            <span class="h-swatch h-swatch--{part.key}"></span>
            <ProviderIcon provider={part.key} size={12} />
            <span>{part.label}</span>
          </span>
          <span class="summary-provider-value"
            >{part.costUSD > 0 ? formatCost(part.costUSD) : '—'}{part.hasUnpricedTokens
              ? ' (partial)'
              : ''}</span
          >
        </div>
      {/each}
    </div>
  {:else}
    <p class="empty">{emptyText}</p>
  {/if}
</section>

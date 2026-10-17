<script lang="ts">
  import type { ProviderState } from '../shared/types.js';
  import {
    buildHistory,
    formatCost,
    type HistoryBucket,
    type HistoryRange,
  } from './format.js';
  import ProviderIcon from './ProviderIcon.svelte';

  interface Props {
    providers: ProviderState[];
  }

  let { providers }: Props = $props();
  let range = $state<HistoryRange>(30);
  let bucket = $state<HistoryBucket>('day');

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
  const chartLabel = $derived(
    `Spend per ${bucket}, last ${String(range)} days, peak ${formatCost(peak)}`,
  );
  const busiestLabel = $derived(`Busiest ${bucket}`);
  const emptyText = $derived(`No priced usage in the last ${String(range)} days.`);
  const bars = $derived(
    history.bars.map((bar) => ({
      start: bar.start,
      title: `${bucket === 'day' ? 'Day' : 'Week of'} ${bar.start} · ${formatCost(bar.totalUSD)}`,
      layers: layers(bar.parts),
    })),
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

<section class="history" aria-label="Spend history">
  <div class="summary-top">
    <span class="eyebrow">History</span>
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
      <span>{history.from}</span>
      <span>peak {formatCost(peak)}</span>
      <span>{history.to}</span>
    </div>

    <div class="h-stats">
      <div><span class="sub">Total</span><strong>{formatCost(history.totalUSD)}</strong></div>
      <div><span class="sub">Per day</span><strong>{formatCost(history.averageUSD)}</strong></div>
      <div>
        <span class="sub">{busiestLabel}</span><strong>{history.busiest}</strong>
      </div>
    </div>

    <div class="summary-providers" aria-label="Spend by provider">
      {#each history.byProvider as part (part.key)}
        <div class="summary-provider">
          <span class="summary-provider-name">
            <ProviderIcon provider={part.key} size={12} />
            <span>{part.label}</span>
          </span>
          <span class="summary-provider-value">{formatCost(part.costUSD)}</span>
        </div>
      {/each}
    </div>
  {:else}
    <p class="empty">{emptyText}</p>
  {/if}
</section>

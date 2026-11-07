<script lang="ts">
  import type { ProviderState } from '../shared/types.js';
  import {
    combinedDaily,
    formatCost,
    formatTokens,
    isPriced,
    PERIOD_LABELS,
    type Period,
    periodSpend,
    spendLabel,
    sparkline,
    splitAmount,
    totalSpend,
    USAGE_NOTES,
    type UsageAvailability,
  } from './format.js';

  import ProviderIcon from './ProviderIcon.svelte';

  interface Props {
    providers: ProviderState[];
    machineCount: number;
    availability: UsageAvailability;
    period: Period;
    onPeriod: (period: Period) => void;
    onMachines?: () => void;
  }

  let { providers, machineCount, availability, period, onPeriod, onMachines }: Props = $props();

  const usages = $derived(providers.map((provider) => provider.usage));
  const spend = $derived(totalSpend(usages, period));
  const amount = $derived(splitAmount(spend.costUSD));
  const daily = $derived(period === 'all' ? [] : combinedDaily(usages));
  const curve = $derived(sparkline(daily.map((day) => day.costUSD), 112, 36));
  const peak = $derived(Math.max(0, ...daily.map((day) => day.costUSD)));
  const sparkLabel = $derived(`Estimated cost per day, last 30 days, peak ${formatCost(peak)}`);
</script>

<section class="summary" aria-label="Estimated cost">
  <div class="summary-top">
    <h2 class="eyebrow">Est. cost</h2>
    <div class="seg" role="group" aria-label="Period">
      {#each Object.entries(PERIOD_LABELS) as [key, label] (key)}
        <button
          type="button"
          aria-pressed={period === key}
          onclick={() => {
            onPeriod(key as Period);
          }}>{label}</button
        >
      {/each}
    </div>
  </div>
  <div class="figure-row">
    <div>
      <div class="amount">
        {#if availability === 'ready' && isPriced(spend)}{amount.whole}<span class="cents"
            >{amount.cents}</span
          >{amount.tail}{:else}—{/if}
      </div>
      {#if availability === 'ready' && spend.hasCost && spend.hasUnpricedTokens}
        <span class="sub">Partial estimate</span>
      {/if}
      <div class="sub">
        {availability === 'ready'
          ? `${formatTokens(spend.tokens)} tokens`
          : USAGE_NOTES[availability]}{#if machineCount > 1}&nbsp;·
          {#if onMachines}<button class="link sub-link" type="button" onclick={onMachines}
              >{machineCount} machines</button
            >{:else}{machineCount} machines{/if}{/if}
      </div>
    </div>
    {#if curve}
      <div class="spark-box">
        <svg class="spark" viewBox="0 0 112 36" role="img" aria-label={sparkLabel}>
          <path d={curve.area} class="spark-area" />
          <path d={curve.line} class="spark-line" />
          <circle cx={curve.end.x} cy={curve.end.y} r="2.6" class="spark-end" />
        </svg>
        <span class="spark-span" aria-hidden="true">30 days</span>
      </div>
    {/if}
  </div>
  {#if providers.length > 0}
    <div class="summary-providers" role="group" aria-label="Estimated cost by provider">
      {#each providers as provider (provider.key)}
        {@const value = periodSpend(provider.usage, period)}
        {@const reading = provider.usage ? `${formatTokens(value.tokens)} tokens` : 'usage unavailable'}
        <div class="summary-provider" title="{provider.label}: {reading}">
          <span class="summary-provider-name">
            <ProviderIcon provider={provider.key} size={12} />
            {provider.label}
          </span>
          <span class="summary-provider-value"
            >{provider.usage ? spendLabel(value) : '—'}<span class="sr-only">, {reading}</span></span
          >
        </div>
      {/each}
    </div>
  {/if}
</section>

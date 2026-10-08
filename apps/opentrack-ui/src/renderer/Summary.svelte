<script lang="ts">
  import type { ProviderState } from '../shared/types.js';
  import {
    combinedDaily,
    formatTokens,
    isPriced,
    PERIOD_LABELS,
    type Period,
    periodSpend,
    spendLabel,
    sparkline,
    splitAmount,
    totalSpend,
  } from './format.js';

  import ProviderIcon from './ProviderIcon.svelte';

  interface Props {
    providers: ProviderState[];
    machineCount: number;
    period: Period;
    onPeriod: (period: Period) => void;
    onMachines?: () => void;
  }

  let { providers, machineCount, period, onPeriod, onMachines }: Props = $props();

  const usages = $derived(providers.map((provider) => provider.usage));
  const spend = $derived(totalSpend(usages, period));
  const amount = $derived(splitAmount(spend.costUSD));
  const daily = $derived(period === 'all' ? [] : combinedDaily(usages));
  const curve = $derived(sparkline(daily.map((day) => day.costUSD), 112, 36));
  const peak = $derived(Math.max(0, ...daily.map((day) => day.costUSD)));
</script>

<section class="summary" aria-label="Spend">
  <div class="summary-top">
    <span class="eyebrow">Spend</span>
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
        {#if isPriced(spend)}{amount.whole}<span class="cents"
            >{amount.cents}</span
          >{:else}—{/if}
      </div>
      {#if spend.hasCost && spend.hasUnpricedTokens}
        <span class="sub">Partial estimate</span>
      {/if}
      <div class="sub">
        {formatTokens(spend.tokens)} tokens{#if machineCount > 1}&nbsp;·
          {#if onMachines}<button class="link sub-link" type="button" onclick={onMachines}
              >{machineCount} machines</button
            >{:else}{machineCount} machines{/if}{/if}
      </div>
    </div>
    {#if curve}
      <svg
        class="spark"
        viewBox="0 0 112 36"
        role="img"
        aria-label="Spend per day, last 30 days, peak ${Math.round(peak)}"
      >
        <path d={curve.area} class="spark-area" />
        <path d={curve.line} class="spark-line" />
        <circle cx={curve.end.x} cy={curve.end.y} r="2.6" class="spark-end" />
      </svg>
    {/if}
  </div>
  {#if providers.length > 0}
    <div class="summary-providers" aria-label="Spend by provider">
      {#each providers as provider (provider.key)}
        {@const value = periodSpend(provider.usage, period)}
        <div
          class="summary-provider"
          title={provider.usage
            ? `${provider.label}: ${formatTokens(value.tokens)} tokens`
            : `${provider.label}: usage unavailable`}
        >
          <span class="summary-provider-name">
            <ProviderIcon provider={provider.key} size={12} />
            {provider.key === 'claude_code' ? 'Claude' : provider.label}
          </span>
          <span class="summary-provider-value">{provider.usage ? spendLabel(value) : '—'}</span>
        </div>
      {/each}
    </div>
  {/if}
</section>

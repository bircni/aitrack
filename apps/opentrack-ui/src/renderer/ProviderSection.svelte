<script lang="ts">
  import { slide } from 'svelte/transition';

  import {
    isQuotaProvider,
    type ProviderState,
    type QuotaProviderKey,
    type Settings,
  } from '../shared/types.js';
  import {
    formatCost,
    formatNumber,
    formatUpdated,
    PERIOD_LABELS,
    type Period,
    periodSpend,
    problemLine,
    slideDuration,
    spendLabel,
    spendReading,
  } from './format.js';
  import Icon from './Icon.svelte';
  import LimitMeter from './LimitMeter.svelte';
  import ProviderIcon from './ProviderIcon.svelte';

  interface Props {
    provider: ProviderState;
    settings: Settings;
    now: number;
    period: Period;
    onPatch: (patch: Partial<Settings>) => void;
    onRefresh: () => void;
    onOpenDashboard: (provider: QuotaProviderKey) => void;
  }

  let { provider, settings, now, period, onPatch, onRefresh, onOpenDashboard }: Props = $props();
  let open = $state(false);

  const spend = $derived(periodSpend(provider.usage, period));
  const quotaKey = $derived(isQuotaProvider(provider.key) ? provider.key : undefined);
  const problem = $derived(
    provider.quotaError ? problemLine(provider.quotaError, now, provider.retryAt) : undefined,
  );
</script>

<section class="provider provider--{provider.key}" aria-label={provider.label}>
  <button
    class="p-head"
    type="button"
    aria-expanded={open}
    disabled={!provider.usage}
    onclick={() => (open = !open)}
  >
    <span class="p-mark"><ProviderIcon provider={provider.key} size={18} /></span>
    <span class="p-identity">
      <span class="p-name">{provider.label}</span>
      {#if provider.quota?.plan}<span class="p-plan">{provider.quota.plan}</span>{/if}
    </span>
    {#if provider.refreshing}<span class="p-busy" role="img" aria-label="Refreshing"></span>{/if}
    <span class="p-cost">{provider.usage ? spendLabel(spend) : '—'}</span>
    {#if provider.usage}
      <span class="p-chevron" class:expanded={open}><Icon name="chevron-down" size={13} /></span>
    {/if}
  </button>

  {#if provider.quotaError && provider.quota}
    <div class="state">Cached limits: {formatUpdated(provider.quota.fetchedAt, now)}</div>
  {/if}
  {#if problem && provider.quotaError}
    <div class="state">
      <span title={provider.quotaError.message}>{problem.text}</span>
      {#if problem.retry}
        <button class="link" type="button" onclick={onRefresh}>Retry</button>
      {:else}
        {#if quotaKey}
          <button class="link" type="button" onclick={() => onOpenDashboard(quotaKey)}
            >Open dashboard</button
          >
        {/if}
      {/if}
    </div>
  {/if}

  {#each provider.quota?.windows ?? [] as window (window.id)}
    <LimitMeter
      {window}
      {settings}
      {now}
      onToggleUsage={() => onPatch({ display: settings.display === 'used' ? 'left' : 'used' })}
      onToggleReset={() =>
        onPatch({ resetDisplay: settings.resetDisplay === 'relative' ? 'absolute' : 'relative' })}
    />
  {/each}

  {#each provider.quota?.values ?? [] as value (value.id)}
    <div class="l-row">
      <span class="l-name">{value.label}</span>
      <span class="l-static"
        >{value.format === 'dollars' ? formatCost(value.value) : formatNumber(value.value)}</span
      >
    </div>
  {/each}

  {#if quotaKey && !provider.quota && !provider.quotaError}
    <div class="state"><span>Checking limits…</span></div>
  {/if}

  {#if open && provider.usage}
    <div class="details" transition:slide={{ duration: slideDuration() }}>
      <div class="d-row"><span>{PERIOD_LABELS.today}</span><span>{spendReading(provider.usage.today)}</span></div>
      <div class="d-row"><span>Yesterday</span><span>{spendReading(provider.usage.yesterday)}</span></div>
      <div class="d-row"><span>{PERIOD_LABELS.week}</span><span>{spendReading(provider.usage.last7Days)}</span></div>
      <div class="d-row"><span>{PERIOD_LABELS.month}</span><span>{spendReading(provider.usage.last30Days)}</span></div>
      <div class="d-row"><span>{PERIOD_LABELS.all}</span><span>{spendReading(provider.usage.allTime)}</span></div>
      {#if spend.models.length > 0}
        <div class="d-rule"></div>
        <div class="d-heading">Models · {PERIOD_LABELS[period]}</div>
        {#each spend.models as model (model.model)}
          <div class="d-row d-model">
            <span>{model.model}</span><span>{spendReading(model)}</span>
          </div>
        {/each}
      {/if}
    </div>
  {/if}
</section>

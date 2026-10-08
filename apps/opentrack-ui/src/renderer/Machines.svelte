<script lang="ts">
  import { compareByCostThenTokens } from 'aitrack-lib/data/sort';
  import { slide } from 'svelte/transition';

  import type { MachineUsage, ProviderState, ProviderUsages, Spend } from '../shared/types.js';
  import {
    combinedDaily,
    formatCost,
    formatTokens,
    heatLevel,
    PERIOD_LABELS,
    type Period,
    periodSpend,
    spendLabel,
    syncStatus,
    totalSpend,
    zoneClock,
  } from './format.js';
  import Icon from './Icon.svelte';
  import ProviderIcon from './ProviderIcon.svelte';

  interface Props {
    machines: MachineUsage[];
    accountUsage?: ProviderUsages;
    /** The enabled providers; a machine's other providers are left out. */
    providers: ProviderState[];
    period: Period;
    now: number;
  }

  let { machines, accountUsage, providers, period, now }: Props = $props();
  let open = $state<string | undefined>();

  const labels = $derived(
    Object.fromEntries(providers.map((provider) => [provider.key, provider.label])),
  );
  const rows = $derived.by(() => {
    const keys = providers.map((provider) => provider.key);
    const row = (id: string, name: string, usages: ProviderUsages, machine?: MachineUsage) => {
      const parts = keys
        .map((key) => ({ key, spend: periodSpend(usages[key], period) }))
        .filter((part) => part.spend.tokens > 0);
      return {
        id,
        name,
        machine,
        parts,
        spend: totalSpend(
          keys.map((key) => usages[key]),
          period,
        ),
        daily: combinedDaily(keys.map((key) => usages[key])),
        models: parts
          .flatMap((part) => part.spend.models)
          .toSorted(compareByCostThenTokens)
          .slice(0, 3),
      };
    };
    const list = machines.map((machine) =>
      row(`machine:${machine.name}`, machine.name, machine.providers, machine),
    );
    const account = keys.filter((key) => accountUsage?.[key]).map((key) => labels[key]);
    if (accountUsage && account.length > 0) {
      list.push(row('account', `${account.join(', ')} account`, accountUsage));
    }
    return list.toSorted((a, b) => compareByCostThenTokens(a.spend, b.spend));
  });
  // Shares follow cost while anything is priced, so an unpriced machine does not look free.
  const byCost = $derived(rows.some((row) => row.spend.costUSD > 0));
  const measure = (spend: Spend): number => (byCost ? spend.costUSD : spend.tokens);
  const total = $derived(rows.reduce((sum, row) => sum + measure(row.spend), 0));
  // One scale for every strip, so a busy day looks busy next to the other machines too.
  const peak = $derived(Math.max(0, ...rows.flatMap((row) => row.daily.map((day) => day.costUSD))));

  function reading(value: Spend): string {
    const tokens = `${formatTokens(value.tokens)} tokens`;
    return value.hasCost ? `${spendLabel(value)} · ${tokens}` : tokens;
  }
</script>

<section class="machines" aria-label="Usage by machine">
  {#each rows as row (row.id)}
    {@const share = total > 0 ? measure(row.spend) / total : 0}
    <article class="machine" class:current={row.machine?.current}>
      <button
        class="m-head"
        type="button"
        aria-expanded={open === row.id}
        onclick={() => (open = open === row.id ? undefined : row.id)}
      >
        <span class="m-mark"><Icon name={row.machine ? 'laptop' : 'cloud'} size={17} /></span>
        <span class="m-identity">
          <span class="m-name">
            {row.name}
            {#if row.machine?.current}<span class="m-badge">This machine</span>{/if}
          </span>
          <span class="m-meta">
            {#if row.machine}
              {@const status = syncStatus(row.machine, now)}
              {@const clock = zoneClock(row.machine.timezone, now)}
              <span class="m-dot" class:stale={status.stale}></span>{status.text}
              {#if clock}<span title={row.machine.timezone}>&nbsp;· {clock} there</span>{/if}
            {:else}
              Account-wide, not tied to a machine
            {/if}
          </span>
        </span>
        <span class="m-cost">{spendLabel(row.spend)}</span>
      </button>

      {#if share > 0}
        <div class="m-share" title="{Math.round(share * 100)}% of {byCost ? 'spend' : 'tokens'}">
          <div class="m-bar">
            {#each row.parts as part (part.key)}
              <span
                class="m-part m-part--{part.key}"
                style:width="{(measure(part.spend) / total) * 100}%"
              ></span>
            {/each}
          </div>
          <span class="m-percent">{Math.round(share * 100)}%</span>
        </div>
      {/if}

      {#if row.daily.length > 0}
        <div class="m-strip" role="img" aria-label="Spend per day, last 30 days">
          {#each row.daily as day (day.date)}
            <span
              class="m-cell"
              data-level={heatLevel(day.costUSD, peak)}
              title="{day.date} · {formatCost(day.costUSD)}"
            ></span>
          {/each}
        </div>
      {/if}

      {#if open === row.id}
        <div class="details" transition:slide={{ duration: 160 }}>
          {#each row.parts as part (part.key)}
            <div class="d-row">
              <span class="m-provider"
                ><ProviderIcon provider={part.key} size={12} />{labels[part.key]}</span
              ><span>{reading(part.spend)}</span>
            </div>
          {:else}
            <div class="d-row"><span>No usage · {PERIOD_LABELS[period]}</span></div>
          {/each}
          {#if row.models.length > 0}
            <div class="d-rule"></div>
            <div class="d-heading">Top models · {PERIOD_LABELS[period]}</div>
            {#each row.models as model (model.model)}
              <div class="d-row d-model"><span>{model.model}</span><span>{reading(model)}</span></div>
            {/each}
          {/if}
        </div>
      {/if}
    </article>
  {/each}
  {#if machines.length === 1}
    <p class="empty">
      Run <code>aitrack init</code> with the same data repo on another machine to compare them here.
    </p>
  {/if}
</section>

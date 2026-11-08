<script lang="ts">
  import { INIT_HINT, compareByCostThenTokens, tokenIntensityLevel } from '../shared/core.js';
  import { slide } from 'svelte/transition';

  import type { DailyUsage, MachineUsage, ProviderState, ProviderUsages } from '../shared/types.js';
  import {
    combinedDaily,
    dayCostLabel,
    formatCost,
    formatDay,
    formatPercent,
    PERIOD_LABELS,
    type Period,
    periodSpend,
    shareBasis,
    spendLabel,
    slideDuration,
    spendReading,
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
  const basis = $derived(shareBasis(rows.map((row) => row.spend)));
  // One scale for every strip, so a busy day looks busy next to the other machines too.
  const peak = $derived(Math.max(0, ...rows.flatMap((row) => row.daily.map((day) => day.costUSD))));

  function stripLabel(daily: DailyUsage[]): string {
    const busiest = daily.reduce((best, day) => (day.costUSD > best.costUSD ? day : best));
    return busiest.costUSD > 0
      ? `Estimated cost per day, last 30 days, peak ${formatCost(busiest.costUSD)} on ${formatDay(busiest.date)}`
      : 'Estimated cost per day, last 30 days, nothing priced';
  }
</script>

<section class="machines" aria-label="Usage by machine">
  {#each rows as row (row.id)}
    {@const share = basis.total > 0 ? basis.measure(row.spend) / basis.total : 0}
    {@const percent = formatPercent(share)}
    <article class="card machine" class:current={row.machine?.current}>
      <button
        class="m-head"
        type="button"
        aria-expanded={open === row.id}
        onclick={() => (open = open === row.id ? undefined : row.id)}
      >
        <span class="m-mark"><Icon name={row.machine ? 'laptop' : 'cloud'} size={17} /></span>
        <span class="m-identity">
          <span class="m-name">
            <span class="m-name-text" title={row.name}>{row.name}</span>
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
        <span class="p-chevron" class:expanded={open === row.id}
          ><Icon name="chevron-down" size={13} /></span
        >
      </button>

      {#if share > 0}
        <div class="m-share" title="{percent} of {basis.byCost ? 'cost' : 'tokens'}">
          <div class="m-bar">
            {#each row.parts as part (part.key)}
              <span
                class="m-part m-part--{part.key}"
                style:width="{(basis.measure(part.spend) / basis.total) * 100}%"
              ></span>
            {/each}
          </div>
          <span class="m-percent">{percent}</span>
        </div>
      {/if}

      {#if row.daily.length > 0}
        <div class="m-strip" role="img" aria-label={stripLabel(row.daily)}>
          {#each row.daily as day (day.date)}
            <span
              class="m-cell"
              data-level={day.costUSD > 0
                ? tokenIntensityLevel(day.costUSD, peak)
                : day.hasUnpricedTokens
                  ? 1
                  : 0}
              title="{formatDay(day.date)} · {dayCostLabel(day)}"
            ></span>
          {/each}
        </div>
      {/if}

      {#if open === row.id}
        <div class="details" transition:slide={{ duration: slideDuration() }}>
          {#each row.parts as part (part.key)}
            <div class="d-row">
              <span class="m-provider"
                ><ProviderIcon provider={part.key} size={12} />{labels[part.key]}</span
              ><span>{spendReading(part.spend)}</span>
            </div>
          {:else}
            <div class="d-row"><span>No usage · {PERIOD_LABELS[period]}</span></div>
          {/each}
          {#if row.models.length > 0}
            <div class="d-rule"></div>
            <div class="d-heading">Top models · {PERIOD_LABELS[period]}</div>
            {#each row.models as model (model.model)}
              <div class="d-row d-model">
                <span title={model.model}>{model.model}</span><span>{spendReading(model)}</span>
              </div>
            {/each}
          {/if}
        </div>
      {/if}
    </article>
  {/each}
  {#if machines.length === 1}
    <p class="empty">
      Run <code>{INIT_HINT}</code> with the same data repo on another machine to compare them here.
    </p>
  {/if}
</section>

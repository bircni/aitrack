<script lang="ts">
  import { slide } from 'svelte/transition';

  import type { ProjectUsages, ProviderKey, Spend } from '../shared/types.js';
  import {
    formatPercent,
    PERIOD_LABELS,
    type Period,
    periodProjects,
    slideDuration,
    spendLabel,
    spendReading,
  } from './format.js';
  import ProviderIcon from './ProviderIcon.svelte';

  interface Props {
    projects?: ProjectUsages;
    period: Period;
  }

  let { projects, period }: Props = $props();
  let open = $state<string | undefined>();

  const entries = $derived(periodProjects(projects, period));
  // Shares follow cost while anything is priced, so an unpriced project does not look free.
  const byCost = $derived(entries.some((entry) => entry.costUSD > 0));
  const measure = (spend: Spend): number => (byCost ? spend.costUSD : spend.tokens);
  const total = $derived(entries.reduce((sum, entry) => sum + measure(entry), 0));
  const rows = $derived(
    entries.map((entry) => {
      const share = measure(entry) / total; // Zero or NaN hides the bar, so an empty total needs no guard.
      const percent = formatPercent(share);
      return {
        project: entry.project,
        unattributed: entry.unattributed === true,
        cost: spendLabel(entry),
        reading: spendReading(entry),
        share,
        percent,
        title: `${percent} of ${byCost ? 'spend' : 'tokens'}`,
        parts: entry.providers.map((part) => ({
          key: part.key as ProviderKey,
          label: part.label,
          reading: spendReading(part),
          width: (measure(part) / total) * 100,
        })),
      };
    }),
  );
  const emptyText = $derived(
    `No project usage ${PERIOD_LABELS[period].toLowerCase()}. Usage is attributed to projects from the next sync or refresh onward.`,
  );
</script>

<section class="machines projects" aria-label="Usage by project">
  {#each rows as row (row.project)}
    <article class="machine project" class:remainder={row.unattributed}>
      <button
        class="m-head"
        type="button"
        aria-expanded={open === row.project}
        onclick={() => (open = open === row.project ? undefined : row.project)}
      >
        <span class="m-identity">
          <span class="m-name" title={row.project}>{row.project}</span>
          <span class="m-meta">{row.reading}</span>
        </span>
        <span class="m-cost">{row.cost}</span>
      </button>

      {#if row.share > 0}
        <div class="m-share" title={row.title}>
          <div class="m-bar">
            {#each row.parts as part (part.key)}
              <span class="m-part m-part--{part.key}" style:width="{part.width}%"></span>
            {/each}
          </div>
          <span class="m-percent">{row.percent}</span>
        </div>
      {/if}

      {#if open === row.project}
        <div class="details" transition:slide={{ duration: slideDuration() }}>
          {#each row.parts as part (part.key)}
            <div class="d-row">
              <span class="m-provider"><ProviderIcon provider={part.key} size={12} />{part.label}</span
              ><span>{part.reading}</span>
            </div>
          {/each}
        </div>
      {/if}
    </article>
  {:else}
    <p class="empty">{emptyText}</p>
  {/each}
  {#if rows.length > 0}
    <p class="empty">Cursor is not attributed to projects and is not counted here.</p>
  {/if}
</section>

<script lang="ts">
  import { slide } from 'svelte/transition';

  import type { ProjectUsages, QuotaProviderKey } from '../shared/types.js';
  import {
    formatPercent,
    formatTokens,
    PERIOD_LABELS,
    type Period,
    periodProjects,
    shareBasis,
    slideDuration,
    spendLabel,
    spendReading,
  } from './format.js';
  import Icon from './Icon.svelte';
  import ProviderIcon from './ProviderIcon.svelte';

  interface Props {
    projects?: ProjectUsages;
    period: Period;
    /** Cursor has no project data, so saying it is left out only matters while it is on. */
    cursorEnabled?: boolean;
  }

  let { projects, period, cursorEnabled = true }: Props = $props();
  let open = $state<string | undefined>();

  const entries = $derived(periodProjects(projects, period));
  const basis = $derived(shareBasis(entries));
  const rows = $derived(
    entries.map((entry) => {
      const share = basis.measure(entry) / basis.total; // Zero or NaN hides the bar, so an empty total needs no guard.
      const percent = formatPercent(share);
      return {
        project: entry.project,
        unattributed: entry.unattributed === true,
        cost: spendLabel(entry),
        tokens: `${formatTokens(entry.tokens)} tokens`,
        share,
        percent,
        title: `${percent} of ${basis.byCost ? 'cost' : 'tokens'}`,
        parts: entry.providers.map((part) => ({
          key: part.key as QuotaProviderKey,
          label: part.label,
          reading: spendReading(part),
          width: (basis.measure(part) / basis.total) * 100,
        })),
      };
    }),
  );
  const span = $derived(period === 'all' ? 'yet' : period === 'today' ? 'today' : `in the last ${PERIOD_LABELS[period]}`);
  const emptyText = $derived(
    projects
      ? `No project usage ${span}.`
      : 'No project usage yet. Usage is attributed to projects from the next sync or refresh onward.',
  );
</script>

<section class="machines projects" aria-label="Usage by project">
  {#each rows as row (row.project)}
    <article class="card machine project" class:remainder={row.unattributed}>
      <button
        class="m-head"
        type="button"
        aria-expanded={open === row.project}
        onclick={() => (open = open === row.project ? undefined : row.project)}
      >
        <span class="m-identity">
          <span class="m-name"><span class="m-name-text" title={row.project}>{row.project}</span></span>
          <span class="m-meta">{row.tokens}</span>
        </span>
        <span class="m-cost">{row.cost}</span>
        <span class="p-chevron" class:expanded={open === row.project}
          ><Icon name="chevron-down" size={13} /></span
        >
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
  {#if rows.length > 0 && cursorEnabled}
    <p class="empty">Cursor is not attributed to projects and is not counted here.</p>
  {/if}
</section>

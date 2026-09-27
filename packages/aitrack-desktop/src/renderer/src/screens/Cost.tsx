import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { costWindow, daysIn, parseCostSpan, sumCost, type CostSpan } from '../costWindow';
import { Explain } from '../Explain';
import { compact, localDay, money, providerLabel } from '../format';
import { StackedCost } from '../StackedCost';
import { ask } from '../types';

export function CostScreen() {
  const queryClient = useQueryClient();
  const usage = useQuery({ queryKey: ['cost'], queryFn: () => ask('cost:get') });
  const [span, setSpan] = useState<CostSpan>('30');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [exportNote, setExportNote] = useState<string | null>(null);
  const refresh = useMutation({
    mutationFn: () => ask('cost:refresh'),
    onSuccess: (result) => {
      setExportNote(result.message);
      void queryClient.invalidateQueries({ queryKey: ['cost'] });
      void queryClient.invalidateQueries({ queryKey: ['models'] });
      void queryClient.invalidateQueries({ queryKey: ['budget'] });
    },
  });
  const save = useMutation({
    mutationFn: (kind: 'pdf' | 'csv') => ask('export:save', { kind }),
    onSuccess: (result) => {
      setExportNote(result.message);
    },
  });
  const budget = useQuery({
    queryKey: ['budget'],
    queryFn: () => ask('cost:budget'),
  });
  const window = costWindow(span, localDay(), customFrom, customTo);
  const models = useQuery({
    queryKey: ['models', window.current.from, window.current.to],
    queryFn: () => ask('cost:models', { from: window.current.from, to: window.current.to }),
  });
  const days = usage.data ?? [];
  const total = sumCost(days);
  const shown = daysIn(days, window.current);
  const earlier = window.previous === null ? [] : daysIn(days, window.previous);
  const shownCost = sumCost(shown);
  const earlierCost = sumCost(earlier);
  const tokens = shown.reduce((sum, day) => sum + day.inputTokens + day.outputTokens, 0);

  return (
    <div className="flex flex-col gap-4">
      <section className="glass pane settle p-8">
        <div className="mb-4 flex flex-wrap gap-2">
          <select
            aria-label="Window"
            className="glass chip bg-transparent px-3 py-1"
            value={span}
            onChange={(event) => {
              const next = parseCostSpan(event.target.value);
              if (next !== null) setSpan(next);
            }}
          >
            <option value="all">All time</option>
            <option value="today">Today</option>
            <option value="7">7 days</option>
            <option value="30">30 days</option>
            <option value="90">90 days</option>
            <option value="custom">Custom</option>
          </select>
          {span === 'custom' ? (
            <>
              <input
                aria-label="From"
                type="date"
                className="glass chip bg-transparent px-3 py-1"
                value={customFrom}
                onChange={(event) => {
                  setCustomFrom(event.target.value);
                }}
              />
              <input
                aria-label="To"
                type="date"
                className="glass chip bg-transparent px-3 py-1"
                value={customTo}
                onChange={(event) => {
                  setCustomTo(event.target.value);
                }}
              />
            </>
          ) : null}
        </div>
        <Explain
          caption={window.currentLabel}
          figure={money(shownCost)}
          figureClassName="text-[52px] leading-none"
          rule={window.currentRule}
        />
        <div className="mt-2 text-[var(--muted)]">
          <Explain
            figure={`${compact(tokens)} tokens`}
            rule="Input plus output tokens in this window. Cache writes are included where the provider counts them as input."
          />
          <span className="ml-2">list price</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-x-6 text-[13px] text-[var(--muted)]">
          {window.previousLabel !== null && window.previousRule !== null ? (
            <Explain
              figure={`${window.previousLabel} ${money(earlierCost)}`}
              rule={window.previousRule}
            />
          ) : null}
          <Explain
            figure={`On record ${money(total)}`}
            rule="Sum of every stored day total on this machine, from the same readers as aitrack usage."
          />
        </div>
        {budget.data?.status ? (
          <div className="mt-2 text-[15px]">
            <Explain
              figure={`This month ${money(budget.data.status.spentUSD)} of ${money(budget.data.status.budgetUSD)}`}
              rule="Calendar-month spend against the monthly budget in your aitrack config. A warning starts at 80% of the ceiling."
            />
            <span className="ml-3 text-[var(--muted)]">
              {budget.data.status.level === 'over'
                ? `${money(budget.data.status.overUSD)} over the ceiling`
                : budget.data.status.level === 'warn'
                  ? 'Past 80% of the ceiling'
                  : 'Inside the ceiling'}
            </span>
          </div>
        ) : null}
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            className="chip glass px-4 py-2"
            onClick={() => {
              refresh.mutate();
            }}
          >
            Refresh Cursor
          </button>
          <button
            type="button"
            className="chip glass px-4 py-2"
            onClick={() => {
              save.mutate('pdf');
            }}
          >
            Export PDF
          </button>
          <button
            type="button"
            className="chip glass px-4 py-2"
            onClick={() => {
              save.mutate('csv');
            }}
          >
            Export CSV
          </button>
        </div>
        {exportNote ? <p className="mt-3 text-[13px] text-[var(--muted)]">{exportNote}</p> : null}
        <div className="mt-6">
          <StackedCost days={shown} />
        </div>
      </section>
      <section className="glass panel p-6">
        <h2 className="num text-[24px]">By provider</h2>
        <ul className="mt-3 space-y-2">
          {['claude_code', 'codex', 'cursor'].map((provider) => {
            const subset = shown.filter((day) => day.provider === provider);
            const cost = subset.reduce((sum, day) => sum + day.costUsd, 0);
            return (
              <li key={provider} className="flex justify-between">
                <span>{providerLabel(provider)}</span>
                <Explain
                  figure={money(cost)}
                  rule={`Sum of ${providerLabel(provider)} day totals in this window.`}
                />
              </li>
            );
          })}
        </ul>
      </section>
      <section className="glass panel p-6">
        <h2 className="num text-[24px]">By model</h2>
        <p className="mt-1 text-[13px] text-[var(--muted)]">
          Session cost in this window lands on a model when that session used one model. Mixed
          sessions stay in their own row.
        </p>
        <ul className="mt-3 space-y-2">
          {(models.data ?? []).length === 0 ? (
            <li className="text-[var(--muted)]">No session cost yet.</li>
          ) : null}
          {(models.data ?? []).map((row) => (
            <li key={row.model} className="flex justify-between gap-4">
              <span>
                {row.model}
                <span className="ml-3 text-[13px] text-[var(--muted)]">
                  {row.sessions} sessions
                </span>
              </span>
              <Explain
                figure={money(row.costUsd)}
                rule="Sum of session cost for sessions in this window whose tokens all came from this model. A session that used more than one model is listed on its own."
              />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

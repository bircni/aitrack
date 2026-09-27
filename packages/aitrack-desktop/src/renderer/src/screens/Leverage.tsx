import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { Explain } from '../Explain';
import { metricText } from '../format';
import { ask, type ComparisonRow, type MetricResult } from '../types';

export function LeverageScreen() {
  const [span, setSpan] = useState<Span>('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [repoId, setRepoId] = useState<string | null>(null);
  const [provider, setProvider] = useState<'claude' | 'codex' | 'cursor' | null>(null);
  const repos = useQuery({
    queryKey: ['repos'],
    queryFn: () => ask('repos:list'),
  });
  const leverage = useQuery({
    queryKey: ['leverage', span, customFrom, customTo, repoId, provider],
    placeholderData: (previous) => previous,
    queryFn: () =>
      ask('leverage:get', {
        ...windowRange(span, customFrom, customTo),
        repoId,
        provider,
      }),
  });
  const report = leverage.data?.report;
  if (!report) return <section className="glass panel p-6">Reading sessions…</section>;
  return (
    <div className="flex flex-col gap-4">
      <svg width="0" height="0" className="absolute" aria-hidden="true">
        <filter id="refract">
          <feTurbulence type="fractalNoise" baseFrequency="0.012" numOctaves="2" result="noise" />
          <feDisplacementMap
            in="SourceGraphic"
            in2="noise"
            scale="8"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </svg>
      <section className="glass pane refract settle p-6">
        <div className="flex items-end justify-between">
          <div>
            <h2 className="num text-[34px] leading-none">Linked, and on your own</h2>
            <div className="mt-3 max-w-[58ch] text-[var(--muted)]">
              <Explain
                plain
                figure={linkedShare(report.linkedCommits, report.humanCommits)}
                rule="Linked commits divided by every commit in this window. Commits with no session are the baseline beside them."
              />
              <span>
                {' '}
                {String(report.humanCommits)} in the same repos do not. That second group is the
                baseline.
              </span>
            </div>
          </div>
          <p className="chip glass px-3 py-1 text-[13px]">
            {report.confidence === 'low' ? 'Too few to trust' : 'Enough commits'}
          </p>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <select
            aria-label="Window"
            className="glass chip bg-transparent px-3 py-1"
            value={span}
            onChange={(event) => {
              const next = parseSpan(event.target.value);
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
          <select
            aria-label="Repo"
            className="glass chip bg-transparent px-3 py-1"
            value={repoId ?? ''}
            onChange={(event) => {
              setRepoId(event.target.value === '' ? null : event.target.value);
            }}
          >
            <option value="">All repos</option>
            {(repos.data ?? []).map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Provider"
            className="glass chip bg-transparent px-3 py-1"
            value={provider ?? ''}
            onChange={(event) => {
              const value = event.target.value;
              if (value === 'claude' || value === 'codex' || value === 'cursor') setProvider(value);
              else setProvider(null);
            }}
          >
            <option value="">All tools</option>
            <option value="claude">Claude Code</option>
            <option value="codex">Codex</option>
            <option value="cursor">Cursor</option>
          </select>
        </div>
        <div className="mt-5 grid grid-cols-[1.4fr_1fr_1fr] gap-x-4 text-[13px] text-[var(--muted)]">
          <span />
          <span>Linked</span>
          <span>On your own</span>
          {report.comparisons.map((row) => (
            <Comparison key={row.id} row={row} />
          ))}
        </div>
        <p className="mt-4 text-[13px] text-[var(--muted)]">
          {ratingLine(report.ratings)} in this window.
        </p>
      </section>
      <div className="grid grid-cols-3 gap-4">
        <MetricColumn title="Speed" metrics={report.speed} />
        <MetricColumn
          title="Quality"
          metrics={[...report.quality, leverage.data?.tabs].filter(
            (item): item is NonNullable<typeof item> => item !== undefined,
          )}
        />
        <MetricColumn title="Cost" metrics={report.cost} />
      </div>
    </div>
  );
}

type Span = 'all' | 'today' | '7' | '30' | '90' | 'custom';

const SPANS = ['all', 'today', '7', '30', '90', 'custom'] as const;

function parseSpan(value: string): Span | null {
  for (const span of SPANS) {
    if (value === span) return span;
  }
  return null;
}

function windowRange(
  span: Span,
  customFrom: string,
  customTo: string,
): { from: string | null; to: string | null } {
  switch (span) {
    case 'all': {
      return { from: null, to: null };
    }
    case 'today': {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      return { from: start.toISOString(), to: new Date().toISOString() };
    }
    case '7':
    case '30':
    case '90': {
      return rolling(span);
    }
    case 'custom': {
      return { from: dayBound(customFrom, false), to: dayBound(customTo, true) };
    }
    default: {
      const unexpected: never = span;
      return unexpected;
    }
  }
}

function rolling(span: '7' | '30' | '90'): { from: string; to: string } {
  const to = new Date();
  let days: number;
  switch (span) {
    case '7': {
      days = 7;
      break;
    }
    case '30': {
      days = 30;
      break;
    }
    case '90': {
      days = 90;
      break;
    }
    default: {
      const unexpected: never = span;
      days = unexpected;
    }
  }
  return {
    from: new Date(to.getTime() - days * 24 * 60 * 60 * 1000).toISOString(),
    to: to.toISOString(),
  };
}

function dayBound(day: string, end: boolean): string | null {
  if (day === '') return null;
  const parsed = new Date(`${day}T${end ? '23:59:59' : '00:00:00'}`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function linkedShare(linked: number, human: number): string {
  const total = linked + human;
  if (total === 0) return 'No commits in this window have a session behind them.';
  const percent = Math.round((linked / total) * 100);
  return `${String(linked)} of ${String(total)} commits (${String(percent)}%) have a session behind them.`;
}

function ratingLine(ratings: {
  kept: number;
  reworked: number;
  discarded: number;
  unrated: number;
}): string {
  return `${String(ratings.kept)} kept, ${String(ratings.reworked)} reworked, ${String(ratings.discarded)} discarded, ${String(ratings.unrated)} unrated`;
}

function Comparison({ row }: { row: ComparisonRow }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="py-1 text-left text-[15px] text-[var(--text)]"
        onClick={() => {
          setOpen((value) => !value);
        }}
      >
        {row.label}
        {open ? (
          <span className="mt-1 block text-[13px] text-[var(--muted)]">{row.rule}</span>
        ) : null}
      </button>
      <span className="num py-1 text-[24px] text-[var(--text)]">
        {metricText(row.linked, row.unit)}
      </span>
      <span className="num py-1 text-[24px] text-[var(--text)]">
        {metricText(row.human, row.unit)}
      </span>
    </>
  );
}

function MetricColumn({ title, metrics }: { title: string; metrics: MetricResult[] }) {
  return (
    <section className="glass panel settle settle-late p-5">
      <h3 className="num text-[24px]">{title}</h3>
      <ul className="mt-3 space-y-4">
        {metrics.map((metric) => (
          <li key={metric.id}>
            <p className="text-[13px] text-[var(--muted)]">{metric.label}</p>
            <p className="num text-[24px] leading-none">{metricText(metric.value, metric.unit)}</p>
            <p className="text-[13px] text-[var(--faint)]">{metric.rule}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

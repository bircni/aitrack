import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { Explain } from '../Explain';
import { money, providerLabel, when } from '../format';
import { ask, type SessionDetail } from '../types';

export function SessionsScreen() {
  const [selected, setSelected] = useState<string | null>(null);
  const [provider, setProvider] = useState('all');
  const [rating, setRating] = useState('all');
  const [link, setLink] = useState('all');
  const [branch, setBranch] = useState('');
  const [repo, setRepo] = useState('all');
  const sessions = useQuery({
    queryKey: ['sessions'],
    queryFn: () => ask('sessions:list'),
  });
  const visible = (sessions.data ?? []).filter((session) => {
    if (provider !== 'all' && session.provider !== provider) return false;
    if (rating === 'unrated' && session.rating !== null) return false;
    if (rating !== 'all' && rating !== 'unrated' && session.rating !== rating) return false;
    if (link === 'linked' && session.linkedCommits === 0) return false;
    if (link === 'open' && session.linkedCommits > 0) return false;
    if (branch !== '' && !(session.branch ?? '').toLowerCase().includes(branch.toLowerCase())) {
      return false;
    }
    if (repo !== 'all' && session.repoId !== repo) return false;
    return true;
  });
  const repos = [
    ...new Set(
      (sessions.data ?? [])
        .map((session) => session.repoId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const current = visible.some((session) => session.id === selected)
    ? selected
    : (visible[0]?.id ?? null);
  const detail = useQuery({
    queryKey: ['session', current],
    queryFn: () => {
      if (current === null) return Promise.reject(new Error('No session'));
      return ask('sessions:get', { id: current });
    },
    enabled: current !== null,
  });

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_minmax(320px,0.9fr)] gap-4">
      <section className="glass panel settle overflow-auto p-4">
        <div className="mb-3 flex flex-wrap gap-2">
          <Filter
            label="Provider"
            value={provider}
            onChange={setProvider}
            options={[
              ['all', 'All tools'],
              ['claude', 'Claude Code'],
              ['codex', 'Codex'],
              ['cursor', 'Cursor'],
            ]}
          />
          <Filter
            label="Rating"
            value={rating}
            onChange={setRating}
            options={[
              ['all', 'Any rating'],
              ['kept', 'Kept'],
              ['reworked', 'Reworked'],
              ['discarded', 'Discarded'],
              ['unrated', 'Unrated'],
            ]}
          />
          <Filter
            label="Link"
            value={link}
            onChange={setLink}
            options={[
              ['all', 'Linked or not'],
              ['linked', 'Linked'],
              ['open', 'Unlinked'],
            ]}
          />
          <Filter
            label="Repo"
            value={repo}
            onChange={setRepo}
            options={[['all', 'All repos'], ...repos.map((id) => [id, repoName(id)] as const)]}
          />
          <input
            aria-label="Branch"
            value={branch}
            placeholder="Branch"
            className="glass chip bg-transparent px-3 py-1"
            onChange={(event) => {
              setBranch(event.target.value);
            }}
          />
        </div>
        {visible.length === 0 ? (
          <p className="p-4 text-[var(--muted)]">
            {(sessions.data ?? []).length === 0
              ? 'No sessions yet. Start a tool in a git repo and this fills in by itself.'
              : 'Nothing matches these filters.'}
          </p>
        ) : (
          <ul>
            {visible.map((session) => (
              <li key={session.id} className="flex items-baseline gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setSelected(session.id);
                  }}
                  className={`flex min-w-0 flex-1 items-baseline justify-between rounded-xl px-3 py-3 text-left ${current === session.id ? 'bg-[oklch(1_0_0/0.1)]' : ''}`}
                >
                  <span>
                    <span className="block">
                      {session.title ?? providerLabel(session.provider)}
                    </span>
                    <span className="text-[13px] text-[var(--muted)]">
                      {providerLabel(session.provider)}
                      <span className="ml-3">{when(session.startedAt)}</span>
                      <span className="ml-3">{session.linkedCommits} linked</span>
                    </span>
                  </span>
                </button>
                {session.tokensKnown ? (
                  <Explain
                    figure={money(session.costUsd)}
                    rule="List price for this session's tokens. It uses the same pricing as the day totals."
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      <SessionDetailPane id={current} detail={detail.data ?? null} />
    </div>
  );
}

function repoName(id: string): string {
  const parts = id.split(/[/\\]/u);
  return parts.at(-1) ?? id;
}

function Filter({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<readonly [string, string]>;
}) {
  return (
    <select
      aria-label={label}
      className="glass chip bg-transparent px-3 py-1"
      value={value}
      onChange={(event) => {
        onChange(event.target.value);
      }}
    >
      {options.map(([option, text]) => (
        <option key={option} value={option}>
          {text}
        </option>
      ))}
    </select>
  );
}

function noteOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function SessionDetailPane({ id, detail }: { id: string | null; detail: SessionDetail | null }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<{ id: string; note: string } | null>(null);
  const note = draft?.id === id ? draft.note : (detail?.ratingNote ?? '');
  const rate = useMutation({
    mutationFn: (body: { rating: 'kept' | 'reworked' | 'discarded'; note: string | null }) => {
      if (id === null) return Promise.reject(new Error('No session'));
      return ask('sessions:rate', { id, rating: body.rating, note: body.note });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['session', id] });
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
  if (id === null || detail === null) {
    return <section className="glass panel p-6 text-[var(--muted)]">Select a session.</section>;
  }
  return (
    <section className="glass panel settle settle-late overflow-auto p-6">
      <h2 className="num text-[34px]">{detail.title ?? providerLabel(detail.provider)}</h2>
      <p className="mt-1 text-[13px] text-[var(--muted)]">
        {providerLabel(detail.provider)}
        <span className="ml-3">{detail.userMessages} prompts</span>
        <span className="ml-3">{detail.assistantMessages} replies</span>
        <span className="ml-3">{detail.toolCalls} tool calls</span>
      </p>
      {detail.branches.length > 1 ? (
        <p className="mt-2 text-[13px] text-[var(--muted)]">
          Branch changed from {detail.branches.join(' to ')}.
        </p>
      ) : null}
      {detail.tokensKnown ? (
        <div className="mt-4">
          <Explain
            figure={money(detail.costUsd)}
            figureClassName="text-[34px]"
            rule="List price for this session's tokens, using the same pricing as the day totals."
          />
        </div>
      ) : (
        <p className="mt-3 text-[13px] text-[var(--faint)]">
          Cursor does not record tokens per session. Cost for Cursor is on the Cost screen, by day.
        </p>
      )}
      <div className="mt-4 flex gap-2">
        {(['kept', 'reworked', 'discarded'] as const).map((rating) => (
          <button
            key={rating}
            type="button"
            className={`chip glass px-3 py-1 ${detail.rating === rating ? 'bg-[oklch(1_0_0/0.16)]' : ''}`}
            aria-pressed={detail.rating === rating}
            onClick={() => {
              rate.mutate({ rating, note: noteOrNull(note) });
            }}
          >
            {rating === 'kept' ? 'Kept' : rating === 'reworked' ? 'Reworked' : 'Discarded'}
          </button>
        ))}
      </div>
      <label className="mt-3 block text-[13px] text-[var(--muted)]">
        Note
        <input
          aria-label="Rating note"
          className="glass chip mt-1 w-full bg-transparent px-3 py-1 text-[var(--text)]"
          value={note}
          placeholder="Optional"
          onChange={(event) => {
            setDraft({ id, note: event.target.value });
          }}
          onBlur={() => {
            if (detail.rating === null) return;
            const next = noteOrNull(note);
            if (next === detail.ratingNote) return;
            rate.mutate({ rating: detail.rating, note: next });
          }}
        />
      </label>
      <h3 className="mt-6 text-[13px] text-[var(--muted)]">Turns</h3>
      <ul className="mt-2 space-y-1 text-[13px]">
        {detail.turns.length === 0 ? (
          <li className="text-[var(--faint)]">No turns recorded.</li>
        ) : null}
        {detail.turns.map((turn) => (
          <li key={turn.index}>
            {turn.role}
            <span className="ml-3 text-[var(--muted)]">{when(turn.startedAt)}</span>
            {turn.model ? <span className="ml-3 text-[var(--muted)]">{turn.model}</span> : null}
            {turn.toolCalls > 0 ? (
              <span className="ml-3 text-[var(--muted)]">{turn.toolCalls} tools</span>
            ) : null}
            {turn.sidechain ? <span className="ml-3 text-[var(--faint)]">Sidechain</span> : null}
          </li>
        ))}
      </ul>
      <h3 className="mt-6 text-[13px] text-[var(--muted)]">Files</h3>
      <ul className="mt-2 space-y-1 text-[13px]">
        {detail.files.length === 0 ? (
          <li className="text-[var(--faint)]">No files recorded.</li>
        ) : null}
        {detail.files.slice(0, 12).map((file) => (
          <li key={`${file.kind}-${file.path}`}>
            {file.kind} {file.path}
          </li>
        ))}
      </ul>
      <h3 className="mt-6 text-[13px] text-[var(--muted)]">Linked commits</h3>
      <ul className="mt-2 space-y-3">
        {detail.links.length === 0 ? (
          <li className="text-[var(--faint)]">Nothing linked yet.</li>
        ) : null}
        {detail.links.map((link) => (
          <li key={link.sha}>
            <p>
              {link.subject} <span className="text-[var(--muted)]">{link.confidence}</span>
            </p>
            <p className="text-[13px] text-[var(--muted)]">{link.explanation}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { ask, type Bootstrap } from '../types';

function checkWord(status: 'ok' | 'warn' | 'fail'): string {
  switch (status) {
    case 'ok': {
      return 'Ok';
    }
    case 'warn': {
      return 'Warning';
    }
    case 'fail': {
      return 'Failed';
    }
    default: {
      const neverStatus: never = status;
      return neverStatus;
    }
  }
}

export function SettingsScreen() {
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: ['bootstrap'],
    queryFn: () => ask('bootstrap'),
  });
  const sync = useQuery({ queryKey: ['sync'], queryFn: () => ask('sync:status') });
  const sources = useQuery({
    queryKey: ['sources'],
    queryFn: () => ask('sources:get'),
  });
  const diagnostics = useQuery({
    queryKey: ['diagnostics'],
    queryFn: () => ask('diagnostics:get'),
  });
  const budget = useQuery({
    queryKey: ['budget'],
    queryFn: () => ask('cost:budget'),
  });
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [budgetDraft, setBudgetDraft] = useState<string | null>(null);
  const [repoUrl, setRepoUrl] = useState('');
  const monthly = budget.data?.monthlyUSD;
  const budgetShown =
    budgetDraft ?? (monthly === undefined || monthly === null ? '' : String(monthly));
  const update = useMutation({
    mutationFn: (
      body: Partial<Bootstrap> & {
        budgetMonthly?: number | null;
        linkBeforeMin?: number;
        linkAfterHours?: number;
        background?: boolean;
      },
    ) => ask('settings:update', body),
    onSuccess: (result) => {
      setMessage(result.message);
      setBudgetDraft(null);
      void queryClient.invalidateQueries({ queryKey: ['bootstrap'] });
      void queryClient.invalidateQueries({ queryKey: ['budget'] });
    },
  });
  const connect = useMutation({
    mutationFn: () => ask('sync:connect', { confirm: 'clone', repoUrl }),
    onSuccess: (result) => {
      setMessage(result.message);
      if (result.ok) void queryClient.invalidateQueries({ queryKey: ['sync'] });
    },
  });
  const rebuild = useMutation({
    mutationFn: () => ask('ingest:rebuild'),
    onSuccess: () => {
      setMessage('Index rebuilt.');
    },
  });
  const preview = useMutation({
    mutationFn: () => ask('sync:preview'),
    onSuccess: (result) => {
      setConfirming(result.ok);
      setMessage(result.message);
    },
  });
  const push = useMutation({
    mutationFn: () => ask('sync:push', { confirm: 'push' }),
    onSuccess: (result) => {
      setConfirming(false);
      setMessage(result.message);
    },
  });

  return (
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <section className="glass panel settle p-6">
        <h2 className="num text-[34px]">Settings</h2>
        <label className="mt-4 flex items-center justify-between">
          Theme
          <select
            className="glass chip bg-transparent px-3 py-1"
            value={settings.data?.theme ?? 'system'}
            onChange={(event) => {
              update.mutate({ theme: event.target.value as Bootstrap['theme'] });
            }}
          >
            <option value="system">Match the system</option>
            <option value="dark">Dark glass</option>
            <option value="light">Light glass</option>
          </select>
        </label>
        <label className="mt-3 flex items-center justify-between">
          Watch Claude Code
          <input
            type="checkbox"
            checked={settings.data?.claude ?? true}
            onChange={(event) => {
              update.mutate({ claude: event.target.checked });
            }}
          />
        </label>
        <label className="mt-3 flex items-center justify-between">
          Watch Codex
          <input
            type="checkbox"
            checked={settings.data?.codex ?? true}
            onChange={(event) => {
              update.mutate({ codex: event.target.checked });
            }}
          />
        </label>
        <label className="mt-3 flex items-center justify-between">
          Include Cursor
          <input
            type="checkbox"
            checked={settings.data?.cursor ?? true}
            onChange={(event) => {
              update.mutate({ cursor: event.target.checked });
            }}
          />
        </label>
        <label className="mt-3 flex items-center justify-between">
          Menu bar only
          <input
            type="checkbox"
            checked={settings.data?.background ?? true}
            onChange={(event) => {
              update.mutate({ background: event.target.checked });
            }}
          />
        </label>
        <label className="mt-3 flex items-center justify-between">
          Weekly rating reminder
          <input
            type="checkbox"
            checked={settings.data?.rateReminder ?? false}
            onChange={(event) => {
              update.mutate({ rateReminder: event.target.checked });
            }}
          />
        </label>
        <p className="mt-1 text-[13px] text-[var(--muted)]">
          Once a week, the menu bar mentions sessions you have not rated.
        </p>
        <label className="mt-3 flex items-center justify-between">
          Open at login
          <input
            type="checkbox"
            checked={settings.data?.openAtLogin ?? false}
            onChange={(event) => {
              update.mutate({ openAtLogin: event.target.checked });
            }}
          />
        </label>
        <label className="mt-4 flex items-center justify-between gap-4">
          Monthly budget
          <span className="flex items-center gap-2">
            <input
              aria-label="Monthly budget"
              inputMode="decimal"
              value={budgetShown}
              placeholder="None"
              className="glass chip w-28 bg-transparent px-3 py-1"
              onChange={(event) => {
                setBudgetDraft(event.target.value);
              }}
            />
            <button
              type="button"
              className="chip glass px-3 py-1"
              onClick={() => {
                const trimmed = budgetShown.trim();
                if (trimmed === '') {
                  update.mutate({ budgetMonthly: null });
                  return;
                }
                const amount = Number(trimmed);
                if (!(amount > 0)) {
                  setMessage('Budget needs a positive dollar amount.');
                  return;
                }
                update.mutate({ budgetMonthly: amount });
              }}
            >
              Save
            </button>
          </span>
        </label>
        <label className="mt-3 flex items-center justify-between">
          Pause watching
          <input
            type="checkbox"
            checked={settings.data?.paused ?? false}
            onChange={(event) => {
              update.mutate({ paused: event.target.checked });
            }}
          />
        </label>
        <button
          type="button"
          className="chip glass mt-5 px-4 py-2"
          onClick={() => {
            rebuild.mutate();
          }}
        >
          Rebuild index
        </button>
      </section>
      <div className="flex flex-col gap-4">
        <section className="glass panel p-6">
          <h2 className="num text-[24px]">Data repo</h2>
          {sync.data?.cloned ? (
            <>
              <p className="mt-2 text-[var(--muted)]">
                {sync.data.repoUrl}
                <span className="ml-3">{sync.data.machineId}</span>
              </p>
              {confirming ? (
                <div className="mt-4">
                  <p>
                    This writes this machine&apos;s Claude Code and Codex day totals into your data
                    repo and pushes that commit. Cursor stays on this machine. Nothing else is
                    uploaded.
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      className="chip glass px-4 py-2"
                      onClick={() => {
                        push.mutate();
                      }}
                    >
                      Push to your data repo
                    </button>
                    <button
                      type="button"
                      className="chip glass px-4 py-2"
                      onClick={() => {
                        setConfirming(false);
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="chip glass mt-4 px-4 py-2"
                  onClick={() => {
                    preview.mutate();
                  }}
                >
                  Preview push
                </button>
              )}
            </>
          ) : (
            <div className="mt-2">
              <p className="text-[var(--muted)]">
                Not connected. The app is fully useful without one.
              </p>
              <label className="mt-3 block text-[13px] text-[var(--muted)]">
                Data repo URL
                <input
                  aria-label="Data repo URL"
                  value={repoUrl}
                  placeholder="git@github.com:you/aitrack-data.git"
                  className="glass chip mt-1 w-full bg-transparent px-3 py-2 text-[var(--text)]"
                  onChange={(event) => {
                    setRepoUrl(event.target.value);
                  }}
                />
              </label>
              <button
                type="button"
                className="chip glass mt-3 px-4 py-2"
                onClick={() => {
                  if (repoUrl.trim() === '') {
                    setMessage('A git remote URL is required.');
                    return;
                  }
                  connect.mutate();
                }}
              >
                Connect this repo
              </button>
            </div>
          )}
          {message ? <p className="mt-3">{message}</p> : null}
        </section>
        <section className="glass panel p-6">
          <h2 className="num text-[24px]">Diagnostics</h2>
          <ul className="mt-3 space-y-2 text-[13px]">
            {(diagnostics.data?.checks ?? []).map((check) => (
              <li key={check.label}>
                <span className="text-[var(--text)]">{check.label}</span>
                <span className="text-[var(--faint)]"> {checkWord(check.status)}</span>
                <span className="text-[var(--muted)]"> {check.detail}</span>
              </li>
            ))}
          </ul>
          <h3 className="mt-5 text-[13px] text-[var(--text)]">Ingest log</h3>
          {(diagnostics.data?.log.length ?? 0) === 0 ? (
            <p className="mt-2 text-[13px] text-[var(--muted)]">No ingest events yet.</p>
          ) : (
            <ul className="mt-2 space-y-1 text-[13px] text-[var(--muted)]">
              {diagnostics.data?.log.slice(0, 8).map((row) => (
                <li key={`${row.at}-${row.kind}`}>
                  {row.kind}: {row.detail}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="glass panel p-6">
          <h2 className="num text-[24px]">Watch roots</h2>
          <p className="mt-2 text-[13px] text-[var(--muted)]">Claude Code</p>
          <ul className="mt-1 space-y-1 break-all text-[13px]">
            {(sources.data?.claude ?? []).map((root) => (
              <li key={root}>{root}</li>
            ))}
          </ul>
          <p className="mt-3 text-[13px] text-[var(--muted)]">Codex</p>
          <ul className="mt-1 space-y-1 break-all text-[13px]">
            {(sources.data?.codex ?? []).map((root) => (
              <li key={root}>{root}</li>
            ))}
          </ul>
          <p className="mt-4 text-[13px] text-[var(--muted)]">
            A commit can link from {sources.data?.linkBeforeMin ?? 5} minutes before the session
            until {sources.data?.linkAfterHours ?? 6} hours after the last edit. Churn is measured
            at 7 days and again at 30.
          </p>
          <div className="mt-3 flex gap-3">
            <label className="text-[13px] text-[var(--muted)]">
              Minutes before
              <input
                aria-label="Minutes before"
                defaultValue={sources.data?.linkBeforeMin ?? 5}
                className="glass chip mt-1 block w-24 bg-transparent px-3 py-1 text-[var(--text)]"
                onBlur={(event) => {
                  const value = Number(event.target.value);
                  if (value > 0) update.mutate({ linkBeforeMin: value });
                }}
              />
            </label>
            <label className="text-[13px] text-[var(--muted)]">
              Hours after
              <input
                aria-label="Hours after"
                defaultValue={sources.data?.linkAfterHours ?? 6}
                className="glass chip mt-1 block w-24 bg-transparent px-3 py-1 text-[var(--text)]"
                onBlur={(event) => {
                  const value = Number(event.target.value);
                  if (value > 0) update.mutate({ linkAfterHours: value });
                }}
              />
            </label>
          </div>
        </section>
      </div>
    </div>
  );
}

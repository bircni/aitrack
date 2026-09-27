import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { Explain } from '../Explain';
import { when } from '../format';
import { ask, type CommitSummary } from '../types';

export function CommitsScreen() {
  const commits = useQuery({
    queryKey: ['commits'],
    queryFn: () => ask('commits:list'),
  });
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<number | null>(null);
  const sessions = useQuery({
    queryKey: ['sessions'],
    queryFn: () => ask('sessions:list'),
  });
  const decide = useMutation({
    mutationFn: (body: {
      commitId: number;
      sessionId: string;
      decision: 'confirm' | 'reject' | 'link';
    }) => ask('commits:decide', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['commits'] });
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      void queryClient.invalidateQueries({ queryKey: ['commit-links'] });
    },
  });
  const grouped = new Map<string, CommitSummary[]>();
  for (const commit of commits.data ?? []) {
    const list = grouped.get(commit.repoId) ?? [];
    list.push(commit);
    grouped.set(commit.repoId, list);
  }

  return (
    <section className="glass panel settle overflow-auto p-6">
      <h2 className="num text-[34px]">Commits</h2>
      <p className="mt-1 max-w-[62ch] text-[var(--muted)]">
        Linked commits are the ones a session can explain. The rest are the human baseline on the
        Leverage screen.
      </p>
      {[...grouped.entries()].map(([repoId, rows]) => (
        <div key={repoId} className="mt-6">
          <h3 className="text-[13px] text-[var(--muted)]">{repoName(repoId)}</h3>
          <ul className="mt-2 divide-y divide-[oklch(1_0_0/0.08)]">
            {rows.slice(0, 40).map((commit) => (
              <li
                key={commit.id}
                className={`border-l-2 py-3 pl-3 ${commit.linked ? 'border-[var(--claude)]' : 'border-[var(--line)]'}`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <button
                      type="button"
                      className="text-left"
                      onClick={() => {
                        setOpen((current) => (current === commit.id ? null : commit.id));
                      }}
                    >
                      {commit.subject}
                    </button>
                    <div className="mt-1 flex flex-wrap items-baseline gap-x-3 text-[13px] text-[var(--muted)]">
                      <span>{commit.sha.slice(0, 7)}</span>
                      <span>{when(commit.authorTime)}</span>
                      <Explain
                        plain
                        figure={`+${String(commit.insertions)} −${String(commit.deletions)}`}
                        figureClassName="text-[13px]"
                        rule="Lines this commit added and removed, from git numstat."
                      />
                      {commit.testFiles > 0 ? (
                        <Explain
                          plain
                          figure={`${String(commit.testFiles)} tests`}
                          figureClassName="text-[13px]"
                          rule="Files in this commit whose path matches the repo's test globs."
                        />
                      ) : null}
                      {commit.linkScore === null ? null : (
                        <Explain
                          plain
                          figure={`score ${commit.linkScore.toFixed(2)}`}
                          figureClassName="text-[13px]"
                          rule="Score of the strongest session link. 0.60 and above is high, 0.35 medium, 0.20 low."
                        />
                      )}
                      {commit.isRevert ? (
                        <span>
                          {commit.revertOf === null
                            ? 'Revert'
                            : `Reverts ${commit.revertOf.slice(0, 7)}`}
                        </span>
                      ) : null}
                      {commit.unreachable ? <span>No longer in this repo</span> : null}
                      <ChurnLine commit={commit} />
                    </div>
                    {open === commit.id ? (
                      <>
                        <CommitFiles id={commit.id} />
                        <CommitLinks
                          id={commit.id}
                          onDecide={(sessionId, decision) => {
                            decide.mutate({ commitId: commit.id, sessionId, decision });
                          }}
                        />
                        <LinkSession
                          commitId={commit.id}
                          options={sessionOptions(sessions.data ?? [], commit.repoId)}
                          onLink={(sessionId) => {
                            decide.mutate({ commitId: commit.id, sessionId, decision: 'link' });
                          }}
                        />
                      </>
                    ) : null}
                  </div>
                  <span className="text-[13px] text-[var(--muted)]">
                    {commit.linked ? 'Linked' : 'On your own'}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function ChurnLine({ commit }: { commit: CommitSummary }) {
  const rule =
    'Share of added lines that blame no longer attributes to this commit after 7 days, and again after 30. Measured again when HEAD moves. Files over 1 MB or 20k blame lines are skipped.';
  if (commit.churnNote !== null) {
    return (
      <Explain
        plain
        figure={commit.churnNote}
        figureClassName="basis-full text-[13px]"
        rule={rule}
      />
    );
  }
  if (commit.churn7 === null) return null;
  const seven = `${String(Math.round(commit.churn7 * 100))}% of the added lines are no longer this commit at HEAD`;
  const figure =
    commit.churn30 === null
      ? `${seven}.`
      : `${seven}, and ${String(Math.round(commit.churn30 * 100))}% after 30 days.`;
  return <Explain plain figure={figure} figureClassName="basis-full text-[13px]" rule={rule} />;
}

function CommitLinks({
  id,
  onDecide,
}: {
  id: number;
  onDecide: (sessionId: string, decision: 'confirm' | 'reject') => void;
}) {
  const links = useQuery({
    queryKey: ['commit-links', id],
    queryFn: () => ask('commits:links', { id }),
  });
  const rows = links.data ?? [];
  return (
    <div className="mt-3">
      <h3 className="text-[13px] text-[var(--muted)]">Linked sessions</h3>
      {rows.length === 0 ? (
        <p className="mt-1 text-[13px] text-[var(--faint)]">No session linked.</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {rows.map((link) => (
            <li key={link.sessionId}>
              <div className="flex items-baseline justify-between gap-3">
                <span>
                  {link.title ?? link.sessionId}
                  <Explain
                    plain
                    figure={link.score.toFixed(2)}
                    figureClassName="ml-3 text-[13px]"
                    rule="Weighted sum of the signals for this session. 0.60 and above is high, 0.35 medium, 0.20 low."
                  />
                </span>
                <span className="flex gap-2">
                  <button
                    type="button"
                    className="chip glass px-3 py-1 text-[13px]"
                    onClick={() => {
                      onDecide(link.sessionId, 'confirm');
                    }}
                  >
                    Confirm
                  </button>
                  <button
                    type="button"
                    className="chip glass px-3 py-1 text-[13px]"
                    onClick={() => {
                      onDecide(link.sessionId, 'reject');
                    }}
                  >
                    Reject
                  </button>
                </span>
              </div>
              <p className="text-[13px] text-[var(--muted)]">{link.explanation}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CommitFiles({ id }: { id: number }) {
  const files = useQuery({
    queryKey: ['commit-files', id],
    queryFn: () => ask('commits:files', { id }),
  });
  return (
    <ul className="mt-2 space-y-1 text-[13px]">
      {(files.data ?? []).map((file) => (
        <li key={file.path}>
          {file.path}
          {file.insertions === null ? null : (
            <span className="ml-3 text-[var(--muted)]">
              +{file.insertions} −{file.deletions ?? 0}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function LinkSession({
  commitId,
  options,
  onLink,
}: {
  commitId: number;
  options: Array<{ id: string; label: string }>;
  onLink: (sessionId: string) => void;
}) {
  const [sessionId, setSessionId] = useState('');
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <select
        aria-label={`Link a session to commit ${String(commitId)}`}
        className="glass chip bg-transparent px-3 py-1 text-[13px]"
        value={sessionId}
        onChange={(event) => {
          setSessionId(event.target.value);
        }}
      >
        <option value="">Link a session</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="chip glass px-3 py-1 text-[13px]"
        onClick={() => {
          if (sessionId === '') return;
          onLink(sessionId);
        }}
      >
        Link session
      </button>
    </div>
  );
}

function sessionOptions(
  sessions: Array<{ id: string; repoId: string | null; title: string | null }>,
  repoId: string,
): Array<{ id: string; label: string }> {
  const sameRepo = sessions.filter((session) => session.repoId === repoId);
  const choices = sameRepo.length > 0 ? sameRepo : sessions;
  return choices.map((session) => ({ id: session.id, label: session.title ?? session.id }));
}

function repoName(id: string): string {
  const parts = id.split(/[/\\]/u);
  return parts.at(-1) ?? id;
}

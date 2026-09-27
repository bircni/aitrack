import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { when } from '../format';
import { ask, type RepoSummary } from '../types';

export function ReposScreen() {
  const repos = useQuery({ queryKey: ['repos'], queryFn: () => ask('repos:list') });

  return (
    <section className="glass panel settle p-6">
      <h2 className="num text-[34px]">Repos</h2>
      <p className="mt-1 max-w-[58ch] text-[var(--muted)]">
        Found from the working directory of a session. aitrack only runs read-only git in these
        folders.
      </p>
      {(repos.data ?? []).length === 0 ? (
        <p className="mt-4 text-[var(--muted)]">
          No git repos yet. A session inside a repository will add one.
        </p>
      ) : (
        <ul className="mt-4 space-y-3">
          {(repos.data ?? []).map((repo) => (
            <RepoCard key={repo.id} repo={repo} />
          ))}
        </ul>
      )}
    </section>
  );
}

function RepoCard({ repo }: { repo: RepoSummary }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? repo.testGlobs.join(', ');
  const update = useMutation({
    mutationFn: (body: { enabled: boolean; testGlobs: string[] }) =>
      ask('repos:update', { id: repo.id, ...body }),
    onSuccess: () => {
      setDraft(null);
      void queryClient.invalidateQueries({ queryKey: ['repos'] });
    },
  });

  return (
    <li className="glass panel px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p>{repo.name}</p>
          <p className="text-[13px] text-[var(--muted)]">{repo.rootPath}</p>
          <p className="text-[13px] text-[var(--faint)]">
            {repo.remoteUrl ?? 'No remote'}
            <span className="ml-3">
              {repo.gitOk ? 'Git ok' : (repo.gitDetail ?? 'Git has not been read')}
            </span>
            <span className="ml-3">
              Last import {repo.importedAt === null ? 'not yet' : when(repo.importedAt)}
            </span>
          </p>
        </div>
        <button
          type="button"
          className="chip glass px-3 py-1"
          onClick={() => {
            update.mutate({ enabled: !repo.enabled, testGlobs: repo.testGlobs });
          }}
        >
          {repo.enabled ? 'Watching' : 'Paused'}
        </button>
      </div>
      <label className="mt-3 block text-[13px] text-[var(--muted)]">
        Test paths
        <input
          aria-label={`Test paths for ${repo.name}`}
          value={shown}
          placeholder="**/*.test.ts"
          className="glass chip mt-1 w-full bg-transparent px-3 py-1 text-[var(--text)]"
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onBlur={() => {
            const testGlobs = shown
              .split(',')
              .map((glob) => glob.trim())
              .filter((glob) => glob !== '');
            update.mutate({ enabled: repo.enabled, testGlobs });
          }}
        />
      </label>
    </li>
  );
}

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';

import { ask } from '../types';

export function Onboarding() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [claude, setClaude] = useState(true);
  const [codex, setCodex] = useState(true);
  const [cursor, setCursor] = useState(true);
  const [repoUrl, setRepoUrl] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const finish = useMutation({
    mutationFn: async () => {
      if (repoUrl.trim() !== '') {
        const connected = await ask('sync:connect', {
          confirm: 'clone',
          repoUrl,
        });
        if (!connected.ok) throw new Error(connected.message);
      }
      await ask('settings:update', { onboarded: true, claude, codex, cursor });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['bootstrap'] });
      void navigate('/');
    },
    onError: (error: Error) => {
      setNote(error.message);
    },
  });

  return (
    <section className="glass pane settle mx-auto max-w-[640px] p-10">
      <h1 className="num text-[34px] leading-none">Your sessions stay yours.</h1>
      <p className="mt-4 max-w-[52ch] text-[var(--muted)]">
        aitrack reads Claude Code, Codex and Cursor on this machine, then links sessions to git
        commits so cost, speed and quality have an explanation. It does not change those tools, your
        repositories, or anything online unless you later choose to push to a data repo you own.
      </p>
      <ul className="mt-6 space-y-2 text-[15px]">
        <li>Prompts are not stored. Only time, files, tokens and the links between them.</li>
        <li>Git is read-only. No fetch, no checkout, no rewrite.</li>
        <li>Cursor tokens stay on this machine and are never written to the data repo.</li>
      </ul>
      <div className="mt-6 flex flex-col gap-2">
        <WatchToggle label="Claude Code" checked={claude} onChange={setClaude} />
        <WatchToggle label="Codex" checked={codex} onChange={setCodex} />
        <WatchToggle label="Cursor" checked={cursor} onChange={setCursor} />
      </div>
      <label className="mt-6 block text-[13px] text-[var(--muted)]">
        Data repo URL, optional
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
      {note ? <p className="mt-3 text-[13px]">{note}</p> : null}
      <button
        type="button"
        className="glass chip mt-8 px-5 py-2"
        onClick={() => {
          finish.mutate();
        }}
      >
        Start watching
      </button>
    </section>
  );
}

function WatchToggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between">
      Watch {label}
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
    </label>
  );
}

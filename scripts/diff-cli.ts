#!/usr/bin/env tsx
// Runs the 4.x CLI and the Rust CLI on the same fixture home and fails on any difference. Removed at the cut-over.
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { runMain } from './runMain.ts';

const ROOT = resolve(import.meta.dirname, '..');
const FIXTURES = join(ROOT, 'crates/core/tests/fixtures');
const ZONES = ['Pacific/Kiritimati', 'UTC', 'Pacific/Midway', 'Europe/Berlin'];

const WINDOWS = [
  'today',
  'yesterday',
  'date 2026-03-15',
  'range 2025-03-01 2025-04-30',
  'thisweek',
  'lastweek',
  'week',
  'thismonth',
  'lastmonth',
  'month',
  'last 700',
  'year',
  'all',
];

const COMMANDS = [
  ...WINDOWS.flatMap((w) => [
    `usage ${w}`,
    `usage ${w} --json`,
    `usage ${w} --compare --json`,
    `usage ${w} --dir .`,
  ]),
  'usage all --short',
  'usage all --providers codex --json',
  'top days',
  'top days --json --sort cost --limit 5',
  'top projects --json --since 2025-03-01 --until 2026-03-31',
  'top models',
  'top models --json --year 2025',
  'machines',
  'machines --json',
  'show --tui',
  'show --tui --json --all',
  'show --tui --year 2025',
  'export all --csv -o out.csv --json',
  'export range 2025-03-01 2025-04-30 --csv -o out.csv',
  'sync --dry-run --json',
  'doctor',
].map((c) => c.split(' '));

/** What each run writes besides its output, compared after the command. */
const WRITTEN = ['out.csv'];

/** 5.0 no longer needs Node, so doctor stops reporting it; "today" labels carry the second each run started. */
const ACCEPTED: Array<[RegExp, string]> = [
  [/^.*Node\.js: .*\n/gmu, ''],
  [/\d{1,2}:\d{2}:\d{2} [AP]M/gu, 'H:MM:SS'],
];

interface Cli {
  name: string;
  program: string;
  args: string[];
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=parity', '-c', 'user.email=parity@example.com', ...args],
    {
      cwd,
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

/** The fixture machines in a data repo with its own bare remote, plus the reader corpora as local logs. */
function seedHome(home: string): void {
  cpSync(join(FIXTURES, 'usage/home'), home, { recursive: true });
  cpSync(join(FIXTURES, 'readers/corpus/claude'), join(home, '.claude/projects'), {
    recursive: true,
  });
  cpSync(join(FIXTURES, 'readers/corpus/codex'), join(home, '.codex/sessions'), {
    recursive: true,
  });
  const repo = join(home, '.config/aitrack/repo');
  const remote = join(home, 'remote.git');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'seed');
  git(home, 'clone', '-q', '--bare', repo, remote);
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'fetch', '-q', 'origin');
  git(repo, 'branch', '-q', '-u', 'origin/main');
  const config = join(home, '.config/aitrack/config.json');
  const parsed = JSON.parse(readFileSync(config, 'utf8')) as Record<string, unknown>;
  writeFileSync(config, JSON.stringify({ ...parsed, repoUrl: remote }, null, 2));
}

interface Run {
  stdout: string;
  stderr: string;
  status: number | null;
  files: Record<string, string>;
}

function run(cli: Cli, home: string, args: string[], zone: string): Run {
  const result = spawnSync(cli.program, [...cli.args, ...args], {
    cwd: home,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: home,
      TZ: zone,
      NO_COLOR: '1',
      AITRACK_NO_CACHE: '1',
      AITRACK_NO_PRICING_REFRESH: '1',
      CURSOR_STATE_DB_PATH: join(home, 'none.vscdb'),
      GIT_AUTHOR_NAME: 'parity',
      GIT_AUTHOR_EMAIL: 'parity@example.com',
      GIT_COMMITTER_NAME: 'parity',
      GIT_COMMITTER_EMAIL: 'parity@example.com',
      ...(process.platform === 'win32' && {
        USERPROFILE: home,
        APPDATA: join(home, 'AppData/Roaming'),
      }),
    },
  });
  const clean = (text: string) =>
    ACCEPTED.reduce((t, [re, to]) => t.replace(re, to), text.replaceAll(home, '~'));
  const files: Record<string, string> = {};
  for (const name of WRITTEN) {
    const path = join(home, name);
    if (existsSync(path)) files[name] = readFileSync(path, 'utf8');
  }
  return {
    stdout: clean(result.stdout),
    stderr: clean(result.stderr),
    status: result.status,
    files,
  };
}

/** Each machine file, without the write time that differs on every run. */
function machineFiles(home: string): Record<string, string> {
  const data = join(home, '.config/aitrack/repo/data');
  return Object.fromEntries(
    readdirSync(data)
      .toSorted()
      .map((name) => [
        name,
        readFileSync(join(data, name), 'utf8').replace(
          /"lastUpdated": "[^"]*"/u,
          '"lastUpdated": ""',
        ),
      ]),
  );
}

function firstDifference(a: string, b: string): string {
  const left = a.split('\n');
  const right = b.split('\n');
  const line = left.findIndex((text, i) => text !== right[i]);
  const at = line === -1 ? left.length : line;
  return `line ${String(at + 1)}:\n  - ${left[at] ?? '(end)'}\n  + ${right[at] ?? '(end)'}`;
}

function compare(label: string, a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const [left, right] = [a[key], b[key]];
    if (left === right) continue;
    problems.push(
      typeof left === 'string' && typeof right === 'string'
        ? `${label} ${key} differs at ${firstDifference(left, right)}`
        : `${label} ${key}: ${JSON.stringify(left)} vs ${JSON.stringify(right)}`,
    );
  }
  return problems;
}

/** One seeded home per CLI, so neither sees what the other wrote. */
function withHomes(body: (a: string, b: string) => void): void {
  const [a, b] = [0, 1].map(() => mkdtempSync(join(tmpdir(), 'aitrack-parity-'))) as [
    string,
    string,
  ];
  try {
    seedHome(a);
    seedHome(b);
    body(a, b);
  } finally {
    for (const home of [a, b]) rmSync(home, { recursive: true, force: true });
  }
}

function main(): void {
  const script = join(ROOT, 'apps/aitrack/dist/cli.js');
  const ts: Cli = { name: '4.x', program: process.execPath, args: [script] };
  const binary = join(
    ROOT,
    'target/debug',
    process.platform === 'win32' ? 'aitrack.exe' : 'aitrack',
  );
  const rs: Cli = { name: '5.0', program: process.env.AITRACK_RUST_BIN ?? binary, args: [] };
  for (const [cli, path] of [
    [ts, script],
    [rs, rs.program],
  ] as const) {
    if (!existsSync(path)) throw new Error(`Build ${cli.name} first: ${path}`);
  }
  const problems: string[] = [];
  for (const zone of ZONES) {
    withHomes((a, b) => {
      for (const args of COMMANDS) {
        const [left, right] = [run(ts, a, args, zone), run(rs, b, args, zone)];
        const label = `[${zone}] aitrack ${args.join(' ')}:`;
        problems.push(
          ...compare(label, { ...left, files: undefined }, { ...right, files: undefined }),
          ...compare(label, left.files, right.files),
        );
      }
    });
    // These write the machine file and commit, so they get their own homes and run in order.
    withHomes((a, b) => {
      for (const step of [['sync'], ['recompute-costs'], ['sync']]) {
        const label = `[${zone}] aitrack ${step.join(' ')}:`;
        const [left, right] = [run(ts, a, step, zone), run(rs, b, step, zone)];
        if (left.status !== 0) problems.push(`${label} 4.x failed: ${left.stderr}`);
        problems.push(
          ...compare(label, { ...left, files: undefined }, { ...right, files: undefined }),
          ...compare(label, machineFiles(a), machineFiles(b)),
        );
      }
    });
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    throw new Error(`${String(problems.length)} difference(s) between 4.x and 5.0`);
  }
  console.log(
    `No differences across ${String(ZONES.length)} zones and ${String(COMMANDS.length)} commands.`,
  );
}

runMain(import.meta.url, main);

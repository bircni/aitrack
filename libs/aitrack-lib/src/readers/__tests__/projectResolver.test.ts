import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { attributeCwd, createProjectResolver, resolveProjectSelector } from '../projectResolver.js';

let root: string;
let withRemote: string;
let withoutRemote: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'aitrack-project-')));
  withRemote = join(root, 'with-remote');
  withoutRemote = join(root, 'without-remote');
  for (const dir of [withRemote, withoutRemote]) {
    mkdirSync(join(dir, 'sub'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: dir });
  }
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:Owner/Repo.git'], {
    cwd: withRemote,
  });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('project resolution', () => {
  it('resolves a directory to owner/repo and null without a remote or directory', async () => {
    const resolve = createProjectResolver();
    expect(await resolve(join(withRemote, 'sub'))).toBe('owner/repo');
    expect(await resolve(withoutRemote)).toBeNull();
    expect(await resolve(join(root, 'gone'))).toBeNull();
  });

  it('resolves a removed agent worktree through the repository that created it', async () => {
    const resolve = createProjectResolver();
    const gone = join(withRemote, '.claude', 'worktrees', 'agent-1a2b');
    expect(await resolve(gone)).toBe('owner/repo');
    expect(await resolve(join(gone, 'sub'))).toBe('owner/repo');
    expect(await resolve(join(withoutRemote, '.claude', 'worktrees', 'agent-1a2b'))).toBeNull();
  });

  it('attributes a cwd to its project and keeps the cwd of work without a remote', async () => {
    const resolve = createProjectResolver();
    expect(await attributeCwd(resolve, withRemote)).toEqual({ project: 'owner/repo' });
    expect(await attributeCwd(resolve, withoutRemote)).toEqual({
      project: '(no remote)',
      cwd: withoutRemote,
    });
    expect(await attributeCwd(resolve, undefined)).toEqual({ project: '(no remote)' });
  });

  it('selects by project or by directory, and rejects what is not a directory', async () => {
    expect(await resolveProjectSelector(join(withRemote, 'sub'))).toEqual({
      kind: 'project',
      project: 'owner/repo',
    });
    expect(await resolveProjectSelector(withoutRemote)).toEqual({
      kind: 'dir',
      dir: withoutRemote,
    });
    const file = join(root, 'file.txt');
    writeFileSync(file, 'x');
    await expect(resolveProjectSelector(file)).rejects.toThrow('Not a directory');
    await expect(resolveProjectSelector(join(root, 'gone'))).rejects.toThrow('Not a directory');
  });
});

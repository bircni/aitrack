import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  tryLoadConfig: vi.fn(),
  resolveMachineId: vi.fn(),
  isCloned: vi.fn(),
  getClaudePaths: vi.fn(),
  getCodexPaths: vi.fn(),
  getCursorStateDbPath: vi.fn(),
  readCursorAuthState: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawnSync: mocks.spawnSync }));
vi.mock('node:fs', () => ({ existsSync: mocks.existsSync, readdirSync: mocks.readdirSync }));
vi.mock('../../config.js', () => ({
  tryLoadConfig: mocks.tryLoadConfig,
  resolveMachineId: mocks.resolveMachineId,
}));
vi.mock('../../git.js', () => ({
  isCloned: mocks.isCloned,
  LOCAL_REPO: '/repo',
}));
vi.mock('../../readers/claude.js', () => ({ getClaudePaths: mocks.getClaudePaths }));
vi.mock('../../readers/codex.js', () => ({ getCodexPaths: mocks.getCodexPaths }));
vi.mock('../../readers/cursor/auth.js', () => ({
  getCursorStateDbPath: mocks.getCursorStateDbPath,
  readCursorAuthState: mocks.readCursorAuthState,
}));

import { doctorCommand } from '../doctor.js';

function dirent(
  name: string,
  kind: 'dir' | 'file',
): { name: string; isDirectory: () => boolean; isFile: () => boolean } {
  return {
    name,
    isDirectory: () => kind === 'dir',
    isFile: () => kind === 'file',
  };
}

function output(): string {
  return vi
    .mocked(console.log)
    .mock.calls.map((call) => String(call[0]))
    .join('\n');
}

describe('doctorCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    mocks.spawnSync.mockReturnValue({ status: 0 });
    mocks.existsSync.mockImplementation((path: string) => path !== '/missing');
    mocks.readdirSync.mockImplementation((path: string) => {
      if (path === '/claude') return [dirent('project', 'dir')];
      if (path === '/claude/project') return [dirent('history.jsonl', 'file')];
      if (path === '/codex') return [dirent('session.jsonl', 'file')];
      return [];
    });
    mocks.tryLoadConfig.mockReturnValue({ repoUrl: 'git@example.com:me/data.git' });
    mocks.resolveMachineId.mockReturnValue('host');
    mocks.isCloned.mockReturnValue(true);
    mocks.getClaudePaths.mockReturnValue(['/claude']);
    mocks.getCodexPaths.mockReturnValue(['/codex']);
    mocks.getCursorStateDbPath.mockReturnValue('/cursor/state.vscdb');
    mocks.readCursorAuthState.mockResolvedValue({ accessToken: 'token' });
  });

  it('prints healthy setup checks', async () => {
    await doctorCommand();

    const out = output();
    expect(out).toContain('aitrack doctor');
    expect(out).toContain('Node.js');
    expect(out).toContain('Config: repoUrl=git@example.com:me/data.git, machineId=host');
    expect(out).toContain('Claude Code source: 1 JSONL file(s)');
    expect(out).toContain('Codex source: 1 JSONL file(s)');
    expect(out).toContain('Cursor source: auth token found');
    expect(process.exitCode).toBeUndefined();
  });

  it('warns for missing optional setup and cursor auth', async () => {
    mocks.tryLoadConfig.mockReturnValue(null);
    mocks.isCloned.mockReturnValue(false);
    mocks.existsSync.mockReturnValue(false);
    mocks.getClaudePaths.mockReturnValue(['/missing']);
    mocks.getCodexPaths.mockReturnValue(['/missing']);
    mocks.getCursorStateDbPath.mockReturnValue(null);

    await doctorCommand();

    const out = output();
    expect(out).toContain('no config found');
    expect(out).toContain('not cloned');
    expect(out).toContain('no source paths found');
    expect(out).toContain('state.vscdb not found');
    expect(process.exitCode).toBeUndefined();
  });

  it('sets a failing exit code when required checks fail', async () => {
    mocks.spawnSync.mockImplementation((command: string, args: string[]) => ({
      status: command === 'git' && args[0] === '--version' ? 1 : 0,
    }));

    await doctorCommand();

    expect(output()).toContain('git: not available on PATH');
    expect(process.exitCode).toBe(1);
  });

  it('reports pricing check results and cursor read errors', async () => {
    mocks.spawnSync.mockImplementation((command: string, args: string[]) => ({
      status: command === 'pnpm' && args.includes('pricing:check') ? 1 : 0,
    }));
    mocks.readCursorAuthState.mockRejectedValue(new Error('locked'));

    await doctorCommand({ pricingCheck: true });

    const out = output();
    expect(out).toContain('Cursor source: locked');
    expect(out).toContain('Pricing drift: pnpm run pricing:check did not pass');
  });
});

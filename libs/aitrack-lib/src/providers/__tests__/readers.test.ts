import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  claude: vi.fn(),
  codex: vi.fn(),
  source: vi.fn(),
  path: vi.fn(),
  auth: vi.fn(),
  cursor: vi.fn(),
}));
vi.mock('../../readers/claude.js', () => ({
  getClaudePaths: () => ['claude'],
  readClaudeData: mocks.claude,
}));
vi.mock('../../readers/codex.js', () => ({
  getCodexPaths: () => ['codex'],
  readCodexData: mocks.codex,
}));
vi.mock('../../readers/paths.js', () => ({ sourceCheck: mocks.source }));
vi.mock('../../readers/cursor/auth.js', () => ({
  getCursorStateDatabasePath: mocks.path,
  readCursorAuthState: mocks.auth,
}));
vi.mock('../../readers/cursor/index.js', () => ({ readCursorData: mocks.cursor }));
import { claudeCodeProvider } from '../claudeCode.js';
import { codexProvider } from '../codex.js';
import { cursorProvider } from '../cursor.js';

beforeEach(() => vi.resetAllMocks());
it('delegates local readers and source diagnostics to the selected provider', async () => {
  await claudeCodeProvider.reader.readData();
  await codexProvider.reader.readData();
  await claudeCodeProvider.doctorCheck();
  await codexProvider.doctorCheck();
  expect(mocks.claude).toHaveBeenCalled();
  expect(mocks.codex).toHaveBeenCalled();
  expect(mocks.source).toHaveBeenCalledWith('Claude Code source', ['claude']);
  expect(mocks.source).toHaveBeenCalledWith('Codex source', ['codex']);
  expect(
    codexProvider.pricing.priceModelCost(
      'gpt-5.6-sol',
      { inputTokens: 10, outputTokens: 2 },
      '2026-06-01',
      'merge',
    ),
  ).toBeGreaterThan(0);
});
it('diagnoses missing Cursor DBs, signed-out state and unreadable auth without exposing tokens', async () => {
  await expect(cursorProvider.doctorCheck()).resolves.toMatchObject({ status: 'warn' });
  mocks.path.mockReturnValue('/state.vscdb');
  mocks.auth.mockResolvedValue({ accessToken: 'secret' });
  expect(await cursorProvider.doctorCheck()).toEqual({
    status: 'ok',
    label: 'Cursor source',
    detail: 'auth token found in /state.vscdb',
  });
  mocks.auth.mockResolvedValue({});
  await expect(cursorProvider.doctorCheck()).resolves.toMatchObject({ status: 'warn' });
  mocks.auth.mockRejectedValue(new Error('unreadable'));
  await expect(cursorProvider.doctorCheck()).resolves.toMatchObject({ detail: 'unreadable' });
  await cursorProvider.live.liveFetch();
  await cursorProvider.live.liveFetch({ maxAgeSeconds: 0 });
  expect(mocks.cursor).toHaveBeenLastCalledWith({ maxAgeSeconds: 0 });
  expect(
    cursorProvider.pricing.priceModelCost(
      'composer-2.5',
      { inputTokens: 10, outputTokens: 2 },
      '2026-06-01',
      'merge',
    ),
  ).toBeGreaterThan(0);
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  isCloned: vi.fn(),
  pull: vi.fn(),
  listDataFiles: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  execSync: vi.fn(),
}));

vi.mock('./config.js', () => ({ loadConfig: mocks.loadConfig }));
vi.mock('./git.js', () => ({
  LOCAL_REPO: '/repo',
  isCloned: mocks.isCloned,
  pull: mocks.pull,
  listDataFiles: mocks.listDataFiles,
}));
vi.mock('fs', () => ({
  readFileSync: mocks.readFileSync,
  writeFileSync: mocks.writeFileSync,
}));
vi.mock('child_process', () => ({ execSync: mocks.execSync }));

import { recomputeCostsCommand } from './recompute.js';

const machineJson = {
  hostname: 'host',
  lastUpdated: 'old',
  days: {
    '2024-01-01': {
      claude_code: {
        byModel: { 'claude-sonnet-4-6': { inputTokens: 1_000_000, outputTokens: 100_000 } },
        totals: { inputTokens: 1_000_000, outputTokens: 100_000 },
      },
    },
  },
};

describe('recomputeCostsCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isCloned.mockReturnValue(true);
    mocks.listDataFiles.mockReturnValue(['/repo/data/host.json']);
    mocks.readFileSync.mockReturnValue(JSON.stringify(machineJson));
    mocks.execSync.mockReturnValue(Buffer.from('M  data/host.json\n'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('throws when the repo has not been cloned', () => {
    mocks.isCloned.mockReturnValue(false);
    expect(() => {
      recomputeCostsCommand();
    }).toThrow('Repo not cloned');
  });

  it('recomputes claude costs and writes updated machine files', () => {
    recomputeCostsCommand();

    expect(mocks.writeFileSync).toHaveBeenCalledWith(
      '/repo/data/host.json',
      expect.stringContaining('"costUSD"'),
      'utf8',
    );
    expect(console.log).toHaveBeenCalledWith('Recomputed costs in 1 file(s).');
    expect(mocks.execSync).toHaveBeenCalledWith('git add data/', expect.any(Object));
  });

  it('skips invalid machine files', () => {
    mocks.readFileSync.mockReturnValue('{bad json');
    recomputeCostsCommand();
    expect(mocks.writeFileSync).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(
      'Nothing to recompute (no claude_code or codex data found in any file).',
    );
  });
});

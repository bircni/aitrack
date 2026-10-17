import { describe, expect, it, vi } from 'vitest';

import { UsageError } from '../errors.js';
import { parseWatchSeconds, watch, watchUntilInterrupted, type WatchDeps } from '../watch.js';

function deps(overrides: Partial<WatchDeps> = {}): WatchDeps & { controller: AbortController } {
  const controller = new AbortController();
  return {
    isTTY: true,
    write: vi.fn<(text: string) => void>(),
    wait: vi.fn(() => Promise.resolve()),
    signal: controller.signal,
    controller,
    ...overrides,
  };
}

describe('watch', () => {
  it('redraws every interval until aborted, then resolves', async () => {
    const d = deps();
    const render = vi.fn(() => {
      if (render.mock.calls.length === 3) d.controller.abort();
      return Promise.resolve();
    });
    await watch(render, true, d);
    expect(render).toHaveBeenCalledTimes(3);
    expect(d.write).toHaveBeenCalledTimes(3);
    expect(d.wait).toHaveBeenCalledWith(30_000, d.signal);
  });

  it('uses the given seconds', async () => {
    const d = deps();
    await watch(
      () => {
        d.controller.abort();
        return Promise.resolve();
      },
      7,
      d,
    );
    expect(d.wait).toHaveBeenCalledWith(7000, d.signal);
  });

  it('refuses to run without a terminal', async () => {
    await expect(watch(vi.fn(), true, deps({ isTTY: false }))).rejects.toBeInstanceOf(UsageError);
  });

  it('stops cleanly on Ctrl-C against the real terminal', async () => {
    const isTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const render = vi.fn(() => {
      process.emit('SIGINT');
      return Promise.resolve();
    });
    try {
      await watchUntilInterrupted(render, 5);
    } finally {
      write.mockRestore();
      if (isTTY) Object.defineProperty(process.stdout, 'isTTY', isTTY);
      else Reflect.deleteProperty(process.stdout, 'isTTY');
    }
    expect(render).toHaveBeenCalledTimes(1);
    expect(process.listenerCount('SIGINT')).toBe(0);
  });

  it('enforces the 5 second minimum', () => {
    expect(parseWatchSeconds('5')).toBe(5);
    expect(() => parseWatchSeconds('4')).toThrow('at least 5');
    expect(() => parseWatchSeconds('x')).toThrow('positive integer');
  });
});

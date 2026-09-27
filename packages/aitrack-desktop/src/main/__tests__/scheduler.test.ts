import { afterEach, describe, expect, it, vi } from 'vitest';

import { SCAN_INTERVAL_MS, startCatchUp, type ScanWatcher } from '../scheduler.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('startCatchUp', () => {
  it('scans when the watcher fires, on the interval, and after resume', () => {
    vi.useFakeTimers();
    const scans: string[] = [];
    let changed: (() => void) | undefined;
    let resumed: (() => void) | undefined;
    let closed = 0;
    const watcher: ScanWatcher = {
      close: () => {
        closed += 1;
      },
    };
    const catchUp = startCatchUp({
      scan: () => {
        scans.push('scan');
      },
      watch: (onChange) => {
        changed = onChange;
        return [watcher];
      },
      listenResume: (listener) => {
        resumed = listener;
      },
    });

    changed?.();
    expect(scans).toEqual(['scan']);
    vi.advanceTimersByTime(SCAN_INTERVAL_MS);
    expect(scans).toEqual(['scan', 'scan']);
    resumed?.();
    expect(scans).toEqual(['scan', 'scan', 'scan']);
    catchUp.stop();
    expect(closed).toBe(1);
    vi.advanceTimersByTime(SCAN_INTERVAL_MS);
    expect(scans).toEqual(['scan', 'scan', 'scan']);
  });
});

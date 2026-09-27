export const SCAN_INTERVAL_MS = 60_000;

export interface ScanWatcher {
  close: () => void;
}

export interface CatchUp {
  stop: () => void;
}

/**
 * Keep the index current after launch: a watcher callback, a fixed interval,
 * and a sleep/wake listener all run the same scan.
 */
export function startCatchUp(options: {
  scan: () => void;
  watch: (onChange: () => void) => ScanWatcher[];
  intervalMs?: number;
  listenResume?: (listener: () => void) => void;
}): CatchUp {
  const watchers = options.watch(options.scan);
  const timer = setInterval(options.scan, options.intervalMs ?? SCAN_INTERVAL_MS);
  options.listenResume?.(options.scan);
  return {
    stop() {
      clearInterval(timer);
      for (const watcher of watchers) watcher.close();
    },
  };
}

import { setTimeout as delay } from 'node:timers/promises';

import { InvalidArgumentError } from 'commander';

import { UsageError } from './errors.js';
import { parsePositiveIntArgument } from './parse.js';

const WATCH_DEFAULT_SECONDS = 30;
const WATCH_MIN_SECONDS = 5;

const CLEAR_SCREEN = '\u001B[H\u001B[2J';

export function parseWatchSeconds(value: string): number {
  const seconds = parsePositiveIntArgument(value);
  if (seconds < WATCH_MIN_SECONDS) {
    throw new InvalidArgumentError(`--watch needs at least ${String(WATCH_MIN_SECONDS)} seconds.`);
  }
  return seconds;
}

export interface WatchDeps {
  isTTY: boolean;
  write: (text: string) => void;
  /** Resolves after `ms`, or as soon as `signal` aborts. */
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
  signal: AbortSignal;
}

function systemWatchDeps(signal: AbortSignal): WatchDeps {
  return {
    isTTY: process.stdout.isTTY,
    write: (text) => {
      process.stdout.write(text);
    },
    wait: (ms, abort) => delay(ms, undefined, { signal: abort }).catch(() => undefined),
    signal,
  };
}

/** Re-renders in place until `deps.signal` aborts, which is a clean exit rather than a failure. */
export async function watch(
  render: () => Promise<void>,
  seconds: number | true,
  deps: WatchDeps,
): Promise<void> {
  if (!deps.isTTY) {
    throw new UsageError('--watch needs an interactive terminal (stdout is not a TTY).');
  }
  const interval = (seconds === true ? WATCH_DEFAULT_SECONDS : seconds) * 1000;
  while (!deps.signal.aborted) {
    deps.write(CLEAR_SCREEN);
    await render();
    await deps.wait(interval, deps.signal);
  }
}

/** Runs `watch` against the real terminal, stopping on Ctrl-C. */
export async function watchUntilInterrupted(
  render: () => Promise<void>,
  seconds: number | true,
): Promise<void> {
  const controller = new AbortController();
  const stop = (): void => {
    controller.abort();
  };
  process.once('SIGINT', stop);
  try {
    await watch(render, seconds, systemWatchDeps(controller.signal));
  } finally {
    process.off('SIGINT', stop);
  }
}

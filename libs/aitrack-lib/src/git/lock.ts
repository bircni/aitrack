import { AsyncLocalStorage } from 'node:async_hooks';

const holder = new AsyncLocalStorage<true>();
let tail: Promise<unknown> = Promise.resolve();

/**
 * Run `fn` once every earlier operation on the one local data repo has
 * settled, so a sync cannot interleave with a concurrent pull. A call made
 * from inside a locked operation runs in its turn instead of waiting on it.
 */
export function withRepoLock<T>(fn: () => Promise<T>): Promise<T> {
  if (holder.getStore()) return fn();
  const run = tail.then(() => holder.run(true, fn));
  tail = run.catch(() => undefined);
  return run;
}

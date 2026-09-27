import { readdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';

/**
 * Watch transcript roots. macOS and Windows use one recursive watcher.
 * Linux, where recursive watch is unavailable, watches each directory.
 */
export function watchSourceRoots(
  roots: readonly string[],
  onChange: () => void,
  debounceMs = 1500,
): FSWatcher[] {
  const watchers: FSWatcher[] = [];
  const timers = new Map<string, NodeJS.Timeout>();
  const kick = (filePath: string): void => {
    const pending = timers.get(filePath);
    if (pending !== undefined) clearTimeout(pending);
    timers.set(
      filePath,
      setTimeout(() => {
        timers.delete(filePath);
        onChange();
      }, debounceMs),
    );
  };
  for (const root of roots) attach(root, kick, watchers);
  return watchers;
}

function attach(root: string, kick: (filePath: string) => void, watchers: FSWatcher[]): void {
  try {
    watchers.push(
      watch(root, { recursive: true }, (_event, filename) => {
        kick(watchedPath(root, filename));
      }),
    );
  } catch {
    watchShallow(root, kick, watchers);
  }
}

function watchShallow(root: string, kick: (filePath: string) => void, watchers: FSWatcher[]): void {
  try {
    watchers.push(
      watch(root, (_event, filename) => {
        kick(watchedPath(root, filename));
      }),
    );
  } catch {
    return;
  }
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(root, name);
    let directory = false;
    try {
      directory = statSync(path).isDirectory();
    } catch {
      directory = false;
    }
    if (directory) watchShallow(path, kick, watchers);
  }
}

function watchedPath(root: string, filename: string | Buffer | null): string {
  if (typeof filename === 'string' && filename !== '') return join(root, filename);
  return root;
}

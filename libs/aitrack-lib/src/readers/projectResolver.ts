import { execFile } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Attribution } from '../data/dayMap.js';
import { NO_REMOTE_PROJECT, normalizeRemoteUrl, type ProjectSelector } from '../data/project.js';

const GIT_TIMEOUT_MS = 5000;

/** `owner/repo` of the directory's origin, or null when it is gone or has no remote. */
export type ProjectResolver = (cwd: string) => Promise<string | null>;

function originUrl(cwd: string): Promise<string | null> {
  return new Promise((done) => {
    execFile(
      'git',
      ['-C', cwd, 'remote', 'get-url', 'origin'],
      {
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (error, stdout) => {
        done(error ? null : stdout.trim());
      },
    );
  });
}

/** One git call per directory for the life of the resolver, so a run asks once per cwd. */
export function createProjectResolver(): ProjectResolver {
  const known = new Map<string, Promise<string | null>>();
  return (cwd) => {
    let pending = known.get(cwd);
    if (!pending) {
      pending = originUrl(cwd).then((url) => (url ? normalizeRemoteUrl(url) : null));
      known.set(cwd, pending);
    }
    return pending;
  };
}

/** The project for a working directory; work without a remote keeps its cwd for local `--dir` matching. */
export async function attributeCwd(
  resolveProject: ProjectResolver,
  cwd: string | undefined,
): Promise<Attribution> {
  const project = cwd === undefined ? null : await resolveProject(cwd);
  if (project !== null) return { project };
  return { project: NO_REMOTE_PROJECT, ...(cwd !== undefined && { cwd }) };
}

/** The project of a directory, or the directory itself when it has no remote. Throws when it is not a directory. */
export async function resolveProjectSelector(path: string): Promise<ProjectSelector> {
  const dir = resolve(path);
  let isDirectory = false;
  try {
    isDirectory = statSync(dir).isDirectory();
  } catch {
    // Reported below with the other not-a-directory case.
  }
  if (!isDirectory) throw new Error(`Not a directory: ${path}`);
  const real = realpathSync(dir);
  const project = await createProjectResolver()(real);
  return project === null ? { kind: 'dir', dir: real } : { kind: 'project', project };
}

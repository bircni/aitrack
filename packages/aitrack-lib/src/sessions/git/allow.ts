/**
 * The only git subcommands the desktop app may run.
 *
 * Inspection is read-only: no fetch, no checkout, nothing that touches the
 * index or the worktree. `runAllowedGit` refuses anything else before spawn.
 */
export const ALLOWED_GIT_COMMANDS = [
  'rev-parse',
  'log',
  'show',
  'diff',
  'blame',
  'remote',
  'branch',
] as const;

export type AllowedGitCommand = (typeof ALLOWED_GIT_COMMANDS)[number];

const ALLOWED = new Set<string>(ALLOWED_GIT_COMMANDS);

const FORBIDDEN = new Set([
  'checkout',
  'switch',
  'commit',
  'push',
  'pull',
  'fetch',
  'reset',
  'clean',
  'stash',
  'rebase',
  'merge',
  'add',
  'rm',
  'mv',
  'clone',
  'init',
  'config',
  'update-index',
  'apply',
  'am',
  'cherry-pick',
  'status',
]);

export class GitCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitCommandError';
  }
}

export function assertAllowedGitArgs(args: readonly string[]): void {
  const command = args[0];
  if (command === undefined || !ALLOWED.has(command)) {
    throw new GitCommandError(`git ${command ?? '(none)'} is not allowed`);
  }
  for (const arg of args.slice(1)) {
    const bare = arg.replace(/^-+/u, '');
    if (FORBIDDEN.has(arg) || FORBIDDEN.has(bare)) {
      throw new GitCommandError(`git ${arg} is not allowed`);
    }
  }
}

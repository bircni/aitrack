export const NO_REMOTE_PROJECT = '(no remote)';
export const UNATTRIBUTED_PROJECT = '(unattributed)';
/** The one model row of a project-scoped report, which has no per-model split. */
export const ALL_MODELS = '(all models)';

const SCP_LIKE = /^(?:[^@/\s]+@)?([^:/\s]{2,}):(?!\/\/)(.+)$/u;

function ownerAndRepo(path: string): string | null {
  const segments = path
    .replace(/\/+$/u, '')
    .replace(/\.git$/u, '')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '~');
  const repo = segments.at(-1);
  const owner = segments.at(-2);
  if (repo === undefined || owner === undefined) return null;
  if ([owner, repo].some((part) => /\s|^\.{1,2}$/u.test(part))) return null;
  return `${owner}/${repo}`.toLowerCase();
}

/**
 * `owner/repo` for a git remote URL (ssh, scp-like or http(s)), or null when it
 * has none. Host, credentials, ports and local paths are never kept.
 */
export function normalizeRemoteUrl(url: string): string | null {
  const text = url.trim();
  const scp = SCP_LIKE.exec(text);
  if (scp?.[2] !== undefined) return ownerAndRepo(scp[2]);
  try {
    const parsed = new URL(text);
    return parsed.hostname === '' ? null : ownerAndRepo(decodeURIComponent(parsed.pathname));
  } catch {
    return null;
  }
}

export type ProjectSelector = { kind: 'project'; project: string } | { kind: 'dir'; dir: string };

export function projectSelectorLabel(selector: ProjectSelector): string {
  return selector.kind === 'project' ? selector.project : `${selector.dir} (no remote)`;
}

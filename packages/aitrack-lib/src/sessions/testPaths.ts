/**
 * Whether a repo-relative path is a test.
 *
 * The built-in patterns cover the layouts this repo and its neighbours use.
 * `extraGlobs` adds project-specific ones (`*` and `**` only).
 */
export function isTestPath(filePath: string, extraGlobs: readonly string[] = []): boolean {
  const normalized = filePath.replaceAll('\\', '/').replace(/^\.\//u, '');
  const base = normalized.split('/').pop() ?? normalized;
  if (segment(normalized, '__tests__')) return true;
  if (segment(normalized, 'test') || segment(normalized, 'tests') || segment(normalized, 'e2e')) {
    return true;
  }
  if (/\.(?:test|spec)\.[^/]+$/u.test(base)) return true;
  if (base.endsWith('_test.go') || /^test_.+\.py$/u.test(base)) return true;
  if (base.endsWith('Tests.swift') || /Test\.(?:java|kt)$/u.test(base)) return true;
  return extraGlobs.some((glob) => matchGlob(normalized, glob));
}

function segment(path: string, name: string): boolean {
  return path === name || path.startsWith(`${name}/`) || path.includes(`/${name}/`);
}

function matchGlob(path: string, glob: string): boolean {
  const pattern = glob
    .replaceAll('\\', '/')
    .replaceAll(/[.+^${}()|[\]\\]/gu, '\\$&')
    .replaceAll('**', '::DOUBLE::')
    .replaceAll('*', '[^/]*')
    .replaceAll('::DOUBLE::', '.*');
  return new RegExp(`^${pattern}$`, 'u').test(path);
}

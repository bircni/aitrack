export interface ResolvedSlug {
  path: string | null;
  uncertain: boolean;
  candidates: string[];
}

/**
 * Turn a Claude or Cursor project slug back into a filesystem path.
 *
 * Both tools encode `/Users/me/my-app` by replacing `/` with `-`. Claude keeps
 * the leading dash (`-Users-me-my-app`); Cursor drops it. Hyphens inside a
 * directory name make the split ambiguous, so a slug is certain only when
 * exactly one existing path matches.
 */
export function resolveEncodedPath(
  slug: string,
  exists: (path: string) => boolean,
  platform: 'posix' | 'win32' = 'posix',
): ResolvedSlug {
  const body = slug.startsWith('-') ? slug.slice(1) : slug;
  if (body === '') return { path: null, uncertain: false, candidates: [] };

  const segments = body.split('-').filter((segment) => segment !== '');
  if (segments.length === 0) return { path: null, uncertain: false, candidates: [] };

  const matches: string[] = [];
  walk(segments, 0, drivePrefix(segments, platform), exists, matches, platform);

  const unique = [...new Set(matches)];
  if (unique.length === 1) {
    const only = unique[0] ?? null;
    return { path: only, uncertain: false, candidates: unique };
  }
  if (unique.length === 0) return { path: null, uncertain: true, candidates: [] };
  return { path: null, uncertain: true, candidates: unique };
}

function drivePrefix(segments: string[], platform: 'posix' | 'win32'): string {
  if (platform !== 'win32') return '';
  const first = segments[0];
  if (first !== undefined && /^[A-Za-z]$/u.test(first)) return `${first.toUpperCase()}:`;
  return '';
}

function walk(
  segments: string[],
  index: number,
  current: string,
  exists: (path: string) => boolean,
  matches: string[],
  platform: 'posix' | 'win32',
): void {
  if (index >= segments.length) {
    if (current !== '' && exists(current)) matches.push(current);
    return;
  }

  const onDrive = platform === 'win32' && /^[A-Za-z]:$/u.test(current);
  const start = onDrive ? index + 1 : index;
  if (start >= segments.length) {
    if (exists(current)) matches.push(current);
    return;
  }

  let name = '';
  for (let end = start; end < segments.length; end += 1) {
    const piece = segments[end];
    if (piece === undefined) continue;
    name = name === '' ? piece : `${name}-${piece}`;
    const next = joinEncoded(current, name, platform);
    if (!exists(next)) continue;
    walk(segments, end + 1, next, exists, matches, platform);
  }
}

function joinEncoded(current: string, name: string, platform: 'posix' | 'win32'): string {
  if (current === '') return platform === 'win32' ? name : `/${name}`;
  if (/^[A-Za-z]:$/u.test(current)) return `${current}/${name}`;
  return `${current}/${name}`;
}

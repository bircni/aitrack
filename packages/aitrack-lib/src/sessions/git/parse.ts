import type { ParsedCommit, ParsedCommitFile } from '../types.js';

/** Record separator, field separator, end of the commit body. */
export const GIT_LOG_FORMAT = '%x1e%H%x1f%P%x1f%at%x1f%ct%x1f%ae%x1f%s%x1f%b%x1c';

const REVERT_TRAILER = /This reverts commit ([0-9a-f]{7,40})/u;

export function parseGitLog(output: string): ParsedCommit[] {
  const commits: ParsedCommit[] = [];
  for (const record of output.split('\u001E')) {
    const trimmed = record.trim();
    if (trimmed === '') continue;
    const parsed = parseRecord(trimmed);
    if (parsed !== null) commits.push(parsed);
  }
  return commits;
}

export function parseBranchList(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split('\n')) {
    const cleaned = line.replace(/^\*/u, '').trim();
    if (cleaned === '' || cleaned.startsWith('(')) continue;
    const name = cleaned.replace(/^remotes\/[^/]+\//u, '');
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Count source lines in `git blame --line-porcelain` output still attributed
 * to `sha`. Either side may be abbreviated; both must share a prefix of at
 * least 7 hex characters.
 */
export function countAttributedLines(porcelain: string, sha: string): number {
  const target = sha.toLowerCase();
  let current = '';
  let count = 0;
  for (const line of porcelain.split('\n')) {
    const header = /^([0-9a-f]{4,40})\s/u.exec(line);
    if (header?.[1] !== undefined) {
      current = header[1];
      continue;
    }
    if (!line.startsWith('\t')) continue;
    if (sameCommit(current, target)) count += 1;
  }
  return count;
}

export function churnFromBlame(
  insertions: number,
  porcelain: string,
  sha: string,
): { linesRewritten: number; linesTotal: number; ratio: number } | null {
  if (insertions <= 0) return null;
  const surviving = Math.min(insertions, countAttributedLines(porcelain, sha));
  const linesRewritten = insertions - surviving;
  return { linesRewritten, linesTotal: insertions, ratio: linesRewritten / insertions };
}

function parseRecord(record: string): ParsedCommit | null {
  const splitAt = record.indexOf('\u001C');
  const header = splitAt === -1 ? record : record.slice(0, splitAt);
  const rest = splitAt === -1 ? '' : record.slice(splitAt + 1);
  const fields = header.split('\u001F');
  const sha = fields[0]?.trim() ?? '';
  if (!/^[0-9a-f]{7,40}$/u.test(sha)) return null;
  const parents = (fields[1] ?? '').split(' ').filter((parent) => parent !== '');
  const authorTime = isoFromUnix(fields[2] ?? '');
  const commitTime = isoFromUnix(fields[3] ?? '');
  if (authorTime === null || commitTime === null) return null;
  const subject = fields[5] ?? '';
  const body = fields[6] ?? '';
  const revertOf = REVERT_TRAILER.exec(body)?.[1] ?? null;
  return {
    sha,
    parents,
    authorTime,
    commitTime,
    authorEmail: fields[4] ?? '',
    subject,
    body,
    files: parseNumstat(rest),
    isMerge: parents.length > 1,
    isRevert: revertOf !== null || subject.startsWith('Revert "'),
    revertOf,
  };
}

function parseNumstat(rest: string): ParsedCommitFile[] {
  const files: ParsedCommitFile[] = [];
  for (const line of rest.split('\n')) {
    if (line.trim() === '') continue;
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/u.exec(line);
    if (match?.[3] === undefined) continue;
    files.push({
      path: match[3],
      insertions: match[1] === '-' ? 0 : Number(match[1]),
      deletions: match[2] === '-' ? 0 : Number(match[2]),
    });
  }
  return files;
}

function isoFromUnix(value: string): string | null {
  if (!/^\d+$/u.test(value)) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString();
}

function sameCommit(left: string, right: string): boolean {
  if (left.length < 7 || right.length < 7) return false;
  return left.startsWith(right) || right.startsWith(left);
}

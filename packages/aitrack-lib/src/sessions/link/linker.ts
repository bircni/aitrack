import type {
  CommitLink,
  LinkConfidence,
  LinkSignal,
  LinkableCommit,
  Session,
  SessionSignals,
} from '../types.js';

export const LINK_WEIGHTS = {
  files: 0.45,
  time: 0.25,
  branch: 0.15,
  cursor: 0.1,
  text: 0.05,
} as const;

const BEFORE_MS = 5 * 60 * 1000;
const AFTER_MS = 6 * 60 * 60 * 1000;
const NEAR_MS = 30 * 60 * 1000;

export interface LinkOptions {
  repoRoot?: string | null;
  windowBeforeMs?: number;
  windowAfterMs?: number;
}

/**
 * Score commits that this session may have produced.
 *
 * Only signals that actually fired are stored, so the UI can show why a link
 * exists. Scores under 0.2 are dropped. Low-confidence links are returned for
 * review and excluded from metrics unless a person confirms them.
 */
export function linkSession(
  session: Session,
  signals: SessionSignals,
  commits: readonly LinkableCommit[],
  options: LinkOptions = {},
): CommitLink[] {
  if (session.startedAt === null) return [];
  const started = Date.parse(session.startedAt);
  if (Number.isNaN(started)) return [];
  const ended = Date.parse(session.endedAt ?? session.startedAt);
  const before = options.windowBeforeMs ?? BEFORE_MS;
  const after = options.windowAfterMs ?? AFTER_MS;
  const edited = editedPaths(session, options.repoRoot ?? null);
  const lastEdit = Date.parse(session.lastEditAt ?? session.endedAt ?? session.startedAt);

  const links: CommitLink[] = [];
  for (const commit of commits) {
    const author = Date.parse(commit.authorTime);
    if (Number.isNaN(author)) continue;
    if (author < started - before || author > ended + after) continue;
    const scored = scoreCommit(
      session,
      signals,
      commit,
      edited,
      lastEdit,
      options.repoRoot ?? null,
    );
    if (scored === null) continue;
    links.push({
      sessionId: session.id,
      sha: commit.sha,
      score: scored.score,
      confidence: scored.confidence,
      signals: scored.signals,
      share: 1,
    });
  }
  return assignShares(links);
}

export function assignShares(links: CommitLink[]): CommitLink[] {
  const totals = new Map<string, number>();
  for (const link of links) totals.set(link.sha, (totals.get(link.sha) ?? 0) + link.score);
  return links.map((link) => {
    const total = totals.get(link.sha) ?? link.score;
    return { ...link, share: total === 0 ? 0 : link.score / total };
  });
}

function scoreCommit(
  session: Session,
  signals: SessionSignals,
  commit: LinkableCommit,
  edited: Set<string>,
  lastEditMs: number,
  repoRoot: string | null,
): { score: number; confidence: LinkConfidence; signals: LinkSignal[] } | null {
  const signalsFired: LinkSignal[] = [];
  const commitPaths = commit.paths.map((path) => normalizePath(path, repoRoot));
  const overlap = countOverlap(edited, commitPaths);
  if (overlap > 0 && commitPaths.length > 0) {
    signalsFired.push({
      name: 'files',
      weight: LINK_WEIGHTS.files,
      score: overlap / new Set(commitPaths).size,
      detail: `${String(overlap)} of ${String(new Set(commitPaths).size)} files this commit touched were edited in the session`,
    });
  }

  if (!Number.isNaN(lastEditMs)) {
    const proximity = timeScore(Date.parse(commit.authorTime) - lastEditMs);
    if (proximity > 0) {
      const minutes = Math.round((Date.parse(commit.authorTime) - lastEditMs) / 60_000);
      signalsFired.push({
        name: 'time',
        weight: LINK_WEIGHTS.time,
        score: proximity,
        detail:
          minutes < 60
            ? `Committed ${String(minutes)} min after the session's last edit`
            : `Committed ${String(Math.round(minutes / 60))} h after the session's last edit`,
      });
    }
  }

  const branch = session.branches.find((name) => commit.branches.includes(name));
  if (branch !== undefined) {
    signalsFired.push({
      name: 'branch',
      weight: LINK_WEIGHTS.branch,
      score: 1,
      detail: `Same branch (${branch})`,
    });
  }

  if (commit.cursorAiPercentage !== null && commit.cursorAiPercentage > 0) {
    signalsFired.push({
      name: 'cursor',
      weight: LINK_WEIGHTS.cursor,
      score: 1,
      detail: `Cursor recorded ${String(commit.cursorAiPercentage)}% AI lines for this commit`,
    });
  }

  const text = textSignal(signals, commit);
  if (text !== null) signalsFired.push(text);

  if (signalsFired.length === 0) return null;
  const score = roundScore(
    signalsFired.reduce((sum, signal) => sum + signal.weight * signal.score, 0),
  );
  if (score < 0.2) return null;
  return { score, confidence: confidenceFor(score), signals: signalsFired };
}

function textSignal(signals: SessionSignals, commit: LinkableCommit): LinkSignal | null {
  const subject = commit.subject.trim();
  const assistant = signals.assistantExcerpt.toLowerCase();
  const user = signals.userExcerpt.toLowerCase();
  const details: string[] = [];
  if (subject.length >= 8 && assistant.includes(subject.toLowerCase())) {
    details.push("Commit subject appears in the assistant's final message");
  }
  const excerpt = signals.userExcerpt.replaceAll(/\s+/gu, ' ').trim();
  if (
    excerpt.length >= 40 &&
    commit.body.toLowerCase().includes(excerpt.slice(0, 40).toLowerCase())
  ) {
    details.push('Commit message quotes the prompt');
  }
  if (details.length === 0 && subject.length >= 8 && user.includes(subject.toLowerCase())) {
    details.push('Commit subject appears in the prompt');
  }
  if (details.length === 0) return null;
  return { name: 'text', weight: LINK_WEIGHTS.text, score: 1, detail: details.join('. ') };
}

function timeScore(deltaMs: number): number {
  if (Number.isNaN(deltaMs) || deltaMs < 0) return 0;
  if (deltaMs <= NEAR_MS) return 1;
  if (deltaMs >= AFTER_MS) return 0;
  return 1 - (deltaMs - NEAR_MS) / (AFTER_MS - NEAR_MS);
}

function confidenceFor(score: number): LinkConfidence {
  if (score >= 0.6) return 'high';
  if (score >= 0.35) return 'medium';
  return 'low';
}

function roundScore(score: number): number {
  return Math.round(score * 10_000) / 10_000;
}

function editedPaths(session: Session, repoRoot: string | null): Set<string> {
  const paths = new Set<string>();
  for (const touch of session.fileTouches) {
    if (touch.kind === 'read') continue;
    paths.add(normalizePath(touch.path, repoRoot));
  }
  return paths;
}

export function normalizePath(filePath: string, repoRoot: string | null): string {
  const slash = filePath.replaceAll('\\', '/').replace(/^\.\//u, '');
  if (repoRoot === null) return slash;
  const root = repoRoot.replaceAll('\\', '/').replace(/\/$/u, '');
  if (slash === root) return '';
  if (slash.startsWith(`${root}/`)) return slash.slice(root.length + 1);
  return slash;
}

function countOverlap(edited: Set<string>, commitPaths: string[]): number {
  const unique = new Set(commitPaths);
  let overlap = 0;
  for (const path of unique) {
    if (path === '') continue;
    if (edited.has(path)) {
      overlap += 1;
      continue;
    }
    for (const editedPath of edited) {
      if (editedPath.endsWith(`/${path}`) || path.endsWith(`/${editedPath}`)) {
        overlap += 1;
        break;
      }
    }
  }
  return overlap;
}

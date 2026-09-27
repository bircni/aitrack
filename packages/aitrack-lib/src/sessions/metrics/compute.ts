import { tryLocalDateString } from '../../data/dayMap.js';
import type { LinkConfidence, SessionProvider, SessionRating } from '../types.js';

export const LOW_SAMPLE = 10;
export const ACTIVE_GAP_MS = 15 * 60 * 1000;
export const UNSHIPPED_AFTER_MS = 48 * 60 * 60 * 1000;

export interface MetricWindow {
  from: string | null;
  to: string | null;
}

export interface MetricSessionInput {
  id: string;
  provider: SessionProvider;
  repoId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  firstEditAt: string | null;
  turnTimestamps: string[];
  turns: number;
  costUsd: number;
  rating: SessionRating | null;
}

export interface MetricCommitInput {
  id: string;
  repoId: string;
  sha: string;
  authorTime: string;
  insertions: number;
  deletions: number;
  testFilesChanged: number;
  testLines: number;
  isRevert: boolean;
  churn7: number | null;
  churn30: number | null;
}

export interface MetricLinkInput {
  sessionId: string;
  commitId: string;
  confidence: LinkConfidence;
  decidedBy: 'auto' | 'user';
  rejected: boolean;
}

export type MetricUnit = 'usd' | 'minutes' | 'ratio' | 'count' | 'lines';

export interface MetricResult {
  id: string;
  label: string;
  value: number | null;
  unit: MetricUnit;
  sampleSize: number;
  confidence: 'ok' | 'low';
  rule: string;
  caveat: string;
  inputs: Record<string, number | string | null>;
}

export interface ComparisonRow {
  id: string;
  label: string;
  unit: MetricUnit;
  linked: number | null;
  human: number | null;
  sampleLinked: number;
  sampleHuman: number;
  rule: string;
  caveat: string;
}

export interface LeverageReport {
  linkedCommits: number;
  humanCommits: number;
  confidence: 'ok' | 'low';
  comparisons: ComparisonRow[];
  speed: MetricResult[];
  quality: MetricResult[];
  cost: MetricResult[];
  ratings: Record<SessionRating | 'unrated', number>;
}

export interface MetricsInput {
  sessions: readonly MetricSessionInput[];
  commits: readonly MetricCommitInput[];
  links: readonly MetricLinkInput[];
  window: MetricWindow;
  now: string;
  repoId?: string | null;
  provider?: SessionProvider | null;
}

const CAVEAT =
  'Low-confidence links are excluded unless you confirmed them. Fewer than 10 commits is too few to trust.';

export function activeMillis(timestamps: readonly string[], gapMs = ACTIVE_GAP_MS): number {
  const times = timestamps
    .map((timestamp) => Date.parse(timestamp))
    .filter((time) => !Number.isNaN(time))
    .toSorted((left, right) => left - right);
  let total = 0;
  for (let index = 1; index < times.length; index += 1) {
    const previous = times[index - 1];
    const current = times[index];
    if (previous === undefined || current === undefined) continue;
    const gap = current - previous;
    if (gap > 0 && gap <= gapMs) total += gap;
  }
  return total;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const left = sorted[mid - 1];
  const right = sorted[mid];
  if (left === undefined || right === undefined) return null;
  return (left + right) / 2;
}

/** Local calendar day of each commit, so a timezone test can pin the bucket. */
export function commitsPerLocalDay(
  commits: ReadonlyArray<{ authorTime: string }>,
): Map<string, number> {
  const days = new Map<string, number>();
  for (const commit of commits) {
    const day = tryLocalDateString(commit.authorTime);
    if (day === null) continue;
    days.set(day, (days.get(day) ?? 0) + 1);
  }
  return days;
}

export function cursorAcceptance(suggested: number, accepted: number): MetricResult {
  const value = suggested > 0 ? accepted / suggested : null;
  return {
    id: 'tab-acceptance',
    label: 'Tab acceptance',
    value,
    unit: 'ratio',
    sampleSize: suggested,
    confidence: suggested >= LOW_SAMPLE ? 'ok' : 'low',
    rule: 'Accepted tab completions divided by suggestions Cursor recorded that day.',
    caveat: 'This is Cursor’s own counter. It is not comparable to Claude or Codex.',
    inputs: { suggested, accepted },
  };
}

export function buildLeverageReport(input: MetricsInput): LeverageReport {
  const sessions = input.sessions.filter((session) => matchesScope(session, input));
  const sessionIds = new Set(sessions.map((session) => session.id));
  const commits = input.commits.filter(
    (commit) =>
      (input.repoId === undefined || input.repoId === null || commit.repoId === input.repoId) &&
      inWindow(commit.authorTime, input.window),
  );
  const commitIds = new Set(commits.map((commit) => commit.id));
  const links = input.links.filter(
    (link) =>
      !link.rejected &&
      sessionIds.has(link.sessionId) &&
      commitIds.has(link.commitId) &&
      (link.decidedBy === 'user' || link.confidence !== 'low'),
  );
  const linkedCommitIds = new Set(links.map((link) => link.commitId));
  const linkedSessionIds = new Set(links.map((link) => link.sessionId));
  const linked = commits.filter((commit) => linkedCommitIds.has(commit.id));
  const human = commits.filter((commit) => !linkedCommitIds.has(commit.id));
  const linkedSessions = sessions.filter((session) => linkedSessionIds.has(session.id));

  const leadTimes: number[] = [];
  for (const link of links) {
    const session = sessions.find((item) => item.id === link.sessionId);
    const commit = commits.find((item) => item.id === link.commitId);
    if (session === undefined || commit === undefined) continue;
    const from = Date.parse(session.firstEditAt ?? session.startedAt ?? '');
    const to = Date.parse(commit.authorTime);
    if (Number.isNaN(from) || Number.isNaN(to) || to < from) continue;
    leadTimes.push((to - from) / 60_000);
  }

  const activeDays = new Set<string>();
  for (const commit of linked) {
    const day = tryLocalDateString(commit.authorTime);
    if (day !== null) activeDays.add(day);
  }
  const activeMs = linkedSessions.reduce(
    (sum, session) => sum + activeMillis(session.turnTimestamps),
    0,
  );
  const shippedLines = linked.reduce(
    (sum, commit) => sum + commit.insertions + commit.deletions,
    0,
  );
  const linkedInsertions = linked.reduce((sum, commit) => sum + commit.insertions, 0);
  const linkedCost = linkedSessions.reduce((sum, session) => sum + session.costUsd, 0);
  const nowMs = Date.parse(input.now);

  const unshipped = sessions.filter((session) => {
    if (linkedSessionIds.has(session.id)) return false;
    if (session.rating === 'discarded') return true;
    const ended = Date.parse(session.endedAt ?? session.startedAt ?? '');
    return !Number.isNaN(ended) && nowMs - ended >= UNSHIPPED_AFTER_MS;
  });

  const ratings: LeverageReport['ratings'] = { kept: 0, reworked: 0, discarded: 0, unrated: 0 };
  for (const session of sessions) {
    if (session.rating === null) ratings.unrated += 1;
    else ratings[session.rating] += 1;
  }

  const confidence = linked.length >= LOW_SAMPLE ? 'ok' : 'low';
  const lead = median(leadTimes);
  const linesPerHour = activeMs > 0 ? shippedLines / (activeMs / 3_600_000) : null;
  const turnsPerCommit =
    linked.length > 0
      ? linkedSessions.reduce((sum, session) => sum + session.turns, 0) / linked.length
      : null;

  return {
    linkedCommits: linked.length,
    humanCommits: human.length,
    confidence,
    ratings,
    comparisons: [
      comparison(
        'lead-time',
        'Session to commit',
        'minutes',
        lead,
        null,
        leadTimes.length,
        0,
        'Median minutes from the first edit in a linked session to the commit.',
        CAVEAT,
      ),
      comparison(
        'size',
        'Change size',
        'lines',
        mean(linked.map((commit) => changeSize(commit))),
        mean(human.map((commit) => changeSize(commit))),
        linked.length,
        human.length,
        'Mean added plus deleted lines per commit.',
        CAVEAT,
      ),
      comparison(
        'churn-7',
        'Churn after 7 days',
        'ratio',
        mean(present(linked.map((commit) => commit.churn7))),
        mean(present(human.map((commit) => commit.churn7))),
        present(linked.map((commit) => commit.churn7)).length,
        present(human.map((commit) => commit.churn7)).length,
        'Share of a commit’s added lines that blame no longer attributes to it after 7 days.',
        'Measured once the window has elapsed, and again when HEAD moves. Files over 1 MB or 20k blame lines are skipped.',
      ),
      comparison(
        'churn-30',
        'Churn after 30 days',
        'ratio',
        mean(present(linked.map((commit) => commit.churn30))),
        mean(present(human.map((commit) => commit.churn30))),
        present(linked.map((commit) => commit.churn30)).length,
        present(human.map((commit) => commit.churn30)).length,
        'Share of a commit’s added lines that blame no longer attributes to it after 30 days.',
        'Measured once the window has elapsed, and again when HEAD moves.',
      ),
      comparison(
        'tests',
        'Test touch',
        'ratio',
        ratio(linked.filter((commit) => commit.testFilesChanged > 0).length, linked.length),
        ratio(human.filter((commit) => commit.testFilesChanged > 0).length, human.length),
        linked.length,
        human.length,
        'Share of commits that change at least one test file.',
        CAVEAT,
      ),
      comparison(
        'test-lines',
        'Test lines',
        'ratio',
        testLineShare(linked),
        testLineShare(human),
        linked.length,
        human.length,
        'Lines added or removed in test files, divided by all lines those commits changed.',
        CAVEAT,
      ),
      comparison(
        'reverts',
        'Revert rate',
        'ratio',
        ratio(linked.filter((commit) => commit.isRevert).length, linked.length),
        ratio(human.filter((commit) => commit.isRevert).length, human.length),
        linked.length,
        human.length,
        'Share of commits that revert an earlier commit. Supplementary, not the quality definition.',
        CAVEAT,
      ),
    ],
    speed: [
      metric(
        'lead-time',
        'Session to commit',
        lead,
        'minutes',
        leadTimes.length,
        'Median minutes from the first edit in a linked session to the commit.',
        CAVEAT,
        { samples: leadTimes.length },
      ),
      metric(
        'throughput',
        'Linked commits per active day',
        activeDays.size > 0 ? linked.length / activeDays.size : null,
        'count',
        linked.length,
        'Linked commits divided by the local days those commits landed on.',
        CAVEAT,
        { commits: linked.length, days: activeDays.size },
      ),
      metric(
        'lines-per-hour',
        'Lines per active hour',
        linesPerHour,
        'lines',
        linkedSessions.length,
        'Added and deleted lines on linked commits, divided by session time. Gaps over 15 minutes are not counted as active.',
        CAVEAT,
        { lines: shippedLines, activeMs },
      ),
      metric(
        'turns-per-commit',
        'Turns per commit',
        turnsPerCommit,
        'count',
        links.length,
        'Assistant turns on the linked sessions, divided by linked commits. A session linked to two commits is counted twice.',
        CAVEAT,
        { sessions: linkedSessions.length, commits: linked.length },
      ),
    ],
    quality: [
      metric(
        'churn-7',
        'Churn after 7 days',
        mean(present(linked.map((commit) => commit.churn7))),
        'ratio',
        present(linked.map((commit) => commit.churn7)).length,
        'Share of added lines that blame no longer attributes to the commit after 7 days.',
        'Compared with commits in the same repo that no session links to.',
        { commits: linked.length },
      ),
      metric(
        'tests',
        'Test touch',
        ratio(linked.filter((commit) => commit.testFilesChanged > 0).length, linked.length),
        'ratio',
        linked.length,
        'Share of linked commits that change at least one test file.',
        CAVEAT,
        {
          commits: linked.length,
          withTests: linked.filter((commit) => commit.testFilesChanged > 0).length,
        },
      ),
      metric(
        'test-lines',
        'Test lines',
        testLineShare(linked),
        'ratio',
        linked.length,
        'Lines added or removed in test files, divided by all lines the linked commits changed.',
        CAVEAT,
        {
          commits: linked.length,
          testLines: linked.reduce((sum, commit) => sum + commit.testLines, 0),
          changedLines: linked.reduce(
            (sum, commit) => sum + commit.insertions + commit.deletions,
            0,
          ),
        },
      ),
      metric(
        'reverts',
        'Revert rate',
        ratio(linked.filter((commit) => commit.isRevert).length, linked.length),
        'ratio',
        linked.length,
        'Share of linked commits that revert an earlier commit.',
        'Supplementary. A revert of an AI commit is not by itself a quality failure.',
        { commits: linked.length },
      ),
    ],
    cost: [
      metric(
        'cost-per-commit',
        'Cost per linked commit',
        linked.length > 0 ? linkedCost / linked.length : null,
        'usd',
        linked.length,
        'Estimated API cost of sessions that shipped a commit, divided by linked commits. Each session’s cost is counted once.',
        'Estimates use list prices, not what a subscription bills.',
        { cost: linkedCost, commits: linked.length },
      ),
      metric(
        'cost-per-100-lines',
        'Cost per 100 shipped lines',
        linkedInsertions > 0 ? (linkedCost * 100) / linkedInsertions : null,
        'usd',
        linked.length,
        'Estimated API cost of linked sessions per 100 lines those commits added.',
        'Deletions are not in the denominator.',
        { cost: linkedCost, insertions: linkedInsertions },
      ),
      metric(
        'unshipped',
        'Unshipped session cost',
        unshipped.reduce((sum, session) => sum + session.costUsd, 0),
        'usd',
        unshipped.length,
        'Cost of sessions you marked discarded, plus sessions with no linked commit 48 hours after they ended.',
        'Unshipped is not wasted. A session can still be worth it without a commit.',
        { sessions: unshipped.length },
      ),
    ],
  };
}

function matchesScope(session: MetricSessionInput, input: MetricsInput): boolean {
  if (input.repoId !== undefined && input.repoId !== null && session.repoId !== input.repoId)
    return false;
  if (
    input.provider !== undefined &&
    input.provider !== null &&
    session.provider !== input.provider
  )
    return false;
  return inWindow(session.startedAt, input.window);
}

function inWindow(iso: string | null, window: MetricWindow): boolean {
  if (iso === null) return window.from === null && window.to === null;
  if (window.from !== null && iso < window.from) return false;
  if (window.to !== null && iso > window.to) return false;
  return true;
}

function changeSize(commit: MetricCommitInput): number {
  return commit.insertions + commit.deletions;
}

function present(values: ReadonlyArray<number | null>): number[] {
  return values.filter((value): value is number => value !== null);
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ratio(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return part / whole;
}

function testLineShare(commits: readonly MetricCommitInput[]): number | null {
  const changed = commits.reduce((sum, commit) => sum + commit.insertions + commit.deletions, 0);
  if (changed <= 0) return null;
  const tests = commits.reduce((sum, commit) => sum + commit.testLines, 0);
  return tests / changed;
}

function comparison(
  id: string,
  label: string,
  unit: MetricUnit,
  linked: number | null,
  human: number | null,
  sampleLinked: number,
  sampleHuman: number,
  rule: string,
  caveat: string,
): ComparisonRow {
  return { id, label, unit, linked, human, sampleLinked, sampleHuman, rule, caveat };
}

function metric(
  id: string,
  label: string,
  value: number | null,
  unit: MetricUnit,
  sampleSize: number,
  rule: string,
  caveat: string,
  inputs: Record<string, number | string | null>,
): MetricResult {
  return {
    id,
    label,
    value,
    unit,
    sampleSize,
    confidence: sampleSize >= LOW_SAMPLE ? 'ok' : 'low',
    rule,
    caveat,
    inputs,
  };
}

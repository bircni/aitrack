import type { DayMap } from '../data/types.js';

/** Providers the desktop app watches. `claude` is Claude Code. */
export type SessionProvider = 'claude' | 'codex' | 'cursor';

export type FileTouchKind = 'read' | 'edit' | 'create' | 'delete';

export type SessionRating = 'kept' | 'reworked' | 'discarded';

export type LinkConfidence = 'high' | 'medium' | 'low';

export type LinkDecision = 'auto' | 'user';

/**
 * A file the session read or wrote.
 *
 * Paths are whatever the tool recorded (often absolute). Linking normalizes
 * them against the git root before comparing with commit paths.
 */
export interface FileTouch {
  path: string;
  kind: FileTouchKind;
  at: string | null;
  turnIndex: number;
}

/** One user or assistant step. Token fields are zero when the provider has none. */
export interface SessionTurn {
  index: number;
  startedAt: string | null;
  endedAt: string | null;
  role: 'user' | 'assistant';
  model: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  rawInputTokens: number;
  cacheCreationInputTokens: number;
  cacheCreation1hInputTokens: number;
  costUSD: number | null;
  toolCalls: number;
  sidechain: boolean;
}

/**
 * One assistant session.
 *
 * Message text is intentionally absent: prompts stay in the tool's own
 * transcript. `signals` on the read result carry a short in-memory excerpt
 * for commit linking and are never written to the database.
 */
export interface Session {
  id: string;
  provider: SessionProvider;
  externalId: string;
  sourcePath: string;
  cwd: string | null;
  cwdUncertain: boolean;
  /** Latest branch seen in the transcript. */
  branch: string | null;
  /** Every distinct branch, earliest first. */
  branches: string[];
  startedAt: string | null;
  endedAt: string | null;
  firstEditAt: string | null;
  lastEditAt: string | null;
  partial: boolean;
  /** False for Cursor, whose token export is per day, not per session. */
  tokensKnown: boolean;
  /** Basename of the first file the session created or edited. */
  title: string | null;
  turns: SessionTurn[];
  fileTouches: FileTouch[];
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUSD: number;
  models: string[];
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
}

/** In-memory text used only to score a link. Callers must not persist it. */
export interface SessionSignals {
  userExcerpt: string;
  assistantExcerpt: string;
}

export interface ReadSessionResult {
  session: Session;
  signals: SessionSignals;
  /** Claude message keys, so a corpus merge can apply the same dedupe as the day map. */
  dedupeKeys: string[];
  /**
   * Per-file usage in the same shape as the day-map cache.
   * Null for providers that do not share that cache.
   */
  usage: { days: DayMap; keys: string[] } | null;
}

export interface CursorDailyStat {
  date: string;
  tabSuggestedLines: number;
  tabAcceptedLines: number;
  composerSuggestedLines: number;
  composerAcceptedLines: number;
}

export interface CursorCommitAttribution {
  commitHash: string;
  repoName: string | null;
  branchName: string | null;
  aiPercentage: number | null;
  composerLinesAdded: number;
  composerLinesDeleted: number;
  tabLinesAdded: number;
  tabLinesDeleted: number;
}

export interface ParsedCommitFile {
  path: string;
  insertions: number;
  deletions: number;
}

export interface ParsedCommit {
  sha: string;
  parents: string[];
  authorTime: string;
  commitTime: string;
  authorEmail: string;
  subject: string;
  body: string;
  files: ParsedCommitFile[];
  isMerge: boolean;
  isRevert: boolean;
  revertOf: string | null;
}

export interface LinkSignal {
  name: 'files' | 'time' | 'branch' | 'cursor' | 'text';
  weight: number;
  score: number;
  detail: string;
}

export interface CommitLink {
  sessionId: string;
  sha: string;
  score: number;
  confidence: LinkConfidence;
  signals: LinkSignal[];
  share: number;
}

export interface LinkableCommit {
  sha: string;
  authorTime: string;
  paths: string[];
  branches: string[];
  subject: string;
  body: string;
  /** Cursor's own AI-line percentage for this sha, when it has one. */
  cursorAiPercentage: number | null;
}

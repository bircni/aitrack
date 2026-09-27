import type { Channel, RequestOf, ResponseOf } from '../../shared/contracts';

export interface Bootstrap {
  platform: string;
  onboarded: boolean;
  theme: 'system' | 'dark' | 'light';
  claude: boolean;
  codex: boolean;
  cursor: boolean;
  paused: boolean;
  background: boolean;
  openAtLogin: boolean;
  rateReminder: boolean;
}

export interface SessionSummary {
  id: string;
  provider: 'claude' | 'codex' | 'cursor';
  title: string | null;
  cwd: string | null;
  branch: string | null;
  startedAt: string | null;
  endedAt: string | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  tokensKnown: boolean;
  rating: 'kept' | 'reworked' | 'discarded' | null;
  linkedCommits: number;
  repoId: string | null;
  toolCalls: number;
  userMessages: number;
  assistantMessages: number;
}

export interface SessionDetail extends SessionSummary {
  ratingNote: string | null;
  turns: Array<{
    index: number;
    role: string;
    startedAt: string | null;
    model: string | null;
    toolCalls: number;
    sidechain: boolean;
  }>;
  branches: string[];
  files: Array<{ path: string; kind: string }>;
  links: Array<{
    sha: string;
    subject: string;
    score: number;
    confidence: string;
    explanation: string;
    decidedBy: string;
  }>;
}

export interface CommitSummary {
  id: number;
  repoId: string;
  sha: string;
  authorTime: string;
  subject: string;
  insertions: number;
  deletions: number;
  testFiles: number;
  isRevert: boolean;
  revertOf: string | null;
  churn7: number | null;
  churn30: number | null;
  churnNote: string | null;
  linked: boolean;
  sessionId: string | null;
  linkScore: number | null;
  unreachable: boolean;
}

export interface RepoSummary {
  id: string;
  rootPath: string;
  name: string;
  remoteUrl: string | null;
  enabled: boolean;
  testGlobs: string[];
  lastSeen: string | null;
  gitOk: boolean;
  gitDetail: string | null;
  importedAt: string | null;
}

export interface UsageDay {
  day: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
}

export interface MetricResult {
  id: string;
  label: string;
  value: number | null;
  unit: string;
  sampleSize: number;
  confidence: 'ok' | 'low';
  rule: string;
  caveat: string;
  inputs: Record<string, number | string | null>;
}

export interface ComparisonRow {
  id: string;
  label: string;
  unit: string;
  linked: number | null;
  human: number | null;
  sampleLinked: number;
  sampleHuman: number;
  rule: string;
  caveat: string;
}

declare global {
  interface Window {
    aitrack: {
      invoke(channel: string, payload?: unknown): Promise<unknown>;
      onChanged(listener: () => void): () => void;
    };
  }
}

export async function ask<C extends Channel>(
  channel: C,
  ...args: RequestOf<C> extends undefined ? [] : [payload: RequestOf<C>]
): Promise<ResponseOf<C>> {
  const payload = args[0];
  return (await window.aitrack.invoke(channel, payload)) as ResponseOf<C>;
}

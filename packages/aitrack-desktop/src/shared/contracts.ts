import { z } from 'zod';

const none = z.undefined();
const provider = z.enum(['claude', 'codex', 'cursor']);
const rating = z.enum(['kept', 'reworked', 'discarded']);
const theme = z.enum(['system', 'dark', 'light']);
const metricUnit = z.enum(['usd', 'minutes', 'ratio', 'count', 'lines']);
const confidence = z.enum(['ok', 'low']);

const ack = z.object({ ok: z.boolean() }).loose();
const messageResult = z.object({ ok: z.boolean(), message: z.string() }).loose();

const bootstrap = z
  .object({
    platform: z.string(),
    onboarded: z.boolean(),
    theme,
    claude: z.boolean(),
    codex: z.boolean(),
    cursor: z.boolean(),
    paused: z.boolean(),
    background: z.boolean(),
    openAtLogin: z.boolean(),
    rateReminder: z.boolean(),
  })
  .loose();

const session = z
  .object({
    id: z.string(),
    provider,
    title: z.string().nullable(),
    cwd: z.string().nullable(),
    branch: z.string().nullable(),
    startedAt: z.string().nullable(),
    endedAt: z.string().nullable(),
    firstEditAt: z.string().nullable(),
    costUsd: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    tokensKnown: z.boolean(),
    rating: rating.nullable(),
    ratingNote: z.string().nullable(),
    linkedCommits: z.number(),
    repoId: z.string().nullable(),
    toolCalls: z.number(),
    userMessages: z.number(),
    assistantMessages: z.number(),
  })
  .loose();

const sessionDetail = session
  .extend({
    turns: z.array(
      z.object({
        index: z.number(),
        role: z.string(),
        startedAt: z.string().nullable(),
        model: z.string().nullable(),
        toolCalls: z.number(),
        sidechain: z.boolean(),
      }),
    ),
    branches: z.array(z.string()),
    files: z.array(z.object({ path: z.string(), kind: z.string() })),
    links: z.array(
      z.object({
        sha: z.string(),
        subject: z.string(),
        score: z.number(),
        confidence: z.string(),
        explanation: z.string(),
        decidedBy: z.string(),
      }),
    ),
  })
  .loose();

const commit = z
  .object({
    id: z.number(),
    repoId: z.string(),
    sha: z.string(),
    authorTime: z.string(),
    subject: z.string(),
    insertions: z.number(),
    deletions: z.number(),
    testFiles: z.number(),
    isRevert: z.boolean(),
    revertOf: z.string().nullable(),
    churn7: z.number().nullable(),
    churn30: z.number().nullable(),
    churnNote: z.string().nullable(),
    linked: z.boolean(),
    sessionId: z.string().nullable(),
    linkScore: z.number().nullable(),
    unreachable: z.boolean(),
  })
  .loose();

const repo = z
  .object({
    id: z.string(),
    rootPath: z.string(),
    name: z.string(),
    remoteUrl: z.string().nullable(),
    enabled: z.boolean(),
    testGlobs: z.array(z.string()),
    lastSeen: z.string().nullable(),
    gitOk: z.boolean(),
    gitDetail: z.string().nullable(),
    importedAt: z.string().nullable(),
  })
  .loose();

const usageDay = z
  .object({
    day: z.string(),
    provider: z.string(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    cachedTokens: z.number(),
    costUsd: z.number(),
  })
  .loose();

const metric = z
  .object({
    id: z.string(),
    label: z.string(),
    value: z.number().nullable(),
    unit: metricUnit,
    sampleSize: z.number(),
    confidence,
    rule: z.string(),
    caveat: z.string(),
    inputs: z.record(z.string(), z.union([z.number(), z.string(), z.null()])),
  })
  .loose();

const comparison = z
  .object({
    id: z.string(),
    label: z.string(),
    unit: metricUnit,
    linked: z.number().nullable(),
    human: z.number().nullable(),
    sampleLinked: z.number(),
    sampleHuman: z.number(),
    rule: z.string(),
    caveat: z.string(),
  })
  .loose();

const leverage = z
  .object({
    report: z.object({
      linkedCommits: z.number(),
      humanCommits: z.number(),
      confidence,
      comparisons: z.array(comparison),
      speed: z.array(metric),
      quality: z.array(metric),
      cost: z.array(metric),
      ratings: z.object({
        kept: z.number(),
        reworked: z.number(),
        discarded: z.number(),
        unrated: z.number(),
      }),
    }),
    tabs: metric,
  })
  .loose();

const settingsUpdate = z.object({
  onboarded: z.boolean().optional(),
  theme: theme.optional(),
  claude: z.boolean().optional(),
  codex: z.boolean().optional(),
  cursor: z.boolean().optional(),
  paused: z.boolean().optional(),
  openAtLogin: z.boolean().optional(),
  budgetMonthly: z.number().positive().nullable().optional(),
  linkBeforeMin: z.number().positive().optional(),
  linkAfterHours: z.number().positive().optional(),
  background: z.boolean().optional(),
  rateReminder: z.boolean().optional(),
});

export const contracts = {
  bootstrap: { request: none, response: bootstrap },
  'sessions:list': { request: none, response: z.array(session) },
  'sessions:get': { request: z.object({ id: z.string() }), response: sessionDetail.nullable() },
  'sessions:rate': {
    request: z.object({ id: z.string(), rating, note: z.string().nullable() }),
    response: ack,
  },
  'commits:list': { request: none, response: z.array(commit) },
  'commits:links': {
    request: z.object({ id: z.number() }),
    response: z.array(
      z.object({
        sessionId: z.string(),
        title: z.string().nullable(),
        score: z.number(),
        confidence: z.string(),
        explanation: z.string(),
        decidedBy: z.string(),
      }),
    ),
  },
  'commits:files': {
    request: z.object({ id: z.number() }),
    response: z.array(
      z.object({
        path: z.string(),
        insertions: z.number().nullable(),
        deletions: z.number().nullable(),
      }),
    ),
  },
  'commits:decide': {
    request: z.object({
      commitId: z.number(),
      sessionId: z.string(),
      decision: z.enum(['confirm', 'reject', 'link']),
    }),
    response: ack,
  },
  'repos:list': { request: none, response: z.array(repo) },
  'repos:update': {
    request: z.object({ id: z.string(), enabled: z.boolean(), testGlobs: z.array(z.string()) }),
    response: ack,
  },
  'cost:get': { request: none, response: z.array(usageDay) },
  'cost:budget': {
    request: none,
    response: z.object({
      monthlyUSD: z.number().nullable(),
      status: z
        .object({
          level: z.enum(['ok', 'warn', 'over']),
          ratio: z.number(),
          spentUSD: z.number(),
          budgetUSD: z.number(),
          overUSD: z.number(),
        })
        .nullable(),
    }),
  },
  'cost:models': {
    request: z.object({
      from: z.string().nullable(),
      to: z.string().nullable(),
    }),
    response: z.array(z.object({ model: z.string(), costUsd: z.number(), sessions: z.number() })),
  },
  'cost:refresh': { request: none, response: messageResult },
  'leverage:get': {
    request: z.object({
      from: z.string().nullable(),
      to: z.string().nullable(),
      repoId: z.string().nullable(),
      provider: provider.nullable(),
    }),
    response: leverage,
  },
  'machines:list': {
    request: none,
    response: z.array(
      z.object({
        id: z.string(),
        timezone: z.string().nullable(),
        lastUpdated: z.string().nullable(),
        days: z.number(),
      }),
    ),
  },
  'settings:get': { request: none, response: bootstrap },
  'settings:update': { request: settingsUpdate, response: messageResult },
  'sync:status': {
    request: none,
    response: z.object({
      configured: z.boolean(),
      cloned: z.boolean(),
      machineId: z.string().nullable(),
      repoUrl: z.string().nullable(),
      dirty: z.boolean(),
    }),
  },
  'sync:preview': {
    request: none,
    response: z.object({
      ok: z.boolean(),
      message: z.string(),
      file: z.string().nullable(),
      days: z.number(),
    }),
  },
  'sync:connect': {
    request: z.object({ confirm: z.string(), repoUrl: z.string() }),
    response: messageResult,
  },
  'sources:get': {
    request: none,
    response: z.object({
      claude: z.array(z.string()),
      codex: z.array(z.string()),
      linkBeforeMin: z.number(),
      linkAfterHours: z.number(),
    }),
  },
  'sync:push': { request: z.object({ confirm: z.string() }), response: messageResult },
  'diagnostics:get': {
    request: none,
    response: z.object({
      checks: z.array(
        z.object({
          status: z.enum(['ok', 'warn', 'fail']),
          label: z.string(),
          detail: z.string(),
        }),
      ),
      log: z.array(z.object({ at: z.string(), kind: z.string(), detail: z.string() })),
    }),
  },
  'ingest:rebuild': {
    request: none,
    response: z.object({
      sessions: z.number(),
      repos: z.number(),
      commits: z.number(),
      links: z.number(),
    }),
  },
  'export:save': {
    request: z.object({ kind: z.enum(['pdf', 'csv']) }),
    response: messageResult,
  },
} satisfies Record<string, { request: z.ZodType; response: z.ZodType }>;

export type Channel = keyof typeof contracts;

export type RequestOf<C extends Channel> = z.output<(typeof contracts)[C]['request']>;

export type ResponseOf<C extends Channel> = z.output<(typeof contracts)[C]['response']>;

export const CHANNELS: readonly Channel[] = Object.keys(contracts) as Channel[];

const ALLOWED_CHANNELS = new Set<string>(CHANNELS);

/** Preload rejects anything outside the contract list before it reaches main. */
export function isKnownChannel(channel: string): boolean {
  return ALLOWED_CHANNELS.has(channel);
}

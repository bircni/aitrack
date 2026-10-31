import { join } from 'node:path';

import { tryLoadConfig } from '../config.js';
import { addModelUsage, type Attribution, getOrCreateDay, mergeDayMaps } from '../data/dayMap.js';
import { normalizeRemoteUrl } from '../data/project.js';
import type { DayMap } from '../data/types.js';
import { environmentValue } from '../env.js';
import { estimateCodexCostUSD } from '../pricing/codex.js';
import type { FallbackCollector } from '../pricing/fallback.js';
import type { CachedParse } from './cache.js';
import { type CodexScan, scanCodexFile, type SessionTotals } from './codexScan.js';
import { codexHomeDirs, resolveSourceRoots } from './paths.js';
import { parseProviderSources } from './pipeline.js';
import { attributeCwd, createProjectResolver, type ProjectResolver } from './projectResolver.js';

export function getCodexPaths(): string[] {
  return resolveSourceRoots({
    envValue: environmentValue('AITRACK_CODEX_SESSION_DIRS'),
    configValue: tryLoadConfig()?.codexSessionsDir,
    defaults: codexHomeDirs().map((dir) => join(dir, 'sessions')),
  });
}

interface SessionResult extends SessionTotals {
  /** One per session file, so every result of a file shares it. */
  attribution: Attribution;
}

function attributeScan(
  { repositoryUrl, cwd }: CodexScan,
  resolveProject: ProjectResolver,
): Promise<Attribution> {
  const remote = repositoryUrl === undefined ? null : normalizeRemoteUrl(repositoryUrl);
  return remote === null ? attributeCwd(resolveProject, cwd) : Promise.resolve({ project: remote });
}

export async function parseSessionFile(
  filePath: string,
  resolveProject: ProjectResolver = createProjectResolver(),
): Promise<SessionResult[]> {
  const scan = await scanCodexFile(filePath);
  const attribution = await attributeScan(scan, resolveProject);
  return scan.sessions.map((result) => ({ ...result, attribution }));
}

function addSessionResult(
  allDays: DayMap,
  result: SessionResult,
  fallbacks?: FallbackCollector,
): void {
  const { dateStr, model, inputTokens, outputTokens, cachedInputTokens } = result;
  const day = getOrCreateDay(allDays, dateStr);
  const cost = estimateCodexCostUSD(
    model,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    dateStr,
    fallbacks,
  );
  addModelUsage(
    day,
    model,
    {
      inputTokens,
      outputTokens,
      cachedInputTokens,
      ...(cost !== undefined && { costUSD: cost }),
    },
    result.attribution,
  );
}

/**
 * One session file's contribution, computed from its own bytes alone so it can
 * be cached. Codex has no cross-file de-duplication, so there are no keys.
 */
async function finishCodexScan(
  scan: CodexScan,
  fallbacks: FallbackCollector | undefined,
  resolveProject: ProjectResolver,
): Promise<CachedParse> {
  const days: DayMap = new Map();
  if (scan.sessions.length === 0) return { days, keys: [] }; // No git call for a file without usage.
  const attribution = await attributeScan(scan, resolveProject);
  for (const result of scan.sessions) addSessionResult(days, { ...result, attribution }, fallbacks);
  return { days, keys: [] };
}

export async function readCodexData(fallbacks?: FallbackCollector): Promise<DayMap> {
  const resolveProject = createProjectResolver();
  const parsed = await parseProviderSources({
    kind: 'codex',
    roots: getCodexPaths(),
    finish: (scan) => finishCodexScan(scan, fallbacks, resolveProject),
  });

  const allDays: DayMap = new Map();
  for (const entry of parsed) mergeDayMaps(allDays, entry.days);
  return allDays;
}

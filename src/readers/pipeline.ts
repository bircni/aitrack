import type { FallbackCollector } from '../pricing/fallback.js';
import { type CachedParse, openParseCache } from './cache.js';
import { mapWithConcurrency } from './concurrency.js';
import { listUniqueSourceFiles } from './paths.js';

/**
 * Read every source file for one provider, using the mtime/size cache.
 *
 * The Claude and Codex readers ran byte-identical copies of this — list the
 * files, open the cache, parse the misses with bounded concurrency, save. What
 * genuinely differs is how the per-file results are merged afterwards (Claude
 * re-reads a file whose messages were already counted; Codex just merges), so
 * that stays with each reader rather than being forced into a shared shape.
 *
 * Note that a cache hit skips `parseFile` entirely, so a run that reads only
 * cached transcripts records no pricing fallbacks. That has always been true.
 */
export async function parseProviderSources(options: {
  /** Cache namespace, e.g. 'claude'. */
  cacheName: string;
  /** Directories to search for source files. */
  roots: string[];
  parseFile: (filePath: string, fallbacks?: FallbackCollector) => Promise<CachedParse>;
  fallbacks?: FallbackCollector;
}): Promise<{ files: string[]; parsed: CachedParse[] }> {
  const files = await listUniqueSourceFiles(options.roots);
  const cache = openParseCache(options.cacheName);

  const parsed = await mapWithConcurrency(files, async (filePath) => {
    const cached = await cache.lookup(filePath);
    if (cached) return cached;
    const fresh = await options.parseFile(filePath, options.fallbacks);
    await cache.record(filePath, fresh);
    return fresh;
  });
  cache.save();

  return { files, parsed };
}

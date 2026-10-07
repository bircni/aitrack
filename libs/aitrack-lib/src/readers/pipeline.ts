import type { FallbackCollector } from '../pricing/fallback.js';
import { type CachedParse, openParseCache } from './cache.js';
import { mapWithConcurrency } from './concurrency.js';
import { listUniqueSourceFiles } from './paths.js';

/**
 * Read every source file for one provider, using the mtime/size cache.
 * Cache hits skip parseFile; recordPricingFallbacks covers them.
 */
export async function parseProviderSources(options: {
  /** Cache namespace, e.g. 'claude'. */
  cacheName: string;
  /** Directories to search for source files. */
  roots: string[];
  parseFile: (filePath: string, fallbacks?: FallbackCollector) => Promise<CachedParse>;
  fallbacks?: FallbackCollector;
}): Promise<CachedParse[]> {
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
  return parsed;
}

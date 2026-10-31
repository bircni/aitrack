import { type CachedParse, openParseCache } from './cache.js';
import { mapWithConcurrency } from './concurrency.js';
import { listUniqueSourceFiles } from './paths.js';
import { type ScanKind, type ScanResult, scanEach } from './scanPool.js';

/**
 * Read every source file for one provider, using the mtime/size cache. Files
 * the cache misses are scanned (in workers for a large batch), then priced and
 * attributed here by `finish`.
 */
export async function parseProviderSources<K extends ScanKind>(options: {
  /** Scanner and cache namespace. */
  kind: K;
  /** Directories to search for source files. */
  roots: string[];
  finish: (scan: ScanResult<K>) => Promise<CachedParse>;
}): Promise<CachedParse[]> {
  const files = await listUniqueSourceFiles(options.roots);
  const cache = openParseCache(options.kind);

  const sources = await mapWithConcurrency(files, async (filePath) => ({
    filePath,
    parse: await cache.lookup(filePath),
  }));
  const missed = sources.filter((source) => source.parse === null);
  await mapWithConcurrency(
    scanEach(options.kind, missed, cache.missedBytes()),
    async ({ source, scan }) => {
      const parse = await options.finish(await scan());
      source.parse = parse;
      await cache.record(source.filePath, parse);
    },
  );
  cache.save();
  return sources.map(({ parse }) => parse).filter((parse) => parse !== null);
}

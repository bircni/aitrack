import type { DayMap } from '../data/types.js';
import {
  type CachedParse,
  type FileStamp,
  fileStamp,
  openMergedSnapshot,
  openParseCache,
} from './cache.js';
import { mapWithConcurrency } from './concurrency.js';
import { listUniqueSourceFiles } from './paths.js';
import { type ScanKind, type ScanResult, scanEach } from './scanPool.js';

interface SourceFiles {
  files: string[];
  stamps: Array<FileStamp | null>;
}

/** Stamped before any scan, so a write during one reads as a change next run. */
async function listSources(roots: string[]): Promise<SourceFiles> {
  const files = await listUniqueSourceFiles(roots);
  return { files, stamps: files.map((file) => fileStamp(file)) };
}

interface ProviderSources<K extends ScanKind> {
  /** Scanner and cache namespace. */
  kind: K;
  /** Directories to search for source files. */
  roots: string[];
  finish: (scan: ScanResult<K>) => Promise<CachedParse>;
}

/**
 * Read every source file for one provider, per file. Files the mtime/size cache
 * misses are scanned (in workers for a large batch), then priced and attributed
 * here by `finish`.
 */
export async function parseProviderSources<K extends ScanKind>(
  { kind, roots, finish }: ProviderSources<K>,
  listed?: SourceFiles,
): Promise<CachedParse[]> {
  const { files, stamps } = listed ?? (await listSources(roots));
  const cache = openParseCache(kind);
  const sources = files.map((filePath, index) => ({
    filePath,
    parse: cache.lookup(filePath, stamps[index]),
  }));
  const missed = sources.filter((source) => source.parse === null);
  await mapWithConcurrency(
    scanEach(kind, missed, cache.missedBytes()),
    async ({ source, scan }) => {
      const parse = await finish(await scan());
      source.parse = parse;
      cache.record(source.filePath, parse);
    },
  );
  cache.save();
  return sources.map(({ parse }) => parse).filter((parse) => parse !== null);
}

/** A provider's merged days, reusing the last merge when no source file changed. */
export async function readProviderDays<K extends ScanKind>(
  options: ProviderSources<K> & { merge: (parsed: CachedParse[]) => DayMap },
): Promise<DayMap> {
  const listed = await listSources(options.roots);
  const snapshot = openMergedSnapshot(options.kind, listed.files, listed.stamps);
  const known = snapshot.read();
  if (known) return known;
  const days = options.merge(await parseProviderSources(options, listed));
  snapshot.write(days);
  return days;
}

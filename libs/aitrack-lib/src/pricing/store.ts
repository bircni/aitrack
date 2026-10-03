import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isRecord } from '../data/guards.js';
import { environmentValue } from '../env.js';
import { APP_DIR } from '../paths.js';
import type { CompactCatalog } from './codecs.js';
import { type ModelPricing, modelPricingFromPack } from './modelPricing.js';
import { type PricingSupplement, pricingPackUrls } from './packMeta.js';
import { supplementFromTables } from './supplementFromTables.js';
import { isCompactCatalog, isPricingManifest, isPricingSupplement } from './validation.js';

export const PRICING_CACHE_DIR = join(APP_DIR, 'pricing');
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FAILURE_RETRY_MS = 30 * 60 * 1000;
const EMPTY_CATALOG: CompactCatalog = { retrievedAt: '1970-01-01T00:00:00.000Z', models: {} };

interface SourceState {
  etag?: string;
  fetchedAt?: string;
  failedAt?: string;
}
const SOURCES = ['manifest', 'supplement', 'litellm', 'modelsDev'] as const;
type Source = (typeof SOURCES)[number];
interface CacheState {
  sources: Partial<Record<Source, SourceState>>;
}
export interface PricingRefreshResult {
  updated: boolean;
  reason: string;
  updatedAt: string;
}

function isStale(state: SourceState | undefined, now: number): boolean {
  if (state?.failedAt && now - Date.parse(state.failedAt) < FAILURE_RETRY_MS) return false;
  return !state?.fetchedAt || !(now - Date.parse(state.fetchedAt) < REFRESH_INTERVAL_MS);
}

function parseBody<T>(body: string, validate: (value: unknown) => value is T, hash?: string): T {
  if (hash && createHash('sha256').update(body).digest('hex') !== hash) {
    throw new Error('hash mismatch');
  }
  const value: unknown = JSON.parse(body);
  if (!validate(value)) throw new Error('invalid pricing payload');
  return value;
}

function readState(path: string): CacheState {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as { sources?: unknown } | null;
    if (!value?.sources || typeof value.sources !== 'object' || Array.isArray(value.sources))
      return { sources: {} };
    for (const source of Object.values(value.sources) as unknown[]) {
      if (
        !source ||
        typeof source !== 'object' ||
        Array.isArray(source) ||
        ['etag', 'fetchedAt', 'failedAt']
          .map((key) => (source as Record<string, unknown>)[key])
          .some((field) => field !== undefined && typeof field !== 'string')
      ) {
        return { sources: {} };
      }
    }
    return value as CacheState;
  } catch {
    return { sources: {} };
  }
}

async function writeAtomic(path: string, body: string): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

function pricingFromParts(
  supplement: PricingSupplement,
  litellm = EMPTY_CATALOG,
  modelsDev = EMPTY_CATALOG,
): ModelPricing {
  return modelPricingFromPack({ supplement, litellm, modelsDev });
}

/** Local tables with a complete, validated disk overlay. Network refresh is optional. */
export class PricingStore {
  private snapshot: ModelPricing;
  private readonly localSupplement = supplementFromTables();
  private state: CacheState = { sources: {} };
  private cachedFiles: Record<string, unknown> | undefined;
  private refreshInFlight: Promise<PricingRefreshResult> | undefined;

  constructor(private readonly cacheDir = PRICING_CACHE_DIR) {
    this.snapshot = pricingFromParts(structuredClone(this.localSupplement));
    this.hydrateFromDiskSync();
  }

  private hydrateFromDiskSync(): void {
    this.state = readState(join(this.cacheDir, 'state.json'));
    try {
      const packPath = join(this.cacheDir, 'pack.json');
      if (existsSync(packPath)) {
        const files: unknown = JSON.parse(readFileSync(packPath, 'utf8'));
        if (!isRecord(files)) throw new Error('invalid cached pricing pack');
        this.cachedFiles = files;
      }
      const load = <T>(file: string, validate: (value: unknown) => value is T, hash?: string): T =>
        parseBody(this.cachedBody(file), validate, hash);
      const manifest = load('manifest.json', isPricingManifest);
      const supplement = load(
        manifest.files.supplement,
        isPricingSupplement,
        manifest.hashes.supplement,
      );
      const litellm = load(manifest.files.litellm, isCompactCatalog, manifest.hashes.litellm);
      const modelsDev = load(manifest.files.modelsDev, isCompactCatalog, manifest.hashes.modelsDev);
      this.snapshot = pricingFromParts(this.mergeSupplement(supplement), litellm, modelsDev);
    } catch {
      this.snapshot = pricingFromParts(structuredClone(this.localSupplement));
      // An incomplete cache must recover immediately, except during failure backoff.
      for (const source of Object.values(this.state.sources)) source.fetchedAt = undefined;
    }
  }

  private cachedBody(fileName: string): string {
    // Read legacy component files only when no aggregate cache exists.
    if (!this.cachedFiles) return readFileSync(join(this.cacheDir, fileName), 'utf8');
    const body = this.cachedFiles[fileName];
    if (typeof body !== 'string') throw new Error(`missing cached ${fileName}`);
    return body;
  }

  private mergeSupplement(remote: PricingSupplement): PricingSupplement {
    if (Date.parse(remote.updatedAt) <= Date.parse(this.localSupplement.updatedAt)) {
      return structuredClone(this.localSupplement);
    }
    // Pack build times do not guarantee that every bundled entry exists remotely.
    const local = structuredClone(this.localSupplement);
    return {
      ...remote,
      claude: {
        models: { ...local.claude.models, ...remote.claude.models },
        overrides: { ...local.claude.overrides, ...remote.claude.overrides },
        familyFallback: { ...local.claude.familyFallback, ...remote.claude.familyFallback },
      },
      codex: {
        current: { ...local.codex.current, ...remote.codex.current },
        historical: { ...local.codex.historical, ...remote.codex.historical },
        overrides: { ...local.codex.overrides, ...remote.codex.overrides },
        familyFallback: [
          ...remote.codex.familyFallback,
          ...local.codex.familyFallback.filter(
            (entry) => !remote.codex.familyFallback.some((rule) => rule.match === entry.match),
          ),
        ],
      },
      cursor: {
        models: { ...local.cursor.models, ...remote.cursor.models },
        fastMultipliers: { ...local.cursor.fastMultipliers, ...remote.cursor.fastMultipliers },
        aliases: [
          ...remote.cursor.aliases,
          ...local.cursor.aliases.filter(
            (entry) => !remote.cursor.aliases.some((rule) => rule.pattern === entry.pattern),
          ),
        ],
      },
    };
  }

  current(): ModelPricing {
    return this.snapshot;
  }
  refreshIfDue(force = false): Promise<PricingRefreshResult> {
    if (environmentValue('AITRACK_NO_PRICING_REFRESH') === '1') {
      return Promise.resolve(this.result(false, 'disabled by AITRACK_NO_PRICING_REFRESH=1'));
    }
    if (this.refreshInFlight) return this.refreshInFlight;
    if (!force && !SOURCES.some((key) => isStale(this.state.sources[key], Date.now()))) {
      return Promise.resolve(this.result(false, 'cache still fresh'));
    }
    this.refreshInFlight = this.refresh().finally(() => {
      this.refreshInFlight = undefined;
    });
    return this.refreshInFlight;
  }

  private result(updated: boolean, reason: string): PricingRefreshResult {
    return { updated, reason, updatedAt: this.snapshot.updatedAt };
  }

  private async refresh(): Promise<PricingRefreshResult> {
    const nowIso = new Date().toISOString();
    try {
      await mkdir(this.cacheDir, { recursive: true });
      const urls = pricingPackUrls();
      const manifest = await this.refreshFile(
        'manifest',
        urls.manifest,
        'manifest.json',
        isPricingManifest,
      );
      const supplement = await this.refreshFile(
        'supplement',
        urls.supplement,
        'supplement.json',
        isPricingSupplement,
        manifest.value.hashes.supplement,
      );
      const litellm = await this.refreshFile(
        'litellm',
        urls.litellm,
        'litellm.json',
        isCompactCatalog,
        manifest.value.hashes.litellm,
      );
      const modelsDev = await this.refreshFile(
        'modelsDev',
        urls.modelsDev,
        'models_dev.json',
        isCompactCatalog,
        manifest.value.hashes.modelsDev,
      );
      const next = pricingFromParts(
        this.mergeSupplement(supplement.value),
        litellm.value,
        modelsDev.value,
      );
      const files = [supplement, litellm, modelsDev, manifest];
      const nextState: CacheState = { sources: {} };
      const cachedFiles = Object.fromEntries(files.map((file) => [file.fileName, file.body]));
      // A single rename commits a whole generation, even with concurrent writers.
      if (!this.cachedFiles || files.some((file) => file.changed)) {
        await writeAtomic(join(this.cacheDir, 'pack.json'), JSON.stringify(cachedFiles));
      }
      for (const file of files) {
        nextState.sources[file.name] = { etag: file.etag, fetchedAt: nowIso };
      }
      await writeAtomic(join(this.cacheDir, 'state.json'), JSON.stringify(nextState));
      const updated =
        next.updatedAt !== this.snapshot.updatedAt ||
        files.slice(0, 3).some((file) => file.changed);
      this.cachedFiles = cachedFiles;
      this.state = nextState;
      this.snapshot = next;
      return this.result(
        updated,
        updated ? 'pricing pack refreshed from pricing branch' : 'remote pack unchanged',
      );
    } catch (error) {
      for (const key of SOURCES) {
        this.state.sources[key] = { ...this.state.sources[key], failedAt: nowIso };
      }
      await writeAtomic(join(this.cacheDir, 'state.json'), JSON.stringify(this.state)).catch(
        () => undefined,
      );
      return this.result(
        false,
        `refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async refreshFile<T>(
    name: Source,
    url: string,
    fileName: string,
    validate: (value: unknown) => value is T,
    hash?: string,
  ) {
    const etag = this.state.sources[name]?.etag;
    const fetchFile = (conditional: boolean) =>
      fetch(url, {
        headers: {
          'user-agent': 'aitrack-pricing-store',
          ...(conditional && etag ? { 'if-none-match': etag } : {}),
        },
        signal: AbortSignal.timeout(5_000),
      });
    let response = await fetchFile(true);
    if (response.status === 304) {
      try {
        const body = this.cachedBody(fileName);
        return {
          name,
          fileName,
          body,
          value: parseBody(body, validate, hash),
          etag: response.headers.get('etag') ?? etag,
          changed: false,
        };
      } catch {
        response = await fetchFile(false);
      }
    }
    if (!response.ok) throw new Error(`HTTP ${String(response.status)} for ${url}`);
    const body = await response.text();
    return {
      name,
      fileName,
      body,
      value: parseBody(body, validate, hash),
      etag: response.headers.get('etag') ?? undefined,
      changed: true,
    };
  }
}

let sharedStore: PricingStore | undefined;
export function sharedPricingStore(): PricingStore {
  return (sharedStore ??= new PricingStore());
}
export function currentModelPricing(): ModelPricing {
  return sharedPricingStore().current();
}
export function resetSharedPricingStore(): void {
  sharedStore = undefined;
}

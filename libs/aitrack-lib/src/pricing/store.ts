import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { environmentValue } from '../env.js';
import { APP_DIR } from '../paths.js';
import { type CompactCatalog } from './codecs.js';
import { type ModelPricing, modelPricingFromPack } from './modelPricing.js';
import { type PricingManifest, type PricingSupplement, pricingPackUrls } from './packMeta.js';
import { supplementFromTables } from './supplementFromTables.js';

export const PRICING_CACHE_DIR = join(APP_DIR, 'pricing');

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FAILURE_RETRY_MS = 30 * 60 * 1000;

const EMPTY_CATALOG: CompactCatalog = { retrievedAt: '1970-01-01T00:00:00.000Z', models: {} };

interface SourceState {
  etag?: string;
  fetchedAt?: string;
  failedAt?: string;
}

interface CacheState {
  sources: {
    manifest?: SourceState;
    supplement?: SourceState;
    litellm?: SourceState;
    modelsDev?: SourceState;
  };
}

export interface PricingRefreshResult {
  updated: boolean;
  reason: string;
  updatedAt: string;
}

function sha256Hex(body: string | Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

function parseIso(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function isStale(state: SourceState | undefined, now: number): boolean {
  const failedAt = parseIso(state?.failedAt);
  // Honor the failure backoff even when the cache is missing or past TTL —
  // otherwise every command retries immediately after a failed first fetch.
  if (failedAt !== undefined && now - failedAt < FAILURE_RETRY_MS) return false;
  const fetchedAt = parseIso(state?.fetchedAt);
  if (fetchedAt === undefined) return true;
  return now - fetchedAt >= REFRESH_INTERVAL_MS;
}

function readJsonFileSync(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${String(process.pid)}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}

interface FetchResult {
  status: number;
  etag?: string;
  body?: string;
}

async function fetchText(url: string, etag?: string): Promise<FetchResult> {
  const headers: Record<string, string> = {
    'user-agent': 'aitrack-pricing-store',
  };
  if (etag) headers['if-none-match'] = etag;
  const response = await fetch(url, { headers });
  if (response.status === 304) {
    return { status: 304, etag: response.headers.get('etag') ?? etag };
  }
  if (!response.ok) {
    throw new Error(`HTTP ${String(response.status)} for ${url}`);
  }
  return {
    status: response.status,
    etag: response.headers.get('etag') ?? undefined,
    body: await response.text(),
  };
}

function newerSupplement(a: PricingSupplement, b: PricingSupplement): PricingSupplement {
  const aMs = parseIso(a.updatedAt) ?? 0;
  const bMs = parseIso(b.updatedAt) ?? 0;
  return bMs > aMs ? b : a;
}

function isPricingSupplement(value: unknown): value is PricingSupplement {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.updatedAt === 'string' &&
    record.claude !== undefined &&
    record.codex !== undefined &&
    record.cursor !== undefined
  );
}

function isCompactCatalog(value: unknown): value is CompactCatalog {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record.models !== undefined &&
    typeof record.models === 'object' &&
    record.models !== null &&
    !Array.isArray(record.models)
  );
}

function isCacheState(value: unknown): value is CacheState {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record.sources !== undefined && typeof record.sources === 'object' && record.sources !== null
  );
}

function pricingFromParts(
  supplement: PricingSupplement,
  litellm?: CompactCatalog,
  modelsDev?: CompactCatalog,
): ModelPricing {
  return modelPricingFromPack({
    supplement,
    litellm: litellm ?? EMPTY_CATALOG,
    modelsDev: modelsDev ?? EMPTY_CATALOG,
  });
}

/**
 * Local `tables/*.json` baseline + disk cache from the orphan `pricing` branch.
 * No prebuilt pack is shipped in the npm package.
 *
 * Construction (and `current()`) loads any on-disk overlay synchronously so
 * standalone commands see cached rates without waiting for sync/doctor.
 * Call `refreshIfDue()` (or let sync/doctor kick it) to pull newer rates.
 */
export class PricingStore {
  private snapshot: ModelPricing;
  private localSupplement: PricingSupplement;
  private state: CacheState;
  private refreshInFlight: Promise<PricingRefreshResult> | undefined;
  private readonly cacheDir: string;

  constructor(cacheDir = PRICING_CACHE_DIR) {
    this.cacheDir = cacheDir;
    this.localSupplement = supplementFromTables();
    this.state = { sources: {} };
    this.snapshot = pricingFromParts(this.localSupplement);
    this.hydrateFromDiskSync();
  }

  private hydrateFromDiskSync(): void {
    const state = readJsonFileSync(join(this.cacheDir, 'state.json'));
    this.state = isCacheState(state) ? state : { sources: {} };
    const cachedSupplementRaw = readJsonFileSync(join(this.cacheDir, 'supplement.json'));
    const cachedLitellmRaw = readJsonFileSync(join(this.cacheDir, 'litellm.json'));
    const cachedModelsDevRaw = readJsonFileSync(join(this.cacheDir, 'models_dev.json'));
    const cachedSupplement = isPricingSupplement(cachedSupplementRaw)
      ? cachedSupplementRaw
      : undefined;
    const cachedLitellm = isCompactCatalog(cachedLitellmRaw) ? cachedLitellmRaw : undefined;
    const cachedModelsDev = isCompactCatalog(cachedModelsDevRaw) ? cachedModelsDevRaw : undefined;
    const supplement = cachedSupplement
      ? newerSupplement(this.localSupplement, cachedSupplement)
      : this.localSupplement;
    this.snapshot = pricingFromParts(supplement, cachedLitellm, cachedModelsDev);
  }

  /** Ensure the cache directory exists and re-read disk. Safe to call once at startup. */
  async init(): Promise<ModelPricing> {
    await mkdir(this.cacheDir, { recursive: true });
    this.localSupplement = supplementFromTables();
    this.hydrateFromDiskSync();
    return this.snapshot;
  }

  current(): ModelPricing {
    return this.snapshot;
  }

  localUpdatedAt(): string {
    return this.localSupplement.updatedAt;
  }

  refreshIfDue(force = false): Promise<PricingRefreshResult> {
    if (environmentValue('AITRACK_NO_PRICING_REFRESH') === '1') {
      return Promise.resolve({
        updated: false,
        reason: 'disabled by AITRACK_NO_PRICING_REFRESH=1',
        updatedAt: this.snapshot.updatedAt,
      });
    }
    if (this.refreshInFlight) return this.refreshInFlight;

    const now = Date.now();
    const due =
      force ||
      isStale(this.state.sources.manifest, now) ||
      isStale(this.state.sources.supplement, now) ||
      isStale(this.state.sources.litellm, now) ||
      isStale(this.state.sources.modelsDev, now);

    if (!due) {
      return Promise.resolve({
        updated: false,
        reason: 'cache still fresh',
        updatedAt: this.snapshot.updatedAt,
      });
    }

    this.refreshInFlight = this.refresh().finally(() => {
      this.refreshInFlight = undefined;
    });
    return this.refreshInFlight;
  }

  private async refresh(): Promise<PricingRefreshResult> {
    await mkdir(this.cacheDir, { recursive: true });
    const urls = pricingPackUrls();
    const nowIso = new Date().toISOString();

    try {
      const manifestFetch = await fetchText(urls.manifest, this.state.sources.manifest?.etag);
      let manifest: PricingManifest | undefined;
      if (manifestFetch.status === 304) {
        this.state.sources.manifest = {
          ...this.state.sources.manifest,
          fetchedAt: nowIso,
          failedAt: undefined,
        };
        manifest = (await readJsonFile(join(this.cacheDir, 'manifest.json'))) as
          | PricingManifest
          | undefined;
      } else {
        if (!manifestFetch.body) throw new Error('empty manifest');
        manifest = JSON.parse(manifestFetch.body) as PricingManifest;
        if (manifest.schemaVersion !== 1) {
          throw new Error(`unsupported pricing pack schema ${String(manifest.schemaVersion)}`);
        }
        await writeJsonAtomic(join(this.cacheDir, 'manifest.json'), manifest);
        this.state.sources.manifest = {
          etag: manifestFetch.etag,
          fetchedAt: nowIso,
          failedAt: undefined,
        };
      }

      if (!manifest) throw new Error('manifest unavailable');

      const supplement = await this.refreshFile<PricingSupplement>({
        name: 'supplement',
        url: urls.supplement,
        fileName: 'supplement.json',
        expectedHash: manifest.hashes?.supplement,
        validate: (value): value is PricingSupplement => {
          if (!value || typeof value !== 'object') return false;
          const record = value as Record<string, unknown>;
          return (
            typeof record.updatedAt === 'string' &&
            record.claude !== undefined &&
            record.codex !== undefined &&
            record.cursor !== undefined
          );
        },
      });

      const litellm = await this.refreshFile<CompactCatalog>({
        name: 'litellm',
        url: urls.litellm,
        fileName: 'litellm.json',
        expectedHash: manifest.hashes?.litellm,
        validate: (value): value is CompactCatalog => {
          if (!value || typeof value !== 'object') return false;
          const record = value as Record<string, unknown>;
          return (
            record.models !== undefined &&
            typeof record.models === 'object' &&
            record.models !== null &&
            Object.keys(record.models).length > 0
          );
        },
      });

      const modelsDev = await this.refreshFile<CompactCatalog>({
        name: 'modelsDev',
        url: urls.modelsDev,
        fileName: 'models_dev.json',
        expectedHash: manifest.hashes?.modelsDev,
        validate: (value): value is CompactCatalog => {
          if (!value || typeof value !== 'object') return false;
          const record = value as Record<string, unknown>;
          return (
            record.models !== undefined &&
            typeof record.models === 'object' &&
            record.models !== null &&
            Object.keys(record.models).length > 0
          );
        },
      });

      await writeJsonAtomic(join(this.cacheDir, 'state.json'), this.state);

      const nextSupplement = newerSupplement(
        this.localSupplement,
        supplement.value ?? this.localSupplement,
      );
      const next = pricingFromParts(nextSupplement, litellm.value, modelsDev.value);
      const updated =
        next.updatedAt !== this.snapshot.updatedAt ||
        supplement.changed ||
        litellm.changed ||
        modelsDev.changed;
      this.snapshot = next;
      return {
        updated,
        reason: updated ? 'pricing pack refreshed from pricing branch' : 'remote pack unchanged',
        updatedAt: next.updatedAt,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const key of ['manifest', 'supplement', 'litellm', 'modelsDev'] as const) {
        this.state.sources[key] = {
          ...this.state.sources[key],
          failedAt: nowIso,
        };
      }
      await writeJsonAtomic(join(this.cacheDir, 'state.json'), this.state).catch(() => undefined);
      return {
        updated: false,
        reason: `refresh failed: ${message}`,
        updatedAt: this.snapshot.updatedAt,
      };
    }
  }

  private async refreshFile<T>({
    name,
    url,
    fileName,
    expectedHash,
    validate,
  }: {
    name: 'supplement' | 'litellm' | 'modelsDev';
    url: string;
    fileName: string;
    expectedHash?: string;
    validate: (value: unknown) => value is T;
  }): Promise<{ value?: T; changed: boolean }> {
    const nowIso = new Date().toISOString();
    const path = join(this.cacheDir, fileName);
    let fetchResult = await fetchText(url, this.state.sources[name]?.etag);

    if (fetchResult.status === 304) {
      const cachedBody = await readFile(path, 'utf8').catch(() => undefined);
      let cachedValue: T | undefined;
      let cacheOk = false;
      if (cachedBody !== undefined) {
        try {
          const parsed: unknown = JSON.parse(cachedBody);
          const hashOk = !expectedHash || sha256Hex(cachedBody) === expectedHash;
          if (hashOk && validate(parsed)) {
            cachedValue = parsed;
            cacheOk = true;
          }
        } catch {
          cacheOk = false;
        }
      }
      if (cacheOk) {
        this.state.sources[name] = {
          ...this.state.sources[name],
          fetchedAt: nowIso,
          failedAt: undefined,
        };
        return { value: cachedValue, changed: false };
      }
      // Corrupt/missing cache with a lingering ETag — drop it and fetch fresh.
      this.state.sources[name] = {
        ...this.state.sources[name],
        etag: undefined,
      };
      fetchResult = await fetchText(url);
    }

    if (!fetchResult.body) throw new Error(`empty ${name}`);
    if (expectedHash) {
      const digest = sha256Hex(fetchResult.body);
      if (digest !== expectedHash) {
        throw new Error(`${name} hash mismatch (expected ${expectedHash}, got ${digest})`);
      }
    }
    const parsed: unknown = JSON.parse(fetchResult.body);
    if (!validate(parsed)) throw new Error(`invalid ${name} payload`);
    await writeJsonAtomic(path, parsed);
    this.state.sources[name] = {
      etag: fetchResult.etag,
      fetchedAt: nowIso,
      failedAt: undefined,
    };
    return { value: parsed, changed: true };
  }
}

let sharedStore: PricingStore | undefined;
let sharedInit: Promise<ModelPricing> | undefined;

/** Process-wide store. Tests can call `resetSharedPricingStore()`. */
export function sharedPricingStore(): PricingStore {
  sharedStore ??= new PricingStore();
  return sharedStore;
}

export function ensurePricingStore(): Promise<ModelPricing> {
  const store = sharedPricingStore();
  sharedInit ??= store.init();
  return sharedInit;
}

export function currentModelPricing(): ModelPricing {
  return sharedPricingStore().current();
}

export function resetSharedPricingStore(): void {
  sharedStore = undefined;
  sharedInit = undefined;
}

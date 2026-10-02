#!/usr/bin/env tsx
/**
 * Build artifacts/pricing-pack/ for the orphan `pricing` branch from:
 *   - tables/{claude,codex,cursor}.json  → supplement.json
 *   - live LiteLLM + models.dev feeds    → litellm.json, models_dev.json
 *   - hashes                             → manifest.json
 *
 * Nothing under artifacts/ is shipped in the npm package; installs refresh from
 * the published branch into ~/.config/aitrack/pricing/.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  catalogFromCompact,
  catalogFromLiteLLM,
  catalogFromModelsDev,
  compactFromCatalog,
  findCatalogRates,
  type CompactCatalog,
} from '../libs/aitrack-lib/src/pricing/codecs.js';
import type {
  PricingManifest,
  PricingSupplement,
} from '../libs/aitrack-lib/src/pricing/packMeta.js';
import type { ClaudePricing, CodexPricing } from '../libs/aitrack-lib/src/pricing/types.js';

const ROOT = resolve(import.meta.dirname, '..');
const TABLES = join(ROOT, 'libs/aitrack-lib/src/pricing/tables');
/** Published by CI to the orphan `pricing` branch — not part of aitrack-lib. */
const PACK = join(ROOT, 'artifacts/pricing-pack');

const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const MODELS_DEV_URL = 'https://models.dev/api.json';

export interface BuildPackOptions {
  writeTablesFromFeeds?: boolean;
  /** Skip network; only rebuild supplement + manifest from existing catalog files. */
  offline?: boolean;
  /**
   * Merge Claude/Codex current IO from catalogs into the published supplement
   * (default true). Cursor natives, aliases, overrides, and historical rows stay
   * table-authored. Always stamps `updatedAt` so the pricing branch sorts newer
   * than the CLI bundle.
   */
  applyCatalogRatesToSupplement?: boolean;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { 'user-agent': 'aitrack-build-pricing-pack' } });
  if (!res.ok) throw new Error(`HTTP ${String(res.status)} for ${url}`);
  return res.json();
}

function sha256File(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function buildSupplementFromTables(): Promise<PricingSupplement> {
  const claude = JSON.parse(await readFile(join(TABLES, 'claude.json'), 'utf8')) as {
    updatedAt: string;
    models: PricingSupplement['claude']['models'];
    overrides: PricingSupplement['claude']['overrides'];
    familyFallback: PricingSupplement['claude']['familyFallback'];
  };
  const codex = JSON.parse(await readFile(join(TABLES, 'codex.json'), 'utf8')) as {
    updatedAt: string;
    current: PricingSupplement['codex']['current'];
    historical: PricingSupplement['codex']['historical'];
    overrides: PricingSupplement['codex']['overrides'];
    familyFallback: PricingSupplement['codex']['familyFallback'];
  };
  const cursor = JSON.parse(await readFile(join(TABLES, 'cursor.json'), 'utf8')) as {
    updatedAt: string;
    models: PricingSupplement['cursor']['models'];
    fastMultipliers: PricingSupplement['cursor']['fastMultipliers'];
    aliases: PricingSupplement['cursor']['aliases'];
  };

  const updatedAt = [claude.updatedAt, codex.updatedAt, cursor.updatedAt]
    .map((d) => Date.parse(d.includes('T') ? d : `${d}T00:00:00Z`))
    .reduce((a, b) => Math.max(a, b), 0);

  return {
    updatedAt: new Date(updatedAt).toISOString(),
    comment:
      'First-party aitrack pricing supplement (Claude cache multipliers, Codex history/overrides, Cursor natives/aliases). Built from tables/*.json. Catalogs fill gaps for new models.',
    claude: {
      models: claude.models,
      overrides: claude.overrides,
      familyFallback: claude.familyFallback,
    },
    codex: {
      current: codex.current,
      historical: codex.historical,
      overrides: codex.overrides,
      familyFallback: codex.familyFallback,
    },
    cursor: {
      models: cursor.models,
      fastMultipliers: cursor.fastMultipliers,
      aliases: cursor.aliases,
    },
  };
}

function nearly(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
}

/**
 * Patch Claude models + Codex `current` IO in a supplement from catalogs.
 * Preserves Claude cache multipliers unless the catalog published them explicitly.
 */
export function applyCatalogRatesToSupplement(
  supplement: PricingSupplement,
  litellm: CompactCatalog,
  modelsDev: CompactCatalog,
): { claudeChanged: string[]; codexChanged: string[] } {
  const primary = catalogFromCompact(litellm);
  const secondary = catalogFromCompact(modelsDev);

  const claudeChanged: string[] = [];
  for (const [id, pricing] of Object.entries(supplement.claude.models)) {
    const hit =
      findCatalogRates(primary, id, ['anthropic']) ??
      findCatalogRates(secondary, id, ['anthropic']);
    if (!hit) continue;
    const cacheWriteNeedsUpdate =
      hit.rates.cacheWriteIsExplicit &&
      !nearly(pricing.cacheCreatePerMillion, hit.rates.cacheWritePerMillion);
    const cacheReadNeedsUpdate =
      hit.rates.cacheReadIsExplicit &&
      !nearly(pricing.cacheReadPerMillion, hit.rates.cacheReadPerMillion);
    const ioMatches =
      nearly(pricing.inputPerMillion, hit.rates.inputPerMillion) &&
      nearly(pricing.outputPerMillion, hit.rates.outputPerMillion);
    if (ioMatches && !cacheWriteNeedsUpdate && !cacheReadNeedsUpdate) {
      continue;
    }
    pricing.inputPerMillion = hit.rates.inputPerMillion;
    pricing.outputPerMillion = hit.rates.outputPerMillion;
    if (hit.rates.cacheWriteIsExplicit) {
      pricing.cacheCreatePerMillion = hit.rates.cacheWritePerMillion;
    }
    if (hit.rates.cacheReadIsExplicit) {
      pricing.cacheReadPerMillion = hit.rates.cacheReadPerMillion;
    }
    claudeChanged.push(id);
  }

  const codexChanged: string[] = [];
  for (const [id, pricing] of Object.entries(supplement.codex.current)) {
    const hit =
      findCatalogRates(primary, id, ['openai']) ?? findCatalogRates(secondary, id, ['openai']);
    if (!hit) continue;
    if (
      nearly(pricing.inputPerMillion, hit.rates.inputPerMillion) &&
      nearly(pricing.outputPerMillion, hit.rates.outputPerMillion)
    ) {
      continue;
    }
    pricing.inputPerMillion = hit.rates.inputPerMillion;
    pricing.outputPerMillion = hit.rates.outputPerMillion;
    codexChanged.push(id);
  }

  return { claudeChanged, codexChanged };
}

/**
 * Update Claude/Codex *current* input/output from catalogs when they differ.
 * Preserves Claude cache multipliers already in the table (Anthropic 1.25× etc.).
 */
export async function writeTablesFromCatalogs(
  litellm: CompactCatalog,
  modelsDev: CompactCatalog,
): Promise<{ claudeChanged: string[]; codexChanged: string[] }> {
  const claudePath = join(TABLES, 'claude.json');
  const codexPath = join(TABLES, 'codex.json');
  const claude = JSON.parse(await readFile(claudePath, 'utf8')) as {
    updatedAt: string;
    models: Record<string, ClaudePricing>;
    [key: string]: unknown;
  };
  const codex = JSON.parse(await readFile(codexPath, 'utf8')) as {
    updatedAt: string;
    current: Record<string, CodexPricing>;
    [key: string]: unknown;
  };

  const draft: PricingSupplement = {
    updatedAt: new Date().toISOString(),
    claude: {
      models: claude.models,
      overrides: {},
      familyFallback: {} as PricingSupplement['claude']['familyFallback'],
    },
    codex: {
      current: codex.current,
      historical: {},
      overrides: {},
      familyFallback: [],
    },
    cursor: { models: {}, fastMultipliers: {}, aliases: [] },
  };
  const changed = applyCatalogRatesToSupplement(draft, litellm, modelsDev);

  if (changed.claudeChanged.length > 0 || changed.codexChanged.length > 0) {
    const today = new Date().toISOString().slice(0, 10);
    claude.updatedAt = today;
    codex.updatedAt = today;
    await writeFile(claudePath, pretty(claude), 'utf8');
    await writeFile(codexPath, pretty(codex), 'utf8');
  }

  return changed;
}

export async function buildPricingPack(options: BuildPackOptions = {}): Promise<{
  packDir: string;
  manifest: PricingManifest;
  litellmCount: number;
  modelsDevCount: number;
  tableWrites?: { claudeChanged: string[]; codexChanged: string[] };
}> {
  await mkdir(PACK, { recursive: true });

  let litellmCompact: CompactCatalog;
  let modelsDevCompact: CompactCatalog;

  if (options.offline) {
    litellmCompact = JSON.parse(
      await readFile(join(PACK, 'litellm.json'), 'utf8'),
    ) as CompactCatalog;
    modelsDevCompact = JSON.parse(
      await readFile(join(PACK, 'models_dev.json'), 'utf8'),
    ) as CompactCatalog;
  } else {
    console.log('Fetching LiteLLM…');
    const litellmRaw = (await fetchJson(LITELLM_URL)) as Record<string, unknown>;
    console.log('Fetching models.dev…');
    const modelsDevRaw = (await fetchJson(MODELS_DEV_URL)) as Record<string, unknown>;
    const retrievedAt = new Date().toISOString();
    litellmCompact = compactFromCatalog(catalogFromLiteLLM(litellmRaw, retrievedAt));
    modelsDevCompact = compactFromCatalog(catalogFromModelsDev(modelsDevRaw, retrievedAt));
  }

  let tableWrites: { claudeChanged: string[]; codexChanged: string[] } | undefined;
  if (options.writeTablesFromFeeds) {
    tableWrites = await writeTablesFromCatalogs(litellmCompact, modelsDevCompact);
    if (tableWrites.claudeChanged.length > 0 || tableWrites.codexChanged.length > 0) {
      console.log(
        `Wrote table updates: Claude [${tableWrites.claudeChanged.join(', ') || 'none'}], Codex [${tableWrites.codexChanged.join(', ') || 'none'}]`,
      );
    } else {
      console.log('Tables already match catalog input/output rates.');
    }
  }

  const supplement = await buildSupplementFromTables();
  const applyToSupplement = options.applyCatalogRatesToSupplement !== false;
  if (applyToSupplement) {
    const applied = applyCatalogRatesToSupplement(supplement, litellmCompact, modelsDevCompact);
    if (applied.claudeChanged.length > 0 || applied.codexChanged.length > 0) {
      console.log(
        `Supplement catalog merge: Claude [${applied.claudeChanged.join(', ') || 'none'}], Codex [${applied.codexChanged.join(', ') || 'none'}]`,
      );
    }
  }
  // Always stamp so the orphan pricing branch sorts newer than a shipped CLI bundle.
  supplement.updatedAt = new Date().toISOString();

  const litellmBody = pretty(litellmCompact);
  const modelsDevBody = pretty(modelsDevCompact);
  const supplementBody = pretty(supplement);

  await writeFile(join(PACK, 'litellm.json'), litellmBody, 'utf8');
  await writeFile(join(PACK, 'models_dev.json'), modelsDevBody, 'utf8');
  await writeFile(join(PACK, 'supplement.json'), supplementBody, 'utf8');

  const manifest: PricingManifest = {
    schemaVersion: 1,
    updatedAt: supplement.updatedAt,
    files: {
      supplement: 'supplement.json',
      litellm: 'litellm.json',
      modelsDev: 'models_dev.json',
    },
    hashes: {
      supplement: sha256File(supplementBody),
      litellm: sha256File(litellmBody),
      modelsDev: sha256File(modelsDevBody),
    },
  };
  await writeFile(join(PACK, 'manifest.json'), pretty(manifest), 'utf8');

  console.log(
    `Pack written to ${PACK} (LiteLLM ${String(Object.keys(litellmCompact.models).length)} models, models.dev ${String(Object.keys(modelsDevCompact.models).length)} models)`,
  );

  return {
    packDir: PACK,
    manifest,
    litellmCount: Object.keys(litellmCompact.models).length,
    modelsDevCount: Object.keys(modelsDevCompact.models).length,
    tableWrites,
  };
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename;

if (isMain) {
  const write = process.argv.includes('--write');
  const offline = process.argv.includes('--offline');
  buildPricingPack({ writeTablesFromFeeds: write, offline })
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}

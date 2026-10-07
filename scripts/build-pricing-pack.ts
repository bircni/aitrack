#!/usr/bin/env tsx
/** Build the pricing branch pack from local tables and live catalogs. */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  applyCatalogRatesToSupplement,
  fetchPricingCatalogs,
} from '../libs/aitrack-lib/src/pricing/catalogs.js';
import {
  catalogFromCompact,
  compactFromCatalog,
  type CompactCatalog,
} from '../libs/aitrack-lib/src/pricing/codecs.js';
import type {
  PricingManifest,
  PricingSupplement,
} from '../libs/aitrack-lib/src/pricing/packMeta.js';
import {
  supplementFromTables,
  type PricingTables,
} from '../libs/aitrack-lib/src/pricing/supplementFromTables.js';

const ROOT = resolve(import.meta.dirname, '..');
const TABLES = join(ROOT, 'libs/aitrack-lib/src/pricing/tables');
/** Published by CI to the orphan `pricing` branch — not part of aitrack-lib. */
const PACK = join(ROOT, 'artifacts/pricing-pack');

type CatalogChanges = ReturnType<typeof applyCatalogRatesToSupplement>;

export interface BuildPackOptions {
  writeTablesFromFeeds?: boolean;
  /** Skip network; only rebuild supplement + manifest from existing catalog files. */
  offline?: boolean;
}

function sha256File(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readPricingTables(): Promise<PricingTables> {
  return {
    claude: JSON.parse(
      await readFile(join(TABLES, 'claude.json'), 'utf8'),
    ) as PricingTables['claude'],
    codex: JSON.parse(await readFile(join(TABLES, 'codex.json'), 'utf8')) as PricingTables['codex'],
    cursor: JSON.parse(
      await readFile(join(TABLES, 'cursor.json'), 'utf8'),
    ) as PricingTables['cursor'],
  };
}

async function writeChangedTables(
  tables: PricingTables,
  supplement: PricingSupplement,
  changed: CatalogChanges,
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  if (changed.claudeChanged.length > 0) {
    tables.claude.updatedAt = today;
    tables.claude.models = supplement.claude.models;
    await writeFile(join(TABLES, 'claude.json'), pretty(tables.claude), 'utf8');
  }
  if (changed.codexChanged.length > 0) {
    tables.codex.updatedAt = today;
    tables.codex.current = supplement.codex.current;
    await writeFile(join(TABLES, 'codex.json'), pretty(tables.codex), 'utf8');
  }
}

export async function buildPricingPack(options: BuildPackOptions = {}): Promise<{
  packDir: string;
  manifest: PricingManifest;
  litellmCount: number;
  modelsDevCount: number;
  tableWrites?: CatalogChanges;
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
    console.log('Fetching LiteLLM + models.dev…');
    const catalogs = await fetchPricingCatalogs();
    litellmCompact = compactFromCatalog(catalogs.primary);
    modelsDevCompact = compactFromCatalog(catalogs.secondary);
  }

  const tables = await readPricingTables();
  const supplement = supplementFromTables(tables);
  const catalogs = {
    primary: catalogFromCompact(litellmCompact),
    secondary: catalogFromCompact(modelsDevCompact),
  };
  const changed = applyCatalogRatesToSupplement(supplement, catalogs);
  const summary = `Claude [${changed.claudeChanged.join(', ') || 'none'}], Codex [${changed.codexChanged.join(', ') || 'none'}]`;
  const anyChanged = changed.claudeChanged.length > 0 || changed.codexChanged.length > 0;
  if (options.writeTablesFromFeeds) {
    await writeChangedTables(tables, supplement, changed);
    console.log(
      anyChanged
        ? `Wrote table updates: ${summary}`
        : 'Tables already match catalog input/output rates.',
    );
  } else if (anyChanged) {
    console.log(`Supplement catalog merge: ${summary}`);
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
    tableWrites: options.writeTablesFromFeeds ? changed : undefined,
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

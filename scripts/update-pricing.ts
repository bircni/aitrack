#!/usr/bin/env tsx
/**
 * Check (and optionally rebuild) pricing against LiteLLM + models.dev.
 *
 * Sources:
 *   - tables/*.json             local offline baseline (Cursor, overrides, cache)
 *   - orphan `pricing` branch   live pack installs refresh into ~/.config/aitrack/pricing/
 *   - artifacts/pricing-pack/   built by pricing:update for CI to publish (not shipped)
 *
 * Run:
 *   pnpm run pricing:check              # fetch catalogs, compare, exit 1 on drift
 *   pnpm run pricing:update             # rebuild artifacts/pricing-pack from live feeds
 *   pnpm run pricing:update -- --write  # also patch Claude/Codex IO in tables
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { errorMessage } from '../libs/aitrack-lib/src/errors.js';
import { CLAUDE_PRICING_BY_ID } from '../libs/aitrack-lib/src/pricing/claude.js';
import {
  catalogFromLiteLLM,
  catalogFromModelsDev,
  findCatalogRates,
  type ModelRates,
  type PricingCatalog,
} from '../libs/aitrack-lib/src/pricing/codecs.js';
import {
  CODEX_PRICING_BY_ID,
  CODEX_PRICING_CURRENT,
} from '../libs/aitrack-lib/src/pricing/codex.js';
import { CURSOR_MODELS } from '../libs/aitrack-lib/src/pricing/cursor.js';
import { buildPricingPack } from './build-pricing-pack.js';

const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const MODELS_DEV_URL = 'https://models.dev/api.json';

export type PricingFinding =
  | { kind: 'ok'; modelId: string; summary: string }
  | {
      kind: 'drift';
      modelId: string;
      summary: string;
      isInOk: boolean;
      isOutOk: boolean;
      saw: number[];
    }
  | { kind: 'unverified'; modelId: string; summary: string; where: string }
  | { kind: 'missing'; modelId: string };

export interface CheckResult {
  drift: number;
  unverified: number;
  missing: number;
}

function nearly(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
}

function ratesSummary(input: number, output: number): string {
  return `$${String(input)}/$${String(output)}`;
}

export function compareAgainstCatalog(options: {
  label: string;
  table: Record<string, { inputPerMillion: number; outputPerMillion: number }>;
  knownIds: string[];
  sourceFile: string;
  providers: string[];
  primary: PricingCatalog;
  secondary: PricingCatalog;
  discover?: boolean;
}): PricingFinding[] {
  const findings: PricingFinding[] = [];
  const known = new Set(options.knownIds);

  for (const [modelId, pricing] of Object.entries(options.table)) {
    const summary = ratesSummary(pricing.inputPerMillion, pricing.outputPerMillion);
    const hit =
      findCatalogRates(options.primary, modelId, options.providers) ??
      findCatalogRates(options.secondary, modelId, options.providers);
    if (!hit) {
      findings.push({
        kind: 'unverified',
        modelId,
        summary,
        where: `${options.providers.join('|')}/${modelId}`,
      });
      continue;
    }
    const isInOk = nearly(pricing.inputPerMillion, hit.rates.inputPerMillion);
    const isOutOk = nearly(pricing.outputPerMillion, hit.rates.outputPerMillion);
    findings.push(
      isInOk && isOutOk
        ? { kind: 'ok', modelId, summary }
        : {
            kind: 'drift',
            modelId,
            summary,
            isInOk,
            isOutOk,
            saw: [hit.rates.inputPerMillion, hit.rates.outputPerMillion],
          },
    );
  }

  if (options.discover) {
    const discovered = new Set<string>();
    for (const catalog of [options.primary, options.secondary]) {
      for (const key of catalog.entries.keys()) {
        const bare = key.includes('/') ? key.slice(key.indexOf('/') + 1) : key;
        if (known.has(bare) || known.has(key)) continue;
        if (!options.providers.some((p) => key.startsWith(`${p}/`))) continue;
        if (discovered.has(bare)) continue;
        discovered.add(bare);
        findings.push({ kind: 'missing', modelId: bare });
      }
    }
  }

  return findings;
}

export function tallyFindings(findings: PricingFinding[]): CheckResult {
  return {
    drift: findings.filter((f) => f.kind === 'drift').length,
    unverified: findings.filter((f) => f.kind === 'unverified').length,
    missing: findings.filter((f) => f.kind === 'missing').length,
  };
}

function reportFinding(finding: PricingFinding, sourceFile: string): void {
  const id = finding.modelId.padEnd(28);
  switch (finding.kind) {
    case 'ok': {
      console.log(`✓ ${id} ${finding.summary}`);
      break;
    }
    case 'drift': {
      console.log(
        `✗ ${id} ${finding.summary}  — input=${finding.isInOk ? 'ok' : 'MISS'} output=${finding.isOutOk ? 'ok' : 'MISS'}  (catalog: ${finding.saw.join('/')})`,
      );
      break;
    }
    case 'unverified': {
      console.log(`? ${id} ${finding.summary}  — not in catalogs (${finding.where})`);
      break;
    }
    case 'missing': {
      console.log(`+ ${id} — in catalogs but missing from ${sourceFile}`);
      break;
    }
  }
}

async function fetchCatalogs(): Promise<{ primary: PricingCatalog; secondary: PricingCatalog }> {
  console.log('Fetching LiteLLM + models.dev for compare…');
  const [litellmRes, modelsDevRes] = await Promise.all([
    fetch(LITELLM_URL, { headers: { 'user-agent': 'aitrack-pricing-check' } }),
    fetch(MODELS_DEV_URL, { headers: { 'user-agent': 'aitrack-pricing-check' } }),
  ]);
  if (!litellmRes.ok) throw new Error(`LiteLLM HTTP ${String(litellmRes.status)}`);
  if (!modelsDevRes.ok) throw new Error(`models.dev HTTP ${String(modelsDevRes.status)}`);
  const retrievedAt = new Date().toISOString();
  return {
    primary: catalogFromLiteLLM((await litellmRes.json()) as Record<string, unknown>, retrievedAt),
    secondary: catalogFromModelsDev(
      (await modelsDevRes.json()) as Record<string, unknown>,
      retrievedAt,
    ),
  };
}

function checkClaude(catalogs: {
  primary: PricingCatalog;
  secondary: PricingCatalog;
}): CheckResult {
  console.log('\n── Claude (LiteLLM anthropic/* + models.dev) ──');
  const findings = compareAgainstCatalog({
    label: 'Claude',
    table: CLAUDE_PRICING_BY_ID,
    knownIds: Object.keys(CLAUDE_PRICING_BY_ID),
    sourceFile: 'tables/claude.json',
    providers: ['anthropic'],
    primary: catalogs.primary,
    secondary: catalogs.secondary,
    discover: false,
  });
  for (const finding of findings) reportFinding(finding, 'tables/claude.json');
  return tallyFindings(findings);
}

function checkCodex(catalogs: { primary: PricingCatalog; secondary: PricingCatalog }): CheckResult {
  console.log('\n── Codex current (LiteLLM openai/* + models.dev) ──');
  const findings = compareAgainstCatalog({
    label: 'Codex',
    table: CODEX_PRICING_CURRENT,
    knownIds: Object.keys(CODEX_PRICING_BY_ID),
    sourceFile: 'tables/codex.json',
    providers: ['openai'],
    primary: catalogs.primary,
    secondary: catalogs.secondary,
    discover: false,
  });
  for (const finding of findings) reportFinding(finding, 'tables/codex.json');
  return tallyFindings(findings);
}

function checkCursor(catalogs: {
  primary: PricingCatalog;
  secondary: PricingCatalog;
}): CheckResult {
  console.log('\n── Cursor natives (supplement is authoritative; catalogs are informational) ──');
  const findings = compareAgainstCatalog({
    label: 'Cursor',
    table: CURSOR_MODELS,
    knownIds: Object.keys(CURSOR_MODELS),
    sourceFile: 'tables/cursor.json',
    providers: ['cursor', 'xai', 'google', 'openai', 'anthropic'],
    primary: catalogs.primary,
    secondary: catalogs.secondary,
    discover: false,
  });
  let ok = 0;
  let infoDrift = 0;
  let supplementOnly = 0;
  for (const finding of findings) {
    if (finding.kind === 'ok') {
      ok += 1;
      reportFinding(finding, 'tables/cursor.json');
    } else if (finding.kind === 'drift') {
      infoDrift += 1;
      console.log(
        `i ${finding.modelId.padEnd(28)} ${finding.summary}  — catalog ${finding.saw.join('/')} (supplement wins)`,
      );
    } else if (finding.kind === 'unverified') {
      supplementOnly += 1;
    }
  }
  console.log(
    `  (${String(ok)} match catalogs, ${String(infoDrift)} intentional overrides, ${String(supplementOnly)} supplement-only)`,
  );
  return { drift: 0, unverified: 0, missing: 0 };
}

/** Exported for unit tests — catalog hit helper. */
export function catalogIo(
  catalogs: { primary: PricingCatalog; secondary: PricingCatalog },
  modelId: string,
  providers: string[],
): ModelRates | undefined {
  return (
    findCatalogRates(catalogs.primary, modelId, providers) ??
    findCatalogRates(catalogs.secondary, modelId, providers)
  )?.rates;
}

async function main(argv: string[]): Promise<number> {
  const doUpdate = argv.includes('--update') || argv.includes('update');
  const doWrite = argv.includes('--write');

  if (doUpdate || doWrite) {
    console.log('Rebuilding artifacts/pricing-pack from live feeds…');
    try {
      await buildPricingPack({ writeTablesFromFeeds: doWrite });
    } catch (error) {
      console.error('Pack build failed:', errorMessage(error));
      return 1;
    }
  }

  let catalogs: { primary: PricingCatalog; secondary: PricingCatalog };
  try {
    catalogs = await fetchCatalogs();
  } catch (error) {
    console.error('Catalog fetch failed:', errorMessage(error));
    return 1;
  }

  const claude = checkClaude(catalogs);
  const codex = checkCodex(catalogs);
  const cursor = checkCursor(catalogs);

  const totalDrift = claude.drift + codex.drift + cursor.drift;
  const totalUnverified = claude.unverified + codex.unverified;
  const totalMissing = claude.missing + codex.missing;

  console.log('');
  if (totalMissing > 0) {
    console.log(
      `${String(totalMissing)} model(s) in catalogs missing from tables — add them (or re-run with --write after deciding) and re-check`,
    );
  }
  if (totalDrift > 0) {
    console.log(
      `${String(totalDrift)} model(s) drift from catalogs — update tables/*.json or run: pnpm run pricing:update -- --write`,
    );
  } else if (totalMissing === 0 && totalUnverified > 0) {
    console.log(
      `No drift on verified models; ${String(totalUnverified)} Claude/Codex model(s) not in catalogs (aliases/historical OK).`,
    );
  } else if (totalMissing === 0 && totalDrift === 0) {
    console.log('All verified pricing matches LiteLLM / models.dev catalogs.');
  }

  return totalDrift > 0 || totalMissing > 0 ? 1 : 0;
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}

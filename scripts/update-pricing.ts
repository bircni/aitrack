#!/usr/bin/env tsx
/** Compare local pricing with live catalogs. Run `pnpm run pricing:check`. */

import { resolve } from 'node:path';

import { errorMessage } from '../libs/aitrack-lib/src/errors.js';
import {
  comparePricingTable,
  fetchPricingCatalogs,
  tallyPricingFindings,
  type PricingCatalogs,
  type PricingComparison,
  type PricingFinding,
} from '../libs/aitrack-lib/src/pricing/catalogs.js';
import type { PricingSupplement } from '../libs/aitrack-lib/src/pricing/packMeta.js';
import { supplementFromTables } from '../libs/aitrack-lib/src/pricing/supplementFromTables.js';

function reportFinding(finding: PricingFinding): void {
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
  }
}

function checkClaude(catalogs: PricingCatalogs, supplement: PricingSupplement): PricingComparison {
  console.log('\n── Claude (LiteLLM anthropic/* + models.dev) ──');
  const findings = comparePricingTable({
    table: supplement.claude.models,
    providers: ['anthropic'],
    primary: catalogs.primary,
    secondary: catalogs.secondary,
  });
  for (const finding of findings) reportFinding(finding);
  return tallyPricingFindings(findings);
}

function checkCodex(catalogs: PricingCatalogs, supplement: PricingSupplement): PricingComparison {
  console.log('\n── Codex current (LiteLLM openai/* + models.dev) ──');
  const findings = comparePricingTable({
    table: supplement.codex.current,
    providers: ['openai'],
    primary: catalogs.primary,
    secondary: catalogs.secondary,
  });
  for (const finding of findings) reportFinding(finding);
  return tallyPricingFindings(findings);
}

function checkCursor(catalogs: PricingCatalogs, supplement: PricingSupplement): PricingComparison {
  console.log('\n── Cursor natives (supplement is authoritative; catalogs are informational) ──');
  const findings = comparePricingTable({
    table: supplement.cursor.models,
    providers: ['cursor', 'xai', 'google', 'openai', 'anthropic'],
    primary: catalogs.primary,
    secondary: catalogs.secondary,
  });
  let ok = 0;
  let infoDrift = 0;
  let supplementOnly = 0;
  for (const finding of findings) {
    if (finding.kind === 'ok') {
      ok += 1;
      reportFinding(finding);
    } else if (finding.kind === 'drift') {
      infoDrift += 1;
      console.log(
        `i ${finding.modelId.padEnd(28)} ${finding.summary}  — catalog ${finding.saw.join('/')} (supplement wins)`,
      );
    } else {
      supplementOnly += 1;
    }
  }
  console.log(
    `  (${String(ok)} match catalogs, ${String(infoDrift)} intentional overrides, ${String(supplementOnly)} supplement-only)`,
  );
  return { drift: 0, unverified: 0 };
}

export async function checkPricing(): Promise<number> {
  const supplement = supplementFromTables();
  let catalogs: PricingCatalogs;
  try {
    console.log('Fetching LiteLLM + models.dev for compare…');
    catalogs = await fetchPricingCatalogs();
  } catch (error) {
    console.error('Catalog fetch failed:', errorMessage(error));
    return 1;
  }

  const claude = checkClaude(catalogs, supplement);
  const codex = checkCodex(catalogs, supplement);
  const cursor = checkCursor(catalogs, supplement);

  const totalDrift = claude.drift + codex.drift + cursor.drift;
  const totalUnverified = claude.unverified + codex.unverified;

  console.log('');
  if (totalDrift > 0) {
    console.log(
      `${String(totalDrift)} model(s) drift from catalogs — update tables/*.json or run: pnpm run pricing:update -- --write`,
    );
  } else if (totalUnverified > 0) {
    console.log(
      `No drift on verified models; ${String(totalUnverified)} Claude/Codex model(s) not in catalogs (aliases/historical OK).`,
    );
  } else {
    console.log('All verified pricing matches LiteLLM / models.dev catalogs.');
  }

  return totalDrift > 0 ? 1 : 0;
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && resolve(entryPoint) === import.meta.filename) {
  checkPricing()
    .then((code) => {
      process.exit(code);
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}

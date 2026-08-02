import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

import { loadConfig, resolveMachineId } from '../config.js';
import {
  buildMachineData,
  machineHasData,
  mergePersistedDays,
  readLocalProviderMaps,
} from '../data/localData.js';
import type { MachineFile } from '../data/types.js';
import { approximatelyEqual, parseMachineFile } from '../data/validate.js';
import { SYNCED_PROVIDERS } from '../display/providers.js';
import { commitDataChanges, isCloned, listDataFiles } from '../git.js';
import { consumeClaudeFallbackHits } from '../pricing/claude.js';
import { consumeCodexFallbackHits } from '../pricing/codex.js';
import { resolveModelCost } from '../pricing/resolve.js';

/**
 * Days serialized without their costs, for change detection.
 *
 * The readers accumulate a cost per JSONL entry while the repricing loop below
 * derives it once from the summed tokens. Those agree mathematically but not in
 * the last float bits, so comparing costs here would mark an already normalized
 * file as changed on every run. Costs are the loop's business; the merge only
 * has to notice a token-level difference.
 */
function tokensJson(days: MachineFile['days']): string {
  return JSON.stringify(days, (key, value: unknown) => (key === 'costUSD' ? undefined : value));
}

export async function recomputeCostsCommand(): Promise<void> {
  const config = loadConfig();
  const machineId = resolveMachineId(config);

  if (!isCloned()) {
    throw new Error('Repo not cloned. Run: npx aitrack init');
  }

  const files = listDataFiles();
  if (files.length === 0) {
    console.log('No synced data files found.');
    return;
  }

  const localFresh = buildMachineData(machineId, await readLocalProviderMaps());

  let changed = 0;
  let legacySkipped = 0;

  for (const filePath of files) {
    const isCurrentMachine = basename(filePath) === `${machineId}.json`;

    const raw = readFileSync(filePath, 'utf8');
    let machine = parseMachineFile(raw, filePath, { allowInconsistentCostTotals: true });
    let isTouched = false;

    if (!machine) {
      // parseMachineFile already warned why. Only the current machine can be
      // repaired — the local logs are its source of truth — and this is the one
      // command that can do it: sync refuses to overwrite a file it cannot read.
      if (!isCurrentMachine || !machineHasData(localFresh)) continue;
      console.warn(`  Rebuilding ${basename(filePath)} from the local logs.`);
      machine = { ...localFresh, days: mergePersistedDays(null, localFresh.days) };
      isTouched = true;
    } else if (isCurrentMachine && machineHasData(localFresh)) {
      // Refresh the current machine's days from the local logs before repricing.
      // Days the logs no longer reach stay as persisted and are repriced below
      // like any other machine's, rather than being dropped.
      const refreshed = mergePersistedDays(machine.days, localFresh.days);
      if (tokensJson(refreshed) !== tokensJson(machine.days)) isTouched = true;
      machine.days = refreshed;
    }

    for (const [date, providers] of Object.entries(machine.days)) {
      for (const providerKey of SYNCED_PROVIDERS) {
        const providerDay = providers[providerKey];
        if (!providerDay) continue;

        let dayTotal = 0;
        let modelCount = 0;
        let isCostComplete = true;
        let isDayTouched = false;

        for (const [model, counts] of Object.entries(providerDay.byModel)) {
          modelCount++;
          const cost = resolveModelCost(providerKey, model, counts, date, 'recompute');
          if (cost === undefined) {
            if (counts.costUSD === undefined) {
              isCostComplete = false;
            } else {
              dayTotal += counts.costUSD;
              if (providerKey === 'claude_code') legacySkipped++;
            }
            continue;
          }
          // Tolerate the last float bits: the readers sum a cost per entry while
          // this derives it from the summed tokens, so an unchanged day would
          // otherwise look repriced on every run.
          if (counts.costUSD === undefined || !approximatelyEqual(counts.costUSD, cost)) {
            counts.costUSD = cost;
            isDayTouched = true;
          }
          dayTotal += cost;
        }

        if (isDayTouched) isTouched = true;
        if (
          modelCount > 0 &&
          isCostComplete &&
          (providerDay.totals.costUSD === undefined ||
            !approximatelyEqual(providerDay.totals.costUSD, dayTotal))
        ) {
          providerDay.totals.costUSD = dayTotal;
          isTouched = true;
        }
      }
    }

    if (isTouched) {
      machine.lastUpdated = new Date().toISOString();
      writeFileSync(filePath, JSON.stringify(machine, null, 2), 'utf8');
      changed++;
    }
  }

  if (changed === 0) {
    console.log('Nothing to recompute — costs are already current.');
    if (legacySkipped > 0) {
      console.log(
        `  ${legacySkipped} model-day(s) skipped (legacy data without cache breakdown — re-sync from that machine).`,
      );
    }
    return;
  }

  console.log(`Recomputed costs in ${changed} file(s).`);
  if (legacySkipped > 0) {
    console.log(
      `  ${legacySkipped} model-day(s) left unchanged (legacy data without cache breakdown — re-sync from that machine).`,
    );
  }

  const fb = [...consumeClaudeFallbackHits(), ...consumeCodexFallbackHits()];
  if (fb.length > 0) {
    console.warn(
      `\nWarning: priced via family fallback (no exact pricing in src/pricing/): ${fb.join(', ')}`,
    );
    console.warn('  These costs may be wrong — update src/pricing/ with the correct rates.');
  }

  const isPushed = commitDataChanges(`recompute: refresh costs at ${new Date().toISOString()}`);
  if (!isPushed) {
    console.log('No file actually changed on disk — pricing already current.');
    return;
  }
  console.log('Pushed updated costs.');
}

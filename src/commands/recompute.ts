import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

import { loadConfig, resolveMachineId } from '../config.js';
import { buildMachineData, machineHasData, readLocalProviderMaps } from '../data/localData.js';
import { parseMachineFile } from '../data/validate.js';
import { commitDataChanges, isCloned, listDataFiles, tryPull } from '../git.js';
import { consumeClaudeFallbackHits } from '../pricing/claude.js';
import { consumeCodexFallbackHits } from '../pricing/codex.js';
import { resolveModelCost } from '../pricing/resolve.js';

export async function recomputeCostsCommand(): Promise<void> {
  const config = loadConfig();
  const machineId = resolveMachineId(config);

  if (!isCloned()) {
    throw new Error('Repo not cloned. Run: npx aitrack init');
  }

  tryPull();

  const files = listDataFiles();
  if (files.length === 0) {
    console.log('No synced data files found.');
    return;
  }

  const localMaps = await readLocalProviderMaps();
  const localFresh = buildMachineData(machineId, {
    claude_code: localMaps.claude_code,
    codex: localMaps.codex,
  });

  let changed = 0;
  let legacySkipped = 0;

  for (const filePath of files) {
    const isCurrentMachine = basename(filePath) === `${machineId}.json`;

    if (isCurrentMachine && machineHasData(localFresh)) {
      writeFileSync(filePath, JSON.stringify(localFresh, null, 2), 'utf8');
      changed++;
      continue;
    }

    const raw = readFileSync(filePath, 'utf8');
    const machine = parseMachineFile(raw, filePath);
    if (!machine) continue;
    let touched = false;

    for (const [date, providers] of Object.entries(machine.days)) {
      for (const providerKey of ['claude_code', 'codex'] as const) {
        const providerDay = providers[providerKey];
        if (!providerDay) continue;

        let dayTotal = 0;
        let anyModel = false;
        let dayTouched = false;

        for (const [model, counts] of Object.entries(providerDay.byModel)) {
          const cost = resolveModelCost(providerKey, model, counts, date, 'recompute');
          if (cost === undefined) {
            if (counts.costUSD !== undefined) {
              dayTotal += counts.costUSD;
              anyModel = true;
              if (providerKey === 'claude_code') legacySkipped++;
            }
            continue;
          }
          if (counts.costUSD !== cost) {
            counts.costUSD = cost;
            dayTouched = true;
          }
          dayTotal += cost;
          anyModel = true;
        }

        if (dayTouched && anyModel) {
          providerDay.totals.costUSD = dayTotal;
          touched = true;
        }
      }
    }

    if (touched) {
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

  const pushed = commitDataChanges(`recompute: refresh costs at ${new Date().toISOString()}`);
  if (!pushed) {
    console.log('No file actually changed on disk — pricing already current.');
    return;
  }
  console.log('Pushed updated costs.');
}

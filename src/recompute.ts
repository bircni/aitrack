import { basename } from 'path';
import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { loadConfig, resolveMachineId } from './config.js';
import { isCloned, LOCAL_REPO, listDataFiles, tryPull } from './git.js';
import { buildMachineData, machineHasData, readLocalProviderMaps } from './localData.js';
import { parseMachineFile } from './validate.js';
import { estimateClaudeCostFromStoredCounts } from './readers/claude.js';
import { consumeClaudeFallbackHits } from './pricing/claude.js';
import { consumeCodexFallbackHits, estimateCodexCostUSD } from './pricing/codex.js';

// Refresh costs using cache-aware token breakdown stored at sync time.
// For this machine, re-reads local JSONL (same accuracy as sync). For other
// machines, reprices from stored breakdown only — legacy rows without a
// breakdown are left unchanged.
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
      const claude = providers.claude_code;
      if (claude) {
        let dayTotal = 0;
        let anyModel = false;
        let dayTouched = false;
        for (const [model, counts] of Object.entries(claude.byModel)) {
          const cost = estimateClaudeCostFromStoredCounts(model, counts, date);
          if (cost === undefined) {
            if (counts.costUSD !== undefined) {
              dayTotal += counts.costUSD;
              anyModel = true;
              legacySkipped++;
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
          claude.totals.costUSD = dayTotal;
          touched = true;
        }
      }

      const codex = providers.codex;
      if (codex) {
        let dayTotal = 0;
        let any = false;
        let dayTouched = false;
        for (const [model, counts] of Object.entries(codex.byModel)) {
          const cost = estimateCodexCostUSD(
            model,
            counts.inputTokens,
            counts.outputTokens,
            counts.cachedInputTokens ?? 0,
            date,
          );
          if (cost === undefined) {
            if (counts.costUSD !== undefined) {
              dayTotal += counts.costUSD;
              any = true;
            }
            continue;
          }
          if (counts.costUSD !== cost) {
            counts.costUSD = cost;
            dayTouched = true;
          }
          dayTotal += cost;
          any = true;
        }
        if (dayTouched && any) {
          codex.totals.costUSD = dayTotal;
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

  const staged = execSync('git status --porcelain -- data/', { cwd: LOCAL_REPO, stdio: 'pipe' })
    .toString()
    .trim();
  if (!staged) {
    console.log('No file actually changed on disk — pricing already current.');
    return;
  }
  execSync('git add data/', { cwd: LOCAL_REPO, stdio: 'inherit' });
  execSync(`git commit -m "recompute: refresh costs at ${new Date().toISOString()}"`, {
    cwd: LOCAL_REPO,
    stdio: 'pipe',
  });
  try {
    execSync('git push', { cwd: LOCAL_REPO, stdio: 'inherit' });
  } catch {
    execSync('git push -u origin HEAD', { cwd: LOCAL_REPO, stdio: 'inherit' });
  }
  console.log('Pushed updated costs.');
}

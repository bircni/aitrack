import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { loadConfig } from './config.js';
import { isCloned, LOCAL_REPO, listDataFiles, pull } from './git.js';
import { estimateClaudeCostFromAggregateTokens } from './readers/claude.js';
import { consumeClaudeFallbackHits } from './pricing/claude.js';
import { consumeCodexFallbackHits, estimateCodexCostUSD } from './pricing/codex.js';
import type { MachineFile } from './types.js';

// Recompute claude_code costUSD for every synced day using the current
// pricing table. Cache vs raw-input split is lost in aggregated synced data,
// so this is an upper-bound estimate — for an exact recompute, delete the
// per-host JSON and re-run `aitrack sync` from each machine.
export function recomputeCostsCommand(): void {
  loadConfig();

  if (!isCloned()) {
    throw new Error('Repo not cloned. Run: npx aitrack init');
  }

  console.log('Pulling latest from remote...');
  pull();

  const files = listDataFiles();
  if (files.length === 0) {
    console.log('No synced data files found.');
    return;
  }

  let changed = 0;
  for (const filePath of files) {
    const raw = readFileSync(filePath, 'utf8');
    const machine = JSON.parse(raw) as MachineFile;
    let touched = false;

    for (const [date, providers] of Object.entries(machine.days)) {
      const claude = providers.claude_code;
      if (claude) {
        let dayTotal = 0;
        for (const [model, counts] of Object.entries(claude.byModel)) {
          const cost = estimateClaudeCostFromAggregateTokens(
            model,
            counts.inputTokens,
            counts.outputTokens,
            date,
          );
          counts.costUSD = cost;
          dayTotal += cost;
        }
        claude.totals.costUSD = dayTotal;
        touched = true;
      }

      const codex = providers.codex;
      if (codex) {
        let dayTotal = 0;
        let any = false;
        for (const [model, counts] of Object.entries(codex.byModel)) {
          const cost = estimateCodexCostUSD(
            model,
            counts.inputTokens,
            counts.outputTokens,
            counts.cachedInputTokens ?? 0,
            date,
          );
          if (cost === undefined) continue;
          counts.costUSD = cost;
          dayTotal += cost;
          any = true;
        }
        if (any) {
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
    console.log('Nothing to recompute (no claude_code or codex data found in any file).');
    return;
  }

  console.log(`Recomputed costs in ${changed} file(s).`);

  const fb = [...consumeClaudeFallbackHits(), ...consumeCodexFallbackHits()];
  if (fb.length > 0) {
    console.warn(
      `\nWarning: priced via family fallback (no exact pricing in src/pricing/): ${fb.join(', ')}`,
    );
    console.warn('  These costs may be wrong — update src/pricing/ with the correct rates.');
  }

  // Stage + commit + push so other machines pick up the new numbers.
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

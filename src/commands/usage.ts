import chalk from 'chalk';

import { tryLoadConfig } from '../config.js';
import { aggregateModelsByDayMap } from '../data/aggregate.js';
import { emptyUsageMessage, loadMergedProviderData } from '../data/usageData.js';
import { fmt, fmtUSD } from '../display/format.js';
import { orderedProviderKeys, providerLabel } from '../display/providers.js';
import { defaultTableStyle, renderTerminalTable } from '../display/terminalTable.js';
import { computeUsageWindow, type UsagePeriod } from '../display/usagePeriods.js';
import { isCloned } from '../git.js';

export interface UsageOptions {
  period: UsagePeriod;
  noCursor?: boolean;
  from?: string;
  to?: string;
  n?: number;
}

interface Row {
  provider: string;
  tokens: string;
  model: string;
  price: string;
  isTotal?: boolean;
}

export async function usageCommand(opts: UsageOptions): Promise<void> {
  const loaded = await loadMergedProviderData({ noCursor: opts.noCursor });

  if (!loaded) {
    console.log(emptyUsageMessage(!tryLoadConfig() || !isCloned()));
    return;
  }

  const reportData = loaded.providerData;
  const window = computeUsageWindow(opts);
  const ordered = orderedProviderKeys(reportData);

  const rows: Row[] = [];
  let totInput = 0;
  let totOutput = 0;
  let totCost = 0;
  let anyCost = false;

  for (const key of ordered) {
    const dayMap = reportData[key];
    if (!dayMap) continue;
    const label = providerLabel(key);
    const byModel = aggregateModelsByDayMap(dayMap, { start: window.start, end: window.end });
    const providerRows: Array<Row & { sortCost: number; sortTokens: number }> = [];
    for (const [model, agg] of byModel) {
      const tokens = agg.inputTokens + agg.outputTokens;
      if (tokens === 0 && !agg.hasCost) continue;
      providerRows.push({
        provider: label,
        tokens: fmt(tokens),
        model,
        price: agg.hasCost ? fmtUSD(agg.costUSD) : '—',
        sortCost: agg.hasCost ? agg.costUSD : 0,
        sortTokens: tokens,
      });
      totInput += agg.inputTokens;
      totOutput += agg.outputTokens;
      if (agg.hasCost) {
        totCost += agg.costUSD;
        anyCost = true;
      }
    }
    providerRows.sort((a, b) => b.sortCost - a.sortCost || b.sortTokens - a.sortTokens);
    for (const row of providerRows) {
      rows.push({ provider: row.provider, tokens: row.tokens, model: row.model, price: row.price });
    }
  }

  if (rows.length === 0) {
    console.log(`No usage recorded for ${window.label}.`);
    return;
  }

  const totalRow: Row = {
    provider: 'TOTAL',
    tokens: fmt(totInput + totOutput),
    model: '',
    price: anyCost ? fmtUSD(totCost) : '—',
    isTotal: true,
  };

  console.log(chalk.bold(`aitrack usage ${window.label}`));
  console.log(
    renderTerminalTable(
      [...rows, totalRow],
      [
        { header: 'Provider', align: 'left', cell: (r) => r.provider },
        { header: 'Tokens', align: 'right', cell: (r) => r.tokens },
        { header: 'Model', align: 'left', cell: (r) => r.model },
        { header: 'Price', align: 'right', cell: (r) => r.price },
      ],
      {
        style: defaultTableStyle(),
        bodyRows: rows,
        footerRow: totalRow,
        footerStyle: chalk.bold.cyan,
      },
    ),
  );
}

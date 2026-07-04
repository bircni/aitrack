import chalk from 'chalk';

import { tryLoadConfig } from '../config.js';
import type { MachineFile } from '../data/types.js';
import { emptyUsageMessage, loadMergedProviderData } from '../data/usageData.js';
import { fmt, fmtUSD } from '../display/format.js';
import { providerLabel, SELECTABLE_PROVIDERS, sortProviderKeys } from '../display/providers.js';
import {
  defaultTableStyle,
  renderTerminalTable,
  type TerminalTableColumn,
} from '../display/terminalTable.js';
import { isCloned } from '../git.js';

interface MachineSummary {
  hostname: string;
  lastUpdated: string;
  days: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUSD: number | null;
  providers: string[];
  firstDay: string | null;
  lastDay: string | null;
}

function summarizeMachine(file: MachineFile): MachineSummary {
  let inputTokens = 0;
  let outputTokens = 0;
  let costUSD = 0;
  let hasCost = false;
  const providers = new Set<string>();
  const dayKeys: string[] = [];

  for (const [date, dayProviders] of Object.entries(file.days)) {
    let isDayHasTokens = false;
    for (const [providerKey, pData] of Object.entries(dayProviders)) {
      providers.add(providerKey);
      inputTokens += pData.totals.inputTokens;
      outputTokens += pData.totals.outputTokens;
      if (pData.totals.costUSD !== undefined) {
        costUSD += pData.totals.costUSD;
        hasCost = true;
      }
      if (pData.totals.inputTokens + pData.totals.outputTokens > 0) isDayHasTokens = true;
    }
    if (isDayHasTokens) dayKeys.push(date);
  }
  dayKeys.sort((a, b) => a.localeCompare(b));
  return {
    hostname: file.hostname,
    lastUpdated: file.lastUpdated,
    days: dayKeys.length,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    costUSD: hasCost ? costUSD : null,
    providers: sortProviderKeys([...providers]),
    firstDay: dayKeys[0] ?? null,
    lastDay: dayKeys.at(-1) ?? null,
  };
}

export async function machinesCommand(): Promise<void> {
  // Machines are summarized from synced data only; skip the local Cursor read.
  const loaded = await loadMergedProviderData({
    providers: SELECTABLE_PROVIDERS.filter((p) => p !== 'cursor'),
  });

  if (!loaded || loaded.machineData.length === 0) {
    console.log(emptyUsageMessage(!tryLoadConfig() || !isCloned()));
    return;
  }

  const summaries = loaded.machineData
    .map(summarizeMachine)
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const columns: Array<TerminalTableColumn<MachineSummary>> = [
    { header: 'Machine', align: 'left', cell: (m) => m.hostname },
    { header: 'Days', align: 'right', cell: (m) => String(m.days) },
    { header: 'Tokens', align: 'right', cell: (m) => fmt(m.totalTokens) },
    { header: 'Cost', align: 'right', cell: (m) => fmtUSD(m.costUSD) },
    { header: 'Last sync', align: 'left', cell: (m) => m.lastUpdated.slice(0, 10) },
    {
      header: 'Providers',
      align: 'left',
      cell: (m) => m.providers.map((p) => providerLabel(p)).join(', '),
    },
  ];

  console.log(chalk.bold(`aitrack machines (${String(summaries.length)})`));
  console.log(renderTerminalTable(summaries, columns, { style: defaultTableStyle() }));
}

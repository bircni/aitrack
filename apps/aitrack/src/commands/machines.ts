import { tryLoadConfig, resolveMachineId } from 'aitrack-lib/config';
import { isUsageNotConfigured, usageEmptyMessage } from 'aitrack-lib/data/emptyState';
import { isStaleSync } from 'aitrack-lib/data/staleSync';
import type { MachineFile } from 'aitrack-lib/data/types';
import { loadReportedMachines, machineUsageTotals } from 'aitrack-lib/data/usageData';
import { fmt, fmtUSDCost } from 'aitrack-lib/display/format';
import { renderTerminalTable, type TerminalTableColumn } from 'aitrack-lib/display/terminalTable';
import { log } from 'aitrack-lib/output';
import { providerLabel } from 'aitrack-lib/providers/index';
import chalk from 'chalk';

import { printEmptyResult, printJsonCommand } from '../cli/json.js';

interface MachineSummary {
  hostname: string;
  timezone: string;
  lastUpdated: string;
  /** Synced before, but not in the last three days; never true for this machine. */
  stale: boolean;
  days: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUSD: number | null;
  providers: string[];
  firstDay: string | null;
  lastDay: string | null;
}

function summarizeMachine(file: MachineFile, currentId: string | undefined): MachineSummary {
  const totals = machineUsageTotals(file);
  return {
    hostname: file.hostname,
    timezone: file.timezone,
    lastUpdated: file.lastUpdated,
    stale: file.hostname !== currentId && isStaleSync(file.lastUpdated, Date.now()),
    days: totals.days,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    totalTokens: totals.inputTokens + totals.outputTokens,
    costUSD: totals.costUSD,
    providers: totals.providers,
    firstDay: totals.firstDay,
    lastDay: totals.lastDay,
  };
}

interface MachinesOptions {
  json?: boolean;
}

export async function machinesCommand(options: MachinesOptions = {}): Promise<void> {
  const machineData = await loadReportedMachines();

  if (machineData.length === 0) {
    printEmptyResult('machines', options.json, usageEmptyMessage(isUsageNotConfigured()), {
      machines: [],
    });
    return;
  }

  const config = tryLoadConfig();
  const currentId = config ? resolveMachineId(config) : undefined;
  const summaries = machineData
    .map((machine) => summarizeMachine(machine, currentId))
    .toSorted((a, b) => b.totalTokens - a.totalTokens);

  if (options.json) {
    printJsonCommand('machines', { machines: summaries });
    return;
  }

  const columns: Array<TerminalTableColumn<MachineSummary>> = [
    { header: 'Machine', align: 'left', cell: (m) => m.hostname },
    { header: 'Timezone', align: 'left', cell: (m) => m.timezone },
    { header: 'Days', align: 'right', cell: (m) => String(m.days) },
    { header: 'Tokens', align: 'right', cell: (m) => fmt(m.totalTokens) },
    {
      header: 'Cost',
      align: 'right',
      cell: (m) => (m.costUSD === null ? '—' : fmtUSDCost(m.costUSD)),
    },
    {
      header: 'Last sync',
      align: 'left',
      cell: (m) =>
        m.lastUpdated === ''
          ? 'not synced'
          : `${m.lastUpdated.slice(0, 10)}${m.stale ? ' (stale)' : ''}`,
    },
    {
      header: 'Providers',
      align: 'left',
      cell: (m) => m.providers.map((p) => providerLabel(p)).join(', '),
    },
  ];

  log.info(chalk.bold(`aitrack machines (${String(summaries.length)})`));
  log.info(renderTerminalTable(summaries, columns));
}

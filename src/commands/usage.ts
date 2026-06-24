import chalk from 'chalk';

import {
  buildUsageReport,
  emptyReportMessage,
  type UsageReportOptions,
} from '../data/usageReport.js';
import { fmt, fmtUSD } from '../display/format.js';
import { defaultTableStyle, renderTerminalTable } from '../display/terminalTable.js';

export type UsageOptions = UsageReportOptions;

interface Row {
  provider: string;
  tokens: string;
  model: string;
  price: string;
  isTotal?: boolean;
}

export async function usageCommand(options: UsageOptions): Promise<void> {
  const report = await buildUsageReport(options);

  if (!report || report.rowCount === 0) {
    console.log(emptyReportMessage(report));
    return;
  }

  const rows: Row[] = [];
  for (const provider of report.providers) {
    for (const row of provider.rows) {
      rows.push({
        provider: provider.label,
        tokens: fmt(row.tokens),
        model: row.model,
        price: row.hasCost ? fmtUSD(row.costUSD) : '—',
      });
    }
  }

  const totalRow: Row = {
    provider: 'TOTAL',
    tokens: fmt(report.totals.tokens),
    model: '',
    price: report.totals.hasCost ? fmtUSD(report.totals.costUSD) : '—',
    isTotal: true,
  };

  console.log(chalk.bold(`aitrack usage ${report.windowLabel}`));
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

import chalk from 'chalk';

import { pad } from './format.js';

export type TableAlign = 'left' | 'right';

export interface TerminalTableColumn<Row> {
  header: string;
  align: TableAlign;
  cell: (row: Row) => string;
}

export interface TerminalTableStyle {
  border: (text: string) => string;
  header: (text: string) => string;
  total?: (text: string) => string;
}

export function defaultTableStyle(dark = false): TerminalTableStyle {
  return {
    border: dark ? chalk.gray : chalk.dim,
    header: dark ? chalk.bold.white : chalk.bold,
    total: dark ? chalk.bold.cyan : chalk.bold,
  };
}

export interface TerminalTableOptions<Row> {
  style?: TerminalTableStyle;
  bodyRows?: Row[];
  footerRow?: Row;
  footerStyle?: (text: string) => string;
  firstColumnStyle?: (text: string) => string;
}

export function renderTerminalTable<Row>(
  rows: Row[],
  columns: Array<TerminalTableColumn<Row>>,
  options: TerminalTableOptions<Row> = {},
): string {
  const style = options.style ?? defaultTableStyle();
  const bodyRows = options.bodyRows ?? rows;
  const widths = columns.map((col) =>
    Math.max(col.header.length, ...rows.map((row) => col.cell(row).length)),
  );

  const hLine = (left: string, mid: string, right: string) =>
    style.border(left + widths.map((w) => '─'.repeat(w + 2)).join(mid) + right);

  const renderRow = (
    cells: string[],
    rowStyle?: (text: string, columnIndex: number) => string,
  ): string =>
    style.border('│') +
    cells
      .map((cell, index) => {
        const padded = pad(cell, widths[index] ?? 0, columns[index]?.align ?? 'left');
        const styled = rowStyle ? rowStyle(padded, index) : padded;
        return ` ${styled} `;
      })
      .join(style.border('│')) +
    style.border('│');

  const lines: string[] = [];
  lines.push(hLine('┌', '┬', '┐'));
  lines.push(
    renderRow(
      columns.map((col) => col.header),
      (text) => style.header(text),
    ),
  );
  lines.push(hLine('├', '┼', '┤'));

  for (const row of bodyRows) {
    lines.push(
      renderRow(
        columns.map((col) => col.cell(row)),
        options.firstColumnStyle
          ? (text, index) =>
              index === 0 && options.firstColumnStyle ? options.firstColumnStyle(text) : text
          : undefined,
      ),
    );
  }

  const footerRow = options.footerRow;
  if (footerRow) {
    lines.push(hLine('├', '┼', '┤'));
    const footerStyle = options.footerStyle ?? style.total ?? style.header;
    lines.push(
      renderRow(
        columns.map((col) => col.cell(footerRow)),
        (text) => footerStyle(text),
      ),
    );
  }

  lines.push(hLine('└', '┴', '┘'));
  return lines.join('\n');
}

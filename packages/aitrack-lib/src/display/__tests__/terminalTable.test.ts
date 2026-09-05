import { describe, expect, it } from 'vitest';

import { defaultTableStyle, renderTerminalTable } from '../terminalTable.js';

interface Row {
  name: string;
  value: number;
}

describe('renderTerminalTable', () => {
  it('renders headers, body rows, and borders', () => {
    const rows: Row[] = [
      { name: 'Claude', value: 10 },
      { name: 'Codex', value: 20 },
    ];
    const table = renderTerminalTable(rows, [
      { header: 'Provider', align: 'left', cell: (r) => r.name },
      { header: 'Tokens', align: 'right', cell: (r) => String(r.value) },
    ]);

    expect(table).toContain('Provider');
    expect(table).toContain('Tokens');
    expect(table).toContain('Claude');
    expect(table).toContain('Codex');
    expect(table).toContain('┌');
    expect(table).toContain('└');
  });

  it('renders a footer row when provided', () => {
    const table = renderTerminalTable(
      [{ name: 'A', value: 1 }],
      [
        { header: 'Name', align: 'left', cell: (r) => r.name },
        { header: 'N', align: 'right', cell: (r) => String(r.value) },
      ],
      { footerRow: { name: 'TOTAL', value: 1 } },
    );

    expect(table).toContain('TOTAL');
  });

  it('exposes light and dark style presets', () => {
    const light = defaultTableStyle(false);
    const dark = defaultTableStyle(true);
    expect(light.border).not.toBe(dark.border);
    expect(light.header).not.toBe(dark.header);
    expect(typeof light.total).toBe('function');
  });
});

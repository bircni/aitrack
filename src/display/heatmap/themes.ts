interface ProviderTheme {
  name: string;
  cells: [string, string, string, string, string];
}
type ThemeSet = Record<string, ProviderTheme> & { _default: ProviderTheme };

const THEMES: Record<'light' | 'dark', ThemeSet> = {
  light: {
    claude_code: {
      name: 'Claude Code',
      cells: ['#ebedf0', '#fde8cf', '#fbba77', '#e87820', '#b04b10'],
    },
    codex: { name: 'Codex', cells: ['#ebedf0', '#cde4f8', '#7db9ea', '#2472c8', '#0b3d7a'] },
    cursor: { name: 'Cursor', cells: ['#ebedf0', '#fde8c8', '#f8a855', '#e56b10', '#8b2e00'] },
    all: { name: 'All providers', cells: ['#ebedf0', '#d4e8f4', '#8ab8d4', '#4a8ab8', '#1e4a6e'] },
    _default: { name: 'Unknown', cells: ['#ebedf0', '#c6e48b', '#7bc96f', '#239a3b', '#196127'] },
  },
  dark: {
    claude_code: {
      name: 'Claude Code',
      cells: ['#1e1e24', '#3d1a06', '#7c3610', '#c4621a', '#f08030'],
    },
    codex: { name: 'Codex', cells: ['#1e1e24', '#0c2240', '#0d4a8a', '#1a7fd4', '#4db8ff'] },
    cursor: { name: 'Cursor', cells: ['#1e1e24', '#3a1800', '#7a3200', '#c45a00', '#f08820'] },
    all: { name: 'All providers', cells: ['#1e1e24', '#0c2438', '#1a4a6e', '#2e7ab0', '#5cb8e8'] },
    _default: { name: 'Unknown', cells: ['#1e1e24', '#0e4429', '#006d32', '#26a641', '#39d353'] },
  },
};

export interface Palette {
  bg: string;
  divider: string;
  title: string;
  label: string;
  value: string;
  muted: string;
}

export const PALETTE: Record<'light' | 'dark', Palette> = {
  light: {
    bg: '#ffffff',
    divider: '#e0e0e0',
    title: '#1c1c1e',
    label: '#888888',
    value: '#1c1c1e',
    muted: '#999999',
  },
  dark: {
    bg: '#0d1117',
    divider: '#30363d',
    title: '#e6edf3',
    label: '#7d8590',
    value: '#e6edf3',
    muted: '#7d8590',
  },
};

export function getProviderTheme(
  providerKey: string,
  dark = false,
): { name: string; cells: [string, string, string, string, string] } {
  const providerThemes = THEMES[dark ? 'dark' : 'light'];
  const theme = providerThemes[providerKey] ?? providerThemes._default;
  return { name: theme.name === 'Unknown' ? providerKey : theme.name, cells: theme.cells };
}

export function pagePalette(dark: boolean): {
  bg: string;
  text: string;
  muted: string;
  divider: string;
  sectionBg: string;
  tableHeaderBg: string;
  tableRowAlt: string;
} {
  const p = PALETTE[dark ? 'dark' : 'light'];
  return dark
    ? {
        bg: p.bg,
        text: p.title,
        muted: p.muted,
        divider: p.divider,
        sectionBg: '#161b22',
        tableHeaderBg: '#1f2630',
        tableRowAlt: '#1a2027',
      }
    : {
        bg: p.bg,
        text: p.title,
        muted: p.label,
        divider: p.divider,
        sectionBg: '#fafafa',
        tableHeaderBg: '#f0f0f0',
        tableRowAlt: '#f6f6f6',
      };
}

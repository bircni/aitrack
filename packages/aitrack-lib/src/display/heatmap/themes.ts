import { PROVIDERS } from '../../providers/index.js';

interface ProviderTheme {
  cells: [string, string, string, string, string];
}
type ThemeSet = Record<string, ProviderTheme> & { _default: ProviderTheme };

/** Cell ramps aitrack ships regardless of the registry: the merged view and
 * the fallback for a provider that declared no colours. */
const BUILTIN_RAMPS: Record<'light' | 'dark', { all: ProviderTheme; _default: ProviderTheme }> = {
  light: {
    all: { cells: ['#ebedf0', '#d4e8f4', '#8ab8d4', '#4a8ab8', '#1e4a6e'] },
    _default: { cells: ['#ebedf0', '#c6e48b', '#7bc96f', '#239a3b', '#196127'] },
  },
  dark: {
    all: { cells: ['#1e1e24', '#0c2438', '#1a4a6e', '#2e7ab0', '#5cb8e8'] },
    _default: { cells: ['#1e1e24', '#0e4429', '#006d32', '#26a641', '#39d353'] },
  },
};

function themeSet(mode: 'light' | 'dark'): ThemeSet {
  return {
    ...Object.fromEntries(
      PROVIDERS.map((provider) => [
        provider.descriptor.key,
        { cells: [...provider.heatmap[mode]] as ProviderTheme['cells'] },
      ]),
    ),
    ...BUILTIN_RAMPS[mode],
  };
}

const THEMES: Record<'light' | 'dark', ThemeSet> = {
  light: themeSet('light'),
  dark: themeSet('dark'),
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

/**
 * Cell colours for a provider. The display name is not here — it lives in
 * PROVIDER_LABELS, and this used to carry a third copy of it whose "Unknown"
 * fallback was just providerLabel's raw-key fallback spelled differently.
 */
export function getProviderTheme(
  providerKey: string,
  dark = false,
): { cells: [string, string, string, string, string] } {
  const providerThemes = THEMES[dark ? 'dark' : 'light'];
  return providerThemes[providerKey] ?? providerThemes._default;
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

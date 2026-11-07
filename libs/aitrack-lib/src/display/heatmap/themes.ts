import { PROVIDERS } from '../../providers/index.js';
import type { CellRamp } from '../../providers/types.js';

type ThemeMode = 'light' | 'dark';
type ThemeSet = Record<string, CellRamp> & { _default: CellRamp };

/** Cell ramps aitrack ships regardless of the registry: the merged view and
 * the fallback for a provider that declared no colours. */
const BUILTIN_RAMPS: Record<ThemeMode, { all: CellRamp; _default: CellRamp }> = {
  light: {
    all: ['#ebedf0', '#d4e8f4', '#8ab8d4', '#4a8ab8', '#1e4a6e'],
    _default: ['#ebedf0', '#c6e48b', '#7bc96f', '#239a3b', '#196127'],
  },
  dark: {
    all: ['#1e1e24', '#0c2438', '#1a4a6e', '#2e7ab0', '#5cb8e8'],
    _default: ['#1e1e24', '#0e4429', '#006d32', '#26a641', '#39d353'],
  },
};

function themeSet(mode: ThemeMode): ThemeSet {
  return {
    ...Object.fromEntries(
      PROVIDERS.map((provider) => [provider.descriptor.key, provider.heatmap[mode]]),
    ),
    ...BUILTIN_RAMPS[mode],
  };
}

const THEMES: Record<ThemeMode, ThemeSet> = {
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

export const PALETTE: Record<ThemeMode, Palette> = {
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

/** Cell colours for a provider. */
export function providerCells(providerKey: string, mode: ThemeMode): CellRamp {
  const providerThemes = THEMES[mode];
  return providerThemes[providerKey] ?? providerThemes._default;
}

/** @public */
export function getProviderTheme(providerKey: string, dark = false): { cells: CellRamp } {
  return { cells: providerCells(providerKey, dark ? 'dark' : 'light') };
}

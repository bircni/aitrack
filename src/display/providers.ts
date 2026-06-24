import type { ProviderData } from '../data/types.js';

export const PROVIDER_ORDER = ['claude_code', 'codex', 'cursor'] as const;

export const PROVIDER_LABELS: Record<string, string> = {
  claude_code: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  all: 'All providers',
};

export function providerLabel(providerKey: string): string {
  return PROVIDER_LABELS[providerKey] ?? providerKey;
}

export function costColumnLabel(providerKey: string, uppercase = false): string {
  const label = providerKey === 'cursor' ? 'Cost' : 'Est. cost';
  return uppercase ? label.toUpperCase() : label;
}

export function activeProviderKeys(providerData: ProviderData): string[] {
  const active: string[] = PROVIDER_ORDER.filter((k) => (providerData[k]?.size ?? 0) > 0);
  for (const [k, data] of Object.entries(providerData)) {
    if (!active.includes(k) && data.size > 0) active.push(k);
  }
  return active;
}

const PROVIDER_ORDER_SET = new Set<string>(PROVIDER_ORDER);

export function orderedProviderKeys(providerData: ProviderData): string[] {
  return [
    ...PROVIDER_ORDER.filter((k) => providerData[k]),
    ...Object.keys(providerData).filter((k) => !PROVIDER_ORDER_SET.has(k)),
  ];
}

export function sortProviderKeys(keys: string[]): string[] {
  return [...keys].sort((a, b) => {
    const ai = PROVIDER_ORDER.indexOf(a as (typeof PROVIDER_ORDER)[number]);
    const bi = PROVIDER_ORDER.indexOf(b as (typeof PROVIDER_ORDER)[number]);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

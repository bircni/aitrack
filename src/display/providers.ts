import type { ProviderData } from '../data/types.js';
import { PROVIDER_BY_ALIAS, PROVIDER_BY_KEY, PROVIDERS, providerKeys } from '../providers/index.js';

/**
 * Display-facing view of the provider registry in `src/providers/`.
 *
 * Every list here is derived from that one table rather than restated, so
 * adding a provider is a single entry.
 */

/**
 * Canonical provider keys, in display order. Doubles as the set the
 * `--providers` flag can select — the two lists were identical.
 */
export const PROVIDER_ORDER: readonly string[] = providerKeys();

export const PROVIDER_LABELS: Record<string, string> = {
  ...Object.fromEntries(
    PROVIDERS.map((provider) => [provider.descriptor.key, provider.descriptor.label]),
  ),
  all: 'All providers',
};

/** Providers written to git during sync; Cursor stays local-only. */
export const SYNCED_PROVIDERS: readonly string[] = PROVIDERS.filter(
  (provider) => provider.descriptor.synced,
).map((provider) => provider.descriptor.key);

export function isSyncedProvider(providerKey: string): boolean {
  return PROVIDER_BY_KEY[providerKey]?.descriptor.synced ?? false;
}

/**
 * Normalize a user-supplied provider name (case-insensitive, friendly aliases)
 * to its canonical key, or return null when it is not a known provider.
 */
export function normalizeProviderKey(input: string): string | null {
  return PROVIDER_BY_ALIAS[input.trim().toLowerCase()]?.descriptor.key ?? null;
}

export function providerLabel(providerKey: string): string {
  return PROVIDER_LABELS[providerKey] ?? providerKey;
}

export function costColumnLabel(providerKey: string, uppercase = false): string {
  const label = PROVIDER_BY_KEY[providerKey]?.descriptor.costLabel ?? 'Est. cost';
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
  return keys.toSorted((a, b) => {
    const ai = PROVIDER_ORDER.indexOf(a);
    const bi = PROVIDER_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

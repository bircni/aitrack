// Adding a provider is a descriptor, one module and one PROVIDERS entry, plus a quota fetcher when
// it has limits. opentrack also needs its dashboard link, icon and colours.
import type { ProviderData } from '../data/types.js';
import { claudeCodeProvider } from './claudeCode.js';
import { codexProvider } from './codex.js';
import { cursorProvider } from './cursor.js';
import { providerKeys } from './descriptors.js';
import type { LiveProvider, Provider, SyncedProvider } from './types.js';

/** In display order. */
export const PROVIDERS: readonly Provider[] = [claudeCodeProvider, codexProvider, cursorProvider];

export const PROVIDER_BY_KEY: Record<string, Provider> = Object.fromEntries(
  PROVIDERS.map((provider) => [provider.descriptor.key, provider]),
);

export const PROVIDER_BY_ALIAS: Record<string, Provider> = Object.fromEntries(
  PROVIDERS.flatMap((provider) => provider.descriptor.aliases.map((alias) => [alias, provider])),
);

export function getProvider(key: string): Provider | undefined {
  return PROVIDER_BY_KEY[key];
}

export { normalizeProviderKey, providerKeys } from './descriptors.js';

/** Providers written to git during sync, in display order. */
export function syncedProviders(): SyncedProvider[] {
  return PROVIDERS.filter((provider): provider is SyncedProvider => provider.reader !== undefined);
}

/** Keys of the providers written to git during sync, in display order. */
export function syncedProviderKeys(): string[] {
  return syncedProviders().map((provider) => provider.descriptor.key);
}

export function isSyncedProvider(key: string): boolean {
  return PROVIDER_BY_KEY[key]?.reader !== undefined;
}

/** Providers fetched live and never persisted (Cursor), in display order. */
export function liveProviders(): LiveProvider[] {
  return PROVIDERS.filter((provider): provider is LiveProvider => provider.live !== undefined);
}

/** Canonical provider keys, in display order. */
const PROVIDER_ORDER: readonly string[] = providerKeys();
const PROVIDER_ORDER_SET = new Set<string>(PROVIDER_ORDER);

export const PROVIDER_LABELS: Record<string, string> = {
  ...Object.fromEntries(
    PROVIDERS.map((provider) => [provider.descriptor.key, provider.descriptor.label]),
  ),
  all: 'All providers',
};

export function providerLabel(providerKey: string): string {
  return PROVIDER_LABELS[providerKey] ?? providerKey;
}

export function costColumnLabel(providerKey: string, uppercase = false): string {
  const label = PROVIDER_BY_KEY[providerKey]?.descriptor.costLabel ?? 'Est. cost';
  return uppercase ? label.toUpperCase() : label;
}

export function activeProviderKeys(providerData: ProviderData): string[] {
  return orderedProviderKeys(providerData).filter((k) => (providerData[k]?.size ?? 0) > 0);
}

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

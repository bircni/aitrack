/**
 * The provider registry.
 *
 * Everything aitrack knows about a provider — its descriptor, heatmap colours,
 * pricing, how to read it, and its `doctor` check — lives in one module per
 * provider. Adding a provider is a new `src/providers/<name>.ts` plus one line
 * in the `PROVIDERS` array below; the reader, sync, pricing, recompute and
 * doctor paths all iterate this list rather than naming providers.
 */
import { claudeCodeProvider } from './claudeCode.js';
import { codexProvider } from './codex.js';
import { cursorProvider } from './cursor.js';
import type { Provider } from './types.js';

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

/** Provider keys in display order. */
export function providerKeys(): string[] {
  return PROVIDERS.map((provider) => provider.descriptor.key);
}

/** Providers written to git during sync, in display order. */
export function syncedProviders(): Provider[] {
  return PROVIDERS.filter((provider) => provider.descriptor.synced);
}

/** Providers fetched live and never persisted (Cursor), in display order. */
export function liveProviders(): Provider[] {
  return PROVIDERS.filter((provider) => !provider.descriptor.synced);
}

// No imports with runtime effect: `--help`, `--version` and completion load this without any reader or rate table.
import type { ProviderDescriptor } from './types.js';

/** In display order. Every other list of providers, the registry and quota included, derives from this. */
export const PROVIDER_DESCRIPTORS = {
  claude_code: {
    key: 'claude_code',
    label: 'Claude Code',
    aliases: ['claude', 'claude-code', 'claude_code', 'claudecode'],
    costLabel: 'Est. cost',
    hasQuota: true,
  },
  codex: {
    key: 'codex',
    label: 'Codex',
    aliases: ['codex'],
    costLabel: 'Est. cost',
    hasQuota: true,
  },
  cursor: {
    key: 'cursor',
    label: 'Cursor',
    aliases: ['cursor'],
    costLabel: 'Est. cost',
    hasQuota: true,
  },
} as const satisfies Record<string, ProviderDescriptor>;

type Descriptors = typeof PROVIDER_DESCRIPTORS;

export type ProviderKey = keyof Descriptors;

export type QuotaProviderKey = {
  [Key in keyof Descriptors]: Descriptors[Key]['hasQuota'] extends true ? Key : never;
}[keyof Descriptors];

const DESCRIPTORS: readonly ProviderDescriptor[] = Object.values(PROVIDER_DESCRIPTORS);

/** In display order. */
export const QUOTA_PROVIDERS = DESCRIPTORS.filter((descriptor) => descriptor.hasQuota).map(
  (descriptor) => descriptor.key as QuotaProviderKey,
) as readonly QuotaProviderKey[];

export function providerKeys(): ProviderKey[] {
  return DESCRIPTORS.map((descriptor) => descriptor.key as ProviderKey);
}

export function isProviderKey(value: unknown): value is ProviderKey {
  return DESCRIPTORS.some((descriptor) => descriptor.key === value);
}

/**
 * Normalize a user-supplied provider name (case-insensitive, friendly aliases)
 * to its canonical key, or return null when it is not a known provider.
 */
export function normalizeProviderKey(input: string): string | null {
  const name = input.trim().toLowerCase();
  return DESCRIPTORS.find((descriptor) => descriptor.aliases.includes(name))?.key ?? null;
}

/**
 * Everything aitrack knows about a provider, in one place.
 *
 * These facts used to be five separate declarations — a display order, a label
 * map, a synced-provider list, an alias map, and a `costColumnLabel` that
 * special-cased Cursor by name — so adding a provider meant finding all five
 * and the reader and pricing paths besides. The derived lists below are built
 * from this table, so an entry here is the only edit.
 */
export interface ProviderDescriptor {
  /** Canonical key, as used in the data files. */
  key: string;
  /** Human-readable name. */
  label: string;
  /** Friendly spellings accepted by `--providers`, lowercase. */
  aliases: readonly string[];
  /**
   * Whether this provider's data is written to git during sync. Cursor is
   * fetched live from its API on every command, so it is never persisted.
   */
  synced: boolean;
  /**
   * Column heading for money. Cursor reports what it actually billed; the
   * others are computed from a local pricing table and are estimates.
   */
  costLabel: string;
}

/** In display order. */
export const PROVIDERS: readonly ProviderDescriptor[] = [
  {
    key: 'claude_code',
    label: 'Claude Code',
    aliases: ['claude', 'claude-code', 'claude_code', 'claudecode'],
    synced: true,
    costLabel: 'Est. cost',
  },
  {
    key: 'codex',
    label: 'Codex',
    aliases: ['codex'],
    synced: true,
    costLabel: 'Est. cost',
  },
  {
    key: 'cursor',
    label: 'Cursor',
    aliases: ['cursor'],
    synced: false,
    costLabel: 'Cost',
  },
];

export const PROVIDER_BY_KEY: Record<string, ProviderDescriptor> = Object.fromEntries(
  PROVIDERS.map((provider) => [provider.key, provider]),
);

export const PROVIDER_BY_ALIAS: Record<string, ProviderDescriptor> = Object.fromEntries(
  PROVIDERS.flatMap((provider) => provider.aliases.map((alias) => [alias, provider])),
);

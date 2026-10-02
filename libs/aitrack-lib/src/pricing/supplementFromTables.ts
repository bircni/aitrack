import type { PricingSupplement } from './packMeta.js';
import claudeTable from './tables/claude.json' with { type: 'json' };
import codexTable from './tables/codex.json' with { type: 'json' };
import cursorTable from './tables/cursor.json' with { type: 'json' };

export type PricingTables = {
  [Provider in 'claude' | 'codex' | 'cursor']: PricingSupplement[Provider] & { updatedAt: string };
};

const DEFAULT_TABLES: PricingTables = {
  claude: claudeTable,
  codex: codexTable,
  cursor: cursorTable,
};

function tableStamp(updatedAt: string): number {
  return Date.parse(updatedAt.includes('T') ? updatedAt : `${updatedAt}T00:00:00Z`);
}

/** Build an isolated supplement from bundled tables or freshly read table data. */
export function supplementFromTables(tables: PricingTables = DEFAULT_TABLES): PricingSupplement {
  const updatedAtMs = Math.max(
    tableStamp(tables.claude.updatedAt),
    tableStamp(tables.codex.updatedAt),
    tableStamp(tables.cursor.updatedAt),
  );
  return {
    updatedAt: new Date(updatedAtMs).toISOString(),
    comment: 'First-party pricing from tables/*.json. Catalogs supply additional models.',
    claude: {
      models: structuredClone(tables.claude.models),
      overrides: structuredClone(tables.claude.overrides),
      familyFallback: structuredClone(tables.claude.familyFallback),
    },
    codex: {
      current: structuredClone(tables.codex.current),
      historical: structuredClone(tables.codex.historical),
      overrides: structuredClone(tables.codex.overrides),
      familyFallback: structuredClone(tables.codex.familyFallback),
    },
    cursor: {
      models: structuredClone(tables.cursor.models),
      fastMultipliers: structuredClone(tables.cursor.fastMultipliers),
      aliases: structuredClone(tables.cursor.aliases),
    },
  };
}

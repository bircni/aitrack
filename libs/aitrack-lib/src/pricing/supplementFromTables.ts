import type { PricingSupplement } from './packMeta.js';
import claudeTable from './tables/claude.json' with { type: 'json' };
import codexTable from './tables/codex.json' with { type: 'json' };
import cursorTable from './tables/cursor.json' with { type: 'json' };

function tableStamp(updatedAt: string): number {
  return Date.parse(updatedAt.includes('T') ? updatedAt : `${updatedAt}T00:00:00Z`);
}

/**
 * Offline baseline rates from `tables/*.json`. The orphan `pricing` branch
 * overlays a newer supplement into `~/.config/aitrack/pricing/` after refresh;
 * nothing is bundled as a prebuilt pack.
 */
export function supplementFromTables(): PricingSupplement {
  const updatedAtMs = Math.max(
    tableStamp(claudeTable.updatedAt),
    tableStamp(codexTable.updatedAt),
    tableStamp(cursorTable.updatedAt),
  );
  return {
    updatedAt: new Date(updatedAtMs).toISOString(),
    comment:
      'Local tables/*.json baseline. Live installs prefer a newer supplement from the pricing branch cache.',
    claude: {
      models: structuredClone(claudeTable.models),
      overrides: structuredClone(claudeTable.overrides),
      familyFallback: structuredClone(claudeTable.familyFallback),
    },
    codex: {
      current: structuredClone(codexTable.current),
      historical: structuredClone(codexTable.historical),
      overrides: structuredClone(codexTable.overrides),
      familyFallback: structuredClone(codexTable.familyFallback),
    },
    cursor: {
      models: structuredClone(cursorTable.models),
      fastMultipliers: structuredClone(cursorTable.fastMultipliers),
      aliases: structuredClone(cursorTable.aliases),
    },
  };
}

import {
  CLAUDE_PRICING_BY_ID,
  estimateClaudeCostFromAggregateTokens,
  estimateClaudeCostFromStoredCounts,
} from './claude.js';
import { CODEX_PRICING_BY_ID, estimateCodexCostUSD } from './codex.js';

/**
 * One Cursor CSV row's token counts.
 *
 * `input` is the total (raw + cache read + cache write) for display and
 * aggregation. When `hasBreakdown` is true the three components are exact and
 * can be priced at their own rates; older exports expose only an aggregate and
 * leave them zero.
 */
export interface CursorCostTokens {
  input: number;
  output: number;
  /** Non-cached input tokens. */
  rawInput: number;
  /** Tokens served from the prompt cache (billed at the reduced cache-read rate). */
  cacheRead: number;
  /** Tokens written to the prompt cache (billed at the cache-creation premium). */
  cacheWrite: number;
  hasBreakdown: boolean;
}

/**
 * Best-effort cost for a Cursor usage row.
 *
 * Cursor's CSV export gives a model name and token counts but no cost. Cursor
 * proxies models from several vendors, so we can only price the ones whose id
 * maps to a list price aitrack already tracks — currently Anthropic Claude and
 * the OpenAI GPT-5 family. Cursor-native models (`cursor-small`, `composer-*`),
 * `auto`, and Gemini / Grok / DeepSeek stay unpriced and return `undefined`,
 * exactly as before. Pricing only on an *exact* table hit keeps a wrong guess
 * from turning into a wrong number: the worst case is a blank cost cell.
 *
 * When the row carries a cache breakdown it is priced component by component
 * (cache reads at 0.1x, cache writes at 1.25x for Claude); an aggregate-only
 * row falls back to charging all input at the full rate — an upper bound.
 */
export function estimateCursorCostUSD(
  model: string,
  tokens: CursorCostTokens,
  usageDate?: string,
): number | undefined {
  const id = normalizeCursorModelId(model);
  if (id === undefined) return undefined;

  if (id.startsWith('claude-')) {
    if (!(id in CLAUDE_PRICING_BY_ID)) return undefined;
    if (tokens.hasBreakdown) {
      return estimateClaudeCostFromStoredCounts(
        id,
        {
          inputTokens: tokens.input,
          outputTokens: tokens.output,
          rawInputTokens: tokens.rawInput,
          cachedInputTokens: tokens.cacheRead,
          cacheCreationInputTokens: tokens.cacheWrite,
        },
        usageDate,
      );
    }
    return estimateClaudeCostFromAggregateTokens(id, tokens.input, tokens.output, usageDate);
  }

  if (!(id in CODEX_PRICING_BY_ID)) return undefined;
  // Codex pricing has no separate cache-write rate; the discount is cache-read only.
  return estimateCodexCostUSD(id, tokens.input, tokens.output, tokens.cacheRead, usageDate);
}

/**
 * Map a Cursor model label onto a canonical pricing-table id, or `undefined`
 * when it is not an Anthropic/OpenAI model aitrack prices. Cursor writes Claude
 * versions with a dot (`claude-4.5-sonnet`) and in either order; the OpenAI
 * families pass through and are matched by exact key upstream.
 */
function normalizeCursorModelId(rawModel: string): string | undefined {
  const model = rawModel.trim().toLowerCase();

  const versionFirst = /^claude-(\d+)(?:[.-](\d+))?-(sonnet|opus|haiku)$/u.exec(model);
  if (versionFirst) {
    const [, major, minor, family] = versionFirst;
    return minor ? `claude-${family}-${major}-${minor}` : `claude-${family}-${major}`;
  }

  const familyFirst = /^claude-(sonnet|opus|haiku)-(\d+)(?:[.-](\d+))?$/u.exec(model);
  if (familyFirst) {
    const [, family, major, minor] = familyFirst;
    return minor ? `claude-${family}-${major}-${minor}` : `claude-${family}-${major}`;
  }

  if (/^(?:gpt-|o\d)/u.test(model)) return model;

  return undefined;
}

/**
 * Model-id suffix rules shared by readers, pricing and display. Readers strip
 * only `-latest`, an alias; dated releases (`-YYYYMMDD`) and effort labels
 * (`-thinking-high`, `-xhigh`) stay in stored keys and are folded only for
 * pricing and display.
 */

/** Claude families, in fallback-pricing order. */
export const CLAUDE_FAMILIES = ['fable', 'mythos', 'opus', 'haiku', 'sonnet'] as const;
export type ClaudeFamily = (typeof CLAUDE_FAMILIES)[number];

const CLAUDE_FAMILY_PATTERN = CLAUDE_FAMILIES.join('|');
const CLAUDE_VERSION_FIRST = new RegExp(
  `^claude-(\\d+)(?:-(\\d+))?-(${CLAUDE_FAMILY_PATTERN})$`,
  'u',
);

/** Cursor/Claude Code effort labels that are not part of the priced model id. */
const MODEL_EFFORT_TOKEN = 'low|medium|extra-high|xhigh|high|(?<!-codex-)max|none|minimal|ultra'; // gpt-5.1-codex-max is a priced model
const MODEL_EFFORT_SUFFIX = new RegExp(
  `(?:-thinking)?(?:-(?:${MODEL_EFFORT_TOKEN}))+(?:-thinking)?$`,
  'u',
);

/** Strip the `-latest` alias suffix. Applied by readers before storing a model. */
export function stripModelAliasSuffix(model: string): string {
  return model.replace(/-latest$/u, '');
}

/** Strip both the `-latest` alias and a `-YYYYMMDD` release suffix. */
export function stripModelVersionSuffixes(model: string): string {
  return model.replace(/-(?:latest|\d{8})$/u, '');
}

/**
 * Strip a trailing thinking/effort label (`-thinking-high`, `-medium`,
 * `-xhigh`, `-max`). Mini/pro/nano/codex stay put — those are priced models.
 */
export function stripModelEffortSuffix(model: string): string {
  let current = model;
  for (;;) {
    const next = current.replace(MODEL_EFFORT_SUFFIX, '').replace(/-thinking$/u, '');
    if (next === current) return current;
    current = next;
  }
}

/**
 * The thinking/effort/fast knobs on a raw id (`medium`, `xhigh fast`), or
 * undefined when the slug is already the priced model.
 */
export function modelEffortLabel(model: string): string | undefined {
  let rest = model.toLowerCase();
  const fast = rest.endsWith('-fast');
  if (fast) rest = rest.slice(0, -'-fast'.length);
  rest = stripModelVersionSuffixes(rest);
  const match = MODEL_EFFORT_SUFFIX.exec(rest);
  const effort = match
    ? match[0].replaceAll('-thinking', '').replace(/^-/u, '').replaceAll('-', ' ')
    : '';
  const parts = [effort, fast ? 'fast' : ''].filter((part) => part !== '');
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/** Lowercased id without release, alias or effort suffixes: the key pricing and display share. */
export function canonicalModelId(model: string): string {
  return stripModelEffortSuffix(stripModelVersionSuffixes(model.toLowerCase()));
}

/**
 * Fold a Claude id onto the family-first, hyphenated key the pricing table
 * uses. Handles version-first (`claude-4.6-opus`), dotted minors, dated
 * releases, and Cursor effort suffixes (`-thinking-high`).
 */
export function canonicalizeClaudeModelId(model: string): string {
  const id = canonicalModelId(model).replace(/(\d+)\.(\d+)/u, '$1-$2');
  const versionFirst = CLAUDE_VERSION_FIRST.exec(id);
  const [, major, minor, family] = versionFirst ?? [];
  return versionFirst && major && family
    ? `claude-${family}-${major}${minor ? `-${minor}` : ''}`
    : id;
}

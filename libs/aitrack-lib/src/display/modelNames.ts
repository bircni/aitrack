import {
  CLAUDE_FAMILIES,
  canonicalizeClaudeModelId,
  modelEffortLabel,
  stripModelEffortSuffix,
  stripModelVersionSuffixes,
} from '../data/modelId.js';

function titleCase(word: string): string {
  return `${(word.at(0) ?? '').toUpperCase()}${word.slice(1)}`;
}

function titleCaseRest(rest: string): string {
  return rest.replaceAll('-', ' ').replaceAll(/\b\w/gu, (c) => c.toUpperCase());
}

function displayStem(model: string): string {
  const lowered = model
    .toLowerCase()
    .replace(/-fast$/u, '')
    .replace(/^cursor-/u, '');
  const canonical = lowered.startsWith('claude-')
    ? canonicalizeClaudeModelId(lowered)
    : stripModelEffortSuffix(stripModelVersionSuffixes(lowered));
  return canonical.replace(/^claude-/u, '');
}

function prettyModelStem(model: string): string {
  const cleaned = displayStem(model);

  for (const family of CLAUDE_FAMILIES) {
    // Both orderings ship in real ids — family-first ("sonnet-4-5") and the
    // older version-first ("3-7-sonnet") — and the minor component is optional,
    // as in "sonnet-4".
    const match =
      new RegExp(String.raw`^${family}-(\d+)(?:-(\d+))?$`, 'u').exec(cleaned) ??
      new RegExp(String.raw`^(\d+)(?:-(\d+))?-${family}$`, 'u').exec(cleaned);
    if (match?.[1] !== undefined) {
      const version = match[2] === undefined ? match[1] : `${match[1]}.${match[2]}`;
      return `${titleCase(family)} ${version}`;
    }
  }

  const gpt = /^gpt-([\d.]+)(?:-(.+))?$/u.exec(cleaned);
  if (gpt) {
    const suffix = gpt[2] ? ` ${titleCaseRest(gpt[2])}` : '';
    return `GPT-${gpt[1]}${suffix}`;
  }
  const grok = /^grok-([\d.]+)(?:-(.+))?$/u.exec(cleaned);
  if (grok) {
    const suffix = grok[2] ? ` ${titleCaseRest(grok[2])}` : '';
    return `Grok ${grok[1]}${suffix}`;
  }
  if (cleaned === 'auto') return 'Auto';
  if (cleaned === 'composer') return 'Composer';
  if (cleaned.startsWith('composer-')) return `Composer ${cleaned.slice('composer-'.length)}`;
  if ((CLAUDE_FAMILIES as readonly string[]).includes(cleaned)) return titleCase(cleaned);
  return cleaned;
}

// "claude-haiku-4-5-20251001" -> "Haiku 4.5"; "claude-sonnet-4-20250514" ->
// "Sonnet 4"; "claude-3-7-sonnet-20250219" -> "Sonnet 3.7";
// "claude-fable-5-1-thinking-high" -> "Fable 5.1";
// "gpt-5.1-codex" -> "GPT-5.1 Codex"
//
// Pass `{ effort: true }` in tables that list each slug as its own row so
// `claude-opus-4-8-thinking-medium` stays distinct from `-high`.
export function displayModelName(model: string, options?: { effort?: boolean }): string {
  const base = prettyModelStem(model);
  if (!options?.effort) return base;
  const effort = modelEffortLabel(model);
  return effort === undefined ? base : `${base} ${effort}`;
}

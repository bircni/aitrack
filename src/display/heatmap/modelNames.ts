const CLAUDE_FAMILIES = ['opus', 'sonnet', 'haiku'];

function titleCase(word: string): string {
  return `${(word.at(0) ?? '').toUpperCase()}${word.slice(1)}`;
}

// "claude-haiku-4-5-20251001" -> "Haiku 4.5"; "claude-sonnet-4-20250514" ->
// "Sonnet 4"; "claude-3-7-sonnet-20250219" -> "Sonnet 3.7";
// "gpt-5.1-codex" -> "GPT-5.1 Codex"
export function displayModelName(model: string): string {
  const cleaned = model
    .replace(/-\d{8}$/, '')
    .replace(/-latest$/, '')
    .replace(/^claude-/, '');

  for (const family of CLAUDE_FAMILIES) {
    // Both orderings ship in real ids — family-first ("sonnet-4-5") and the
    // older version-first ("3-7-sonnet") — and the minor component is optional,
    // as in "sonnet-4".
    const match =
      new RegExp(String.raw`^${family}-(\d+)(?:-(\d+))?$`).exec(cleaned) ??
      new RegExp(String.raw`^(\d+)(?:-(\d+))?-${family}$`).exec(cleaned);
    if (match?.[1] !== undefined) {
      const version = match[2] === undefined ? match[1] : `${match[1]}.${match[2]}`;
      return `${titleCase(family)} ${version}`;
    }
  }

  const gpt = /^gpt-([\d.]+)(?:-(.+))?$/.exec(cleaned);
  if (gpt) {
    const suffix = gpt[2]
      ? ' ' + gpt[2].replaceAll('-', ' ').replaceAll(/\b\w/g, (c) => c.toUpperCase())
      : '';
    return `GPT-${gpt[1]}${suffix}`;
  }
  return cleaned;
}

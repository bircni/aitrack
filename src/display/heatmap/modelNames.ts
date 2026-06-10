// "claude-haiku-4-5-20251001" -> "Haiku 4.5"; "gpt-5.1-codex" -> "GPT-5.1 Codex"
export function displayModelName(model: string): string {
  const cleaned = model.replace(/-\d{8}$/, '').replace(/^claude-/, '');
  for (const family of ['opus', 'sonnet', 'haiku']) {
    const re = new RegExp(String.raw`^${family}-(\d+)-(\d+)$`);
    const m = re.exec(cleaned);
    if (m?.[1] !== undefined && m[2] !== undefined) {
      return `${(family[0] ?? '').toUpperCase()}${family.slice(1)} ${m[1]}.${m[2]}`;
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

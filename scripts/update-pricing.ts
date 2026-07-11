#!/usr/bin/env tsx
// Check in-code pricing tables (Claude + Codex) against vendor docs.
//
// Run: `pnpm run pricing:check`
// Exits 0 if everything matches, 1 if drift is detected.

import { CLAUDE_PRICING_BY_ID, type ClaudePricing } from '../src/pricing/claude.js';
import {
  CODEX_PRICING_BY_ID,
  CODEX_PRICING_CURRENT,
  type CodexPricing,
} from '../src/pricing/codex.js';

const CLAUDE_PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing';
const CODEX_PRICING_URL = 'https://developers.openai.com/api/docs/pricing';

// Find ALL occurrences of `needle` where the next char isn't a continuation
// of an identifier (avoids matching "gpt-5.1" inside "gpt-5.1-codex" or
// "Claude Opus 4" inside "Claude Opus 4.7").
function findHits(html: string, needle: string, isBoundary: (c: string) => boolean): number[] {
  const hits: number[] = [];
  let start = 0;
  for (;;) {
    const at = html.indexOf(needle, start);
    if (at === -1) break;
    const after = html[at + needle.length];
    if (!after || isBoundary(after)) hits.push(at);
    start = at + needle.length;
  }
  return hits;
}

// Collect dollar amounts from every heading occurrence's window. The first
// hit isn't always the canonical pricing row (e.g. a model can be referenced
// in a tool-pricing aside before its main row), so we union across all hits.
function pricesAt(html: string, hits: number[], windowSize: number): number[] {
  const found: number[] = [];
  for (const index of hits) {
    const window = html.slice(index, index + windowSize);
    const re = /\$([\d.]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(window)) !== null) {
      const amount = m[1];
      if (amount === undefined) continue;
      const v = parseFloat(amount);
      if (!Number.isNaN(v)) found.push(v);
    }
  }
  return found;
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'user-agent': 'aitrack-update-pricing-script' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ── Claude ────────────────────────────────────────────────────────────────

// `claude-opus-4-7` -> `Claude Opus 4.7`
function claudeHeading(modelId: string): string {
  const m = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?$/.exec(modelId);
  if (!m) return modelId;
  const familyId = m[1];
  const majorVersion = m[2];
  if (familyId === undefined || majorVersion === undefined) return modelId;
  const family = familyId.charAt(0).toUpperCase() + familyId.slice(1);
  const version = m[3] ? `${majorVersion}.${m[3]}` : majorVersion;
  return `Claude ${family} ${version}`;
}

// `Claude Opus 4.8` -> `claude-opus-4-8`
function claudeModelId(family: string, version: string): string {
  const dot = version.indexOf('.');
  if (dot === -1) return `claude-${family.toLowerCase()}-${version}`;
  return `claude-${family.toLowerCase()}-${version.slice(0, dot)}-${version.slice(dot + 1)}`;
}

// Scan the docs page for priced Claude models we don't track yet.
function discoverClaudeModelsOnPage(html: string): string[] {
  const re = /Claude (Opus|Sonnet|Haiku|Fable|Mythos) (\d+(?:\.\d+)?)/g;
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const after = html[m.index + m[0].length];
    if (after && /[\d.]/.test(after)) continue;
    const prices = pricesAt(html, [m.index], 800);
    if (prices.length === 0) continue;
    const family = m[1];
    const version = m[2];
    if (family === undefined || version === undefined) continue;
    found.add(claudeModelId(family, version));
  }
  return [...found].sort((a, b) => a.localeCompare(b));
}

function claudeSummary(p: ClaudePricing): string {
  return `$${p.inputPerMillion}/${p.outputPerMillion}`;
}

async function checkClaude(): Promise<{ drift: number; unverified: number; missing: number }> {
  console.log(`\n── Claude (${CLAUDE_PRICING_URL}) ──`);
  let html: string;
  try {
    html = await fetchHtml(CLAUDE_PRICING_URL);
  } catch (error) {
    console.error('Fetch failed:', (error as Error).message);
    return { drift: 1, unverified: 0, missing: 0 };
  }

  let drift = 0;
  let unverified = 0;
  let missing = 0;
  for (const [modelId, pricing] of Object.entries(CLAUDE_PRICING_BY_ID)) {
    const heading = claudeHeading(modelId);
    const hits = findHits(html, heading, (c) => !/[\d.]/.test(c));
    const found = pricesAt(html, hits, 800);
    if (found.length === 0) {
      console.log(`? ${modelId.padEnd(22)} ${claudeSummary(pricing)}  — "${heading}" not on page`);
      unverified++;
      continue;
    }
    const isInOk = found.includes(pricing.inputPerMillion);
    const isOutOk = found.includes(pricing.outputPerMillion);
    if (isInOk && isOutOk) {
      console.log(`✓ ${modelId.padEnd(22)} ${claudeSummary(pricing)}`);
    } else {
      console.log(
        `✗ ${modelId.padEnd(22)} ${claudeSummary(pricing)}  — input=${isInOk ? 'ok' : 'MISS'} output=${isOutOk ? 'ok' : 'MISS'}  (saw: ${found.slice(0, 6).join(', ')})`,
      );
      drift++;
    }
  }

  const known = new Set(Object.keys(CLAUDE_PRICING_BY_ID));
  for (const modelId of discoverClaudeModelsOnPage(html)) {
    if (known.has(modelId)) continue;
    console.log(`+ ${modelId.padEnd(22)} — on docs page but missing from src/pricing/claude.ts`);
    missing++;
  }

  return { drift, unverified, missing };
}

// ── Codex ─────────────────────────────────────────────────────────────────

function codexSummary(p: CodexPricing): string {
  return `$${p.inputPerMillion}/${p.outputPerMillion}`;
}

// Scan the docs page for priced Codex models we don't track yet. Suffix is
// open-ended (`-mini`, `-nano`, `-codex-max`, `-luna`, `-sol`, ...) since
// OpenAI names new tiers/snapshots freely; boundary check below keeps this
// from swallowing unrelated trailing text.
function discoverCodexModelsOnPage(html: string): string[] {
  const re = /gpt-\d+(?:\.\d+)?(?:-[a-z]+)*/g;
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const after = html[m.index + m[0].length];
    if (after && /[\w.-]/.test(after)) continue;
    const prices = pricesAt(html, [m.index], 3000);
    if (prices.length === 0) continue;
    found.add(m[0]);
  }
  return [...found].sort((a, b) => a.localeCompare(b));
}

async function checkCodex(): Promise<{ drift: number; unverified: number; missing: number }> {
  console.log(`\n── Codex (${CODEX_PRICING_URL}) ──`);
  let html: string;
  try {
    html = await fetchHtml(CODEX_PRICING_URL);
  } catch (error) {
    console.error('Fetch failed:', (error as Error).message);
    return { drift: 1, unverified: 0, missing: 0 };
  }

  let drift = 0;
  let unverified = 0;
  for (const [modelId, pricing] of Object.entries(CODEX_PRICING_CURRENT)) {
    // Boundary: any char that can't continue a model id (digit, dot, dash,
    // letter) ends the match. This keeps `gpt-5` from matching `gpt-5.1` and
    // `gpt-5.1-codex` from matching `gpt-5.1-codex-mini`.
    const hits = findHits(html, modelId, (c) => !/[\w.-]/.test(c));
    // Pricing table cells have a lot of inline-style boilerplate between
    // the model name and the price, so use a generous window.
    const found = pricesAt(html, hits, 3000);
    if (found.length === 0) {
      console.log(`? ${modelId.padEnd(22)} ${codexSummary(pricing)}  — "${modelId}" not on page`);
      unverified++;
      continue;
    }
    const isInOk = found.includes(pricing.inputPerMillion);
    const isOutOk = found.includes(pricing.outputPerMillion);
    if (isInOk && isOutOk) {
      console.log(`✓ ${modelId.padEnd(22)} ${codexSummary(pricing)}`);
    } else {
      console.log(
        `✗ ${modelId.padEnd(22)} ${codexSummary(pricing)}  — input=${isInOk ? 'ok' : 'MISS'} output=${isOutOk ? 'ok' : 'MISS'}  (saw: ${found.slice(0, 6).join(', ')})`,
      );
      drift++;
    }
  }

  let missing = 0;
  const known = new Set(Object.keys(CODEX_PRICING_BY_ID));
  for (const modelId of discoverCodexModelsOnPage(html)) {
    if (known.has(modelId)) continue;
    console.log(`+ ${modelId.padEnd(22)} — on docs page but missing from src/pricing/codex.ts`);
    missing++;
  }

  return { drift, unverified, missing };
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const claude = await checkClaude();
  const codex = await checkCodex();

  const totalDrift = claude.drift + codex.drift;
  const totalUnverified = claude.unverified + codex.unverified;
  const totalMissing = claude.missing + codex.missing;

  console.log('');
  if (totalMissing > 0) {
    console.log(`${totalMissing} model(s) on docs page missing from src/pricing/*.ts — add them and re-run`);
  }
  if (totalDrift > 0) {
    console.log(`${totalDrift} model(s) drift from current docs — update src/pricing/*.ts`);
  } else if (totalMissing === 0 && totalUnverified > 0) {
    console.log(`No drift, but ${totalUnverified} model(s) couldn't be found on the page.`);
  } else if (totalMissing === 0 && totalDrift === 0) {
    console.log('All pricing matches docs.');
  }

  return totalDrift > 0 || totalMissing > 0 ? 1 : 0;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });

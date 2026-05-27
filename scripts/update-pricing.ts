#!/usr/bin/env tsx
// Check in-code pricing tables (Claude + Codex) against vendor docs.
//
// Run: `pnpm run pricing:check`
// Exits 0 if everything matches, 1 if drift is detected.

import { CLAUDE_PRICING_BY_ID, type ClaudePricing } from '../src/pricing/claude.js';
import { CODEX_PRICING_CURRENT, type CodexPricing } from '../src/pricing/codex.js';

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
    if (at < 0) break;
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
  for (const idx of hits) {
    const window = html.slice(idx, idx + windowSize);
    const re = /\$([\d.]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(window)) !== null) {
      const v = parseFloat(m[1]);
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
  const m = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?$/.exec(modelId);
  if (!m) return modelId;
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  const version = m[3] ? `${m[2]}.${m[3]}` : m[2];
  return `Claude ${family} ${version}`;
}

function claudeSummary(p: ClaudePricing): string {
  return `$${p.inputPerMillion}/${p.outputPerMillion}`;
}

async function checkClaude(): Promise<{ drift: number; unverified: number }> {
  console.log(`\n── Claude (${CLAUDE_PRICING_URL}) ──`);
  let html: string;
  try {
    html = await fetchHtml(CLAUDE_PRICING_URL);
  } catch (err) {
    console.error('Fetch failed:', (err as Error).message);
    return { drift: 1, unverified: 0 };
  }

  let drift = 0;
  let unverified = 0;
  for (const [modelId, pricing] of Object.entries(CLAUDE_PRICING_BY_ID)) {
    const heading = claudeHeading(modelId);
    const hits = findHits(html, heading, (c) => !/[\d.]/.test(c));
    const found = pricesAt(html, hits, 800);
    if (found.length === 0) {
      console.log(`? ${modelId.padEnd(22)} ${claudeSummary(pricing)}  — "${heading}" not on page`);
      unverified++;
      continue;
    }
    const inOk = found.includes(pricing.inputPerMillion);
    const outOk = found.includes(pricing.outputPerMillion);
    if (inOk && outOk) {
      console.log(`✓ ${modelId.padEnd(22)} ${claudeSummary(pricing)}`);
    } else {
      console.log(
        `✗ ${modelId.padEnd(22)} ${claudeSummary(pricing)}  — input=${inOk ? 'ok' : 'MISS'} output=${outOk ? 'ok' : 'MISS'}  (saw: ${found.slice(0, 6).join(', ')})`,
      );
      drift++;
    }
  }
  return { drift, unverified };
}

// ── Codex ─────────────────────────────────────────────────────────────────

function codexSummary(p: CodexPricing): string {
  return `$${p.inputPerMillion}/${p.outputPerMillion}`;
}

async function checkCodex(): Promise<{ drift: number; unverified: number }> {
  console.log(`\n── Codex (${CODEX_PRICING_URL}) ──`);
  let html: string;
  try {
    html = await fetchHtml(CODEX_PRICING_URL);
  } catch (err) {
    console.error('Fetch failed:', (err as Error).message);
    return { drift: 1, unverified: 0 };
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
    const inOk = found.includes(pricing.inputPerMillion);
    const outOk = found.includes(pricing.outputPerMillion);
    if (inOk && outOk) {
      console.log(`✓ ${modelId.padEnd(22)} ${codexSummary(pricing)}`);
    } else {
      console.log(
        `✗ ${modelId.padEnd(22)} ${codexSummary(pricing)}  — input=${inOk ? 'ok' : 'MISS'} output=${outOk ? 'ok' : 'MISS'}  (saw: ${found.slice(0, 6).join(', ')})`,
      );
      drift++;
    }
  }
  return { drift, unverified };
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const claude = await checkClaude();
  const codex = await checkCodex();

  const totalDrift = claude.drift + codex.drift;
  const totalUnverified = claude.unverified + codex.unverified;

  console.log('');
  if (totalDrift > 0) {
    console.log(`${totalDrift} model(s) drift from current docs — update src/pricing/*.ts`);
  } else if (totalUnverified > 0) {
    console.log(`No drift, but ${totalUnverified} model(s) couldn't be found on the page.`);
  } else {
    console.log('All pricing matches docs.');
  }

  return totalDrift > 0 ? 1 : 0;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });

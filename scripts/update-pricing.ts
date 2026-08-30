#!/usr/bin/env tsx
// Check in-code pricing tables (Claude + Codex) against vendor docs.
//
// Run: `pnpm run pricing:check`
// Exits 0 if everything matches, 1 if drift is detected.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { errorMessage } from '../src/errors.js';
import { CLAUDE_PRICING_BY_ID } from '../src/pricing/claude.js';
import { CODEX_PRICING_BY_ID, CODEX_PRICING_CURRENT } from '../src/pricing/codex.js';

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
      const v = Number.parseFloat(amount);
      if (!Number.isNaN(v)) found.push(v);
    }
  }
  return found;
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'user-agent': 'aitrack-update-pricing-script' },
  });
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  return res.text();
}

// ── Claude ────────────────────────────────────────────────────────────────

// `claude-opus-4-7` -> `Claude Opus 4.7`
export function claudeHeading(modelId: string): string {
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
export function discoverClaudeModelsOnPage(html: string): string[] {
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

export interface ProviderCheck<P extends { inputPerMillion: number; outputPerMillion: number }> {
  label: string;
  url: string;
  /** Entries to verify against the docs page. */
  table: Record<string, P>;
  /** Every id the source file knows, used to spot models missing from it. */
  knownIds: string[];
  sourceFile: string;
  /** Built once per fetched page, then asked for each model's prices. */
  lookup: (html: string) => (modelId: string) => { prices: number[]; where: string };
  discover: (html: string) => string[];
}

export interface CheckResult {
  drift: number;
  unverified: number;
  missing: number;
}

/**
 * One model's verdict against the docs page.
 *
 * Comparison is kept apart from fetching and printing so it can be tested — it
 * is the part that decides whether a release ships wrong prices, and it used to
 * be welded to `fetchHtml` and `console.log`.
 */
export type PricingFinding =
  | { kind: 'ok'; modelId: string; summary: string }
  | {
      kind: 'drift';
      modelId: string;
      summary: string;
      isInOk: boolean;
      isOutOk: boolean;
      saw: number[];
    }
  | { kind: 'unverified'; modelId: string; summary: string; where: string }
  | { kind: 'missing'; modelId: string };

export function compareProviderPricing<
  P extends { inputPerMillion: number; outputPerMillion: number },
>(check: ProviderCheck<P>, html: string): PricingFinding[] {
  const findings: PricingFinding[] = [];
  const pricesFor = check.lookup(html);

  for (const [modelId, pricing] of Object.entries(check.table)) {
    const summary = `$${String(pricing.inputPerMillion)}/${String(pricing.outputPerMillion)}`;
    const { prices, where } = pricesFor(modelId);
    if (prices.length === 0) {
      findings.push({ kind: 'unverified', modelId, summary, where });
      continue;
    }
    const isInOk = prices.includes(pricing.inputPerMillion);
    const isOutOk = prices.includes(pricing.outputPerMillion);
    findings.push(
      isInOk && isOutOk
        ? { kind: 'ok', modelId, summary }
        : { kind: 'drift', modelId, summary, isInOk, isOutOk, saw: prices.slice(0, 6) },
    );
  }

  const known = new Set(check.knownIds);
  for (const modelId of check.discover(html)) {
    if (!known.has(modelId)) findings.push({ kind: 'missing', modelId });
  }

  return findings;
}

export function tallyFindings(findings: PricingFinding[]): CheckResult {
  return {
    drift: findings.filter((f) => f.kind === 'drift').length,
    unverified: findings.filter((f) => f.kind === 'unverified').length,
    missing: findings.filter((f) => f.kind === 'missing').length,
  };
}

function reportFinding(finding: PricingFinding, sourceFile: string): void {
  const id = finding.modelId.padEnd(22);
  switch (finding.kind) {
    case 'ok': {
      console.log(`\u2713 ${id} ${finding.summary}`);
      break;
    }
    case 'drift': {
      console.log(
        `\u2717 ${id} ${finding.summary}  — input=${finding.isInOk ? 'ok' : 'MISS'} output=${finding.isOutOk ? 'ok' : 'MISS'}  (saw: ${finding.saw.join(', ')})`,
      );
      break;
    }
    case 'unverified': {
      console.log(`? ${id} ${finding.summary}  — "${finding.where}" not on page`);
      break;
    }
    case 'missing': {
      console.log(`+ ${id} — on docs page but missing from ${sourceFile}`);
      break;
    }
  }
}

async function checkProvider<P extends { inputPerMillion: number; outputPerMillion: number }>(
  check: ProviderCheck<P>,
): Promise<CheckResult> {
  console.log(`\n── ${check.label} (${check.url}) ──`);
  let html: string;
  try {
    html = await fetchHtml(check.url);
  } catch (error) {
    console.error('Fetch failed:', errorMessage(error));
    return { drift: 1, unverified: 0, missing: 0 };
  }

  const findings = compareProviderPricing(check, html);
  for (const finding of findings) reportFinding(finding, check.sourceFile);
  return tallyFindings(findings);
}

function checkClaude(): Promise<CheckResult> {
  return checkProvider({
    label: 'Claude',
    url: CLAUDE_PRICING_URL,
    table: CLAUDE_PRICING_BY_ID,
    knownIds: Object.keys(CLAUDE_PRICING_BY_ID),
    sourceFile: 'src/pricing/claude.ts',
    lookup: (html) => (modelId) => {
      const heading = claudeHeading(modelId);
      const hits = findHits(html, heading, (c) => !/[\d.]/.test(c));
      return { prices: pricesAt(html, hits, 800), where: heading };
    },
    discover: discoverClaudeModelsOnPage,
  });
}

// ── Codex ─────────────────────────────────────────────────────────────────

interface CodexPricingRow {
  modelId: string;
  prices: number[];
}

function codexPricingRows(html: string): CodexPricingRow[] {
  const rowPattern = /\[1,\[\[0,&quot;([^[]*?)&quot;\]/g;
  const matches = [...html.matchAll(rowPattern)];
  const rows: CodexPricingRow[] = [];

  for (const [index, match] of matches.entries()) {
    const label = match[1];
    if (!label) continue;
    const modelMatch = /^(gpt-\d+(?:\.\d+)?(?:-[a-z0-9]+)*)(?:\s|$)/i.exec(label);
    const modelId = modelMatch?.[1]?.toLowerCase();
    if (!modelId) continue;

    const rowStart = match.index + match[0].length;
    const rowEnd = matches[index + 1]?.index ?? html.length;
    const rowHtml = html.slice(rowStart, rowEnd);
    const prices = [...rowHtml.matchAll(/\[0,(-?\d+(?:\.\d+)?)\]/g)].flatMap((priceMatch) => {
      const raw = priceMatch[1];
      if (!raw) return [];
      const price = Number(raw);
      return Number.isFinite(price) ? [price] : [];
    });
    rows.push({ modelId, prices });
  }

  return rows;
}

function standardPricingPane(html: string): string {
  const paneMarker = '<div data-content-switcher-pane="true" data-value="standard">';
  const start = html.indexOf(paneMarker);
  if (start === -1) return '';
  const next = html.indexOf('<div data-content-switcher-pane="true"', start + paneMarker.length);
  return html.slice(start, next === -1 ? html.length : next);
}

export function discoverCodexModelsOnPage(html: string): string[] {
  const isCurrentVersion = (modelId: string, minimumGpt5Minor: number): boolean => {
    const match = /^gpt-(\d+)(?:\.(\d+))?/.exec(modelId);
    if (!match?.[1]) return false;
    const major = Number(match[1]);
    if (major > 5) return true;
    return major === 5 && match[2] !== undefined && Number(match[2]) >= minimumGpt5Minor;
  };
  const currentStandardRows = codexPricingRows(standardPricingPane(html)).filter((row) =>
    isCurrentVersion(row.modelId, 4),
  );
  const codexSpecificRows = codexPricingRows(html).filter(
    (row) => /-codex(?:-|$)/.test(row.modelId) && isCurrentVersion(row.modelId, 3),
  );
  return [
    ...new Set(
      [...currentStandardRows, ...codexSpecificRows]
        .filter((row) => row.prices.length >= 2)
        .map((row) => row.modelId),
    ),
  ].sort((a, b) => a.localeCompare(b));
}

function checkCodex(): Promise<CheckResult> {
  return checkProvider({
    label: 'Codex',
    url: CODEX_PRICING_URL,
    table: CODEX_PRICING_CURRENT,
    knownIds: Object.keys(CODEX_PRICING_BY_ID),
    sourceFile: 'src/pricing/codex.ts',
    lookup: (html) => {
      const rows = codexPricingRows(html);
      return (modelId) => ({
        prices: rows.find((row) => row.modelId === modelId)?.prices ?? [],
        where: modelId,
      });
    },
    discover: discoverCodexModelsOnPage,
  });
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
    console.log(
      `${String(totalMissing)} model(s) on docs page missing from src/pricing/*.ts — add them and re-run`,
    );
  }
  if (totalDrift > 0) {
    console.log(`${String(totalDrift)} model(s) drift from current docs — update src/pricing/*.ts`);
  } else if (totalMissing === 0 && totalUnverified > 0) {
    console.log(`No drift, but ${String(totalUnverified)} model(s) couldn't be found on the page.`);
  } else if (totalMissing === 0 && totalDrift === 0) {
    console.log('All pricing matches docs.');
  }

  return totalDrift > 0 || totalMissing > 0 ? 1 : 0;
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}

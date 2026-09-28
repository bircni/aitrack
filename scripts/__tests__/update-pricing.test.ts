import { describe, expect, it } from 'vitest';

import {
  claudeHeading,
  claudePricingLookup,
  discoverClaudeModelsOnPage,
  discoverCodexModelsOnPage,
  compareProviderPricing,
  tallyFindings,
} from '../update-pricing.js';

describe('pricing checker discovery', () => {
  it('converts every tracked Claude family slug to its docs heading', () => {
    expect(claudeHeading('claude-fable-5')).toBe('Claude Fable 5');
    expect(claudeHeading('claude-mythos-5')).toBe('Claude Mythos 5');
  });

  it('discovers priced Fable and Mythos models from Claude docs text', () => {
    const html =
      '<table><tr><td>Claude Fable 5</td><td>$10</td><td>$50</td></tr><tr><td>Claude Mythos 5</td><td>$10</td><td>$50</td></tr></table>';
    expect(discoverClaudeModelsOnPage(html)).toEqual(['claude-fable-5', 'claude-mythos-5']);
  });

  it('reads output prices beyond the old 800-character window', () => {
    const html = `<table><tr><td><span>Claude Mythos 5.1</span><button aria-label="Claude Mythos 5.1 (Invite only)" class="${'status '.repeat(150)}">Invite only</button></td><td>$10<!-- --> <span>/ MTok</span></td><td>$50<!-- --> <span>/ MTok</span></td><td>$12.50</td></tr></table>`;
    expect(claudePricingLookup(html)('claude-mythos-5-1').prices).toEqual([10, 50]);
    expect(discoverClaudeModelsOnPage(html)).toEqual(['claude-mythos-5-1']);
  });

  it('does not borrow prices from another row or a longer model version', () => {
    const html =
      '<table><tr><td>Claude Opus 4</td><td>$15</td><td>-</td></tr><tr><td>Claude Opus 4.1</td><td>$15</td><td>$75</td></tr></table>';
    expect(claudePricingLookup(html)('claude-opus-4').prices).toEqual([15]);
    expect(discoverClaudeModelsOnPage(html)).toEqual(['claude-opus-4-1']);
  });

  it('ignores navigation, prose, and cache prices when comparing base rates', () => {
    const html =
      '<nav>Claude Fable 5 $10 $50</nav><table><tr><td>Claude Fable 5</td><td>$10</td><td>$60</td><td>$50</td></tr></table><p>Claude Mythos 5 costs $10/$50</p>';
    const [finding] = compareProviderPricing(
      {
        label: 'Claude',
        url: 'https://example.test/pricing',
        table: { 'claude-fable-5': { inputPerMillion: 10, outputPerMillion: 50 } },
        knownIds: ['claude-fable-5'],
        sourceFile: 'claude.json',
        lookup: claudePricingLookup,
        discover: discoverClaudeModelsOnPage,
      },
      html,
    );
    expect(finding).toMatchObject({ kind: 'drift', isInOk: true, isOutOk: false });
    expect(discoverClaudeModelsOnPage(html)).toEqual(['claude-fable-5']);
  });

  it('discovers priced Codex model ids that are not already in the local table', () => {
    const html = [
      '<div data-content-switcher-pane="true" data-value="standard">',
      '[1,[[0,&quot;gpt-5.6-sol&quot;],[0,5],[0,0.5],[0,6.25],[0,30]]],',
      '[1,[[0,&quot;gpt-5.5-pro (&lt;272K context length)&quot;],[0,30],[0,&quot;-&quot;],[0,180]]],',
      '</div><div data-content-switcher-pane="true" data-value="batch">',
      '[1,[[0,&quot;gpt-5.7-batch&quot;],[0,1],[0,2]]]',
      '</div>',
      '[1,[[0,&quot;gpt-5-chat-latest&quot;],[0,1.25],[0,10]]]',
      '[1,[[0,&quot;gpt-6.0-codex&quot;],[0,7],[0,42]]]',
    ].join('');
    expect(discoverCodexModelsOnPage(html)).toEqual([
      'gpt-5.5-pro',
      'gpt-5.6-sol',
      'gpt-6.0-codex',
    ]);
  });

  it('does not borrow prices from the next Codex table row', () => {
    const html = [
      '<div data-content-switcher-pane="true" data-value="standard">',
      '[1,[[0,&quot;gpt-5.6-unpriced&quot;],[0,&quot;-&quot;],[0,&quot;-&quot;]]],',
      '[1,[[0,&quot;gpt-5.6-priced&quot;],[0,2],[0,12]]]',
      '</div>',
    ].join('');
    expect(discoverCodexModelsOnPage(html)).toEqual(['gpt-5.6-priced']);
  });
});

describe('compareProviderPricing', () => {
  const check = {
    label: 'Test',
    url: 'https://example.test/pricing',
    table: {
      'model-ok': { inputPerMillion: 3, outputPerMillion: 15 },
      'model-drift': { inputPerMillion: 1, outputPerMillion: 2 },
      'model-absent': { inputPerMillion: 9, outputPerMillion: 9 },
    },
    knownIds: ['model-ok', 'model-drift', 'model-absent'],
    sourceFile: 'src/pricing/test.ts',
    lookup: () => (modelId: string) => {
      if (modelId === 'model-ok') return { prices: [3, 15], where: 'Test' };
      if (modelId === 'model-drift') return { prices: [4, 20, 99], where: 'Test' };
      return { prices: [], where: 'Model Absent' };
    },
    discover: () => ['model-ok', 'brand-new-model'],
  };

  it('classifies matching, drifted, and unfindable models', () => {
    const findings = compareProviderPricing(check, '<html></html>');
    const byId = new Map(findings.map((f) => [f.modelId, f]));

    expect(byId.get('model-ok')?.kind).toBe('ok');
    expect(byId.get('model-drift')?.kind).toBe('drift');
    // Not on the page at all is different from wrong on the page: one needs a
    // scraper fix, the other needs a price update.
    expect(byId.get('model-absent')?.kind).toBe('unverified');
  });

  it('reports which side drifted and what it saw', () => {
    const drift = compareProviderPricing(check, '').find((f) => f.kind === 'drift');
    expect(drift).toMatchObject({ isInOk: false, isOutOk: false, saw: [4, 20, 99] });
  });

  it('flags a model on the page that the pricing table does not know', () => {
    const findings = compareProviderPricing(check, '');
    expect(findings.filter((f) => f.kind === 'missing').map((f) => f.modelId)).toEqual([
      'brand-new-model',
    ]);
  });

  it('counts each category for the exit status', () => {
    // main() exits non-zero on drift or missing, but not on unverified alone.
    expect(tallyFindings(compareProviderPricing(check, ''))).toEqual({
      drift: 1,
      unverified: 1,
      missing: 1,
    });
  });

  it('treats a half-correct price as drift', () => {
    const halfRight = {
      ...check,
      table: { 'model-half': { inputPerMillion: 3, outputPerMillion: 999 } },
      knownIds: ['model-half'],
      lookup: () => () => ({ prices: [3, 15], where: 'Test' }),
      discover: () => [],
    };
    const [finding] = compareProviderPricing(halfRight, '');
    expect(finding).toMatchObject({ kind: 'drift', isInOk: true, isOutOk: false });
  });
});

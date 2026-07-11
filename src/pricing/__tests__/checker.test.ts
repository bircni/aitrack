import { describe, expect, it } from 'vitest';

import {
  claudeHeading,
  discoverClaudeModelsOnPage,
  discoverCodexModelsOnPage,
} from '../../../scripts/update-pricing.js';

describe('pricing checker discovery', () => {
  it('converts every tracked Claude family slug to its docs heading', () => {
    expect(claudeHeading('claude-fable-5')).toBe('Claude Fable 5');
    expect(claudeHeading('claude-mythos-5')).toBe('Claude Mythos 5');
  });

  it('discovers priced Fable and Mythos models from Claude docs text', () => {
    const html = 'Claude Fable 5 <span>$10</span> Claude Mythos 5 <span>$50</span>';
    expect(discoverClaudeModelsOnPage(html)).toEqual(['claude-fable-5', 'claude-mythos-5']);
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

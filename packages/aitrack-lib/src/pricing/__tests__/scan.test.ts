import { describe, expect, it, vi } from 'vitest';

import { createFallbackCollector } from '../fallback.js';
import { recordPricingFallbacks, warnAboutPricingFallbacks } from '../scan.js';

describe('recordPricingFallbacks', () => {
  it('records a family fallback and skips an id that matches no family', () => {
    const fallbacks = createFallbackCollector();
    recordPricingFallbacks(
      {
        claude_code: new Map([
          [
            '2026-01-01',
            {
              inputTokens: 1,
              outputTokens: 1,
              byModel: {
                'claude-opus-9-9': { inputTokens: 1, outputTokens: 1 },
                unknown: { inputTokens: 1, outputTokens: 1 },
              },
            },
          ],
        ]),
        codex: new Map([
          [
            '2026-01-01',
            {
              inputTokens: 1,
              outputTokens: 1,
              byModel: { 'gpt-6-new': { inputTokens: 1, outputTokens: 1 } },
            },
          ],
        ]),
      },
      fallbacks,
    );

    expect(fallbacks.drain()).toEqual(['claude-opus-9-9', 'gpt-6-new']);
  });

  it('warns through the shared reporter', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    warnAboutPricingFallbacks({
      claude_code: new Map([
        [
          '2026-01-01',
          {
            inputTokens: 1,
            outputTokens: 1,
            byModel: { 'claude-haiku-9': { inputTokens: 1, outputTokens: 1 } },
          },
        ],
      ]),
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('claude-haiku-9'));
    warn.mockRestore();
  });
});

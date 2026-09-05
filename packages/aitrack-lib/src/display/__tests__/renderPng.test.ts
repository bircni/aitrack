import { makeDay } from '@aitrack/test-fixtures';
import { describe, expect, it } from 'vitest';

import type { DayEntry } from '../../data/types.js';
import { renderToPng } from '../renderPng.js';

// PNG width/height live in bytes 16-19 / 20-23 of the IHDR chunk.
function pngWidth(buffer: Buffer): number {
  return buffer.readUInt32BE(16);
}

function pngSize(buffer: Buffer): { width: number; height: number } {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

describe('renderToPng', () => {
  it('returns a valid PNG buffer', () => {
    const dayMap = new Map([['2024-01-15', makeDay(1000, 500)]]);
    const buffer = renderToPng({ claude_code: dayMap }, {});
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer[0]).toBe(0x89);
    expect(buffer[1]).toBe(0x50);
    expect(buffer[2]).toBe(0x4e);
    expect(buffer[3]).toBe(0x47);
  });

  it('keeps the canvas at its established size for a fixed year (layout regression guard)', () => {
    const oneProvider = new Map([['2025-06-01', makeDay(1000, 500)]]);
    const twoProviders = new Map([['2025-06-02', makeDay(200, 100)]]);

    const single = pngSize(renderToPng({ claude_code: oneProvider }, { year: 2025 }));
    const paired = pngSize(
      renderToPng({ claude_code: oneProvider, codex: twoProviders }, { year: 2025 }),
    );
    const merged = pngSize(
      renderToPng({ claude_code: oneProvider, codex: twoProviders }, { year: 2025, all: true }),
    );

    // Golden dimensions: a change here means the heatmap layout shifted.
    expect(single).toEqual({ width: 927, height: 404 });
    // Each extra provider adds exactly one section band...
    expect(paired).toEqual({ width: 927, height: 760 });
    expect(paired.height - single.height).toBe(356);
    // ...and `all` collapses back to a single band.
    expect(merged).toEqual(single);
  });

  it('widens the canvas for a 54-week year instead of clipping it', () => {
    const dayMap = new Map([['2028-12-31', makeDay(1000, 500)]]);

    const ordinary = pngWidth(renderToPng({ claude_code: dayMap }, { year: 2027 }));
    const fiftyFour = pngWidth(renderToPng({ claude_code: dayMap }, { year: 2028 }));

    expect(fiftyFour).toBe(ordinary + 15);
  });

  it('works in dark mode', () => {
    const dayMap = new Map([['2024-01-15', makeDay(500, 250)]]);
    const buffer = renderToPng({ claude_code: dayMap }, { dark: true });
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);
  });

  it('defaults to one section per provider for multiple providers', () => {
    const claudeMap = new Map([['2024-01-15', makeDay(100, 50)]]);
    const codexMap = new Map([['2024-01-16', makeDay(200, 100)]]);
    const buffer = renderToPng({ claude_code: claudeMap, codex: codexMap }, {});
    expect(buffer).toBeInstanceOf(Buffer);
  });

  it('handles empty provider data without crashing', () => {
    expect(() => renderToPng({}, {})).not.toThrow();
  });

  it('merges into one section when all is true', () => {
    const claudeMap = new Map([['2024-01-15', makeDay(100, 50)]]);
    const codexMap = new Map([['2024-01-16', makeDay(200, 100)]]);
    const buffer = renderToPng({ claude_code: claudeMap, codex: codexMap }, { all: true });
    expect(buffer[0]).toBe(0x89);
    expect(buffer[1]).toBe(0x50);
  });

  it('renders with a year filter', () => {
    const dayMap = new Map([
      ['2024-06-01', makeDay(100, 50)],
      ['2025-06-01', makeDay(200, 100)],
    ]);
    const buffer = renderToPng({ claude_code: dayMap }, { year: 2024 });
    expect(buffer[0]).toBe(0x89);
  });

  it('renders long model names without crashing (token amount moves to its own line)', () => {
    const day: DayEntry = {
      inputTokens: 5_000_000,
      outputTokens: 40_000,
      byModel: {
        'composer-2.5-fast-extra-long-name': { inputTokens: 5_000_000, outputTokens: 40_000 },
      },
    };
    const buffer = renderToPng({ cursor: new Map([['2024-03-15', day]]) }, {});
    expect(buffer[0]).toBe(0x89);
  });
});

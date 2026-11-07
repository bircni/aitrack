import { makeDay } from '@aitrack/test-fixtures';
import { createCanvas } from '@napi-rs/canvas';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderToPng } from '../renderPng.js';

// PNG width/height live in bytes 16-19 / 20-23 of the IHDR chunk.
function pngWidth(buffer: Buffer): number {
  return buffer.readUInt32BE(16);
}

function pngSize(buffer: Buffer): { width: number; height: number } {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

describe('renderToPng', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns a valid PNG that follows the dark option', () => {
    const dayMap = new Map([['2024-01-15', makeDay(1000, 500)]]);
    const light = renderToPng({ claude_code: dayMap }, {});
    const dark = renderToPng({ claude_code: dayMap }, { dark: true });
    expect(light.subarray(0, 4).toString('latin1')).toBe('\u0089PNG');
    expect(dark.subarray(0, 4).toString('latin1')).toBe('\u0089PNG');
    expect(dark.equals(light)).toBe(false);
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
    vi.useFakeTimers({ now: new Date(2026, 8, 20, 12) }); // A year in progress stops at today.
    const dayMap = new Map([['2028-12-31', makeDay(1000, 500)]]);

    const ordinary = pngWidth(renderToPng({ claude_code: dayMap }, { year: 2027 }));
    const fiftyFour = pngWidth(renderToPng({ claude_code: dayMap }, { year: 2028 }));

    expect(fiftyFour).toBe(ordinary + 15);
  });

  it('handles empty provider data without crashing', () => {
    expect(() => renderToPng({}, {})).not.toThrow();
  });

  it('shortens a long model name to its stat column instead of overlapping the next', () => {
    const context = createCanvas(1, 1).getContext('2d');
    const fillText = vi.spyOn(Object.getPrototypeOf(context) as typeof context, 'fillText');
    const measure = context.measureText.bind(context);
    context.font = 'bold 13px Arial';
    const columnWidth = (53 * 15) / 6;
    const longName = 'some-very-long-model-name-from-a-cursor-export-20261231';
    expect(measure(longName).width).toBeGreaterThan(columnWidth);

    renderToPng({
      cursor: new Map([['2024-03-15', makeDay(5_000_000, 40_000, undefined, longName)]]),
    });

    const shortened = fillText.mock.calls.map(([text]) => text).find((text) => text.endsWith('…'));
    expect(shortened?.startsWith('some-very')).toBe(true);
    expect(measure(shortened ?? '').width).toBeLessThanOrEqual(columnWidth);
  });
});

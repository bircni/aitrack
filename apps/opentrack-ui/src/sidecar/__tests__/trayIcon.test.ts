import { describe, expect, it } from 'vitest';

import { renderTrayIcon, summarizeTray } from '../trayIcon.js';
import { NOW, provider, sessionWindow } from './quotaFixtures.js';

describe('tray icon', () => {
  const AUTO = { trayProvider: 'auto', trayWindow: 'highest' } as const;

  it('takes the most urgent tone and the highest usage', () => {
    const summary = summarizeTray(
      [
        provider([sessionWindow(20, 2.5)]),
        provider([sessionWindow(48, 2.5)]),
        { ...provider([]), quota: undefined },
      ],
      NOW,
      AUTO,
    );
    expect(summary).toEqual({
      tone: 'warn',
      usedPercent: 48,
      tooltip: 'opentrack\nClaude Code: 20% session\nClaude Code: 48% session',
      bars: [
        { tone: 'calm', usedPercent: 20 },
        { tone: 'warn', usedPercent: 48 },
      ],
    });
    expect(summarizeTray([], NOW, AUTO).tone).toBe('neutral');
    // No reset time means no pace, so fullness alone decides, as on the meter.
    const unpaced = { ...sessionWindow(95, 2.5), resetsAt: undefined };
    expect(summarizeTray([provider([unpaced])], NOW, AUTO).tone).toBe('crit');
  });

  it('follows the chosen provider and window', () => {
    const weekly = { ...sessionWindow(10, 2.5), id: 'weekly', label: 'Weekly' };
    const codex = { ...provider([sessionWindow(90, 2.5), weekly]), key: 'codex' as const };
    const providers = [provider([sessionWindow(60, 2.5)]), codex];
    expect(
      summarizeTray(providers, NOW, { trayProvider: 'codex', trayWindow: 'weekly' }),
    ).toMatchObject({
      usedPercent: 10,
      tone: 'calm',
      bars: [
        { usedPercent: 90, tone: 'crit' },
        { usedPercent: 10, tone: 'calm' },
      ],
    });
    // Claude has no weekly window, so it falls back to its most used one.
    expect(
      summarizeTray(providers, NOW, { trayProvider: 'claude_code', trayWindow: 'weekly' }),
    ).toMatchObject({ usedPercent: 60 });
    expect(
      summarizeTray([codex], NOW, { trayProvider: 'claude_code', trayWindow: 'session' }),
    ).toMatchObject({ usedPercent: 90 });
  });

  it('includes monetary limits in tray usage, tone and bars', () => {
    const money = {
      ...sessionWindow(95, 2.5),
      id: 'onDemand',
      label: 'On-demand',
      format: 'dollars' as const,
      usedValue: 95,
      limitValue: 100,
    };
    const cursor = { ...provider([money]), key: 'cursor' as const, label: 'Cursor' };
    expect(summarizeTray([cursor], NOW, { ...AUTO, trayStyle: 'bars' })).toEqual({
      tone: 'crit',
      usedPercent: 95,
      bars: [{ tone: 'crit', usedPercent: 95 }],
      tooltip: 'opentrack\nCursor On-demand: 95%',
    });
  });

  it('draws the outline ring, the used wedge solid and the rest faint', () => {
    const size = 32;
    const pixels = renderTrayIcon(size, 25, 'crit');
    expect(pixels).toHaveLength(size * size * 4);
    const alphaAt = (x: number, y: number) => pixels[(y * size + x) * 4 + 3];
    expect(alphaAt(0, 0)).toBe(0); // Corner, outside the O
    expect(alphaAt(16, 1)).toBe(255); // Outline ring
    expect(alphaAt(16, 5)).toBe(0); // Gap between ring and pie
    expect(alphaAt(19, 10)).toBe(255); // Just clockwise of 12 o'clock: used
    expect(alphaAt(16, 16)).toBe(71); // Past the wedge: left, faint
  });

  it('shows session and weekly bars for each provider instead of only its chosen limit', () => {
    const weekly = { ...sessionWindow(40, 2.5), id: 'weekly', label: 'Weekly' };
    const providers = [
      provider([sessionWindow(20, 2.5), weekly]),
      {
        ...provider([sessionWindow(60, 2.5), { ...weekly, usedPercent: 80 }]),
        key: 'codex' as const,
        label: 'Codex',
      },
    ];
    const summary = summarizeTray(providers, NOW, {
      trayProvider: 'auto',
      trayWindow: 'session',
      trayStyle: 'bars',
    });
    expect(summary.bars.map(({ usedPercent }) => usedPercent)).toEqual([20, 40, 60, 80]);
    expect(summary.tooltip).toBe(
      'opentrack\nClaude Code Session: 20%\nClaude Code Weekly: 40%\nCodex Session: 60%\nCodex Weekly: 80%',
    );
    const selected = summarizeTray(providers, NOW, {
      trayProvider: 'codex',
      trayWindow: 'weekly',
      trayStyle: 'bars',
    });
    expect(selected.bars.map(({ usedPercent }) => usedPercent)).toEqual([60, 80]);
    expect(selected.tooltip).toBe('opentrack\nCodex Session: 60%\nCodex Weekly: 80%');
  });

  it('fits four or more limit bars inside the tray without clipping', () => {
    for (const count of [4, 6]) {
      const pixels = renderTrayIcon(32, 100, 'calm', {
        style: 'bars',
        colored: false,
        bars: Array.from({ length: count }, () => ({ usedPercent: 100, tone: 'calm' as const })),
      });
      const filledRows = Array.from(
        { length: 32 },
        (_, y) => (pixels[(y * 32 + 16) * 4 + 3] ?? 0) > 150,
      );
      const starts = filledRows.filter((filled, y) => filled && !filledRows[y - 1]);
      expect(starts).toHaveLength(count);
      expect(filledRows[0]).toBe(false);
      expect(filledRows[31]).toBe(false);
    }
  });

  it('draws separate rounded progress bars with gaps and individual tones', () => {
    const size = 32;
    const pixels = renderTrayIcon(size, 100, 'crit', {
      style: 'bars',
      colored: true,
      bars: [
        { usedPercent: 25, tone: 'calm' },
        { usedPercent: 60, tone: 'warn' },
        { usedPercent: 100, tone: 'crit' },
      ],
    });
    const at = (x: number, y: number) => [
      ...pixels.subarray((y * size + x) * 4, (y * size + x) * 4 + 4),
    ];
    expect(at(6, 7)).toEqual([52, 168, 83, 255]);
    expect(at(20, 7)).toEqual([52, 168, 83, 71]);
    expect(at(16, 11)[3]).toBe(0);
    expect(at(10, 15)).toEqual([242, 153, 0, 255]);
    expect(at(25, 23)).toEqual([217, 48, 37, 255]);
    expect(at(0, 0)[3]).toBe(0);
  });

  it('keeps progress but removes tone colors for both monochrome styles', () => {
    for (const style of ['icon', 'bars'] as const) {
      const options = { style, colored: false, bars: [{ usedPercent: 50, tone: 'crit' as const }] };
      const pixels = renderTrayIcon(32, 50, 'crit', options);
      expect(pixels).toEqual(
        renderTrayIcon(32, 50, 'calm', {
          ...options,
          bars: [{ usedPercent: 50, tone: 'calm' }],
        }),
      );
      for (let offset = 0; offset < pixels.length; offset += 4) {
        expect(pixels[offset]).toBe(pixels[offset + 1]);
        expect(pixels[offset]).toBe(pixels[offset + 2]);
      }
      expect(pixels.includes(255)).toBe(true);
      expect(pixels.includes(71)).toBe(true);
    }
  });
});

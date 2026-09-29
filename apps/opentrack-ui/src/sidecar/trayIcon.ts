import { clampPercent, projectPace } from 'aitrack-lib/quota/pacing';

import { meterTone, type Tone } from '../shared/pace.js';
import type { ProviderState, QuotaWindow, Settings, TrayWindow } from '../shared/types.js';

/** The popup's meter tones, so the icon never looks calmer than the window it stands for. */
export type TrayTone = 'neutral' | Tone;

/** Least to most urgent. */
const TONES: readonly TrayTone[] = ['neutral', 'calm', 'warn', 'crit'];

const TONE_RGB: Record<TrayTone, readonly [number, number, number]> = {
  neutral: [140, 140, 150],
  calm: [52, 168, 83],
  warn: [242, 153, 0],
  crit: [217, 48, 37],
};

export interface TraySummary {
  tone: TrayTone;
  /** Highest percent used across the enabled providers' windows, 0–100. */
  usedPercent: number;
  tooltip: string;
}

/** The chosen window, falling back to the most used one when the provider has no such window. */
function pickWindow(windows: QuotaWindow[], choice: TrayWindow): QuotaWindow {
  const preferred = choice === 'highest' ? undefined : windows.find(({ id }) => id === choice);
  return preferred ?? windows.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));
}

/**
 * One picture for the tray icon: the chosen provider (or the most used one)
 * and window. With `highest`, the tone is the most urgent pace of any window
 * shown, so a weekly limit running out still colours a session-heavy icon.
 */
export function summarizeTray(
  providers: ProviderState[],
  now: number,
  choice: Pick<Settings, 'trayProvider' | 'trayWindow'>,
): TraySummary {
  let tone: TrayTone = 'neutral';
  let usedPercent = 0;
  const lines = ['opentrack'];
  // A provider that was turned off is not in `providers`; follow the most used one instead.
  const follow = providers.some(({ key }) => key === choice.trayProvider)
    ? choice.trayProvider
    : 'auto';
  for (const provider of providers) {
    const windows = provider.quota?.windows.filter((window) => window.format === 'percent') ?? [];
    if (windows.length === 0) continue;
    const shown = pickWindow(windows, choice.trayWindow);
    lines.push(
      `${provider.label}: ${String(Math.round(shown.usedPercent))}% ${shown.label.toLowerCase()}`,
    );
    if (follow !== 'auto' && follow !== provider.key) continue;
    usedPercent = Math.max(usedPercent, shown.usedPercent);
    for (const window of choice.trayWindow === 'highest' ? windows : [shown]) {
      const next = meterTone(window, projectPace(window, now));
      if (TONES.indexOf(next) > TONES.indexOf(tone)) tone = next;
    }
  }
  return { tone, usedPercent: clampPercent(usedPercent), tooltip: lines.join('\n') };
}

const SUBSAMPLES = 4; // Per axis: smooth wedge edges once Windows scales the icon down.
const EMPTY_ALPHA = 0.28;

interface IconShape {
  outer: number;
  ringInner: number;
  pie: number;
  sweep: number;
}

/** Opacity of one point `dx, dy` from the centre. */
function shapeAlpha(dx: number, dy: number, shape: IconShape): number {
  const distance = Math.hypot(dx, dy);
  if (distance > shape.outer) return 0;
  if (distance >= shape.ringInner) return 1;
  if (distance > shape.pie) return 0;
  const angle = (Math.atan2(dx, -dy) + 2 * Math.PI) % (2 * Math.PI);
  return angle < shape.sweep ? 1 : EMPTY_ALPHA;
}

/**
 * The opentrack "O" filled like a pie, as straight RGBA (the layout Tauri's
 * tray image takes): a solid outline ring, and inside it a wedge from 12
 * o'clock covering `usedPercent`, over a faint disc for what is left. All in
 * the tone, so it reads on light and dark taskbars alike.
 */
export function renderTrayIcon(size: number, usedPercent: number, tone: TrayTone): Buffer {
  const pixels = Buffer.alloc(size * size * 4);
  const [red, green, blue] = TONE_RGB[tone];
  const centre = size / 2;
  const outer = size / 2;
  const ring = Math.max(1.5, size * 0.11);
  const shape: IconShape = {
    outer,
    ringInner: outer - ring,
    pie: outer - ring - Math.max(1, size * 0.08),
    sweep: (clampPercent(usedPercent) / 100) * 2 * Math.PI,
  };
  const step = 1 / SUBSAMPLES;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let alpha = 0;
      for (let sy = step / 2; sy < 1; sy += step) {
        for (let sx = step / 2; sx < 1; sx += step) {
          alpha += shapeAlpha(x + sx - centre, y + sy - centre, shape);
        }
      }
      const offset = (y * size + x) * 4;
      pixels[offset] = red;
      pixels[offset + 1] = green;
      pixels[offset + 2] = blue;
      pixels[offset + 3] = Math.round((alpha / (SUBSAMPLES * SUBSAMPLES)) * 255);
    }
  }
  return pixels;
}

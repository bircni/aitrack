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

interface TrayBar {
  tone: TrayTone;
  usedPercent: number;
}

export interface TraySummary {
  tone: TrayTone;
  /** Percent used of the shown window, the highest over the followed providers, 0–100. */
  usedPercent: number;
  tooltip: string;
  bars: TrayBar[];
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
  choice: Pick<Settings, 'trayProvider' | 'trayWindow'> & Partial<Pick<Settings, 'trayStyle'>>,
): TraySummary {
  let tone: TrayTone = 'neutral';
  let usedPercent = 0;
  const lines = ['opentrack'];
  const barLines = ['opentrack'];
  const bars: TrayBar[] = [];
  // A provider that was turned off is not in `providers`; follow the most used one instead.
  const follow = providers.some(({ key }) => key === choice.trayProvider)
    ? choice.trayProvider
    : 'auto';
  for (const provider of providers) {
    const followed = follow === 'auto' || follow === provider.key;
    const windows = provider.quota?.windows ?? [];
    if (windows.length === 0) continue;
    const shown = pickWindow(windows, choice.trayWindow);
    lines.push(
      `${provider.label}: ${String(Math.round(shown.usedPercent))}% ${shown.label.toLowerCase()}`,
    );
    if (!followed) continue;
    usedPercent = Math.max(usedPercent, shown.usedPercent);
    for (const window of windows) {
      const windowTone = meterTone(window, projectPace(window, now));
      bars.push({ tone: windowTone, usedPercent: clampPercent(window.usedPercent) });
      barLines.push(
        `${provider.label} ${window.label}: ${String(Math.round(window.usedPercent))}%`,
      );
      if (
        (choice.trayWindow === 'highest' || window === shown) &&
        TONES.indexOf(windowTone) > TONES.indexOf(tone)
      ) {
        tone = windowTone;
      }
    }
  }
  return {
    tone,
    usedPercent: clampPercent(usedPercent),
    tooltip: (choice.trayStyle === 'bars' ? barLines : lines).join('\n'),
    bars,
  };
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

function barAlpha(x: number, y: number, size: number, height: number, bar?: TrayBar): number {
  if (!bar) return 0;
  const radius = height / 2;
  const left = size * 0.06;
  const right = size * 0.94;
  const nearestX = Math.max(left + radius, Math.min(right - radius, x));
  if (Math.hypot(x - nearestX, y - radius) > radius) return 0;
  return x < left + (clampPercent(bar.usedPercent) / 100) * (right - left) ? 1 : EMPTY_ALPHA;
}

interface TrayAppearance {
  style: Settings['trayStyle'];
  colored: boolean;
  bars: TrayBar[];
}

const DEFAULT_APPEARANCE: TrayAppearance = { style: 'icon', colored: true, bars: [] };

/** The "O" filled like a pie, or one bar per limit, as straight RGBA for Tauri's tray image. */
export function renderTrayIcon(
  size: number,
  usedPercent: number,
  tone: TrayTone,
  appearance: TrayAppearance = DEFAULT_APPEARANCE,
): Buffer {
  const pixels = Buffer.alloc(size * size * 4);
  const bars =
    appearance.bars.length > 0 ? appearance.bars : [{ usedPercent: 0, tone: 'neutral' as const }];
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
  const barGap = Math.min(size * 0.07, (size * 0.2) / Math.max(1, bars.length - 1));
  const barHeight = Math.min(size * 0.18, (size * 0.88 - (bars.length - 1) * barGap) / bars.length);
  const barsTop = (size - (bars.length * barHeight + (bars.length - 1) * barGap)) / 2;
  for (let y = 0; y < size; y += 1) {
    const barIndex = Math.floor((y + 0.5 - barsTop) / (barHeight + barGap));
    const bar = bars[barIndex];
    const rgb = appearance.colored
      ? TONE_RGB[appearance.style === 'bars' ? (bar?.tone ?? 'neutral') : tone]
      : ([150, 150, 150] as const);
    for (let x = 0; x < size; x += 1) {
      let alpha = 0;
      for (let sy = step / 2; sy < 1; sy += step) {
        for (let sx = step / 2; sx < 1; sx += step) {
          alpha +=
            appearance.style === 'bars'
              ? barAlpha(
                  x + sx,
                  y + sy - barsTop - barIndex * (barHeight + barGap),
                  size,
                  barHeight,
                  bar,
                )
              : shapeAlpha(x + sx - centre, y + sy - centre, shape);
        }
      }
      const offset = (y * size + x) * 4;
      pixels[offset] = rgb[0];
      pixels[offset + 1] = rgb[1];
      pixels[offset + 2] = rgb[2];
      pixels[offset + 3] = Math.round((alpha / (SUBSAMPLES * SUBSAMPLES)) * 255);
    }
  }
  return pixels;
}

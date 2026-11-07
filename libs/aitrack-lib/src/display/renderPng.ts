import { createRequire } from 'node:module';

import type * as NapiCanvas from '@napi-rs/canvas';

import type { DayMap, ProviderData } from '../data/types.js';
import { tokenIntensityLevel } from './heatmap/intensity.js';
import { resolveProviderLayout } from './heatmap/layout.js';
import { buildDateGrid, monthLabels } from './heatmap/stats.js';
import { PALETTE, providerCells } from './heatmap/themes.js';
import { buildProviderSectionViewModel } from './heatmap/viewModel.js';
import type { RenderOptions } from './renderOptions.js';

const CELL = 12;
const GAP = 3;
const STEP = CELL + GAP;
const LEFT = 52;
// A year grid is normally 53 columns, but a leap year whose Jan 1 falls on a
// Saturday (2028, 2056, ...) needs 54. Keep 53 as the floor so the usual
// layout is unchanged and only those years widen.
const MIN_WEEKS = 53;
function gridWidth(weekCount: number): number {
  return Math.max(MIN_WEEKS, weekCount) * STEP;
}
function totalWidth(weekCount: number): number {
  return LEFT + gridWidth(weekCount) + 80;
}

const SEC_PAD_TOP = 32;
const HEADER_H = 52;
const DIVIDER_H = 1;
const MONTH_H = 28;
const GRID_H = 7 * STEP;
const LEGEND_H = 32;
const STATS_H = 78;
const SEC_PAD_BOT = 28;
const SECTION_H =
  SEC_PAD_TOP + HEADER_H + DIVIDER_H + MONTH_H + GRID_H + LEGEND_H + STATS_H + SEC_PAD_BOT;

const STAT_COLUMN_GAP = 8;

function fitText(context: NapiCanvas.SKRSContext2D, text: string, maxWidth: number): string {
  if (context.measureText(text).width <= maxWidth) return text;
  let fitted = text;
  while (fitted.length > 0 && context.measureText(`${fitted}…`).width > maxWidth) {
    fitted = fitted.slice(0, -1);
  }
  return `${fitted}…`;
}

function roundedRect(
  context: NapiCanvas.SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + w, y, x + w, y + h, r);
  context.arcTo(x + w, y + h, x, y + h, r);
  context.arcTo(x, y + h, x, y, r);
  context.arcTo(x, y, x + w, y, r);
  context.closePath();
}

function drawSection(
  context: NapiCanvas.SKRSContext2D,
  providerKey: string,
  dayMap: DayMap,
  weeks: Array<Array<string | null>>,
  baseY: number,
  mode: 'light' | 'dark',
): void {
  const C = PALETTE[mode];
  const vm = buildProviderSectionViewModel(providerKey, dayMap, new Set(weeks.flat()));
  const themeCells = providerCells(providerKey, mode);
  const gridW = gridWidth(weeks.length);

  let y = baseY + SEC_PAD_TOP;

  context.fillStyle = C.title;
  context.font = 'bold 22px Arial';
  context.fillText(vm.name, LEFT, y + 16);

  const colW = 112;
  const statsRight = LEFT + gridW;
  for (const [index, col] of vm.headerStats.entries()) {
    const cx = statsRight - (vm.headerStats.length - 1 - index) * colW;
    context.fillStyle = C.label;
    context.font = '9px Arial';
    context.textAlign = 'center';
    context.fillText(col.label, cx, y + 4);
    context.fillStyle = C.title;
    context.font = 'bold 16px Arial';
    context.fillText(col.value, cx, y + 22);
    context.textAlign = 'left';
  }

  y += HEADER_H;

  context.fillStyle = C.divider;
  context.fillRect(LEFT, y, gridW, DIVIDER_H);
  y += DIVIDER_H;

  context.fillStyle = C.muted;
  context.font = '11px Arial';
  for (const { column, label } of monthLabels(weeks)) {
    context.fillText(label, LEFT + column * STEP, y + 14);
  }
  y += MONTH_H;

  context.fillStyle = C.muted;
  context.font = '10px Arial';
  context.textAlign = 'right';
  context.fillText('Mon', LEFT - 6, y + STEP + CELL);
  context.fillText('Wed', LEFT - 6, y + 3 * STEP + CELL);
  context.fillText('Fri', LEFT - 6, y + 5 * STEP + CELL);
  context.textAlign = 'left';

  for (const [w, week] of weeks.entries()) {
    for (let d = 0; d < 7; d++) {
      const dateString = week[d] ?? null;
      const x = LEFT + w * STEP;
      const cellY = y + d * STEP;
      const rec = dateString ? dayMap.get(dateString) : null;
      const tokens = rec ? rec.inputTokens + rec.outputTokens : 0;
      const level = dateString ? tokenIntensityLevel(tokens, vm.maxTokens) : 0;
      context.fillStyle = themeCells[level];
      roundedRect(context, x, cellY, CELL, CELL, 2);
      context.fill();
    }
  }
  y += GRID_H;

  context.fillStyle = C.muted;
  context.font = '10px Arial';
  context.fillText('LESS', LEFT, y + CELL);
  const lx = LEFT + 38;
  for (let level = 0; level <= 4; level++) {
    context.fillStyle = themeCells[level] ?? themeCells[0];
    roundedRect(context, lx + level * (CELL + 3), y, CELL, CELL, 2);
    context.fill();
  }
  context.fillStyle = C.muted;
  context.fillText('MORE', lx + 5 * (CELL + 3) + 4, y + CELL);
  y += LEGEND_H;

  context.fillStyle = C.divider;
  context.fillRect(LEFT, y, gridW, 1);
  y += 14;

  const bColW = gridW / vm.bottomStats.length;
  for (const [index, stat] of vm.bottomStats.entries()) {
    const bx = LEFT + index * bColW;
    context.fillStyle = C.label;
    context.font = '9px Arial';
    context.fillText(stat.label, bx, y + 12);
    context.fillStyle = C.value;
    context.font = 'bold 13px Arial';
    context.fillText(fitText(context, stat.value, bColW - STAT_COLUMN_GAP), bx, y + 28);
    if (stat.sub !== undefined) {
      context.fillStyle = C.muted;
      context.font = '11px Arial';
      context.fillText(stat.sub, bx, y + 43);
    }
  }
}

export function renderToPng(
  providerData: ProviderData,
  { dark = false, all = false, year }: RenderOptions = {},
): Buffer {
  const mode: 'light' | 'dark' = dark ? 'dark' : 'light';
  const C = PALETTE[mode];
  const weeks = buildDateGrid(year);
  const { layoutData, keys } = resolveProviderLayout(providerData, { all, year });

  const CANVAS_PAD = 24;
  const totalH = CANVAS_PAD + keys.length * SECTION_H + CANVAS_PAD;

  const totalW = totalWidth(weeks.length);
  // Native and slow to load, and `show --tui` never draws; this API is sync, so not import().
  const { createCanvas } = createRequire(import.meta.url)('@napi-rs/canvas') as typeof NapiCanvas;
  const canvas = createCanvas(totalW, totalH);
  const context = canvas.getContext('2d');

  context.fillStyle = C.bg;
  context.fillRect(0, 0, totalW, totalH);

  for (const [index, key] of keys.entries()) {
    const dayMap = layoutData[key];
    if (dayMap !== undefined) {
      drawSection(context, key, dayMap, weeks, CANVAS_PAD + index * SECTION_H, mode);
    }
  }

  return canvas.toBuffer('image/png');
}

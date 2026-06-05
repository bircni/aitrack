import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';

import { getOrCreateDay } from './dayMap.js';
import type { DayMap, MachineFile, ProviderData, RenderOptions } from './types.js';

// ── Layout ────────────────────────────────────────────────────────────────

const CELL = 12;
const GAP = 3;
const STEP = CELL + GAP;
const WEEKS = 53;
const LEFT = 52;
const RIGHT = 80;
const GRID_W = WEEKS * STEP;
const TOTAL_W = LEFT + GRID_W + RIGHT;

const SEC_PAD_TOP = 32;
const HEADER_H = 52;
const DIVIDER_H = 1;
const MONTH_H = 28;
const GRID_H = 7 * STEP;
const LEGEND_H = 32;
const STATS_H = 64;
const SEC_PAD_BOT = 28;
const SECTION_H =
  SEC_PAD_TOP + HEADER_H + DIVIDER_H + MONTH_H + GRID_H + LEGEND_H + STATS_H + SEC_PAD_BOT;

export const PROVIDER_ORDER = ['claude_code', 'codex', 'cursor', 'gemini', 'opencode'];

export const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

// ── Themes ────────────────────────────────────────────────────────────────

interface ProviderTheme {
  name: string;
  cells: [string, string, string, string, string];
}
type ThemeSet = Record<string, ProviderTheme> & { _default: ProviderTheme };

const THEMES: Record<'light' | 'dark', ThemeSet> = {
  light: {
    claude_code: {
      name: 'Claude Code',
      cells: ['#ebedf0', '#fde8cf', '#fbba77', '#e87820', '#b04b10'],
    },
    codex: { name: 'Codex', cells: ['#ebedf0', '#cde4f8', '#7db9ea', '#2472c8', '#0b3d7a'] },
    cursor: { name: 'Cursor', cells: ['#ebedf0', '#fde8c8', '#f8a855', '#e56b10', '#8b2e00'] },
    gemini: { name: 'Gemini', cells: ['#ebedf0', '#d4f0c8', '#78c96f', '#28a745', '#155724'] },
    opencode: { name: 'Open Code', cells: ['#ebedf0', '#e8d8f8', '#b07cd8', '#7c3aed', '#4a1d96'] },
    all: { name: 'All providers', cells: ['#ebedf0', '#d4e8f4', '#8ab8d4', '#4a8ab8', '#1e4a6e'] },
    _default: { name: 'Unknown', cells: ['#ebedf0', '#c6e48b', '#7bc96f', '#239a3b', '#196127'] },
  },
  dark: {
    claude_code: {
      name: 'Claude Code',
      cells: ['#1e1e24', '#3d1a06', '#7c3610', '#c4621a', '#f08030'],
    },
    codex: { name: 'Codex', cells: ['#1e1e24', '#0c2240', '#0d4a8a', '#1a7fd4', '#4db8ff'] },
    cursor: { name: 'Cursor', cells: ['#1e1e24', '#3a1800', '#7a3200', '#c45a00', '#f08820'] },
    gemini: { name: 'Gemini', cells: ['#1e1e24', '#0d3320', '#1a6640', '#26a641', '#39d353'] },
    opencode: { name: 'Open Code', cells: ['#1e1e24', '#2a1050', '#5a2aa0', '#8b5cf6', '#c4b5fd'] },
    all: { name: 'All providers', cells: ['#1e1e24', '#0c2438', '#1a4a6e', '#2e7ab0', '#5cb8e8'] },
    _default: { name: 'Unknown', cells: ['#1e1e24', '#0e4429', '#006d32', '#26a641', '#39d353'] },
  },
};

interface Palette {
  bg: string;
  divider: string;
  title: string;
  label: string;
  value: string;
  muted: string;
}

const PALETTE: Record<'light' | 'dark', Palette> = {
  light: {
    bg: '#ffffff',
    divider: '#e0e0e0',
    title: '#1c1c1e',
    label: '#888888',
    value: '#1c1c1e',
    muted: '#999999',
  },
  dark: {
    bg: '#0d1117',
    divider: '#30363d',
    title: '#e6edf3',
    label: '#7d8590',
    value: '#e6edf3',
    muted: '#7d8590',
  },
};

// ── Helpers ────────────────────────────────────────────────────────────────

export function fmt(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

// "claude-haiku-4-5-20251001" -> "Haiku 4.5"; "gpt-5.1-codex" -> "GPT-5.1 Codex"
export function displayModelName(model: string): string {
  const cleaned = model.replace(/-\d{8}$/, '').replace(/^claude-/, '');
  for (const family of ['opus', 'sonnet', 'haiku']) {
    const re = new RegExp(String.raw`^${family}-(\d+)-(\d+)$`);
    const m = re.exec(cleaned);
    if (m?.[1] !== undefined && m[2] !== undefined) {
      return `${(family[0] ?? '').toUpperCase()}${family.slice(1)} ${m[1]}.${m[2]}`;
    }
  }
  const gpt = /^gpt-([\d.]+)(?:-(.+))?$/.exec(cleaned);
  if (gpt) {
    const suffix = gpt[2]
      ? ' ' + gpt[2].replaceAll('-', ' ').replaceAll(/\b\w/g, (c) => c.toUpperCase())
      : '';
    return `GPT-${gpt[1]}${suffix}`;
  }
  return cleaned;
}

export function fmtUSD(n: number): string {
  if (n > 0 && n < 0.01) return '<$0.01';
  return `$${n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function intensityLevel(tokens: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (!tokens || !max) return 0;
  const r = Math.min(tokens / max, 1);
  if (r < 0.1) return 1;
  if (r < 0.35) return 2;
  if (r < 0.65) return 3;
  return 4;
}

export function tokenIntensityLevel(tokens: number, max: number): 0 | 1 | 2 | 3 | 4 {
  return intensityLevel(tokens, max);
}

export function buildHeatmapWeeks(year?: number): Array<Array<string | null>> {
  return buildDateGrid(year);
}

export function getProviderTheme(
  providerKey: string,
  dark = false,
): { name: string; cells: [string, string, string, string, string] } {
  const providerThemes = THEMES[dark ? 'dark' : 'light'];
  const theme = providerThemes[providerKey] ?? providerThemes._default;
  return { name: theme.name === 'Unknown' ? providerKey : theme.name, cells: theme.cells };
}

function roundedRect(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const sortedAsc = [...sorted].sort((a, b) => a - b);
  const idx = Math.min(sortedAsc.length - 1, Math.floor(p * (sortedAsc.length - 1)));
  return sortedAsc[idx] ?? 0;
}

function buildDateGrid(year?: number): Array<Array<string | null>> {
  if (year !== undefined) {
    return buildYearGrid(year);
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - today.getDay() - 52 * 7);
  const weeks: Array<Array<string | null>> = [];
  const cur = new Date(start);
  while (cur <= today) {
    const week: Array<string | null> = [];
    for (let d = 0; d < 7; d++) {
      if (cur <= today) {
        const y = cur.getFullYear();
        const m = String(cur.getMonth() + 1).padStart(2, '0');
        const day = String(cur.getDate()).padStart(2, '0');
        week.push(`${y}-${m}-${day}`);
      } else {
        week.push(null);
      }
      cur.setDate(cur.getDate() + 1);
    }
    weeks.push(week);
  }
  return weeks;
}

function buildYearGrid(year: number): Array<Array<string | null>> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(year, 0, 1);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay());
  const end = year === today.getFullYear() ? today : new Date(year, 11, 31);
  end.setHours(0, 0, 0, 0);

  const weeks: Array<Array<string | null>> = [];
  const cur = new Date(start);
  do {
    const week: Array<string | null> = [];
    for (let d = 0; d < 7; d++) {
      if (cur <= end && cur.getFullYear() === year) {
        week.push(dateKey(cur));
      } else {
        week.push(null);
      }
      cur.setDate(cur.getDate() + 1);
    }
    weeks.push(week);
  } while (cur <= end || cur.getDay() !== 0);
  return weeks;
}

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function hasActivity(dayMap: DayMap, key: string): boolean {
  const v = dayMap.get(key);
  return v !== undefined && v.inputTokens + v.outputTokens > 0;
}

export function currentStreak(dayMap: DayMap): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const cur = new Date(today);
  let streak = 0;
  for (;;) {
    if (!hasActivity(dayMap, dateKey(cur))) break;
    streak++;
    cur.setDate(cur.getDate() - 1);
  }
  return streak;
}

export function longestStreak(dayMap: DayMap): number {
  const activeDates = [...dayMap.entries()]
    .filter(([, v]) => v.inputTokens + v.outputTokens > 0)
    .map(([d]) => d)
    .sort();
  if (activeDates.length === 0) return 0;

  let longest = 1;
  let current = 1;
  for (let i = 1; i < activeDates.length; i++) {
    const prev = new Date(`${activeDates[i - 1]}T12:00:00`);
    const cur = new Date(`${activeDates[i]}T12:00:00`);
    const diffDays = Math.round((cur.getTime() - prev.getTime()) / 86_400_000);
    if (diffDays === 1) {
      current++;
      longest = Math.max(longest, current);
    } else if (diffDays > 1) {
      current = 1;
    }
  }
  return longest;
}

export function peakMonth(dayMap: DayMap): { month: string; tokens: number } | null {
  const months = new Map<string, number>();
  for (const [date, day] of dayMap) {
    const total = day.inputTokens + day.outputTokens;
    if (total === 0) continue;
    const month = date.slice(0, 7);
    months.set(month, (months.get(month) ?? 0) + total);
  }
  let best: { month: string; tokens: number } | null = null;
  for (const [month, tokens] of months) {
    if (!best || tokens > best.tokens) best = { month, tokens };
  }
  return best;
}

interface ModelTop {
  model: string;
  tokens: number;
}
interface PeakDay {
  date: string;
  tokens: number;
}
interface ModelStats {
  topAllTime: ModelTop | null;
  topRecent: ModelTop | null;
  peak: PeakDay | null;
}

// Single pass: top model all-time, top model in the last 30 days, peak day.
// Replaces two separate O(n) walks (each with an O(n log n) sort).
export function computeModelStats(dayMap: DayMap): ModelStats {
  const since = since30Days();
  const allTime = new Map<string, number>();
  const recent = new Map<string, number>();
  let topAll: ModelTop | null = null;
  let topRec: ModelTop | null = null;
  let peak: PeakDay | null = null;

  const bump = (
    table: Map<string, number>,
    model: string,
    delta: number,
    track: ModelTop | null,
  ): ModelTop => {
    const next = (table.get(model) ?? 0) + delta;
    table.set(model, next);
    // Tie-break by model id (lexicographic ascending) for determinism.
    if (!track || next > track.tokens || (next === track.tokens && model < track.model)) {
      return { model, tokens: next };
    }
    return track;
  };

  for (const [date, data] of dayMap) {
    const dayTotal = data.inputTokens + data.outputTokens;
    if (dayTotal > 0 && (!peak || dayTotal > peak.tokens)) {
      peak = { date, tokens: dayTotal };
    }
    const isRecent = date >= since;
    for (const [model, counts] of Object.entries(data.byModel)) {
      const tokens = counts.inputTokens + counts.outputTokens;
      if (tokens === 0) continue;
      topAll = bump(allTime, model, tokens, topAll);
      if (isRecent) topRec = bump(recent, model, tokens, topRec);
    }
  }

  return { topAllTime: topAll, topRecent: topRec, peak };
}

function since30Days(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function formatPeakDate(date: string): string {
  // "2026-05-17" -> "May 17, 2026"
  const [y = '', m = '', d = ''] = date.split('-');
  const monthIdx = parseInt(m, 10) - 1;
  return `${MONTHS[monthIdx] ?? m} ${parseInt(d, 10)}, ${y}`;
}

export function formatMonthLabel(month: string): string {
  const [y = '', m = ''] = month.split('-');
  const monthIdx = parseInt(m, 10) - 1;
  return `${MONTHS[monthIdx] ?? m} ${y}`;
}

// ── Drawing ────────────────────────────────────────────────────────────────

function drawSection(
  ctx: SKRSContext2D,
  providerKey: string,
  dayMap: DayMap,
  weeks: Array<Array<string | null>>,
  baseY: number,
  mode: 'light' | 'dark',
  C: Palette,
): void {
  const providerThemes = THEMES[mode];
  const theme = providerThemes[providerKey] ?? {
    ...providerThemes._default,
    name: providerKey,
  };
  let totalIn = 0;
  let totalOut = 0;
  let totalCost = 0;
  let hasCost = false;
  const dayTotals: number[] = [];
  for (const v of dayMap.values()) {
    const total = v.inputTokens + v.outputTokens;
    if (total > 0) dayTotals.push(total);
    totalIn += v.inputTokens;
    totalOut += v.outputTokens;
    if (v.costUSD !== undefined) {
      totalCost += v.costUSD;
      hasCost = true;
    }
  }
  // Clamp the intensity anchor to the 90th-percentile day so a single outlier
  // doesn't flatten the rest of the year into the lightest shade.
  const maxTokens = percentile(dayTotals, 0.9) || 1;

  let y = baseY + SEC_PAD_TOP;

  // Provider name
  ctx.fillStyle = C.title;
  ctx.font = 'bold 22px Arial';
  ctx.fillText(theme.name, LEFT, y + 16);

  // Token and cost stats (right-aligned columns)
  const statCols = [
    { label: 'INPUT TOKENS', value: fmt(totalIn) },
    { label: 'OUTPUT TOKENS', value: fmt(totalOut) },
    { label: 'TOTAL TOKENS', value: fmt(totalIn + totalOut) },
    {
      // claude_code and codex are both API-equivalent estimates; cursor exposes
      // a real billed cost if present.
      label: providerKey === 'cursor' ? 'COST' : 'EST. COST',
      value: hasCost ? fmtUSD(totalCost) : '—',
    },
  ];
  const colW = 112;
  const statsRight = LEFT + GRID_W;
  for (const [i, col] of statCols.entries()) {
    const cx = statsRight - (statCols.length - 1 - i) * colW;
    ctx.fillStyle = C.label;
    ctx.font = '9px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(col.label, cx, y + 4);
    ctx.fillStyle = C.title;
    ctx.font = 'bold 16px Arial';
    ctx.fillText(col.value, cx, y + 22);
    ctx.textAlign = 'left';
  }

  y += HEADER_H;

  // Divider
  ctx.fillStyle = C.divider;
  ctx.fillRect(LEFT, y, GRID_W, DIVIDER_H);
  y += DIVIDER_H;

  // Month labels
  ctx.fillStyle = C.muted;
  ctx.font = '11px Arial';
  let lastMonth = -1;
  for (const [w, week] of weeks.entries()) {
    const first = week.find((d) => d !== null);
    if (!first) continue;
    const month = parseInt(first.slice(5, 7)) - 1;
    if (month !== lastMonth) {
      ctx.fillText(MONTHS[month] ?? '', LEFT + w * STEP, y + 14);
      lastMonth = month;
    }
  }
  y += MONTH_H;

  // Day labels (right-aligned). Grid starts Sunday (d=0), so label Mon/Wed/Fri
  // at their actual row positions (d=1, 3, 5).
  ctx.fillStyle = C.muted;
  ctx.font = '10px Arial';
  ctx.textAlign = 'right';
  ctx.fillText('Mon', LEFT - 6, y + STEP + CELL);
  ctx.fillText('Wed', LEFT - 6, y + 3 * STEP + CELL);
  ctx.fillText('Fri', LEFT - 6, y + 5 * STEP + CELL);
  ctx.textAlign = 'left';

  // Grid
  for (const [w, week] of weeks.entries()) {
    for (let d = 0; d < 7; d++) {
      const dateStr = week[d] ?? null;
      const x = LEFT + w * STEP;
      const cellY = y + d * STEP;
      const rec = dateStr ? dayMap.get(dateStr) : null;
      const tokens = rec ? rec.inputTokens + rec.outputTokens : 0;
      ctx.fillStyle = theme.cells[dateStr ? intensityLevel(tokens, maxTokens) : 0];
      roundedRect(ctx, x, cellY, CELL, CELL, 2);
      ctx.fill();
    }
  }
  y += GRID_H;

  // Legend
  ctx.fillStyle = C.muted;
  ctx.font = '10px Arial';
  ctx.fillText('LESS', LEFT, y + CELL);
  const lx = LEFT + 38;
  for (let level = 0; level <= 4; level++) {
    ctx.fillStyle = theme.cells[level] ?? theme.cells[0];
    roundedRect(ctx, lx + level * (CELL + 3), y, CELL, CELL, 2);
    ctx.fill();
  }
  ctx.fillStyle = C.muted;
  ctx.fillText('MORE', lx + 5 * (CELL + 3) + 4, y + CELL);
  y += LEGEND_H;

  // Bottom divider + stats
  ctx.fillStyle = C.divider;
  ctx.fillRect(LEFT, y, GRID_W, 1);
  y += 14;

  const { topAllTime, topRecent, peak } = computeModelStats(dayMap);
  const cs = currentStreak(dayMap);
  const ls = longestStreak(dayMap);
  const peakMo = peakMonth(dayMap);

  const bottomStats = [
    {
      label: 'MOST USED MODEL',
      value: topAllTime ? `${displayModelName(topAllTime.model)} (${fmt(topAllTime.tokens)})` : '—',
    },
    {
      label: 'RECENT USE (LAST 30 DAYS)',
      value: topRecent ? `${displayModelName(topRecent.model)} (${fmt(topRecent.tokens)})` : '—',
    },
    {
      label: 'PEAK DAY',
      value: peak ? `${formatPeakDate(peak.date)} (${fmt(peak.tokens)})` : '—',
    },
    {
      label: 'PEAK MONTH',
      value: peakMo ? `${formatMonthLabel(peakMo.month)} (${fmt(peakMo.tokens)})` : '—',
    },
    { label: 'CURRENT STREAK', value: `${cs} day${cs === 1 ? '' : 's'}` },
    { label: 'LONGEST STREAK', value: `${ls} day${ls === 1 ? '' : 's'}` },
  ];

  const bColW = GRID_W / bottomStats.length;
  for (const [i, stat] of bottomStats.entries()) {
    const bx = LEFT + i * bColW;
    ctx.fillStyle = C.label;
    ctx.font = '9px Arial';
    ctx.fillText(stat.label, bx, y + 12);
    ctx.fillStyle = C.value;
    ctx.font = 'bold 13px Arial';
    ctx.fillText(stat.value, bx, y + 28);
  }
}

// ── Entry point ────────────────────────────────────────────────────────────

/** Merge every provider DayMap into one (per-day and per-model sums). */
export function mergeAllProviderDayMaps(providerData: ProviderData): DayMap {
  const result: DayMap = new Map();
  for (const dayMap of Object.values(providerData)) {
    for (const [date, srcDay] of dayMap) {
      const dstDay = getOrCreateDay(result, date);
      dstDay.inputTokens += srcDay.inputTokens;
      dstDay.outputTokens += srcDay.outputTokens;
      if (srcDay.costUSD !== undefined) dstDay.costUSD = (dstDay.costUSD ?? 0) + srcDay.costUSD;
      for (const [model, counts] of Object.entries(srcDay.byModel)) {
        const modelTotals = (dstDay.byModel[model] ??= { inputTokens: 0, outputTokens: 0 });
        modelTotals.inputTokens += counts.inputTokens;
        modelTotals.outputTokens += counts.outputTokens;
        if (counts.costUSD !== undefined) {
          modelTotals.costUSD = (modelTotals.costUSD ?? 0) + counts.costUSD;
        }
      }
    }
  }
  return result;
}

export function renderToPng(
  providerData: ProviderData,
  _machineData: MachineFile[],
  { dark = false, all = false, year }: RenderOptions = {},
): Buffer {
  const mode: 'light' | 'dark' = dark ? 'dark' : 'light';
  const C = PALETTE[mode];
  const weeks = buildDateGrid(year);

  const layoutData: ProviderData = all
    ? { all: mergeAllProviderDayMaps(providerData) }
    : providerData;

  let activeProviders: string[];
  if (all) {
    activeProviders = (layoutData.all?.size ?? 0) > 0 ? ['all'] : [];
  } else {
    activeProviders = PROVIDER_ORDER.filter((k) => (layoutData[k]?.size ?? 0) > 0);
    for (const k of Object.keys(layoutData)) {
      if (!activeProviders.includes(k) && (layoutData[k]?.size ?? 0) > 0) activeProviders.push(k);
    }
  }

  const CANVAS_PAD = 24;
  const totalH = CANVAS_PAD + activeProviders.length * SECTION_H + CANVAS_PAD;

  const canvas = createCanvas(TOTAL_W, totalH);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, TOTAL_W, totalH);

  for (const [i, key] of activeProviders.entries()) {
    const dayMap = layoutData[key];
    if (dayMap !== undefined) {
      drawSection(ctx, key, dayMap, weeks, CANVAS_PAD + i * SECTION_H, mode, C);
    }
  }

  return canvas.toBuffer('image/png');
}

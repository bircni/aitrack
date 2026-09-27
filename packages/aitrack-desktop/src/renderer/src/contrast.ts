/** Linear-light sRGB, the space WCAG contrast is computed in. */
export interface LinearRgb {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface Oklch {
  l: number;
  c: number;
  h: number;
  a: number;
}

const TEXT_ROLES = ['--text', '--muted', '--faint'] as const;
const PROVIDERS = ['--claude', '--codex', '--cursor'] as const;

export interface ContrastPair {
  theme: 'dark' | 'light';
  role: string;
  ratio: number;
  onLightest: number;
  onDarkest: number;
}

/** AA pairs for body text on the worst mesh spot visible through the glass. */
export function contrastPairs(css: string): ContrastPair[] {
  const root = variables(block(css, ':root'));
  const light = new Map(root);
  for (const [name, value] of variables(block(css, ":root[data-theme='light']"))) {
    light.set(name, value);
  }
  const mixes = meshMixes(css);
  return [...pairsFor('dark', root, mixes), ...pairsFor('light', light, mixes)];
}

function pairsFor(
  theme: 'dark' | 'light',
  vars: Map<string, string>,
  mixes: Array<{ name: string; percent: number }>,
): ContrastPair[] {
  const ink = paint(required(vars, '--ink'));
  const spots = mixes.map((mix) => over(paint(required(vars, mix.name), mix.percent / 100), ink));
  const stops = paints(required(vars, '--glass'));
  const backgrounds = stops.flatMap((stop) => spots.map((spot) => over(stop, spot)));
  const lightest = brightest(backgrounds);
  const darkestBg = darkest(backgrounds);
  const roles = [...TEXT_ROLES, ...PROVIDERS];
  return roles.map((role) => {
    const color = paint(required(vars, role));
    const onLightest = contrast(color, lightest);
    const onDarkest = contrast(color, darkestBg);
    return {
      theme,
      role,
      ratio: Math.min(onLightest, onDarkest),
      onLightest,
      onDarkest,
    };
  });
}

function brightest(colors: LinearRgb[]): LinearRgb {
  return colors.reduce((best, color) => (luminance(color) > luminance(best) ? color : best));
}

function darkest(colors: LinearRgb[]): LinearRgb {
  return colors.reduce((best, color) => (luminance(color) < luminance(best) ? color : best));
}

export function contrast(foreground: LinearRgb, background: LinearRgb): number {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function luminance(color: LinearRgb): number {
  return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
}

function over(foreground: LinearRgb, background: LinearRgb): LinearRgb {
  const a = foreground.a + background.a * (1 - foreground.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: (foreground.r * foreground.a + background.r * background.a * (1 - foreground.a)) / a,
    g: (foreground.g * foreground.a + background.g * background.a * (1 - foreground.a)) / a,
    b: (foreground.b * foreground.a + background.b * background.a * (1 - foreground.a)) / a,
    a,
  };
}

function paint(value: string, alpha?: number): LinearRgb {
  const parsed = parseOklch(value);
  if (alpha !== undefined) parsed.a = alpha;
  return oklchToLinear(parsed);
}

function paints(value: string): LinearRgb[] {
  const found = [...value.matchAll(/oklch\([^)]+\)/gu)].map((match) =>
    oklchToLinear(parseOklch(match[0])),
  );
  if (found.length === 0) throw new Error(`No oklch color in ${value}`);
  return found;
}

function required(vars: Map<string, string>, name: string): string {
  const value = vars.get(name);
  if (value === undefined) throw new Error(`Missing ${name}`);
  return value;
}

function meshMixes(css: string): Array<{ name: string; percent: number }> {
  return [...css.matchAll(/color-mix\(in oklch, var\((--[\w-]+)\) (\d+)%/gu)].map((match) => ({
    name: match[1] ?? '',
    percent: Number(match[2]),
  }));
}

function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`Missing ${selector}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

function variables(body: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const match of body.matchAll(/(--[\w-]+):\s*([^;]+);/gu)) {
    const name = match[1];
    const value = match[2];
    if (name === undefined || value === undefined) continue;
    vars.set(name, value.trim());
  }
  return vars;
}

function parseOklch(value: string): Oklch {
  const match = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)/u.exec(value);
  if (match === null) throw new Error(`Cannot read ${value}`);
  return {
    l: Number(match[1]),
    c: Number(match[2]),
    h: Number(match[3]),
    a: match[4] === undefined ? 1 : Number(match[4]),
  };
}

function oklchToLinear(color: Oklch): LinearRgb {
  const hue = (color.h * Math.PI) / 180;
  const a = color.c * Math.cos(hue);
  const b = color.c * Math.sin(hue);
  const l = cube(color.l + 0.3963377774 * a + 0.2158037573 * b);
  const m = cube(color.l - 0.1055613458 * a - 0.0638541728 * b);
  const s = cube(color.l - 0.0894841775 * a - 1.291485548 * b);
  return {
    r: clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    a: color.a,
  };
}

function cube(value: number): number {
  return value * value * value;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

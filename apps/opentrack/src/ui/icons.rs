//! The renderer's glyphs and the provider marks, from their SVG path data.

use eframe::egui::{self, Color32, ColorImage, Pos2, Rect, Shape, Stroke, TextureHandle, TextureOptions, Vec2};

/// A path's subpaths as polylines, in its own units.
type Polylines = Vec<Vec<(f32, f32)>>;

const STEPS: u16 = 16;

fn numbers(text: &str) -> Vec<f32> {
    let mut out = Vec::new();
    let mut current = String::new();
    let flush = |current: &mut String, out: &mut Vec<f32>| {
        if let Ok(value) = current.parse() {
            out.push(value);
        }
        current.clear();
    };
    for c in text.chars() {
        let starts_new =
            c == '-' && !current.is_empty() && !current.ends_with('e') || c == '.' && current.contains('.');
        if c.is_ascii_digit() || c == '.' || c == '-' || c == 'e' {
            if starts_new {
                flush(&mut current, &mut out);
            }
            current.push(c);
        } else {
            flush(&mut current, &mut out);
        }
    }
    flush(&mut current, &mut out);
    out
}

/// Arc flags are single digits that may run into the next number ("0 0 1-.4-9").
fn arc_numbers(text: &str) -> Vec<f32> {
    let mut out = Vec::new();
    let mut rest = text.trim_start_matches([' ', ',']);
    while !rest.is_empty() {
        let index = out.len() % 7;
        if index == 3 || index == 4 {
            let (flag, tail) = rest.split_at(1);
            out.push(flag.parse().unwrap_or(0.0));
            rest = tail.trim_start_matches([' ', ',']);
            continue;
        }
        let end = rest
            .char_indices()
            .skip(1)
            .find(|&(i, c)| {
                c == ' ' || c == ',' || (c == '-' && !rest[..i].ends_with('e')) || (c == '.' && rest[..i].contains('.'))
            })
            .map_or(rest.len(), |(i, _)| i);
        out.push(rest[..end].parse().unwrap_or(0.0));
        rest = rest[end..].trim_start_matches([' ', ',']);
    }
    out
}

fn cubic(from: (f32, f32), c1: (f32, f32), c2: (f32, f32), to: (f32, f32), out: &mut Vec<(f32, f32)>) {
    const STEPS: u16 = 12;
    for step in 1..=STEPS {
        let t = f32::from(step) / f32::from(STEPS);
        let u = 1.0 - t;
        let blend =
            |a: f32, b: f32, c: f32, d: f32| u * u * u * a + 3.0 * u * u * t * b + 3.0 * u * t * t * c + t * t * t * d;
        out.push((blend(from.0, c1.0, c2.0, to.0), blend(from.1, c1.1, c2.1, to.1)));
    }
}

/// SVG's endpoint arc, flattened.
#[expect(clippy::too_many_arguments, reason = "each argument is a distinct part of the arc")]
fn arc(
    from: (f32, f32),
    rx: f32,
    ry: f32,
    rotation: f32,
    large: bool,
    sweep: bool,
    to: (f32, f32),
    out: &mut Vec<(f32, f32)>,
) {
    let (mut rx, mut ry) = (rx.abs(), ry.abs());
    if rx == 0.0 || ry == 0.0 {
        out.push(to);
        return;
    }
    let phi = rotation.to_radians();
    let (sin, cos) = phi.sin_cos();
    let dx = (from.0 - to.0) / 2.0;
    let dy = (from.1 - to.1) / 2.0;
    let x1 = cos * dx + sin * dy;
    let y1 = -sin * dx + cos * dy;
    let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
    if lambda > 1.0 {
        rx *= lambda.sqrt();
        ry *= lambda.sqrt();
    }
    let num = (rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1).max(0.0);
    let den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
    let mut coef = (num / den).sqrt();
    if large == sweep {
        coef = -coef;
    }
    let cx1 = coef * rx * y1 / ry;
    let cy1 = -coef * ry * x1 / rx;
    let cx = cos * cx1 - sin * cy1 + f32::midpoint(from.0, to.0);
    let cy = sin * cx1 + cos * cy1 + f32::midpoint(from.1, to.1);
    let angle = |ux: f32, uy: f32, vx: f32, vy: f32| {
        let dot = ux * vx + uy * vy;
        let len = (ux * ux + uy * uy).sqrt() * (vx * vx + vy * vy).sqrt();
        let a = (dot / len).clamp(-1.0, 1.0).acos();
        if ux * vy - uy * vx < 0.0 {
            -a
        } else {
            a
        }
    };
    let start = angle(1.0, 0.0, (x1 - cx1) / rx, (y1 - cy1) / ry);
    let mut delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
    if !sweep && delta > 0.0 {
        delta -= std::f32::consts::TAU;
    } else if sweep && delta < 0.0 {
        delta += std::f32::consts::TAU;
    }
    for step in 1..=STEPS {
        let theta = start + delta * f32::from(step) / f32::from(STEPS);
        let (s, c) = theta.sin_cos();
        out.push((cos * rx * c - sin * ry * s + cx, sin * rx * c + cos * ry * s + cy));
    }
}

/// M/L/H/V/C/A/Z, absolute and relative, which is all the renderer's icons use.
fn parse(d: &str) -> Polylines {
    let mut lines: Polylines = Vec::new();
    let mut current: Vec<(f32, f32)> = Vec::new();
    let mut at = (0.0f32, 0.0f32);
    let mut start = at;
    let commands: Vec<(usize, char)> = d.char_indices().filter(|(_, c)| c.is_ascii_alphabetic() && *c != 'e').collect();
    for (n, &(index, command)) in commands.iter().enumerate() {
        let end = commands.get(n + 1).map_or(d.len(), |(i, _)| *i);
        let args = &d[index + 1..end];
        let relative = command.is_ascii_lowercase();
        let base = |at: (f32, f32)| if relative { at } else { (0.0, 0.0) };
        match command.to_ascii_uppercase() {
            'M' => {
                if current.len() > 1 {
                    lines.push(std::mem::take(&mut current));
                }
                current.clear();
                for (i, pair) in numbers(args).chunks(2).enumerate() {
                    let b = base(at);
                    at = (b.0 + pair[0], b.1 + pair[1]);
                    if i == 0 {
                        start = at;
                    }
                    current.push(at);
                }
            }
            'L' => {
                for pair in numbers(args).chunks(2) {
                    let b = base(at);
                    at = (b.0 + pair[0], b.1 + pair[1]);
                    current.push(at);
                }
            }
            'H' => {
                for x in numbers(args) {
                    at.0 = if relative { at.0 + x } else { x };
                    current.push(at);
                }
            }
            'V' => {
                for y in numbers(args) {
                    at.1 = if relative { at.1 + y } else { y };
                    current.push(at);
                }
            }
            'C' => {
                for c in numbers(args).chunks(6) {
                    let b = base(at);
                    let p = |i: usize| (b.0 + c[i], b.1 + c[i + 1]);
                    let to = p(4);
                    cubic(at, p(0), p(2), to, &mut current);
                    at = to;
                }
            }
            'A' => {
                for a in arc_numbers(args).chunks(7) {
                    let b = base(at);
                    let to = (b.0 + a[5], b.1 + a[6]);
                    arc(at, a[0], a[1], a[2], a[3] != 0.0, a[4] != 0.0, to, &mut current);
                    at = to;
                }
            }
            'Z' => {
                current.push(start);
                at = start;
                lines.push(std::mem::take(&mut current));
            }
            _ => {}
        }
    }
    if current.len() > 1 {
        lines.push(current);
    }
    lines
}

fn circle(cx: f32, cy: f32, r: f32) -> Vec<(f32, f32)> {
    (0..=24)
        .map(|i| {
            let theta = f32::from(i16::try_from(i).unwrap_or(0)) / 24.0 * std::f32::consts::TAU;
            (cx + r * theta.cos(), cy + r * theta.sin())
        })
        .collect()
}

fn rounded_rect(x: f32, y: f32, w: f32, h: f32, r: f32) -> String {
    format!(
        "M{} {y}H{}A{r} {r} 0 0 1 {} {}V{}A{r} {r} 0 0 1 {} {}H{}A{r} {r} 0 0 1 {x} {}V{}A{r} {r} 0 0 1 {} {y}Z",
        x + r,
        x + w - r,
        x + w,
        y + r,
        y + h - r,
        x + w - r,
        y + h,
        x + r,
        y + h - r,
        y + r,
        x + r
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Glyph {
    Back,
    ChevronDown,
    ChevronUp,
    Cloud,
    Laptop,
    Compact,
    Refresh,
    Sliders,
    Sync,
}

fn glyph_lines(glyph: Glyph) -> Polylines {
    match glyph {
        Glyph::Back => parse("m14.5 5-7 7 7 7"),
        Glyph::ChevronDown => parse("m6 9 6 6 6-6"),
        Glyph::ChevronUp => parse("m6 15 6-6 6 6"),
        Glyph::Laptop => [parse(&rounded_rect(4.5, 5.0, 15.0, 10.5, 1.5)), parse("M2.5 19h19")].concat(),
        Glyph::Cloud => parse("M7 18a4.5 4.5 0 0 1-.4-9A6 6 0 0 1 18 9.5a4 4 0 0 1-.5 8.5Z"),
        Glyph::Refresh => [parse("M20 11a8 8 0 1 0-2.3 5.7"), parse("M20 4v7h-7")].concat(),
        Glyph::Sync => {
            [parse("M7 18a4.5 4.5 0 0 1-.4-9A6 6 0 0 1 18 9.5a4 4 0 0 1-.5 8.5"), parse("m9 15 3-3 3 3M12 12v8")]
                .concat()
        }
        Glyph::Sliders => {
            let mut lines = parse("M4 7h10M18 7h2M4 17h4M12 17h8");
            lines.push(circle(16.0, 7.0, 2.0));
            lines.push(circle(10.0, 17.0, 2.0));
            lines
        }
        Glyph::Compact => [parse(&rounded_rect(4.0, 4.0, 16.0, 16.0, 2.0)), parse("M4 12h16")].concat(),
    }
}

/// A 24-unit stroke glyph in `rect`, turned by `rotation` radians about its centre.
pub fn paint_glyph(painter: &egui::Painter, rect: Rect, glyph: Glyph, color: Color32, rotation: f32) {
    let scale = rect.width() / 24.0;
    let center = rect.center();
    let (sin, cos) = rotation.sin_cos();
    let stroke = Stroke::new(1.8 * scale, color);
    for line in glyph_lines(glyph) {
        let points: Vec<Pos2> = line
            .iter()
            .map(|&(x, y)| {
                let (dx, dy) = ((x - 12.0) * scale, (y - 12.0) * scale);
                Pos2::new(center.x + dx * cos - dy * sin, center.y + dx * sin + dy * cos)
            })
            .collect();
        painter.add(Shape::line(points, stroke));
    }
}

/// Marks from `OpenQuota` (MIT), one path each.
const CLAUDE: &str = include_str!("../../icons/providers/claude.path");
const CODEX: &str = include_str!("../../icons/providers/codex.path");
const CURSOR: &str = include_str!("../../icons/providers/cursor.path");

const MARK_SIZE: usize = 64;

/// Nonzero-winding coverage of the path in a `size` square, 4×4 samples a pixel.
#[expect(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    reason = "a 64-pixel grid converted between float and integer"
)]
fn rasterize(lines: &Polylines, view: f32, size: usize) -> Vec<u8> {
    const SAMPLES: usize = 4;
    let scale = size as f32 / view;
    let edges: Vec<((f32, f32), (f32, f32))> = lines
        .iter()
        .flat_map(|line| {
            let closed = line.first() == line.last();
            let mut segments: Vec<_> = line.windows(2).map(|w| (w[0], w[1])).collect();
            if !closed {
                if let (Some(&a), Some(&b)) = (line.last(), line.first()) {
                    segments.push((a, b));
                }
            }
            segments
        })
        .map(|((x0, y0), (x1, y1))| ((x0 * scale, y0 * scale), (x1 * scale, y1 * scale)))
        .collect();
    let mut coverage = vec![0u16; size * size];
    for row in 0..size * SAMPLES {
        let y = (row as f32 + 0.5) / SAMPLES as f32;
        let mut crossings: Vec<(f32, i32)> = edges
            .iter()
            .filter_map(|&((x0, y0), (x1, y1))| {
                if (y0 <= y) == (y1 <= y) {
                    return None;
                }
                let x = x0 + (y - y0) / (y1 - y0) * (x1 - x0);
                Some((x, if y1 > y0 { 1 } else { -1 }))
            })
            .collect();
        crossings.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut winding = 0;
        for pair in crossings.windows(2) {
            winding += pair[0].1;
            if winding == 0 {
                continue;
            }
            for column in 0..size * SAMPLES {
                let x = (column as f32 + 0.5) / SAMPLES as f32;
                if x >= pair[0].0 && x < pair[1].0 {
                    coverage[(row / SAMPLES) * size + column / SAMPLES] += 1;
                }
            }
        }
    }
    coverage.iter().map(|c| ((u32::from(*c) * 255) / (SAMPLES * SAMPLES) as u32).min(255) as u8).collect()
}

pub struct ProviderMarks {
    textures: Vec<(&'static str, TextureHandle)>,
}

impl ProviderMarks {
    pub fn load(ctx: &egui::Context) -> Self {
        let textures = [("claude_code", CLAUDE), ("codex", CODEX), ("cursor", CURSOR)]
            .into_iter()
            .map(|(key, d)| {
                let alpha = rasterize(&parse(d), 100.0, MARK_SIZE);
                let image = ColorImage::from_rgba_unmultiplied(
                    [MARK_SIZE, MARK_SIZE],
                    &alpha.iter().flat_map(|a| [255, 255, 255, *a]).collect::<Vec<u8>>(),
                );
                (key, ctx.load_texture(format!("mark-{key}"), image, TextureOptions::LINEAR))
            })
            .collect();
        Self { textures }
    }

    pub fn paint(&self, painter: &egui::Painter, rect: Rect, key: &str, color: Color32) {
        if let Some((_, texture)) = self.textures.iter().find(|(k, _)| *k == key) {
            let uv = Rect::from_min_max(Pos2::ZERO, Pos2::new(1.0, 1.0));
            painter.image(texture.id(), rect, uv, color);
        }
    }
}

pub fn square(center: Pos2, size: f32) -> Rect {
    Rect::from_center_size(center, Vec2::splat(size))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_relative_moves_lines_and_arcs() {
        assert_eq!(parse("m6 9 6 6 6-6"), vec![vec![(6.0, 9.0), (12.0, 15.0), (18.0, 9.0)]]);
        assert_eq!(parse("M4 7h10M18 7h2").len(), 2);
        assert_eq!(arc_numbers("4.5 4.5 0 0 1-.4-9"), [4.5, 4.5, 0.0, 0.0, 1.0, -0.4, -9.0]);
        let cloud = parse("M7 18a4.5 4.5 0 0 1-.4-9A6 6 0 0 1 18 9.5a4 4 0 0 1-.5 8.5Z");
        let last = *cloud[0].last().unwrap();
        assert!((last.0 - 7.0).abs() < 1e-3 && (last.1 - 18.0).abs() < 1e-3);
    }

    #[test]
    fn fills_a_mark_by_nonzero_winding() {
        let square = parse("M0 0H10V10H0Z");
        let alpha = rasterize(&square, 20.0, 4);
        assert_eq!(&alpha[..4], &[255, 255, 0, 0]);
        assert!(rasterize(&parse(CODEX), 100.0, 32).contains(&255));
    }
}

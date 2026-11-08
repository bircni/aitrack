//! `aitrack show`'s PNG heatmap, drawn with 4.x's layout; text uses the embedded `DejaVu` Sans, not Arial.

use std::collections::HashSet;

use ab_glyph::{Font, FontRef, PxScale, ScaleFont, point};
use tiny_skia::{Color, FillRule, Paint, PathBuilder, Pixmap, Rect, Transform};

use super::heatmap::intensity::token_intensity_level;
use super::heatmap::layout::resolve_provider_layout;
use super::heatmap::stats::{Week, build_date_grid, month_labels};
use super::heatmap::themes::{Palette, palette, provider_cells};
use super::heatmap::view_model::build_provider_section_view_model;
pub use super::render_options::RenderOptions;
use crate::data::types::{DayMap, ProviderData};
use crate::day::Day;
use crate::time::Clock;

const REGULAR: &[u8] = include_bytes!("../../assets/DejaVuSans.ttf");
const BOLD: &[u8] = include_bytes!("../../assets/DejaVuSans-Bold.ttf");

const CELL: f32 = 12.0;
const GAP: f32 = 3.0;
const STEP: f32 = CELL + GAP;
const LEFT: f32 = 52.0;
/// A year grid is 53 columns, but a leap year opening on a Saturday needs 54; 53 stays the floor.
const MIN_WEEKS: usize = 53;
const SEC_PAD_TOP: f32 = 32.0;
const HEADER_H: f32 = 52.0;
const DIVIDER_H: f32 = 1.0;
const MONTH_H: f32 = 28.0;
const GRID_H: f32 = 7.0 * STEP;
const LEGEND_H: f32 = 32.0;
const STATS_H: f32 = 78.0;
const SEC_PAD_BOT: f32 = 28.0;
const SECTION_H: f32 = SEC_PAD_TOP + HEADER_H + DIVIDER_H + MONTH_H + GRID_H + LEGEND_H + STATS_H + SEC_PAD_BOT;
const STAT_COLUMN_GAP: f32 = 8.0;
const CANVAS_PAD: f32 = 24.0;

#[allow(clippy::cast_precision_loss)]
fn grid_width(weeks: usize) -> f32 {
    weeks.max(MIN_WEEKS) as f32 * STEP
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Align {
    Left,
    Center,
    Right,
}

fn color(hex: &str) -> Color {
    let channel = |i: usize| u8::from_str_radix(hex.get(i..i + 2).unwrap_or("00"), 16).unwrap_or(0);
    Color::from_rgba8(channel(1), channel(3), channel(5), 255)
}

struct Canvas {
    pixmap: Pixmap,
    regular: FontRef<'static>,
    bold: FontRef<'static>,
}

impl Canvas {
    fn font(&self, bold: bool) -> &FontRef<'static> {
        if bold { &self.bold } else { &self.regular }
    }

    /// A CSS pixel size is the em size; `ab_glyph` scales by ascent-to-descent height.
    fn scale(&self, size: f32, bold: bool) -> PxScale {
        let font = self.font(bold);
        PxScale::from(size * font.height_unscaled() / font.units_per_em().unwrap_or(2048.0))
    }

    fn measure(&self, text: &str, size: f32, bold: bool) -> f32 {
        let font = self.font(bold).as_scaled(self.scale(size, bold));
        text.chars().map(|c| font.h_advance(font.glyph_id(c))).sum()
    }

    fn fill_rect(&mut self, x: f32, y: f32, w: f32, h: f32, fill: &str) {
        if let Some(rect) = Rect::from_xywh(x, y, w, h) {
            let mut paint = Paint::default();
            paint.set_color(color(fill));
            self.pixmap.fill_rect(rect, &paint, Transform::identity(), None);
        }
    }

    /// `arcTo` corners, as cubic quarter circles.
    fn rounded_rect(&mut self, left: f32, top: f32, size: f32, radius: f32, fill: &str) {
        let (right, bottom) = (left + size, top + size);
        let bend = radius * 0.552_284_8;
        let mut pb = PathBuilder::new();
        pb.move_to(left + radius, top);
        pb.line_to(right - radius, top);
        pb.cubic_to(right - radius + bend, top, right, top + radius - bend, right, top + radius);
        pb.line_to(right, bottom - radius);
        pb.cubic_to(right, bottom - radius + bend, right - radius + bend, bottom, right - radius, bottom);
        pb.line_to(left + radius, bottom);
        pb.cubic_to(left + radius - bend, bottom, left, bottom - radius + bend, left, bottom - radius);
        pb.line_to(left, top + radius);
        pb.cubic_to(left, top + radius - bend, left + radius - bend, top, left + radius, top);
        pb.close();
        if let Some(path) = pb.finish() {
            let mut paint = Paint::default();
            paint.set_color(color(fill));
            paint.anti_alias = true;
            self.pixmap.fill_path(&path, &paint, FillRule::Winding, Transform::identity(), None);
        }
    }

    /// `fillText` on the alphabetic baseline `y`.
    #[allow(clippy::too_many_arguments)]
    fn text(&mut self, text: &str, anchor: f32, baseline: f32, size: f32, bold: bool, fill: &str, align: Align) {
        let width = self.measure(text, size, bold);
        let mut caret = match align {
            Align::Left => anchor,
            Align::Center => anchor - width / 2.0,
            Align::Right => anchor - width,
        };
        let scale = self.scale(size, bold);
        let font = self.font(bold).clone();
        let scaled = font.as_scaled(scale);
        let rgb = {
            let c = color(fill).to_color_u8();
            [c.red(), c.green(), c.blue()]
        };
        #[allow(clippy::cast_possible_wrap)]
        let (w, h) = (self.pixmap.width() as i32, self.pixmap.height() as i32);
        let data = self.pixmap.data_mut();
        for c in text.chars() {
            let id = scaled.glyph_id(c);
            let glyph = id.with_scale_and_position(scale, point(caret, baseline));
            caret += scaled.h_advance(id);
            let Some(outlined) = font.outline_glyph(glyph) else { continue };
            let bounds = outlined.px_bounds();
            #[allow(clippy::cast_possible_truncation, clippy::cast_possible_wrap)]
            outlined.draw(|gx, gy, coverage| {
                let px = bounds.min.x as i32 + gx as i32;
                let py = bounds.min.y as i32 + gy as i32;
                if px < 0 || py < 0 || px >= w || py >= h {
                    return;
                }
                let at = usize::try_from((py * w + px) * 4).unwrap_or(0);
                let alpha = coverage.clamp(0.0, 1.0);
                for (i, src) in rgb.into_iter().enumerate() {
                    let dst = f32::from(data[at + i]);
                    #[allow(clippy::cast_sign_loss)]
                    let blended = (dst + (f32::from(src) - dst) * alpha).round() as u8;
                    data[at + i] = blended;
                }
            });
        }
    }

    /// Truncated with an ellipsis to fit `max_width`.
    fn fit_text(&self, text: &str, max_width: f32, size: f32, bold: bool) -> String {
        if self.measure(text, size, bold) <= max_width {
            return text.to_owned();
        }
        let mut fitted: Vec<char> = text.chars().collect();
        while !fitted.is_empty()
            && self.measure(&format!("{}…", fitted.iter().collect::<String>()), size, bold) > max_width
        {
            fitted.pop();
        }
        format!("{}…", fitted.iter().collect::<String>())
    }
}

#[allow(clippy::cast_precision_loss, clippy::too_many_lines)]
fn draw_section(canvas: &mut Canvas, key: &str, days: &DayMap, weeks: &[Week], base_y: f32, dark: bool, today: Day) {
    let c: Palette = palette(dark);
    let visible: HashSet<Day> = weeks.iter().flatten().flatten().copied().collect();
    let vm = build_provider_section_view_model(key, days, |d| visible.contains(d), today);
    let cells = provider_cells(key, dark);
    let grid_w = grid_width(weeks.len());

    let mut y = base_y + SEC_PAD_TOP;
    canvas.text(&vm.name, LEFT, y + 16.0, 22.0, true, c.title, Align::Left);

    let col_w = 112.0;
    let stats_right = LEFT + grid_w;
    let count = vm.header_stats.len();
    for (index, col) in vm.header_stats.iter().enumerate() {
        let cx = stats_right - (count - 1 - index) as f32 * col_w;
        canvas.text(&col.label, cx, y + 4.0, 9.0, false, c.label, Align::Center);
        canvas.text(&col.value, cx, y + 22.0, 16.0, true, c.title, Align::Center);
    }
    y += HEADER_H;

    canvas.fill_rect(LEFT, y, grid_w, DIVIDER_H, c.divider);
    y += DIVIDER_H;

    for label in month_labels(weeks) {
        canvas.text(label.label, LEFT + label.column as f32 * STEP, y + 14.0, 11.0, false, c.muted, Align::Left);
    }
    y += MONTH_H;

    for (row, name) in [(1.0, "Mon"), (3.0, "Wed"), (5.0, "Fri")] {
        canvas.text(name, LEFT - 6.0, y + row * STEP + CELL, 10.0, false, c.muted, Align::Right);
    }

    for (w, week) in weeks.iter().enumerate() {
        for (d, date) in week.iter().enumerate() {
            let level = date.map_or(0, |date| {
                let tokens = days.get(&date).map_or(0, |e| e.counts.input_tokens + e.counts.output_tokens);
                token_intensity_level(tokens, vm.max_tokens)
            });
            canvas.rounded_rect(LEFT + w as f32 * STEP, y + d as f32 * STEP, CELL, 2.0, cells[usize::from(level)]);
        }
    }
    y += GRID_H;

    canvas.text("LESS", LEFT, y + CELL, 10.0, false, c.muted, Align::Left);
    let lx = LEFT + 38.0;
    for (level, fill) in cells.iter().enumerate() {
        canvas.rounded_rect(lx + level as f32 * (CELL + 3.0), y, CELL, 2.0, fill);
    }
    canvas.text("MORE", lx + 5.0 * (CELL + 3.0) + 4.0, y + CELL, 10.0, false, c.muted, Align::Left);
    y += LEGEND_H;

    canvas.fill_rect(LEFT, y, grid_w, 1.0, c.divider);
    y += 14.0;

    let column = grid_w / vm.bottom_stats.len() as f32;
    for (index, stat) in vm.bottom_stats.iter().enumerate() {
        let bx = LEFT + index as f32 * column;
        canvas.text(&stat.label, bx, y + 12.0, 9.0, false, c.label, Align::Left);
        let value = canvas.fit_text(&stat.value, column - STAT_COLUMN_GAP, 13.0, true);
        canvas.text(&value, bx, y + 28.0, 13.0, true, c.value, Align::Left);
        if let Some(sub) = &stat.sub {
            canvas.text(sub, bx, y + 43.0, 11.0, false, c.muted, Align::Left);
        }
    }
}

pub fn render_to_png(data: &ProviderData, options: &RenderOptions) -> Vec<u8> {
    render_to_png_at(data, options, Clock::system().today())
}

pub fn render_to_png_at(data: &ProviderData, options: &RenderOptions, today: Day) -> Vec<u8> {
    let weeks = build_date_grid(options.year, today);
    let layout = resolve_provider_layout(data, options.all, options.year);
    #[allow(clippy::cast_precision_loss)]
    let total_h = CANVAS_PAD * 2.0 + layout.keys.len() as f32 * SECTION_H;
    let total_w = LEFT + grid_width(weeks.len()) + 80.0;
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let (width, height) = (total_w as u32, total_h as u32);
    let mut canvas = Canvas {
        pixmap: Pixmap::new(width, height).expect("a non-empty canvas"),
        regular: FontRef::try_from_slice(REGULAR).expect("the embedded font parses"),
        bold: FontRef::try_from_slice(BOLD).expect("the embedded font parses"),
    };
    canvas.fill_rect(0.0, 0.0, total_w, total_h, palette(options.dark).bg);
    #[allow(clippy::cast_precision_loss)]
    for (index, key) in layout.keys.iter().enumerate() {
        if let Some(days) = layout.data.get(key) {
            draw_section(&mut canvas, key, days, &weeks, CANVAS_PAD + index as f32 * SECTION_H, options.dark, today);
        }
    }
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    // Every pixel is opaque after the background fill, so premultiplied and straight alpha agree.
    let mut writer = encoder.write_header().expect("PNG header to memory");
    writer.write_image_data(canvas.pixmap.data()).expect("PNG data to memory");
    writer.finish().expect("PNG end to memory");
    out
}

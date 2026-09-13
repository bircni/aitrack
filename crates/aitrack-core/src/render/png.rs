//! PNG heatmap rendering using tiny-skia and fontdue.

use crate::data::types::ProviderData;
use crate::render::heatmap::view_model::token_intensity_level;
use crate::render::heatmap::{
    ColorMode, MONTHS, ProviderLayoutOptions, build_date_grid, build_provider_section_view_model,
    get_palette, get_provider_theme, resolve_provider_layout,
};
use fontdue::{Font, FontSettings};
use tiny_skia::*;

const CELL: u32 = 12;
const GAP: u32 = 3;
const STEP: u32 = CELL + GAP;
const LEFT: u32 = 52;
const MIN_WEEKS: usize = 53;

const SEC_PAD_TOP: u32 = 32;
const HEADER_H: u32 = 52;
const DIVIDER_H: u32 = 1;
const MONTH_H: u32 = 28;
const GRID_H: u32 = 7 * STEP;
const LEGEND_H: u32 = 32;
const STATS_H: u32 = 78;
const SEC_PAD_BOT: u32 = 28;
const SECTION_H: u32 =
    SEC_PAD_TOP + HEADER_H + DIVIDER_H + MONTH_H + GRID_H + LEGEND_H + STATS_H + SEC_PAD_BOT;

fn grid_width(week_count: usize) -> u32 {
    MIN_WEEKS.max(week_count) as u32 * STEP
}

fn total_width(week_count: usize) -> u32 {
    LEFT + grid_width(week_count) + 80
}

fn hex_to_color(hex: &str) -> Color {
    let hex = hex.trim_start_matches('#');
    let r = u8::from_str_radix(&hex[0..2], 16).unwrap_or(0);
    let g = u8::from_str_radix(&hex[2..4], 16).unwrap_or(0);
    let b = u8::from_str_radix(&hex[4..6], 16).unwrap_or(0);
    Color::from_rgba8(r, g, b, 255)
}

struct FontCache {
    font: Font,
}

impl FontCache {
    fn new() -> Self {
        let font_data = include_bytes!("../../assets/Poppins-SemiBold.ttf");
        let font = Font::from_bytes(font_data as &[u8], FontSettings::default())
            .expect("Failed to load font");
        Self { font }
    }

    fn draw_text(&self, pixmap: &mut Pixmap, text: &str, draw: TextDraw) {
        let scale = draw.size;
        let mut cursor_x = draw.x;

        // Calculate text width for alignment
        if matches!(draw.align, TextAlign::Center | TextAlign::Right) {
            let mut width = 0.0;
            for ch in text.chars() {
                let (metrics, _) = self.font.rasterize(ch, scale);
                width += metrics.advance_width;
            }

            if matches!(draw.align, TextAlign::Center) {
                cursor_x -= width / 2.0;
            } else {
                cursor_x -= width;
            }
        }

        for ch in text.chars() {
            let (metrics, bitmap) = self.font.rasterize(ch, scale);

            if !bitmap.is_empty() {
                for py in 0..metrics.height {
                    for px in 0..metrics.width {
                        let alpha = bitmap[py * metrics.width + px];
                        if alpha > 0 {
                            let draw_x = (cursor_x + px as f32 + metrics.xmin as f32) as u32;
                            let draw_y = (draw.y + py as f32 - metrics.ymin as f32) as u32;

                            if draw_x < pixmap.width() && draw_y < pixmap.height() {
                                let idx = (draw_y * pixmap.width() + draw_x) as usize * 4;
                                if idx + 3 < pixmap.data().len() {
                                    let data = pixmap.data_mut();
                                    let alpha_f = alpha as f32 / 255.0;
                                    data[idx] = (draw.color.red() * 255.0) as u8;
                                    data[idx + 1] = (draw.color.green() * 255.0) as u8;
                                    data[idx + 2] = (draw.color.blue() * 255.0) as u8;
                                    data[idx + 3] = (alpha_f * 255.0) as u8;
                                }
                            }
                        }
                    }
                }
            }

            cursor_x += metrics.advance_width;
        }
    }
}

#[derive(Clone, Copy)]
enum TextAlign {
    Left,
    Center,
    Right,
}

#[derive(Clone, Copy)]
struct TextDraw {
    x: f32,
    y: f32,
    size: f32,
    color: Color,
    align: TextAlign,
}

fn text_at(x: f32, y: f32, size: f32, color: Color, align: TextAlign) -> TextDraw {
    TextDraw {
        x,
        y,
        size,
        color,
        align,
    }
}

fn rounded_rect(pixmap: &mut Pixmap, x: f32, y: f32, w: f32, h: f32, r: f32, color: Color) {
    let mut paint = Paint::default();
    paint.set_color(color);
    paint.anti_alias = true;

    let path = {
        let mut pb = PathBuilder::new();
        pb.move_to(x + r, y);
        pb.line_to(x + w - r, y);
        pb.quad_to(x + w, y, x + w, y + r);
        pb.line_to(x + w, y + h - r);
        pb.quad_to(x + w, y + h, x + w - r, y + h);
        pb.line_to(x + r, y + h);
        pb.quad_to(x, y + h, x, y + h - r);
        pb.line_to(x, y + r);
        pb.quad_to(x, y, x + r, y);
        pb.close();
        pb.finish().unwrap()
    };

    pixmap.fill_path(
        &path,
        &paint,
        FillRule::Winding,
        Transform::identity(),
        None,
    );
}

fn draw_section(
    pixmap: &mut Pixmap,
    font_cache: &FontCache,
    provider_key: &str,
    day_map: &crate::data::types::DayMap,
    weeks: &[Vec<Option<String>>],
    base_y: u32,
    mode: ColorMode,
) {
    let palette = get_palette(mode);
    let vm = build_provider_section_view_model(provider_key, day_map);
    let theme_cells = get_provider_theme(provider_key, matches!(mode, ColorMode::Dark));
    let grid_w = grid_width(weeks.len());

    let mut y = base_y + SEC_PAD_TOP;

    // Provider name (title)
    font_cache.draw_text(
        pixmap,
        &vm.name,
        text_at(
            LEFT as f32,
            y as f32 + 16.0,
            22.0,
            hex_to_color(palette.title),
            TextAlign::Left,
        ),
    );

    // Header stats (right-aligned columns)
    let col_w = 112;
    let stats_right = LEFT + grid_w;
    for (index, col) in vm.header_stats.iter().enumerate() {
        let cx = stats_right - (vm.header_stats.len() - 1 - index) as u32 * col_w;

        font_cache.draw_text(
            pixmap,
            &col.label,
            text_at(
                cx as f32,
                y as f32 + 4.0,
                9.0,
                hex_to_color(palette.label),
                TextAlign::Center,
            ),
        );

        font_cache.draw_text(
            pixmap,
            &col.value,
            text_at(
                cx as f32,
                y as f32 + 22.0,
                16.0,
                hex_to_color(palette.title),
                TextAlign::Center,
            ),
        );
    }

    y += HEADER_H;

    // Divider line
    let mut paint = Paint::default();
    paint.set_color(hex_to_color(palette.divider));
    pixmap.fill_rect(
        Rect::from_xywh(LEFT as f32, y as f32, grid_w as f32, DIVIDER_H as f32).unwrap(),
        &paint,
        Transform::identity(),
        None,
    );
    y += DIVIDER_H;

    // Month labels
    let mut last_month = -1_i32;
    for (w, week) in weeks.iter().enumerate() {
        if let Some(first) = week.iter().find_map(|d| d.as_ref()) {
            if let Ok(month) = first[5..7].parse::<i32>() {
                let month_idx = month - 1;
                if month_idx != last_month && (0..12).contains(&month_idx) {
                    font_cache.draw_text(
                        pixmap,
                        MONTHS[month_idx as usize],
                        text_at(
                            (LEFT + w as u32 * STEP) as f32,
                            y as f32 + 14.0,
                            11.0,
                            hex_to_color(palette.muted),
                            TextAlign::Left,
                        ),
                    );
                    last_month = month_idx;
                }
            }
        }
    }
    y += MONTH_H;

    // Day labels
    font_cache.draw_text(
        pixmap,
        "Mon",
        text_at(
            (LEFT - 6) as f32,
            (y + STEP) as f32 + CELL as f32,
            10.0,
            hex_to_color(palette.muted),
            TextAlign::Right,
        ),
    );
    font_cache.draw_text(
        pixmap,
        "Wed",
        text_at(
            (LEFT - 6) as f32,
            (y + 3 * STEP) as f32 + CELL as f32,
            10.0,
            hex_to_color(palette.muted),
            TextAlign::Right,
        ),
    );
    font_cache.draw_text(
        pixmap,
        "Fri",
        text_at(
            (LEFT - 6) as f32,
            (y + 5 * STEP) as f32 + CELL as f32,
            10.0,
            hex_to_color(palette.muted),
            TextAlign::Right,
        ),
    );

    // Draw grid cells
    for (w, week) in weeks.iter().enumerate() {
        for (d, date_string) in week.iter().enumerate() {
            let x = LEFT + w as u32 * STEP;
            let cell_y = y + d as u32 * STEP;

            let tokens = if let Some(date) = date_string {
                if let Some(rec) = day_map.get(date) {
                    rec.input_tokens + rec.output_tokens
                } else {
                    0
                }
            } else {
                0
            };

            let level = if date_string.is_some() {
                token_intensity_level(tokens, vm.max_tokens)
            } else {
                0
            };

            let color = hex_to_color(theme_cells[level as usize]);
            rounded_rect(
                pixmap,
                x as f32,
                cell_y as f32,
                CELL as f32,
                CELL as f32,
                2.0,
                color,
            );
        }
    }
    y += GRID_H;

    // Legend
    font_cache.draw_text(
        pixmap,
        "LESS",
        text_at(
            LEFT as f32,
            y as f32 + CELL as f32,
            10.0,
            hex_to_color(palette.muted),
            TextAlign::Left,
        ),
    );

    let lx = LEFT + 38;
    for (offset, level) in (0..=4).enumerate() {
        let color = hex_to_color(theme_cells[level]);
        rounded_rect(
            pixmap,
            (lx + offset as u32 * (CELL + 3)) as f32,
            y as f32,
            CELL as f32,
            CELL as f32,
            2.0,
            color,
        );
    }

    font_cache.draw_text(
        pixmap,
        "MORE",
        text_at(
            (lx + 5 * (CELL + 3) + 4) as f32,
            y as f32 + CELL as f32,
            10.0,
            hex_to_color(palette.muted),
            TextAlign::Left,
        ),
    );
    y += LEGEND_H;

    // Bottom divider
    let mut paint = Paint::default();
    paint.set_color(hex_to_color(palette.divider));
    pixmap.fill_rect(
        Rect::from_xywh(LEFT as f32, y as f32, grid_w as f32, 1.0).unwrap(),
        &paint,
        Transform::identity(),
        None,
    );
    y += 14;

    // Bottom stats
    let b_col_w = grid_w / vm.bottom_stats.len() as u32;
    for (index, stat) in vm.bottom_stats.iter().enumerate() {
        let bx = LEFT + index as u32 * b_col_w;

        font_cache.draw_text(
            pixmap,
            &stat.label,
            text_at(
                bx as f32,
                y as f32 + 12.0,
                9.0,
                hex_to_color(palette.label),
                TextAlign::Left,
            ),
        );

        font_cache.draw_text(
            pixmap,
            &stat.value,
            text_at(
                bx as f32,
                y as f32 + 28.0,
                13.0,
                hex_to_color(palette.value),
                TextAlign::Left,
            ),
        );

        if let Some(ref sub) = stat.sub {
            font_cache.draw_text(
                pixmap,
                sub,
                text_at(
                    bx as f32,
                    y as f32 + 43.0,
                    11.0,
                    hex_to_color(palette.muted),
                    TextAlign::Left,
                ),
            );
        }
    }
}

#[derive(Default)]
pub struct RenderOptions {
    pub dark: bool,
    pub all: bool,
    pub year: Option<u32>,
}

pub fn render_to_png(
    provider_data: &ProviderData,
    options: &RenderOptions,
) -> anyhow::Result<Vec<u8>> {
    let mode = if options.dark {
        ColorMode::Dark
    } else {
        ColorMode::Light
    };
    let palette = get_palette(mode);

    let weeks = build_date_grid(options.year);
    let layout = resolve_provider_layout(
        provider_data,
        &ProviderLayoutOptions {
            all: options.all,
            year: options.year,
        },
    );

    let canvas_pad = 24;
    let total_h = canvas_pad + layout.keys.len() as u32 * SECTION_H + canvas_pad;
    let total_w = total_width(weeks.len());

    let mut pixmap =
        Pixmap::new(total_w, total_h).ok_or_else(|| anyhow::anyhow!("Failed to create pixmap"))?;

    // Fill background
    pixmap.fill(hex_to_color(palette.bg));

    let font_cache = FontCache::new();

    for (index, key) in layout.keys.iter().enumerate() {
        if let Some(day_map) = layout.layout_data.get(key) {
            draw_section(
                &mut pixmap,
                &font_cache,
                key,
                day_map,
                &weeks,
                canvas_pad + index as u32 * SECTION_H,
                mode,
            );
        }
    }

    Ok(pixmap.data().to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hex_to_color() {
        let color = hex_to_color("#ffffff");
        assert_eq!(color.red(), 1.0);
        assert_eq!(color.green(), 1.0);
        assert_eq!(color.blue(), 1.0);
    }

    #[test]
    fn test_render_to_png_empty() {
        let provider_data = ProviderData::new();
        let options = RenderOptions::default();
        let result = render_to_png(&provider_data, &options);
        // Should succeed even with empty data
        assert!(result.is_ok());
    }
}

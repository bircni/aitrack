//! Pieces several screens use: text, cards, segmented buttons, links, switches, icon buttons, meters.

use eframe::egui::{
    self, Align, Color32, CornerRadius, FontFamily, FontId, Frame, Layout, Margin, Rect, Response, RichText, Role,
    Sense, Stroke, StrokeKind, Ui, Vec2, WidgetInfo,
};

use super::icons::{paint_glyph, square, Glyph};
use super::theme::{bold, Palette};

pub fn text(value: impl Into<String>, size: f32, color: Color32) -> RichText {
    RichText::new(value).font(FontId::new(size, FontFamily::Proportional)).color(color)
}

pub fn strong(value: impl Into<String>, size: f32, color: Color32) -> RichText {
    RichText::new(value).font(FontId::new(size, bold())).color(color)
}

/// A figure, in the fixed-width face the heatmap and the terminal set numbers in.
pub fn mono(value: impl Into<String>, size: f32, color: Color32) -> RichText {
    RichText::new(value).font(FontId::new(size, FontFamily::Monospace)).color(color)
}

/// A small spaced-out capital label, as over the heatmap's stats.
pub fn caps(value: &str, color: Color32) -> RichText {
    strong(value.to_uppercase(), 10.0, color).extra_letter_spacing(0.7)
}

/// A block of the popup under a rule; the popup is flat, so rules and not cards part its blocks.
pub fn section<R>(ui: &mut Ui, palette: &Palette, add: impl FnOnce(&mut Ui) -> R) -> R {
    ui.painter().hline(ui.max_rect().x_range(), ui.cursor().top(), Stroke::new(1.0, palette.rule));
    Frame::new()
        .inner_margin(Margin { left: 16, right: 16, top: 14, bottom: 16 })
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            add(ui)
        })
        .inner
}

/// A row of `count` heatmap cells across the available width, coloured by `color`; `mark` outlines one.
pub fn cells(
    ui: &mut Ui,
    palette: &Palette,
    (count, height): (usize, f32),
    color: impl Fn(usize) -> Color32,
    mark: Option<usize>,
) -> Response {
    let (rect, response) = ui.allocate_exact_size(Vec2::new(ui.available_width(), height), Sense::hover());
    #[expect(clippy::cast_precision_loss, reason = "a few dozen cells")]
    let (slots, gaps) = (count.max(1) as f32, count.saturating_sub(1) as f32);
    let width = (rect.width() - 2.0 * gaps) / slots;
    let radius = CornerRadius::same(if height > 6.0 { 2 } else { 1 });
    for index in 0..count {
        #[expect(clippy::cast_precision_loss, reason = "a few dozen cells")]
        let left = rect.left() + index as f32 * (width + 2.0);
        let cell = Rect::from_min_size(egui::pos2(left, rect.top()), Vec2::new(width, height));
        ui.painter().rect_filled(cell, radius, color(index));
        if mark == Some(index) {
            ui.painter().rect_stroke(cell, radius, Stroke::new(1.5, palette.ink), StrokeKind::Outside);
        }
    }
    response
}

/// The colour of cell `index` when the first `filled` of a row are lit along `ramp`, dim to bright.
pub fn ramp_cell(palette: &Palette, ramp: [Color32; 4], filled: usize, index: usize) -> Color32 {
    if index >= filled {
        return palette.track;
    }
    ramp[(index * 4 / filled.max(1)).min(3)]
}

/// How many of `count` cells a share of 0 to 1 lights.
pub fn lit_cells(share: f32, count: usize) -> usize {
    #[expect(
        clippy::cast_precision_loss,
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a share of a few dozen cells, clamped to them first"
    )]
    let lit = (share.clamp(0.0, 1.0) * count as f32).round() as usize;
    lit
}

/// Capital text tabs with a rule under the chosen one.
pub fn caps_tabs<T: Copy + PartialEq>(ui: &mut Ui, palette: &Palette, value: &mut T, options: &[(T, &str)]) -> bool {
    let mut changed = false;
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 18.0;
        for (option, label) in options {
            let selected = *value == *option;
            let color = if selected { palette.ink } else { palette.ink2 };
            let galley = egui::WidgetText::from(caps(label, color)).into_galley(
                ui,
                Some(egui::TextWrapMode::Extend),
                f32::INFINITY,
                egui::TextStyle::Body,
            );
            let (rect, response) = ui.allocate_exact_size(galley.size() + Vec2::new(0.0, 7.0), Sense::click());
            ui.painter().galley(rect.min, galley, color);
            if selected {
                ui.painter().hline(rect.x_range(), rect.bottom() - 1.0, Stroke::new(2.0, palette.ink));
            }
            response.widget_info(|| WidgetInfo::selected(Role::Button, true, selected, *label));
            paint_focus(ui, palette, &response, rect, 3);
            if response.clicked() && !selected {
                *value = *option;
                changed = true;
            }
        }
    });
    changed
}

/// The app icon's ring, filled to `share`, with `label` in its middle.
pub fn ring(ui: &mut Ui, palette: &Palette, share: f32, color: Color32, label: &str) -> Response {
    let (rect, response) = ui.allocate_exact_size(Vec2::splat(68.0), Sense::hover());
    let (center, radius) = (rect.center(), 29.0);
    ui.painter().circle_stroke(center, radius, Stroke::new(8.0, palette.track));
    let steps = 96_u16;
    let end = lit_cells(share, usize::from(steps));
    if end > 0 {
        let points: Vec<egui::Pos2> = (0..=end)
            .map(|step| {
                #[expect(clippy::cast_precision_loss, reason = "at most 96 steps")]
                let turn = step as f32 / f32::from(steps) * std::f32::consts::TAU - std::f32::consts::FRAC_PI_2;
                center + Vec2::angled(turn) * radius
            })
            .collect();
        ui.painter().add(egui::Shape::line(points, Stroke::new(8.0, color)));
    }
    let galley = ui.painter().layout_no_wrap(label.to_owned(), FontId::new(16.0, FontFamily::Monospace), palette.ink);
    ui.painter().galley(center - galley.size() / 2.0, galley, palette.ink);
    response
}

pub fn banner(ui: &mut Ui, palette: &Palette, add: impl FnOnce(&mut Ui)) {
    Frame::new()
        .fill(palette.raised)
        .corner_radius(CornerRadius::same(8))
        .inner_margin(Margin::symmetric(10, 8))
        .outer_margin(Margin { left: 12, right: 12, top: 0, bottom: 12 })
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal_wrapped(|ui| {
                ui.spacing_mut().item_spacing.x = 6.0;
                add(ui);
            });
        });
}

pub fn empty(ui: &mut Ui, palette: &Palette, message: &str) {
    Frame::new().inner_margin(Margin::symmetric(16, 24)).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.vertical_centered(|ui| ui.label(text(message, 12.0, palette.ink3)));
    });
}

/// A text button that underlines on hover.
pub fn link(ui: &mut Ui, palette: &Palette, label: &str, enabled: bool) -> Response {
    let color = if enabled { palette.ink } else { palette.ink3 };
    let galley = ui.painter().layout_no_wrap(label.into(), FontId::new(12.0, bold()), color);
    let (rect, response) = ui.allocate_exact_size(galley.size(), if enabled { Sense::click() } else { Sense::hover() });
    let response = response.on_hover_cursor(egui::CursorIcon::PointingHand);
    ui.painter().galley(rect.min, galley, color);
    if enabled && response.hovered() {
        let y = rect.bottom() + 1.0;
        ui.painter().hline(rect.x_range(), y, Stroke::new(1.0, color));
    }
    response.widget_info(|| WidgetInfo::labeled(Role::Button, enabled, label));
    paint_focus(ui, palette, &response, rect, 3);
    response
}

pub fn paint_focus(ui: &Ui, palette: &Palette, response: &Response, rect: Rect, radius: u8) {
    if response.has_focus() {
        ui.painter().rect_stroke(
            rect.expand(2.0),
            CornerRadius::same(radius),
            Stroke::new(2.0, palette.focus),
            StrokeKind::Outside,
        );
    }
}

/// The renderer's `.seg` control: one pressed option among a few. Measured first, so it takes only its
/// own width in any layout direction.
pub fn segmented<T: Copy + PartialEq>(ui: &mut Ui, palette: &Palette, value: &mut T, options: &[(T, &str)]) -> bool {
    let font = FontId::new(11.5, FontFamily::Proportional);
    let galleys: Vec<_> = options
        .iter()
        .map(|(_, label)| ui.painter().layout_no_wrap((*label).into(), font.clone(), palette.ink))
        .collect();
    let widths: Vec<f32> = galleys.iter().map(|g| g.size().x + 12.0).collect();
    let height = galleys.iter().map(|g| g.size().y).fold(0.0, f32::max) + 4.0;
    let base = ui.next_auto_id();
    let (outer, _) = ui.allocate_exact_size(Vec2::new(widths.iter().sum::<f32>() + 4.0, height + 4.0), Sense::hover());
    ui.painter().rect_filled(outer, CornerRadius::same(7), palette.raised);
    let mut changed = false;
    let mut x = outer.left() + 2.0;
    for ((option, label), (galley, width)) in options.iter().zip(galleys.into_iter().zip(widths)) {
        let rect = Rect::from_min_size(egui::pos2(x, outer.top() + 2.0), Vec2::new(width, height));
        x += width;
        let response = ui.interact(rect, base.with(*label), Sense::click());
        let selected = *value == *option;
        if selected {
            ui.painter().rect(
                rect,
                CornerRadius::same(5),
                palette.surface,
                Stroke::new(1.0, palette.edge),
                StrokeKind::Inside,
            );
        }
        let color = if selected { palette.ink } else { palette.ink2 };
        ui.painter().galley_with_override_text_color(rect.center() - galley.size() / 2.0, galley, color);
        response.widget_info(|| WidgetInfo::selected(Role::Button, true, selected, *label));
        paint_focus(ui, palette, &response, rect, 5);
        if response.clicked() && !selected {
            *value = *option;
            changed = true;
        }
    }
    changed
}

/// A square icon button; `rotation` turns the glyph, e.g. while refreshing.
#[derive(Clone, Copy)]
pub struct IconButton<'a> {
    pub glyph: Glyph,
    pub label: &'a str,
    pub enabled: bool,
    pub active: bool,
    pub rotation: f32,
    pub size: f32,
}

impl<'a> IconButton<'a> {
    pub const fn new(glyph: Glyph, label: &'a str) -> Self {
        Self { glyph, label, enabled: true, active: false, rotation: 0.0, size: 28.0 }
    }
}

pub fn icon_button(ui: &mut Ui, palette: &Palette, button: IconButton<'_>) -> Response {
    let IconButton { glyph, label, enabled, active, rotation, size } = button;
    let (rect, response) =
        ui.allocate_exact_size(Vec2::splat(size), if enabled { Sense::click() } else { Sense::hover() });
    let hovered = enabled && response.hovered();
    if hovered || active {
        ui.painter().rect_filled(rect, CornerRadius::same(8), palette.raised);
    }
    let color = if !enabled {
        palette.ink2.gamma_multiply(0.4)
    } else if hovered || active {
        palette.ink
    } else {
        palette.ink2
    };
    paint_glyph(ui.painter(), square(rect.center(), size * 0.55), glyph, color, rotation);
    response.widget_info(|| WidgetInfo::labeled(Role::Button, enabled, label));
    paint_focus(ui, palette, &response, rect, 8);
    response.on_hover_text(label)
}

/// An on/off switch, with `label` for screen readers.
pub fn switch(ui: &mut Ui, palette: &Palette, on: &mut bool, label: &str) -> bool {
    let size = Vec2::new(30.0, 18.0);
    let (rect, mut response) = ui.allocate_exact_size(size, Sense::click());
    if response.clicked() {
        *on = !*on;
        response.mark_changed();
    }
    let how_on = ui.ctx().animate_bool_with_time(response.id, *on, 0.16);
    let track = Palette::mix(palette.ok, how_on, palette.track);
    ui.painter().rect_filled(rect, CornerRadius::same(9), track);
    let x = egui::lerp((rect.left() + 9.0)..=(rect.right() - 9.0), how_on);
    ui.painter().circle_filled(egui::pos2(x, rect.center().y), 7.0, Color32::WHITE);
    response.widget_info(|| WidgetInfo::selected(Role::Switch, true, *on, label));
    paint_focus(ui, palette, &response, rect, 9);
    response.changed()
}

/// Two labels at either end of a row, the left one cut short when they meet.
pub fn spread(ui: &mut Ui, left: RichText, right: RichText) {
    ui.horizontal(|ui| {
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            ui.label(right);
            ui.with_layout(Layout::left_to_right(Align::Center), |ui| ui.add(egui::Label::new(left).truncate()));
        });
    });
}

/// A label in a column `width` wide, at its left or right edge, so what follows lines up row to row.
pub fn fixed(ui: &mut Ui, width: f32, align: Align, label: RichText) {
    let layout =
        if align == Align::Max { Layout::right_to_left(Align::Center) } else { Layout::left_to_right(Align::Center) };
    ui.allocate_ui_with_layout(Vec2::new(width, 16.0), layout, |ui| {
        ui.set_min_width(width);
        ui.add(egui::Label::new(label).truncate());
    });
}

/// The animation angle `time * rate`, wrapped to one turn in f64 so long uptimes stay smooth in f32.
pub fn phase(ui: &Ui, rate: f64) -> f32 {
    let turn = (ui.input(|i| i.time) * rate).rem_euclid(std::f64::consts::TAU);
    #[expect(clippy::cast_possible_truncation, reason = "wrapped to [0, 2π), which f32 holds")]
    let turn = turn as f32;
    turn
}

/// One turn every 0.9 s, for the refresh spinners.
pub fn spin_angle(ui: &Ui) -> f32 {
    phase(ui, std::f64::consts::TAU / 0.9)
}

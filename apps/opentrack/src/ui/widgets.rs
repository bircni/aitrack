//! Pieces several screens use: text, cards, segmented buttons, links, switches, icon buttons, meters.

use eframe::egui::{
    self, Align, Color32, CornerRadius, FontFamily, FontId, Frame, Layout, Margin, Rect, Response, RichText, Role,
    Sense, Shadow, Stroke, StrokeKind, Ui, Vec2, WidgetInfo,
};

use super::icons::{paint_glyph, square, Glyph};
use super::theme::{bold, Palette};

pub fn text(value: impl Into<String>, size: f32, color: Color32) -> RichText {
    RichText::new(value).font(FontId::new(size, FontFamily::Proportional)).color(color)
}

pub fn strong(value: impl Into<String>, size: f32, color: Color32) -> RichText {
    RichText::new(value).font(FontId::new(size, bold())).color(color)
}

pub fn card<R>(ui: &mut Ui, palette: &Palette, add: impl FnOnce(&mut Ui) -> R) -> R {
    Frame::new()
        .fill(palette.card)
        .stroke(Stroke::new(1.0, palette.edge))
        .corner_radius(CornerRadius::same(14))
        .shadow(Shadow { offset: [0, 2], blur: 8, spread: 0, color: Color32::from_black_alpha(6) })
        .inner_margin(Margin::same(14))
        .outer_margin(Margin { left: 12, right: 12, top: 0, bottom: 10 })
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            add(ui)
        })
        .inner
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
        let right_width = ui.painter().layout_no_wrap(right.text().into(), FontId::default(), Color32::WHITE).size().x;
        ui.add_sized(
            [ui.available_width() - right_width - 12.0, 16.0],
            egui::Label::new(left).truncate().halign(Align::Min),
        );
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| ui.label(right));
    });
}

/// A stacked bar of `(fraction, colour)` parts on a track.
pub fn stacked_bar(ui: &mut Ui, palette: &Palette, parts: &[(f32, Color32)], height: f32, width: f32) {
    let (rect, _) = ui.allocate_exact_size(Vec2::new(width, height), Sense::hover());
    let radius = CornerRadius::same(u8::try_from((height / 2.0).round() as i32).unwrap_or(3));
    ui.painter().rect_filled(rect, radius, palette.track);
    let mut x = rect.left();
    let clip = ui.painter().with_clip_rect(rect);
    for (fraction, color) in parts {
        let w = rect.width() * fraction.clamp(0.0, 1.0);
        clip.rect_filled(
            Rect::from_min_size(egui::pos2(x, rect.top()), Vec2::new(w, height)),
            CornerRadius::ZERO,
            *color,
        );
        x += w;
    }
}

/// A rule across the section, with the room below it a new block starts after.
pub fn divider(ui: &mut Ui, palette: &Palette) {
    ui.painter().hline(ui.max_rect().x_range(), ui.cursor().top(), Stroke::new(1.0, palette.rule));
    ui.add_space(12.0);
}

/// One turn every 0.9 s, for the refresh spinners.
pub fn spin_angle(ui: &Ui) -> f32 {
    #[expect(clippy::cast_possible_truncation, reason = "the value is rounded and bounded to the target range first")]
    let time = ui.input(|i| i.time) as f32;
    time * std::f32::consts::TAU / 0.9
}

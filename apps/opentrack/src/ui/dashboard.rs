//! The tab bar, the Limits tab with its status line and provider cards, and the compact view.

use aitrack_core::quota::pacing::{project_pace, PaceProjection, PaceSeverity};
use aitrack_core::quota::{QuotaFormat, QuotaWindow};
use eframe::egui::{
    self, Align, Color32, CornerRadius, FontId, Frame as EguiFrame, Layout, Margin, Pos2, Rect, Response, Role, Sense,
    Shape, Stroke, StrokeKind, Ui, Vec2, WidgetInfo,
};

use super::format::{
    fill_percent, format_cost, format_limit_value, format_number, format_reset, format_updated, is_primary_limit,
    limit_label, limit_status, pace_label, problem_line, usage_availability, usage_note, Availability, ProblemAction,
};
use super::theme::Palette;
use super::widgets::{card, empty, link, paint_focus, spin_angle, spread, strong, text};
use super::{retry_banner, views, Action, Frame, Model, Tab, View};
use crate::pace::{has_reset, meter_tone, Tone};
use crate::settings::Settings;
use crate::state::ProviderState;

const NO_PACE: PaceProjection = PaceProjection {
    severity: PaceSeverity::Level,
    projected_used_percent: None,
    even_pace_percent: None,
    run_out_at: None,
};

pub const TABS: [(Tab, &str); 2] = [(Tab::Limits, "Limits"), (Tab::Usage, "Usage")];

pub fn show(ui: &mut Ui, view: &mut View, model: &Model<'_>, frame: &mut Frame<'_>) {
    let palette = frame.palette;
    let state = model.state;
    let availability = usage_availability(state);
    ui.add_space(12.0);
    if availability == Availability::Off {
        empty(ui, &palette, &format!("{}. Choose some in Settings.", usage_note(Availability::Off)));
        return;
    }
    tab_bar(ui, view, &palette);
    if let Some(error) = &state.pull_error {
        retry_banner(ui, frame, error, || Action::Refresh);
    }
    if let Some(result) = state.sync_result.as_ref().filter(|r| !r.ok) {
        retry_banner(ui, frame, format!("Sync failed: {}", result.message), || Action::Sync);
    }
    match view.tab {
        Tab::Limits => {
            status(ui, model, &palette);
            for provider in &state.providers {
                provider_card(ui, model, frame, provider);
            }
        }
        Tab::Usage => views::usage(ui, view, model, frame, availability),
    }
}

fn tab_bar(ui: &mut Ui, view: &mut View, palette: &Palette) {
    EguiFrame::new()
        .fill(palette.raised)
        .corner_radius(CornerRadius::same(9))
        .inner_margin(Margin::same(2))
        .outer_margin(Margin { left: 12, right: 12, top: 0, bottom: 12 })
        .show(ui, |ui| {
            ui.spacing_mut().item_spacing.x = 2.0;
            let width = (ui.available_width() - 2.0) / 2.0;
            ui.horizontal(|ui| {
                for (tab, label) in TABS {
                    let selected = view.tab == tab;
                    let (rect, response) = ui.allocate_exact_size(Vec2::new(width, 26.0), Sense::click());
                    if selected {
                        ui.painter().rect(
                            rect,
                            CornerRadius::same(7),
                            palette.card,
                            Stroke::new(1.0, palette.edge),
                            StrokeKind::Inside,
                        );
                    }
                    let color = if selected { palette.ink } else { palette.ink2 };
                    let galley =
                        ui.painter().layout_no_wrap(label.to_owned(), FontId::new(13.0, super::theme::bold()), color);
                    ui.painter().galley(rect.center() - galley.size() / 2.0, galley, color);
                    response.widget_info(|| WidgetInfo::selected(Role::Button, true, selected, label));
                    paint_focus(ui, palette, &response, rect, 7);
                    if response.clicked() {
                        view.tab = tab;
                    }
                }
            });
        });
}

const fn tone_dot(palette: &Palette, tone: Tone) -> Color32 {
    match tone {
        Tone::Neutral | Tone::Calm => palette.ok,
        Tone::Warn => palette.warn,
        Tone::Crit => palette.crit,
    }
}

/// The one line that says whether any limit needs attention, so the popup can be closed after it.
fn status(ui: &mut Ui, model: &Model<'_>, palette: &Palette) {
    let relative = model.settings.reset_display == "relative";
    let Some(status) = limit_status(model.clock, &model.state.providers, model.now, relative) else { return };
    EguiFrame::new().inner_margin(Margin { left: 16, right: 16, top: 2, bottom: 14 }).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.horizontal_top(|ui| {
            ui.spacing_mut().item_spacing.x = 10.0;
            let (dot, _) = ui.allocate_exact_size(Vec2::new(8.0, 18.0), Sense::hover());
            ui.painter().circle_filled(dot.center(), 4.0, tone_dot(palette, status.tone));
            ui.vertical(|ui| {
                ui.spacing_mut().item_spacing.y = 3.0;
                ui.add(egui::Label::new(strong(&status.title, 14.0, palette.ink)).wrap());
                if let Some(detail) = &status.detail {
                    ui.add(egui::Label::new(text(detail, 11.0, palette.ink2)).wrap());
                }
            });
        });
    });
}

pub fn mark(ui: &mut Ui, frame: &Frame<'_>, key: &str, size: f32) {
    let (rect, _) = ui.allocate_exact_size(Vec2::splat(size), Sense::hover());
    let color = if key == "claude_code" { frame.palette.claude } else { frame.palette.ink };
    frame.marks.paint(ui.painter(), rect, key, color);
}

fn provider_card(ui: &mut Ui, model: &Model<'_>, frame: &mut Frame<'_>, provider: &ProviderState) {
    let palette = frame.palette;
    card(ui, &palette, |ui| {
        ui.spacing_mut().item_spacing.y = 14.0;
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 8.0;
            mark(ui, frame, &provider.key, 16.0);
            ui.label(strong(&provider.label, 13.0, palette.ink));
            if provider.refreshing {
                busy_dot(ui, &palette);
            }
            if let Some(plan) = provider.quota.as_ref().and_then(|q| q.plan.as_deref()) {
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| ui.label(text(plan, 11.0, palette.ink2)));
            }
        });

        if let (Some(_), Some(quota)) = (&provider.quota_error, &provider.quota) {
            ui.label(text(
                format!("Cached limits: {}", format_updated(model.clock, Some(&quota.fetched_at), model.now)),
                11.0,
                palette.ink2,
            ));
        }
        if let Some(error) = &provider.quota_error {
            let (line, action) = problem_line(error, model.now, provider.retry_at);
            ui.horizontal_wrapped(|ui| {
                ui.spacing_mut().item_spacing.x = 6.0;
                let label = ui.label(text(&line, 11.0, palette.ink2));
                if line != error.message {
                    label.on_hover_text(&error.message);
                }
                match action {
                    ProblemAction::Retry => {
                        if link(ui, &palette, "Retry", true).clicked() {
                            frame.act(Action::Refresh);
                        }
                    }
                    ProblemAction::Dashboard => {
                        if link(ui, &palette, "Open dashboard", true).clicked() {
                            frame.act(Action::OpenDashboard(provider.key.clone()));
                        }
                    }
                }
            });
        }
        let stale = provider.quota_error.is_some();
        let windows = provider.quota.as_ref().map(|q| q.windows.as_slice()).unwrap_or_default();
        for window in windows.iter().filter(|w| is_primary_limit(w)) {
            limit_meter(ui, model, frame, &provider.key, window, stale);
        }
        let values = provider.quota.as_ref().map(|q| q.values.as_slice()).unwrap_or_default();
        if windows.iter().any(|w| !is_primary_limit(w)) || !values.is_empty() {
            ui.vertical(|ui| {
                ui.spacing_mut().item_spacing.y = 6.0;
                if windows.iter().any(is_primary_limit) {
                    ui.painter().hline(ui.max_rect().x_range(), ui.cursor().top(), Stroke::new(1.0, palette.rule));
                    ui.add_space(4.0);
                }
                for window in windows.iter().filter(|w| !is_primary_limit(w)) {
                    small_limit(ui, model, &palette, window, stale);
                }
                for value in values {
                    let shown = if value.format == QuotaFormat::Dollars {
                        format_cost(value.value)
                    } else {
                        format_number(value.value)
                    };
                    spread(ui, text(&value.label, 12.0, palette.ink2), strong(shown, 12.0, palette.ink));
                }
            });
        }
        if provider.quota.is_none() && provider.quota_error.is_none() {
            ui.label(text("Checking limits…", 11.0, palette.ink2));
        }
    });
}

fn busy_dot(ui: &mut Ui, palette: &Palette) {
    let (rect, response) = ui.allocate_exact_size(Vec2::splat(10.0), Sense::hover());
    let start = spin_angle(ui);
    let points: Vec<Pos2> = (0..=18u8)
        .map(|i| {
            let theta = start + f32::from(i) / 24.0 * std::f32::consts::TAU;
            rect.center() + Vec2::angled(theta) * 4.25
        })
        .collect();
    ui.painter().add(Shape::line(points, Stroke::new(1.5, palette.ink3)));
    response.widget_info(|| WidgetInfo::labeled(Role::ProgressIndicator, true, "Refreshing"));
    ui.ctx().request_repaint_after(std::time::Duration::from_millis(16));
}

/// How a limit reads right now, worked out the same way for every size it is drawn at.
struct Reading {
    value: String,
    fill: f32,
    color: Color32,
    tone: Tone,
    /// Where usage would be if it were spent evenly, as a share of the bar.
    even: Option<f32>,
    pace: Option<String>,
    reset: Option<String>,
    state: Option<String>,
}

impl Reading {
    fn new(model: &Model<'_>, palette: &Palette, window: &QuotaWindow, stale: bool) -> Self {
        let settings: &Settings = model.settings;
        let left = settings.display == "left";
        let past = has_reset(model.clock, window, model.now);
        let pace = if stale || past { NO_PACE } else { project_pace(window, model.now) };
        let tone = if past { Tone::Calm } else { meter_tone(window, &pace) };
        let label = pace_label(&pace, model.now, model.clock.zone());
        #[expect(clippy::cast_possible_truncation, reason = "a percentage of at most 100, drawn in f32")]
        let share = |percent: f64| (percent.clamp(0.0, 100.0) / 100.0) as f32;
        // Colour is kept for a limit that needs attention; a calm one is plain ink.
        let color = match tone {
            _ if past => palette.ink3,
            Tone::Neutral | Tone::Calm => palette.meter,
            Tone::Warn => palette.warn,
            Tone::Crit => palette.crit,
        };
        let state = if past {
            Some("reset passed".to_owned())
        } else if stale {
            Some("cached".into())
        } else {
            label.as_deref().map(str::to_lowercase)
        };
        Self {
            value: format_limit_value(window, left),
            fill: share(fill_percent(window, left)),
            color,
            tone,
            even: label.as_ref().and(pace.even_pace_percent).map(|even| share(if left { 100.0 - even } else { even })),
            pace: label,
            reset: format_reset(
                model.clock,
                window.resets_at.as_deref(),
                model.now,
                settings.reset_display == "relative",
            ),
            state,
        }
    }

    fn describe(&self, window: &QuotaWindow, display: &str) -> String {
        let reading =
            [Some(self.value.as_str()), self.state.as_deref()].into_iter().flatten().collect::<Vec<_>>().join(", ");
        format!("{} {display}: {reading}", limit_label(window))
    }
}

/// A rounded bar filled to `fill`, with the even-pace tick when there is one.
fn bar(ui: &mut Ui, palette: &Palette, size: Vec2, fill: f32, color: Color32, even: Option<f32>) -> Response {
    let (rect, response) = ui.allocate_exact_size(size, Sense::hover());
    let radius = CornerRadius::from(size.y / 2.0);
    ui.painter().rect_filled(rect, radius, palette.track);
    ui.painter().rect_filled(
        Rect::from_min_size(rect.min, Vec2::new(rect.width() * fill, rect.height())),
        radius,
        color,
    );
    if let Some(even) = even {
        let x = rect.left() + rect.width() * even;
        ui.painter().vline(x, (rect.top() - 2.0)..=(rect.bottom() + 2.0), Stroke::new(1.5, palette.ink2));
    }
    response
}

pub fn limit_meter(
    ui: &mut Ui,
    model: &Model<'_>,
    frame: &mut Frame<'_>,
    provider: &str,
    window: &QuotaWindow,
    stale: bool,
) {
    let palette = frame.palette;
    let settings: &Settings = model.settings;
    let left = settings.display == "left";
    let reading = Reading::new(model, &palette, window, stale);
    ui.vertical(|ui| {
        ui.spacing_mut().item_spacing.y = 6.0;
        ui.horizontal(|ui| {
            ui.label(text(limit_label(window), 13.0, palette.ink));
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                let response = ui
                    .add(egui::Label::new(strong(&reading.value, 13.0, palette.ink)).sense(Sense::click()))
                    .on_hover_text("Show used or left");
                if response.clicked() {
                    frame.patch(settings, |s| s.display = if left { "used".into() } else { "left".into() });
                }
            });
        });
        let id = ui.scope_id().with((provider, &window.id));
        let shown = ui.ctx().animate_value_with_time(id, reading.fill, 0.22);
        let size = Vec2::new(ui.available_width(), 6.0);
        let response = bar(ui, &palette, size, shown, reading.color, reading.even);
        response.widget_info(|| {
            WidgetInfo::labeled(Role::ProgressIndicator, true, reading.describe(window, &settings.display))
        });
        if reading.reset.is_some() || reading.pace.is_some() {
            ui.horizontal(|ui| {
                if let Some(reset) = &reading.reset {
                    let response = ui
                        .add(egui::Label::new(text(reset, 11.0, palette.ink2)).sense(Sense::click()))
                        .on_hover_text("Show time or countdown");
                    if response.clicked() {
                        let relative = settings.reset_display == "relative";
                        frame.patch(settings, |s| {
                            s.reset_display = if relative { "absolute".into() } else { "relative".into() }
                        });
                    }
                }
                if let Some(pace) = &reading.pace {
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        ui.label(text(pace, 11.0, palette.tone_text(reading.tone)));
                    });
                }
            });
        }
    });
}

/// A limit that rarely decides anything, on one line; its reset and pace are in the tooltip.
fn small_limit(ui: &mut Ui, model: &Model<'_>, palette: &Palette, window: &QuotaWindow, stale: bool) {
    let reading = Reading::new(model, palette, window, stale);
    let row = ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 10.0;
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            ui.add_sized(
                [96.0, 16.0],
                egui::Label::new(strong(&reading.value, 12.0, palette.ink)).truncate().halign(Align::Max),
            );
            let response = bar(ui, palette, Vec2::new(64.0, 4.0), reading.fill, reading.color, None);
            response.widget_info(|| {
                WidgetInfo::labeled(Role::ProgressIndicator, true, reading.describe(window, &model.settings.display))
            });
            ui.with_layout(Layout::left_to_right(Align::Center), |ui| {
                ui.add(egui::Label::new(text(limit_label(window), 12.0, palette.ink2)).truncate());
            });
        });
    });
    let note: Vec<&str> = [reading.reset.as_deref(), reading.pace.as_deref()].into_iter().flatten().collect();
    if !note.is_empty() {
        row.response.on_hover_text(note.join(" · "));
    }
}

pub fn compact(ui: &mut Ui, model: &Model<'_>, frame: &Frame<'_>) {
    let palette = frame.palette;
    let providers = &model.state.providers;
    if providers.is_empty() {
        empty(ui, &palette, "No providers are turned on.");
        return;
    }
    EguiFrame::new().inner_margin(Margin { left: 16, right: 16, top: 14, bottom: 8 }).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.spacing_mut().item_spacing.y = 10.0;
        for provider in providers {
            let windows = provider.quota.as_ref().map(|q| q.windows.as_slice()).unwrap_or_default();
            let window = windows
                .iter()
                .find(|w| w.id == "session")
                .or_else(|| windows.iter().find(|w| w.id == "weekly"))
                .or_else(|| windows.first());
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 8.0;
                mark(ui, frame, &provider.key, 14.0);
                ui.add_sized(
                    [84.0, 16.0],
                    egui::Label::new(strong(&provider.label, 12.0, palette.ink)).truncate().halign(Align::Min),
                );
                match (window, &provider.quota_error) {
                    (Some(window), error) => compact_meter(ui, model, &palette, window, error.is_some()),
                    (None, Some(error)) => {
                        let line = problem_line(error, model.now, provider.retry_at).0;
                        ui.add(egui::Label::new(text(line, 11.0, palette.ink2)).truncate());
                    }
                    (None, None) => {
                        ui.label(text("No limits yet.", 11.0, palette.ink2));
                    }
                }
            });
        }
        let relative = model.settings.reset_display == "relative";
        let urgent = limit_status(model.clock, providers, model.now, relative).filter(|s| s.tone > Tone::Calm);
        if let Some(status) = urgent {
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 8.0;
                let (dot, _) = ui.allocate_exact_size(Vec2::new(8.0, 16.0), Sense::hover());
                ui.painter().circle_filled(dot.center(), 4.0, tone_dot(&palette, status.tone));
                ui.add(egui::Label::new(text(&status.title, 12.0, palette.tone_text(status.tone))).truncate());
            });
        }
    });
}

fn compact_meter(ui: &mut Ui, model: &Model<'_>, palette: &Palette, window: &QuotaWindow, stale: bool) {
    let reading = Reading::new(model, palette, window, stale);
    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
        let reset = reading.reset.as_deref().map_or("", |reset| reset.strip_prefix("Resets ").unwrap_or(reset));
        ui.add_sized([72.0, 16.0], egui::Label::new(text(reset, 11.0, palette.ink2)).truncate().halign(Align::Max));
        ui.add_sized(
            [38.0, 16.0],
            egui::Label::new(strong(&reading.value, 12.0, palette.ink)).truncate().halign(Align::Max),
        );
        let size = Vec2::new(ui.available_width(), 6.0);
        let response = bar(ui, palette, size, reading.fill, reading.color, reading.even);
        response.widget_info(|| {
            WidgetInfo::labeled(Role::ProgressIndicator, true, reading.describe(window, &model.settings.display))
        });
    });
}

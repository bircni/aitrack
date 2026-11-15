//! The tabs, the Limits tab with its ring and each provider's limits in heatmap cells, and the compact view.

use aitrack_core::quota::pacing::{project_pace, PaceProjection, PaceSeverity};
use aitrack_core::quota::{QuotaFormat, QuotaWindow};
use eframe::egui::{
    self, Align, Color32, Frame as EguiFrame, Layout, Margin, Pos2, Role, Sense, Shape, Stroke, Ui, Vec2, WidgetInfo,
};

use super::format::{
    fill_percent, format_cost, format_limit_value, format_number, format_percent, format_reset, format_updated,
    is_primary_limit, limit_label, limit_status, pace_label, problem_line, usage_availability, usage_note,
    Availability, ProblemAction,
};
use super::theme::Palette;
use super::widgets::{
    caps, caps_tabs, cells, empty, fixed, link, lit_cells, mono, ramp_cell, ring, section, spin_angle, spread, strong,
    text,
};
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

/// A full limit's row of cells, and a one-line limit's.
const CELLS: usize = 28;
const SMALL_CELLS: usize = 14;

pub fn show(ui: &mut Ui, view: &mut View, model: &Model<'_>, frame: &mut Frame<'_>) {
    let palette = frame.palette;
    let state = model.state;
    let availability = usage_availability(state);
    ui.add_space(14.0);
    if availability == Availability::Off {
        empty(ui, &palette, &format!("{}. Choose some in Settings.", usage_note(Availability::Off)));
        return;
    }
    EguiFrame::new().inner_margin(Margin { left: 16, right: 16, top: 0, bottom: 0 }).show(ui, |ui| {
        caps_tabs(ui, &palette, &mut view.tab, &TABS);
    });
    if state.pull_error.is_some() || state.sync_result.as_ref().is_some_and(|r| !r.ok) {
        ui.add_space(10.0);
    }
    if let Some(error) = &state.pull_error {
        retry_banner(ui, frame, error, || Action::Refresh);
    }
    if let Some(result) = state.sync_result.as_ref().filter(|r| !r.ok) {
        retry_banner(ui, frame, format!("Sync failed: {}", result.message), || Action::Sync);
    }
    match view.tab {
        Tab::Limits => {
            hero(ui, model, &palette);
            for provider in &state.providers {
                provider_limits(ui, model, frame, provider);
            }
        }
        Tab::Usage => views::usage(ui, view, model, frame, availability),
    }
}

const fn tone_dot(palette: &Palette, tone: Tone) -> Color32 {
    match tone {
        Tone::Neutral | Tone::Calm => palette.ok,
        Tone::Warn => palette.warn,
        Tone::Crit => palette.crit,
    }
}

/// The app's ring, filled to the limit that matters most, and what to make of it.
fn hero(ui: &mut Ui, model: &Model<'_>, palette: &Palette) {
    let relative = model.settings.reset_display == "relative";
    let Some(status) = limit_status(model.clock, &model.state.providers, model.now, relative) else { return };
    section(ui, palette, |ui| {
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 14.0;
            #[expect(clippy::cast_possible_truncation, reason = "a percentage of at most 100, drawn in f32")]
            let share = (status.used_percent / 100.0) as f32;
            let color = palette.tone_ramp(status.tone, &status.provider)[2];
            let label = format_percent(status.used_percent / 100.0);
            let response = ring(ui, palette, share, color, label.trim_end_matches('%'));
            response.widget_info(|| {
                WidgetInfo::labeled(Role::ProgressIndicator, true, format!("{} {label} used", status.name))
            });
            ui.vertical(|ui| {
                ui.spacing_mut().item_spacing.y = 4.0;
                ui.add(egui::Label::new(caps(&status.name, palette.ink2)).wrap());
                let color = if status.tone > Tone::Calm { palette.tone_text(status.tone) } else { palette.ink };
                ui.add(egui::Label::new(strong(&status.title, 16.0, color)).wrap());
                if let Some(detail) = &status.detail {
                    ui.label(text(detail, 11.0, palette.ink2));
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

fn provider_limits(ui: &mut Ui, model: &Model<'_>, frame: &mut Frame<'_>, provider: &ProviderState) {
    let palette = frame.palette;
    section(ui, &palette, |ui| {
        ui.spacing_mut().item_spacing.y = 12.0;
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 8.0;
            mark(ui, frame, &provider.key, 16.0);
            ui.label(strong(&provider.label, 14.0, palette.ink));
            if provider.refreshing {
                busy_dot(ui, &palette);
            }
            if let Some(plan) = provider.quota.as_ref().and_then(|q| q.plan.as_deref()) {
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| ui.label(caps(plan, palette.ink2)));
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
                for window in windows.iter().filter(|w| !is_primary_limit(w)) {
                    small_limit(ui, model, &palette, &provider.key, window, stale);
                }
                for value in values {
                    let shown = if value.format == QuotaFormat::Dollars {
                        format_cost(value.value)
                    } else {
                        format_number(value.value)
                    };
                    spread(ui, text(&value.label, 12.0, palette.ink2), mono(shown, 11.0, palette.ink));
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
    /// The colours its cells light along: the provider's own while calm.
    ramp: [Color32; 4],
    tone: Tone,
    /// Where usage would be if it were spent evenly, as a share of the row.
    even: Option<f32>,
    pace: Option<String>,
    reset: Option<String>,
    state: Option<String>,
}

impl Reading {
    fn new(model: &Model<'_>, palette: &Palette, provider: &str, window: &QuotaWindow, stale: bool) -> Self {
        let settings: &Settings = model.settings;
        let left = settings.display == "left";
        let past = has_reset(model.clock, window, model.now);
        let pace = if stale || past { NO_PACE } else { project_pace(window, model.now) };
        let tone = if past { Tone::Calm } else { meter_tone(window, &pace) };
        let label = pace_label(&pace, model.now, model.clock.zone());
        #[expect(clippy::cast_possible_truncation, reason = "a percentage of at most 100, drawn in f32")]
        let share = |percent: f64| (percent.clamp(0.0, 100.0) / 100.0) as f32;
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
            ramp: if past { [palette.ink3; 4] } else { palette.tone_ramp(tone, provider) },
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

    /// The row of cells, lit to `fill`; the even-pace cell is outlined when `paced`.
    fn cells(&self, ui: &mut Ui, palette: &Palette, (count, height): (usize, f32), fill: f32, paced: bool) {
        let lit = lit_cells(fill, count);
        let mark = self.even.filter(|_| paced).map(|even| lit_cells(even, count).saturating_sub(1));
        cells(ui, palette, (count, height), |index| ramp_cell(palette, self.ramp, lit, index), mark);
    }
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
    let reading = Reading::new(model, &palette, provider, window, stale);
    let row = ui.vertical(|ui| {
        ui.spacing_mut().item_spacing.y = 6.0;
        ui.horizontal(|ui| {
            ui.label(text(limit_label(window), 13.0, palette.ink));
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                let response = ui
                    .add(egui::Label::new(mono(&reading.value, 12.0, palette.ink)).sense(Sense::click()))
                    .on_hover_text("Show used or left");
                if response.clicked() {
                    frame.patch(settings, |s| s.display = if left { "used".into() } else { "left".into() });
                }
            });
        });
        let id = ui.scope_id().with((provider, &window.id));
        let shown = ui.ctx().animate_value_with_time(id, reading.fill, 0.22);
        reading.cells(ui, &palette, (CELLS, 9.0), shown, true);
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
    row.response.widget_info(|| {
        WidgetInfo::labeled(Role::ProgressIndicator, true, reading.describe(window, &settings.display))
    });
}

/// A limit that rarely decides anything, on one line; its reset and pace are in the tooltip.
fn small_limit(ui: &mut Ui, model: &Model<'_>, palette: &Palette, provider: &str, window: &QuotaWindow, stale: bool) {
    let reading = Reading::new(model, palette, provider, window, stale);
    let row = ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 10.0;
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            fixed(ui, 104.0, Align::Max, mono(&reading.value, 11.0, palette.ink));
            ui.allocate_ui(Vec2::new(96.0, 5.0), |ui| {
                reading.cells(ui, palette, (SMALL_CELLS, 5.0), reading.fill, false);
            });
            ui.with_layout(Layout::left_to_right(Align::Center), |ui| {
                ui.add(egui::Label::new(text(limit_label(window), 12.0, palette.ink2)).truncate());
            });
        });
    });
    row.response.widget_info(|| {
        WidgetInfo::labeled(Role::ProgressIndicator, true, reading.describe(window, &model.settings.display))
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
                fixed(ui, 84.0, Align::Min, strong(&provider.label, 12.0, palette.ink));
                match (window, &provider.quota_error) {
                    (Some(window), error) => {
                        let reading = Reading::new(model, &palette, &provider.key, window, error.is_some());
                        compact_meter(ui, model, &palette, window, &reading);
                    }
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
                ui.add(egui::Label::new(text(status.line(), 12.0, palette.tone_text(status.tone))).truncate());
            });
        }
    });
}

fn compact_meter(ui: &mut Ui, model: &Model<'_>, palette: &Palette, window: &QuotaWindow, reading: &Reading) {
    let row = ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
        let reset = reading.reset.as_deref().map_or("", |reset| reset.strip_prefix("Resets ").unwrap_or(reset));
        fixed(ui, 72.0, Align::Max, text(reset, 11.0, palette.ink2));
        fixed(ui, 38.0, Align::Max, mono(&reading.value, 11.0, palette.ink));
        reading.cells(ui, palette, (SMALL_CELLS, 7.0), reading.fill, true);
    });
    row.response.widget_info(|| {
        WidgetInfo::labeled(Role::ProgressIndicator, true, reading.describe(window, &model.settings.display))
    });
}

//! The cost summary, the usage tabs, the provider cards with their limit meters, and the compact view.

use aitrack_core::quota::pacing::{project_pace, PaceProjection, PaceSeverity};
use aitrack_core::quota::{QuotaFormat, QuotaWindow};
use eframe::egui::{
    self, Align, CornerRadius, FontId, Frame as EguiFrame, Layout, Margin, Pos2, Rect, Role, Sense, Shape, Stroke,
    StrokeKind, Ui, Vec2, WidgetInfo,
};

use super::format::{
    combined_daily, empty_usage_guidance, fill_percent, format_cost, format_limit_value, format_number, format_reset,
    format_tokens, format_updated, is_priced, pace_label, period_usage, period_value, problem_line, sparkline,
    spend_label, spend_reading, split_amount, total_spend, usage_availability, usage_note, Availability, Period,
    ProblemAction, Spend,
};
use super::widgets::{banner, card, divider, empty, link, paint_focus, segmented, spin_angle, spread, strong, text};
use super::{retry_banner, views, Action, Frame, Model, Tab, View};
use crate::pace::{has_reset, meter_tone, Tone};
use crate::settings::Settings;
use crate::state::{AppState, ProviderState};

const NO_PACE: PaceProjection = PaceProjection {
    severity: PaceSeverity::Level,
    projected_used_percent: None,
    even_pace_percent: None,
    run_out_at: None,
};

pub fn tabs(state: &AppState) -> Vec<(Tab, String)> {
    let mut tabs = vec![
        (Tab::Providers, "Providers".to_owned()),
        (Tab::History, "History".to_owned()),
        (Tab::Projects, "Projects".to_owned()),
    ];
    let machines = state.machines.as_ref().map_or(0, Vec::len);
    if machines > 0 {
        tabs.push((Tab::Machines, format!("Machines {machines}")));
    }
    tabs
}

pub fn show(ui: &mut Ui, view: &mut View, model: &Model<'_>, frame: &mut Frame<'_>) {
    let palette = frame.palette;
    let state = model.state;
    let availability = usage_availability(state);
    let machines = state.machines.as_ref().map_or(0, Vec::len);
    summary(ui, view, model, frame, availability, machines);

    if availability == Availability::Empty {
        let labels: Vec<&str> = state.providers.iter().map(|p| p.label.as_str()).collect();
        banner(ui, &palette, |ui| {
            ui.label(text(empty_usage_guidance(&labels), 12.0, palette.ink2));
        });
    }
    if let Some(error) = &state.pull_error {
        retry_banner(ui, frame, error, || Action::Refresh);
    }
    if let Some(error) = &state.usage_error {
        if let Some(at) = &state.usage_updated_at {
            banner(ui, &palette, |ui| {
                let age = format_updated(model.clock, Some(at), model.now);
                ui.label(text(format!("Cached usage: {age}"), 12.0, palette.ink2));
            });
        }
        retry_banner(ui, frame, error, || Action::Refresh);
    }
    if let Some(result) = state.sync_result.as_ref().filter(|r| !r.ok) {
        retry_banner(ui, frame, format!("Sync failed: {}", result.message), || Action::Sync);
    }
    if availability == Availability::Off {
        empty(ui, &palette, &format!("{}. Choose some in Settings.", usage_note(Availability::Off)));
        return;
    }

    if view.tab == Tab::Machines && machines == 0 {
        view.tab = Tab::Providers;
    }
    tab_bar(ui, view, model, frame);
    match view.tab {
        Tab::Providers => {
            for provider in &state.providers {
                provider_section(ui, view, model, frame, provider);
            }
        }
        Tab::Machines => views::machines(ui, view, model, frame),
        _ if availability != Availability::Ready => empty(ui, &palette, &format!("{}.", usage_note(availability))),
        Tab::History => views::history(ui, view, model, frame),
        Tab::Projects => views::projects(ui, view, model, frame),
    }
}

fn tab_bar(ui: &mut Ui, view: &mut View, model: &Model<'_>, frame: &Frame<'_>) {
    let palette = frame.palette;
    let tabs = tabs(model.state);
    EguiFrame::new()
        .fill(palette.raised)
        .corner_radius(CornerRadius::same(9))
        .inner_margin(Margin::same(2))
        .outer_margin(Margin { left: 12, right: 12, top: 0, bottom: 10 })
        .show(ui, |ui| {
            ui.spacing_mut().item_spacing.x = 2.0;
            #[expect(
                clippy::cast_precision_loss,
                reason = "counts and millisecond times stay far below 2^53, like the JavaScript numbers 4.x used"
            )]
            let width = (ui.available_width() - 2.0 * (tabs.len() - 1) as f32) / tabs.len() as f32;
            ui.horizontal(|ui| {
                for (tab, label) in &tabs {
                    let selected = view.tab == *tab;
                    let (rect, response) = ui.allocate_exact_size(Vec2::new(width, 24.0), Sense::click());
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
                        ui.painter().layout_no_wrap(label.clone(), FontId::new(12.0, super::theme::bold()), color);
                    ui.painter().galley(rect.center() - galley.size() / 2.0, galley, color);
                    response.widget_info(|| WidgetInfo::selected(Role::Button, true, selected, label));
                    paint_focus(ui, &palette, &response, rect, 7);
                    if response.clicked() {
                        view.tab = *tab;
                    }
                }
            });
        });
}

fn summary(
    ui: &mut Ui,
    view: &mut View,
    model: &Model<'_>,
    frame: &Frame<'_>,
    availability: Availability,
    machines: usize,
) {
    let palette = frame.palette;
    let providers = &model.state.providers;
    let spend = total_spend(providers.iter().map(|p| p.usage.as_ref()), view.period);
    EguiFrame::new().inner_margin(Margin { left: 16, right: 16, top: 16, bottom: 14 }).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.spacing_mut().item_spacing.y = 12.0;
        ui.horizontal(|ui| {
            ui.label(strong("Est. cost", 12.0, palette.ink2));
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                let options: Vec<(Period, &str)> = Period::ALL.iter().map(|p| (*p, p.label())).collect();
                segmented(ui, &palette, &mut view.period, &options);
            });
        });
        ui.horizontal(|ui| {
            ui.vertical(|ui| {
                ui.spacing_mut().item_spacing.y = 6.0;
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = 0.0;
                    if availability == Availability::Ready && is_priced(&spend) {
                        let (whole, cents) = split_amount(spend.cost_usd);
                        ui.label(strong(whole, 30.0, palette.ink));
                        ui.label(text(cents, 30.0, palette.ink3));
                    } else {
                        ui.label(strong("—", 30.0, palette.ink));
                    }
                });
                if availability == Availability::Ready && spend.has_cost && spend.has_unpriced_tokens {
                    ui.label(text("Partial estimate", 12.0, palette.ink2));
                }
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = 0.0;
                    let reading = if availability == Availability::Ready {
                        format!("{} tokens", format_tokens(spend.tokens))
                    } else {
                        usage_note(availability).to_owned()
                    };
                    ui.label(text(reading, 12.0, palette.ink2));
                    if machines > 1 {
                        ui.label(text("\u{a0}· ", 12.0, palette.ink2));
                        let response = ui.add(
                            egui::Label::new(text(format!("{machines} machines"), 12.0, palette.ink2))
                                .sense(Sense::click()),
                        );
                        if response.clicked() {
                            view.tab = Tab::Machines;
                        }
                    }
                });
            });
            if view.period != Period::All {
                let spark = view.spark.get(model.state, (), || Spark::new(model.state));
                if let Some(spark) = spark.as_ref() {
                    ui.with_layout(Layout::right_to_left(Align::Max), |ui| spark.show(ui, frame));
                }
            }
        });
        if !providers.is_empty() {
            provider_chips(ui, view.period, providers, frame);
        }
    });
}

/// The summary's 30-day cost curve, worked out once per state.
pub struct Spark {
    points: Vec<(f64, f64)>,
    peak: f64,
}

impl Spark {
    fn new(state: &AppState) -> Option<Self> {
        let daily = combined_daily(state.providers.iter().map(|p| p.usage.as_ref()), 30);
        let values: Vec<f64> = daily.iter().map(|d| d.cost_usd).collect();
        let points = sparkline(&values, 112.0, 36.0, 3.0)?;
        Some(Self { points, peak: values.iter().copied().fold(0.0, f64::max) })
    }

    fn show(&self, ui: &mut Ui, frame: &Frame<'_>) {
        let palette = frame.palette;
        let points = &self.points;
        ui.vertical(|ui| {
            ui.spacing_mut().item_spacing.y = 2.0;
            let (rect, response) = ui.allocate_exact_size(Vec2::new(112.0, 36.0), Sense::hover());
            #[expect(
                clippy::cast_possible_truncation,
                reason = "sparkline points lie inside the chart's small pixel box"
            )]
            let at = |(x, y): (f64, f64)| Pos2::new(rect.left() + x as f32, rect.top() + y as f32);
            let line: Vec<Pos2> = points.iter().copied().map(at).collect();
            let baseline = rect.top() + 33.0;
            for pair in line.windows(2) {
                let quad = vec![pair[0], pair[1], Pos2::new(pair[1].x, baseline), Pos2::new(pair[0].x, baseline)];
                ui.painter().add(Shape::convex_polygon(quad, palette.curve_fill, Stroke::NONE));
            }
            let end = line.last().copied();
            ui.painter().add(Shape::line(line, Stroke::new(1.4, palette.curve)));
            if let Some(end) = end {
                ui.painter().circle(end, 2.6, palette.surface, Stroke::new(1.4, palette.curve));
            }
            response.widget_info(|| {
                let label = format!("Estimated cost per day, last 30 days, peak {}", format_cost(self.peak));
                WidgetInfo::labeled(Role::Image, true, label)
            });
            ui.with_layout(Layout::right_to_left(Align::Min), |ui| ui.label(text("30 days", 10.5, palette.ink3)));
        });
    }
}

/// The width each of `count` chips gets in a row with 6 pt gaps.
pub fn chip_width(ui: &Ui, count: usize) -> f32 {
    let count = count.max(1);
    #[expect(
        clippy::cast_precision_loss,
        reason = "counts and millisecond times stay far below 2^53, like the JavaScript numbers 4.x used"
    )]
    let width = (ui.available_width() - 6.0 * (count - 1) as f32) / count as f32;
    width
}

/// A small card naming a provider over a figure; `swatch` adds its chart colour.
pub fn chip(
    ui: &mut Ui,
    frame: &Frame<'_>,
    width: f32,
    (key, label): (&str, &str),
    figure: String,
    swatch: bool,
) -> egui::Response {
    let palette = frame.palette;
    EguiFrame::new()
        .fill(palette.card)
        .stroke(Stroke::new(1.0, palette.edge))
        .corner_radius(CornerRadius::same(9))
        .inner_margin(Margin::symmetric(9, 8))
        .show(ui, |ui| {
            ui.set_width(width - 20.0);
            ui.vertical(|ui| {
                ui.spacing_mut().item_spacing.y = 5.0;
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = 5.0;
                    if swatch {
                        let (rect, _) = ui.allocate_exact_size(Vec2::splat(7.0), Sense::hover());
                        ui.painter().rect_filled(rect, CornerRadius::same(2), palette.provider(key));
                    }
                    mark(ui, frame, key, 12.0);
                    ui.add(egui::Label::new(text(label, 10.0, palette.ink2)).truncate());
                });
                ui.add(egui::Label::new(strong(figure, 12.0, palette.ink)).wrap());
            });
        })
        .response
}

fn provider_chips(ui: &mut Ui, period: Period, providers: &[ProviderState], frame: &Frame<'_>) {
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 6.0;
        let width = chip_width(ui, providers.len());
        for provider in providers {
            let value = period_value(provider.usage.as_ref(), period);
            let cost = if provider.usage.is_some() { spend_label(&value) } else { "—".into() };
            chip(ui, frame, width, (&provider.key, &provider.label), cost, false).on_hover_text(
                if provider.usage.is_some() {
                    format!("{}: {} tokens", provider.label, format_tokens(value.tokens))
                } else {
                    format!("{}: usage unavailable", provider.label)
                },
            );
        }
    });
}

pub fn mark(ui: &mut Ui, frame: &Frame<'_>, key: &str, size: f32) {
    let (rect, _) = ui.allocate_exact_size(Vec2::splat(size), Sense::hover());
    let color = if key == "claude_code" { frame.palette.claude } else { frame.palette.ink };
    frame.marks.paint(ui.painter(), rect, key, color);
}

fn heading(ui: &mut Ui, frame: &Frame<'_>, provider: &ProviderState) {
    let palette = frame.palette;
    mark(ui, frame, &provider.key, 18.0);
    ui.label(strong(&provider.label, 13.0, palette.ink));
    if let Some(plan) = provider.quota.as_ref().and_then(|q| q.plan.as_deref()) {
        ui.label(text(plan, 10.5, palette.ink2));
    }
}

fn provider_section(ui: &mut Ui, view: &mut View, model: &Model<'_>, frame: &mut Frame<'_>, provider: &ProviderState) {
    let palette = frame.palette;
    let spend = provider.usage.as_ref().map(|usage| period_usage(usage, view.period));
    let open = view.open_providers.contains(&provider.key) && spend.is_some();
    card(ui, &palette, |ui| {
        ui.spacing_mut().item_spacing.y = 16.0;
        let head = ui.horizontal(|ui| {
            ui.set_min_height(28.0);
            ui.spacing_mut().item_spacing.x = 9.0;
            heading(ui, frame, provider);
            if provider.refreshing {
                busy_dot(ui, &palette);
            }
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                if spend.is_some() {
                    views::chevron(ui, &palette, &provider.key, open);
                }
                let cost = spend.map_or_else(|| "—".into(), |spend| spend_label(&Spend::from(spend)));
                ui.label(text(cost, 12.0, palette.ink2));
            });
        });
        let response = ui.interact(head.response.rect, ui.scope_id().with(("head", &provider.key)), Sense::click());
        if spend.is_some() {
            response.widget_info(|| WidgetInfo::selected(Role::Button, true, open, &provider.label));
            if response.clicked() {
                if open {
                    view.open_providers.remove(&provider.key);
                } else {
                    view.open_providers.insert(provider.key.clone());
                }
            }
        }

        if let (Some(_), Some(quota)) = (&provider.quota_error, &provider.quota) {
            ui.label(text(
                format!("Cached limits: {}", format_updated(model.clock, Some(&quota.fetched_at), model.now)),
                12.0,
                palette.ink2,
            ));
        }
        if let Some(error) = &provider.quota_error {
            let (line, action) = problem_line(error, model.now, provider.retry_at);
            ui.horizontal_wrapped(|ui| {
                ui.spacing_mut().item_spacing.x = 6.0;
                let label = ui.label(text(&line, 12.0, palette.ink2));
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
        for window in provider.quota.iter().flat_map(|q| &q.windows) {
            limit_meter(ui, model, frame, &provider.key, window, stale);
        }
        for value in provider.quota.iter().flat_map(|q| &q.values) {
            let shown = if value.format == QuotaFormat::Dollars {
                format_cost(value.value)
            } else {
                format_number(value.value)
            };
            spread(ui, text(&value.label, 12.5, palette.ink), strong(shown, 12.5, palette.ink));
        }
        if provider.quota.is_none() && provider.quota_error.is_none() {
            ui.label(text("Checking limits…", 12.0, palette.ink2));
        }
        if let (true, Some(usage), Some(spend)) = (open, &provider.usage, spend) {
            details(ui, &palette, view.period, usage, spend);
        }
    });
}

fn details(
    ui: &mut Ui,
    palette: &super::theme::Palette,
    period: Period,
    usage: &crate::state::ProviderUsage,
    spend: &crate::state::PeriodUsage,
) {
    ui.vertical(|ui| {
        ui.spacing_mut().item_spacing.y = 8.0;
        divider(ui, palette);
        for (label, period_usage) in [
            (Period::Today.label(), &usage.today),
            ("Yesterday", &usage.yesterday),
            (Period::Week.label(), &usage.last7_days),
            (Period::Month.label(), &usage.last30_days),
            (Period::All.label(), &usage.all_time),
        ] {
            spread(
                ui,
                text(label, 12.0, palette.ink2),
                text(spend_reading(&Spend::from(period_usage)), 12.0, palette.ink),
            );
        }
        if !spend.models.is_empty() {
            let (rect, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 5.0), Sense::hover());
            ui.painter().hline(rect.x_range(), rect.center().y, Stroke::new(1.0, palette.rule));
            ui.label(text(format!("Models · {}", period.label()), 12.0, palette.ink2));
            for model in &spend.models {
                spread(
                    ui,
                    text(&model.model, 11.5, palette.ink2),
                    text(spend_reading(&Spend::from(model)), 11.5, palette.ink),
                );
            }
        }
    });
}

fn busy_dot(ui: &mut Ui, palette: &super::theme::Palette) {
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
    let past = has_reset(model.clock, window, model.now);
    let pace = if stale || past { NO_PACE } else { project_pace(window, model.now) };
    let tone = if past { Tone::Calm } else { meter_tone(window, &pace) };
    let label = pace_label(&pace, model.now, model.clock.zone());
    let reset = format_reset(model.clock, window.resets_at.as_deref(), model.now, settings.reset_display == "relative");
    let value = format_limit_value(window, left);
    ui.vertical(|ui| {
        ui.spacing_mut().item_spacing.y = 6.0;
        ui.horizontal(|ui| {
            ui.label(text(&window.label, 12.5, palette.ink));
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                let response = ui
                    .add(egui::Label::new(strong(&value, 12.5, palette.ink)).sense(Sense::click()))
                    .on_hover_text("Show used or left");
                if response.clicked() {
                    frame.patch(settings, |s| s.display = if left { "used".into() } else { "left".into() });
                }
            });
        });
        let fill = fill_percent(window, left);
        #[expect(clippy::cast_possible_truncation, reason = "a percentage of at most 100, drawn in f32")]
        let target = (fill / 100.0) as f32;
        let id = ui.scope_id().with((provider, &window.id));
        let shown = ui.ctx().animate_value_with_time(id, target, 0.22);
        let (rect, response) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 5.0), Sense::hover());
        ui.painter().rect_filled(rect, CornerRadius::same(3), palette.track);
        let color = if past { palette.ink3 } else { palette.tone(tone, provider) };
        let fill_rect = Rect::from_min_size(rect.min, Vec2::new(rect.width() * shown, rect.height()));
        ui.painter().rect_filled(fill_rect, CornerRadius::same(3), color);
        if let (Some(_), Some(even)) = (&label, pace.even_pace_percent) {
            let at = if left { 100.0 - even } else { even }.clamp(0.0, 100.0);
            #[expect(clippy::cast_possible_truncation, reason = "a percentage of at most 100, drawn in f32")]
            let x = rect.left() + rect.width() * (at / 100.0) as f32;
            ui.painter().vline(x, (rect.top() - 2.0)..=(rect.bottom() + 2.0), Stroke::new(1.5, palette.ink2));
        }
        let state = if past {
            Some("reset passed".to_owned())
        } else if stale {
            Some("cached".into())
        } else {
            label.as_deref().map(str::to_lowercase)
        };
        response.widget_info(|| {
            let reading = [Some(value.as_str()), state.as_deref()].into_iter().flatten().collect::<Vec<_>>().join(", ");
            WidgetInfo::labeled(
                Role::ProgressIndicator,
                true,
                format!("{} {}: {reading}", window.label, settings.display),
            )
        });
        if reset.is_some() || label.is_some() {
            ui.horizontal(|ui| {
                if let Some(reset) = &reset {
                    let response = ui
                        .add(egui::Label::new(text(reset, 11.5, palette.ink2)).sense(Sense::click()))
                        .on_hover_text("Show time or countdown");
                    if response.clicked() {
                        let relative = settings.reset_display == "relative";
                        frame.patch(settings, |s| {
                            s.reset_display = if relative { "absolute".into() } else { "relative".into() }
                        });
                    }
                }
                if let Some(label) = &label {
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        ui.label(text(label, 11.5, palette.tone_text(tone)));
                    });
                }
            });
        }
    });
}

pub fn compact(ui: &mut Ui, model: &Model<'_>, frame: &mut Frame<'_>) {
    let palette = frame.palette;
    let providers = &model.state.providers;
    if providers.is_empty() {
        empty(ui, &palette, "No providers are turned on.");
        return;
    }
    EguiFrame::new().inner_margin(Margin { left: 16, right: 16, top: 14, bottom: 6 }).show(ui, |ui| {
        ui.set_width(ui.available_width());
        for provider in providers {
            ui.vertical(|ui| {
                ui.spacing_mut().item_spacing.y = 8.0;
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = 9.0;
                    heading(ui, frame, provider);
                });
                if let Some(error) = &provider.quota_error {
                    ui.label(text(problem_line(error, model.now, provider.retry_at).0, 12.0, palette.ink2));
                }
                let windows = provider.quota.as_ref().map(|q| q.windows.as_slice()).unwrap_or_default();
                let session = windows
                    .iter()
                    .find(|w| w.id == "session")
                    .or_else(|| windows.iter().find(|w| w.id == "weekly"))
                    .or_else(|| windows.first());
                match session {
                    Some(window) => {
                        limit_meter(ui, model, frame, &provider.key, window, provider.quota_error.is_some());
                    }
                    None if provider.quota_error.is_none() => {
                        ui.label(text("No limits yet.", 12.0, palette.ink3));
                    }
                    None => {}
                }
            });
            ui.add_space(14.0);
        }
    });
}

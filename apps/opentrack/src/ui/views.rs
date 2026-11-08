//! The History, Machines and Projects tabs.

use eframe::egui::{
    self, Align, CornerRadius, Frame as EguiFrame, Layout, Margin, Pos2, Rect, Role, Sense, Ui, Vec2, WidgetInfo,
};

use super::dashboard::{chip, chip_width, mark};
use super::format::{
    build_history, by_cost_then_tokens, combined_daily, day_cost_label, format_cost, format_day, format_percent,
    format_tokens, intensity_level, period_projects, period_spend, spend_label, spend_reading, sync_status,
    total_spend, zone_clock, Bucket, Period, ShareBasis, Spend, INIT_HINT,
};
use super::icons::{paint_glyph, square, Glyph};
use super::theme::Palette;
use super::widgets::{card, divider, empty, segmented, spread, stacked_bar, strong, text};
use super::{Frame, Model, View};
use crate::state::{AppState, DailyUsage, ModelUsage, ProviderUsages};

pub fn history(ui: &mut Ui, view: &mut View, model: &Model<'_>, frame: &Frame<'_>) {
    let palette = frame.palette;
    let (range, bucket) = (view.history_range, view.history_bucket);
    let history =
        view.history.get(model.state, (range, bucket), || build_history(&model.state.providers, range, bucket));
    EguiFrame::new().outer_margin(Margin { left: 12, right: 12, top: 0, bottom: 10 }).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.spacing_mut().item_spacing.y = 8.0;
        ui.horizontal(|ui| {
            ui.label(strong("History", 12.0, palette.ink2));
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                ui.spacing_mut().item_spacing.x = 6.0;
                segmented(ui, &palette, &mut view.history_bucket, &[(Bucket::Day, "Day"), (Bucket::Week, "Week")]);
                segmented(ui, &palette, &mut view.history_range, &[(30, "30 days"), (90, "90 days")]);
            });
        });
        if history.peak_usd <= 0.0 {
            empty(ui, &palette, &format!("No priced usage in the last {} days.", view.history_range));
            return;
        }
        let (rect, response) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 96.0), Sense::hover());
        #[expect(
            clippy::cast_precision_loss,
            reason = "counts and millisecond times stay far below 2^53, like the JavaScript numbers 4.x used"
        )]
        let slot = rect.width() / history.bars.len().max(1) as f32;
        let gap = (slot * 0.2).min(2.0);
        let pointer = response.hover_pos();
        let noun = if view.history_bucket == Bucket::Day { "Day" } else { "Week of" };
        for (index, bar) in history.bars.iter().enumerate() {
            #[expect(
                clippy::cast_precision_loss,
                reason = "counts and millisecond times stay far below 2^53, like the JavaScript numbers 4.x used"
            )]
            let x = rect.left() + index as f32 * slot + gap / 2.0;
            let mut top = rect.bottom();
            for part in bar.parts.iter().filter(|p| p.cost_usd > 0.0) {
                #[expect(
                    clippy::cast_possible_truncation,
                    reason = "the value is rounded and bounded to the target range first"
                )]
                let height = (part.cost_usd / history.peak_usd) as f32 * rect.height();
                let layer = Rect::from_min_max(Pos2::new(x, top - height), Pos2::new(x + (slot - gap).max(0.5), top));
                ui.painter().rect_filled(layer, CornerRadius::ZERO, palette.provider(&part.key));
                top -= height;
            }
            let column = Rect::from_min_max(Pos2::new(x, rect.top()), Pos2::new(x + slot, rect.bottom()));
            if pointer.is_some_and(|p| column.contains(p)) {
                let split: Vec<String> = bar
                    .parts
                    .iter()
                    .filter(|p| p.cost_usd > 0.0)
                    .map(|p| format!("{} {}", p.label, format_cost(p.cost_usd)))
                    .collect();
                let split = if split.is_empty() { String::new() } else { format!(" ({})", split.join(", ")) };
                let tip = format!("{noun} {} · {}{split}", format_day(&bar.start), format_cost(bar.total_usd));
                response.clone().on_hover_text_at_pointer(tip);
            }
        }
        let bucket = if view.history_bucket == Bucket::Day { "day" } else { "week" };
        response.widget_info(|| {
            let label = format!(
                "Estimated cost per {bucket}, last {} days, peak {} on {}",
                view.history_range,
                format_cost(history.peak_usd),
                format_day(&history.busiest)
            );
            WidgetInfo::labeled(Role::Image, true, label)
        });
        ui.horizontal(|ui| {
            ui.label(text(format_day(&history.from), 11.0, palette.ink2));
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                ui.label(text(format_day(&history.to), 11.0, palette.ink2));
                ui.with_layout(Layout::centered_and_justified(egui::Direction::LeftToRight), |ui| {
                    ui.label(text(format!("peak {}", format_cost(history.peak_usd)), 11.0, palette.ink2));
                });
            });
        });
        let partial = if history.has_unpriced_tokens { " (partial)" } else { "" };
        ui.columns(3, |columns| {
            let stats = [
                (format!("Total{partial}"), format_cost(history.total_usd)),
                (format!("Per day{partial}"), format_cost(history.average_usd)),
                (format!("Busiest {bucket}"), format_day(&history.busiest)),
            ];
            for (column, (label, value)) in columns.iter_mut().zip(stats) {
                column.label(text(label, 12.0, palette.ink2));
                column.label(strong(value, 13.0, palette.ink));
            }
        });
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 6.0;
            let width = chip_width(ui, history.by_provider.len());
            for part in &history.by_provider {
                let cost = if part.cost_usd > 0.0 { format_cost(part.cost_usd) } else { "—".into() };
                let partial = if part.has_unpriced_tokens { " (partial)" } else { "" };
                chip(ui, frame, width, (&part.key, &part.label), format!("{cost}{partial}"), true);
            }
        });
    });
}

/// A machine (or the account) on the Machines tab, worked out once per state and period.
pub struct Row {
    id: String,
    name: String,
    /// Its index in the state's machines; the account has none.
    machine: Option<usize>,
    parts: Vec<(String, Spend)>,
    spend: Spend,
    daily: Vec<DailyUsage>,
    models: Vec<ModelUsage>,
}

fn row(
    state: &AppState,
    id: String,
    name: String,
    usages: &ProviderUsages,
    machine: Option<usize>,
    period: Period,
) -> Row {
    let keys: Vec<&str> = state.providers.iter().map(|p| p.key.as_str()).collect();
    let spends: Vec<_> =
        keys.iter().filter_map(|key| period_spend(usages.get(*key), period).map(|s| (*key, s))).collect();
    let parts = spends
        .iter()
        .map(|(key, spend)| ((*key).to_owned(), Spend::from(*spend)))
        .filter(|(_, spend)| spend.tokens > 0.0)
        .collect();
    let mut models: Vec<&ModelUsage> = spends.iter().flat_map(|(_, spend)| &spend.models).collect();
    let by_spend = |a: &&ModelUsage, b: &&ModelUsage| by_cost_then_tokens(&Spend::from(*a), &Spend::from(*b));
    models.sort_by(by_spend);
    models.truncate(3);
    Row {
        id,
        name,
        machine,
        spend: total_spend(keys.iter().map(|k| usages.get(*k)), period),
        daily: combined_daily(keys.iter().map(|k| usages.get(*k)), 30),
        parts,
        models: models.into_iter().cloned().collect(),
    }
}

fn rows(state: &AppState, period: Period) -> Vec<Row> {
    let machines = state.machines.as_deref().unwrap_or_default();
    let mut rows: Vec<Row> = machines
        .iter()
        .enumerate()
        .map(|(i, m)| row(state, format!("machine:{}", m.name), m.name.clone(), &m.providers, Some(i), period))
        .collect();
    if let Some(account) = &state.account_usage {
        let labels: Vec<&str> =
            state.providers.iter().filter(|p| account.contains_key(&p.key)).map(|p| p.label.as_str()).collect();
        if !labels.is_empty() {
            rows.push(row(state, "account".into(), format!("{} account", labels.join(", ")), account, None, period));
        }
    }
    rows.sort_by(|a, b| by_cost_then_tokens(&a.spend, &b.spend));
    rows
}

fn expander(ui: &mut Ui, view: &mut View, id: &str, rect: Rect) -> bool {
    let response = ui.interact(rect, ui.scope_id().with(("row", id)), Sense::click());
    let open = view.open_row.as_deref() == Some(id);
    response.widget_info(|| WidgetInfo::selected(Role::Button, true, open, id));
    if response.clicked() {
        view.open_row = if open { None } else { Some(id.to_owned()) };
    }
    view.open_row.as_deref() == Some(id)
}

pub(super) fn chevron(ui: &mut Ui, palette: &Palette, id: &str, open: bool) {
    let openness = ui.ctx().animate_bool_with_time(ui.scope_id().with(("chevron", id)), open, 0.16);
    let (rect, _) = ui.allocate_exact_size(Vec2::splat(13.0), Sense::hover());
    paint_glyph(ui.painter(), rect, Glyph::ChevronDown, palette.ink2, openness * std::f32::consts::PI);
}

/// The row's share of the whole, split by provider.
fn share_bar<'a>(
    ui: &mut Ui,
    palette: &Palette,
    basis: &ShareBasis,
    spend: &Spend,
    parts: impl Iterator<Item = (&'a str, Spend)>,
) {
    if basis.total <= 0.0 || basis.measure(spend) <= 0.0 {
        return;
    }
    #[expect(clippy::cast_possible_truncation, reason = "the value is rounded and bounded to the target range first")]
    let parts: Vec<(&str, f32)> = parts.map(|(key, part)| (key, (basis.measure(&part) / basis.total) as f32)).collect();
    let what = if basis.by_cost { "cost" } else { "tokens" };
    let share = basis.measure(spend) / basis.total;
    let percent = format_percent(share);
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 8.0;
        let colored: Vec<(f32, egui::Color32)> = parts.iter().map(|(key, w)| (*w, palette.provider(key))).collect();
        let width = ui.available_width() - 38.0;
        stacked_bar(ui, palette, &colored, 6.0, width);
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| ui.label(text(&percent, 11.0, palette.ink2)));
    })
    .response
    .on_hover_text(format!("{percent} of {what}"));
}

/// A provider's name and spend, one line of an opened row.
fn provider_spend_row(ui: &mut Ui, frame: &Frame<'_>, key: &str, label: &str, spend: &Spend) {
    let palette = frame.palette;
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 5.0;
        mark(ui, frame, key, 12.0);
        ui.label(text(label, 12.0, palette.ink2));
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            ui.label(text(spend_reading(spend), 12.0, palette.ink));
        });
    });
}

pub fn machines(ui: &mut Ui, view: &mut View, model: &Model<'_>, frame: &Frame<'_>) {
    let palette = frame.palette;
    let state = model.state;
    let machines = state.machines.as_deref().unwrap_or_default();
    let period = view.period;
    let rows = view.machine_rows.get(model.state, period, || rows(state, period));
    let basis = ShareBasis::new(rows.iter().map(|r| &r.spend));
    let peak = rows.iter().flat_map(|r| r.daily.iter().map(|d| d.cost_usd)).fold(0.0, f64::max);
    for row in rows.iter() {
        let machine = row.machine.and_then(|i| machines.get(i));
        let open = view.open_row.as_deref() == Some(row.id.as_str());
        card(ui, &palette, |ui| {
            ui.spacing_mut().item_spacing.y = 10.0;
            let head = ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 9.0;
                let current = machine.is_some_and(|m| m.current);
                let (rect, _) = ui.allocate_exact_size(Vec2::splat(32.0), Sense::hover());
                let (fill, ink) = if current {
                    (Palette::mix(palette.focus, 0.12, palette.card), palette.focus)
                } else {
                    (palette.raised, palette.ink2)
                };
                ui.painter().rect_filled(rect, CornerRadius::same(10), fill);
                let glyph = if machine.is_some() { Glyph::Laptop } else { Glyph::Cloud };
                paint_glyph(ui.painter(), square(rect.center(), 17.0), glyph, ink, 0.0);
                ui.vertical(|ui| {
                    ui.spacing_mut().item_spacing.y = 2.0;
                    ui.set_max_width(ui.available_width() - 90.0);
                    ui.horizontal(|ui| {
                        ui.spacing_mut().item_spacing.x = 6.0;
                        ui.add(egui::Label::new(strong(&row.name, 13.0, palette.ink)).truncate())
                            .on_hover_text(&row.name);
                        if current {
                            EguiFrame::new()
                                .fill(Palette::mix(palette.focus, 0.12, palette.card))
                                .corner_radius(CornerRadius::same(5))
                                .inner_margin(Margin::symmetric(5, 0))
                                .show(ui, |ui| {
                                    ui.label(strong(
                                        "This machine",
                                        10.0,
                                        Palette::mix(palette.focus, 0.8, palette.ink),
                                    ))
                                });
                        }
                    });
                    ui.horizontal(|ui| {
                        ui.spacing_mut().item_spacing.x = 5.0;
                        match machine {
                            Some(machine) => {
                                let (status, stale) = sync_status(model.clock, machine, model.now);
                                let (dot, _) = ui.allocate_exact_size(Vec2::splat(6.0), Sense::hover());
                                ui.painter().circle_filled(
                                    dot.center(),
                                    3.0,
                                    if stale { palette.warn } else { palette.ok },
                                );
                                let clock = zone_clock(model.clock, &machine.timezone, model.now);
                                let meta =
                                    clock.map_or_else(|| status.clone(), |clock| format!("{status} · {clock} there"));
                                ui.add(egui::Label::new(text(meta, 11.0, palette.ink2)).truncate()).on_hover_text(
                                    if machine.timezone.is_empty() { status } else { machine.timezone.clone() },
                                );
                            }
                            None => {
                                ui.label(text("Account-wide, not tied to a machine", 11.0, palette.ink2));
                            }
                        }
                    });
                });
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    chevron(ui, &palette, &row.id, open);
                    ui.label(strong(spend_label(&row.spend), 12.0, palette.ink));
                });
            });
            let open = expander(ui, view, &row.id, head.response.rect);
            share_bar(ui, &palette, &basis, &row.spend, row.parts.iter().map(|(key, spend)| (key.as_str(), *spend)));
            if !row.daily.is_empty() {
                strip(ui, &palette, &row.daily, peak);
            }
            if open {
                ui.vertical(|ui| {
                    ui.spacing_mut().item_spacing.y = 8.0;
                    divider(ui, &palette);
                    if row.parts.is_empty() {
                        ui.label(text(format!("No usage · {}", view.period.label()), 12.0, palette.ink2));
                    }
                    for (key, spend) in &row.parts {
                        let label =
                            state.providers.iter().find(|p| &p.key == key).map_or(key.as_str(), |p| p.label.as_str());
                        provider_spend_row(ui, frame, key, label, spend);
                    }
                    if !row.models.is_empty() {
                        ui.label(text(format!("Top models · {}", view.period.label()), 12.0, palette.ink2));
                        for model in &row.models {
                            spread(
                                ui,
                                text(&model.model, 11.5, palette.ink2),
                                text(spend_reading(&Spend::from(model)), 11.5, palette.ink),
                            );
                        }
                    }
                });
            }
        });
    }
    if machines.len() == 1 {
        empty(
            ui,
            &palette,
            &format!("Run {INIT_HINT} with the same data repo on another machine to compare them here."),
        );
    }
}

/// The 30-day heatmap strip; one scale for every machine, so a busy day looks busy next to the others.
fn strip(ui: &mut Ui, palette: &Palette, daily: &[DailyUsage], peak: f64) {
    let (rect, response) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 8.0), Sense::hover());
    let cell = (rect.width() - 2.0 * 29.0) / 30.0;
    let colors = [
        palette.track,
        Palette::mix(palette.meter, 0.25, palette.track),
        Palette::mix(palette.meter, 0.5, palette.track),
        Palette::mix(palette.meter, 0.75, palette.track),
        palette.meter,
    ];
    let pointer = response.hover_pos();
    for (index, day) in daily.iter().enumerate() {
        let level =
            if day.cost_usd > 0.0 { intensity_level(day.cost_usd, peak) } else { u8::from(day.has_unpriced_tokens) };
        #[expect(
            clippy::cast_precision_loss,
            reason = "counts and millisecond times stay far below 2^53, like the JavaScript numbers 4.x used"
        )]
        let x = rect.left() + index as f32 * (cell + 2.0);
        let cell_rect = Rect::from_min_size(Pos2::new(x, rect.top()), Vec2::new(cell, 8.0));
        ui.painter().rect_filled(cell_rect, CornerRadius::same(2), colors[usize::from(level)]);
        if pointer.is_some_and(|p| cell_rect.expand(1.0).contains(p)) {
            response.clone().on_hover_text_at_pointer(format!("{} · {}", format_day(&day.date), day_cost_label(day)));
        }
    }
    response.widget_info(|| {
        let busiest = daily.iter().fold(None::<&DailyUsage>, |best, day| {
            if day.cost_usd > best.map_or(0.0, |b| b.cost_usd) {
                Some(day)
            } else {
                best
            }
        });
        let label = busiest.map_or_else(
            || "Estimated cost per day, last 30 days, nothing priced".to_owned(),
            |day| {
                format!(
                    "Estimated cost per day, last 30 days, peak {} on {}",
                    format_cost(day.cost_usd),
                    format_day(&day.date)
                )
            },
        );
        WidgetInfo::labeled(Role::Image, true, label)
    });
}

pub fn projects(ui: &mut Ui, view: &mut View, model: &Model<'_>, frame: &Frame<'_>) {
    let palette = frame.palette;
    let projects = model.state.projects.as_ref();
    let entries = period_projects(projects, view.period);
    let spends: Vec<Spend> = entries.iter().map(Spend::from).collect();
    let basis = ShareBasis::new(spends.iter());
    if entries.is_empty() {
        let span = match view.period {
            Period::All => "yet".to_owned(),
            Period::Today => "today".to_owned(),
            period @ (Period::Week | Period::Month) => format!("in the last {}", period.label()),
        };
        let message = if projects.is_some() {
            format!("No project usage {span}.")
        } else {
            "No project usage yet. Usage is attributed to projects from the next sync or refresh onward.".to_owned()
        };
        empty(ui, &palette, &message);
        return;
    }
    for (entry, spend) in entries.iter().zip(&spends) {
        let id = format!("project:{}", entry.project);
        let open = view.open_row.as_deref() == Some(id.as_str());
        card(ui, &palette, |ui| {
            ui.spacing_mut().item_spacing.y = 10.0;
            let head = ui.horizontal(|ui| {
                ui.vertical(|ui| {
                    ui.spacing_mut().item_spacing.y = 2.0;
                    ui.set_max_width(ui.available_width() - 90.0);
                    let color = if entry.unattributed { palette.ink2 } else { palette.ink };
                    ui.add(egui::Label::new(strong(&entry.project, 13.0, color)).truncate())
                        .on_hover_text(&entry.project);
                    ui.label(text(format!("{} tokens", format_tokens(entry.tokens)), 11.0, palette.ink2));
                });
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    chevron(ui, &palette, &id, open);
                    ui.label(strong(spend_label(spend), 12.0, palette.ink));
                });
            });
            let open = expander(ui, view, &id, head.response.rect);
            share_bar(ui, &palette, &basis, spend, entry.providers.iter().map(|p| (p.key.as_str(), Spend::from(p))));
            if open {
                ui.vertical(|ui| {
                    ui.spacing_mut().item_spacing.y = 8.0;
                    divider(ui, &palette);
                    for part in &entry.providers {
                        provider_spend_row(ui, frame, &part.key, &part.label, &Spend::from(part));
                    }
                });
            }
        });
    }
    if model.state.providers.iter().any(|p| p.key == "cursor") {
        empty(ui, &palette, "Cursor is not attributed to projects and is not counted here.");
    }
}

//! The Usage tab: the period, the total with its chart, and one breakdown by model, project or machine.

use eframe::egui::{
    self, Align, Color32, CornerRadius, FontFamily, FontId, Frame as EguiFrame, Layout, Margin, Pos2, Rect, Role,
    Sense, Stroke, Ui, Vec2, WidgetInfo,
};

use super::dashboard::mark;
use super::format::{
    build_history, by_cost_then_tokens, combined_daily, day_cost_label, empty_usage_guidance, format_cost, format_day,
    format_percent, format_tokens, format_updated, intensity_level, is_priced, period_projects, period_usage,
    spend_label, spend_reading, sync_status, total_spend, usage_note, zone_clock, Availability, Bucket, Period,
    ShareBasis, Spend, INIT_HINT,
};
use super::icons::{paint_glyph, Glyph};
use super::theme::{bold, Palette};
use super::widgets::{banner, card, empty, paint_focus, segmented, spread, stacked_bar, strong, text};
use super::{retry_banner, Action, By, Frame, Model, View};
use crate::state::{AppState, DailyUsage, MachineUsage, ModelUsage, ProviderUsages};

pub fn usage(ui: &mut Ui, view: &mut View, model: &Model<'_>, frame: &mut Frame<'_>, availability: Availability) {
    let palette = frame.palette;
    let state = model.state;
    if availability == Availability::Empty {
        let labels: Vec<&str> = state.providers.iter().map(|p| p.label.as_str()).collect();
        banner(ui, &palette, |ui| {
            ui.label(text(empty_usage_guidance(&labels), 12.0, palette.ink2));
        });
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
    if availability != Availability::Ready {
        empty(ui, &palette, &format!("{}.", usage_note(availability)));
        return;
    }
    period_tabs(ui, view, &palette);
    total(ui, view.period, model, &palette);
    chart(ui, view, model, &palette);
    breakdown(ui, view, model, frame);
}

/// The one period every number on the tab is for.
fn period_tabs(ui: &mut Ui, view: &mut View, palette: &Palette) {
    EguiFrame::new().inner_margin(Margin { left: 16, right: 16, top: 0, bottom: 12 }).show(ui, |ui| {
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 14.0;
            for period in Period::ALL.iter().copied() {
                let selected = view.period == period;
                let family = if selected { bold() } else { FontFamily::Proportional };
                let color = if selected { palette.ink } else { palette.ink2 };
                let galley = ui.painter().layout_no_wrap(period.label().to_owned(), FontId::new(12.0, family), color);
                let (rect, response) = ui.allocate_exact_size(galley.size() + Vec2::new(0.0, 6.0), Sense::click());
                ui.painter().galley(rect.min, galley, color);
                if selected {
                    ui.painter().hline(rect.x_range(), rect.bottom() - 1.0, Stroke::new(2.0, palette.ink));
                }
                response.widget_info(|| WidgetInfo::selected(Role::Button, true, selected, period.label()));
                paint_focus(ui, palette, &response, rect, 3);
                if response.clicked() {
                    view.period = period;
                }
            }
        });
    });
}

fn total(ui: &mut Ui, period: Period, model: &Model<'_>, palette: &Palette) {
    let spend = total_spend(model.state.providers.iter().map(|p| p.usage.as_ref()), period);
    EguiFrame::new().inner_margin(Margin { left: 16, right: 16, top: 0, bottom: 12 }).show(ui, |ui| {
        let size = Vec2::new(ui.available_width(), 30.0);
        ui.allocate_ui_with_layout(size, Layout::left_to_right(Align::BOTTOM), |ui| {
            ui.spacing_mut().item_spacing.x = 8.0;
            let figure = if is_priced(&spend) { format_cost(spend.cost_usd) } else { "—".into() };
            ui.label(strong(figure, 26.0, palette.ink));
            let kind = if spend.has_cost && spend.has_unpriced_tokens { "partial estimate" } else { "estimated" };
            ui.label(text(format!("{kind} · {} tokens", format_tokens(spend.tokens)), 11.0, palette.ink2));
        });
    });
}

/// Estimated cost per day, stacked by provider, over the days the period covers.
fn chart(ui: &mut Ui, view: &mut View, model: &Model<'_>, palette: &Palette) {
    let (range, bucket) = match view.period {
        Period::Today | Period::Week => (7, Bucket::Day),
        Period::Month => (30, Bucket::Day),
        Period::All => (90, Bucket::Week),
    };
    let history = view.history.get(model.state, view.period, || build_history(&model.state.providers, range, bucket));
    EguiFrame::new().inner_margin(Margin { left: 16, right: 16, top: 0, bottom: 14 }).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.spacing_mut().item_spacing.y = 8.0;
        if history.peak_usd <= 0.0 {
            ui.label(text(format!("No priced usage in the last {range} days."), 11.0, palette.ink2));
            return;
        }
        let (rect, response) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 64.0), Sense::hover());
        #[expect(
            clippy::cast_precision_loss,
            reason = "counts and millisecond times stay far below 2^53, like the JavaScript numbers 4.x used"
        )]
        let slot = rect.width() / history.bars.len().max(1) as f32;
        let gap = (slot * 0.14).min(6.0);
        let pointer = response.hover_pos();
        let (noun, each) = if bucket == Bucket::Day { ("Day", "day") } else { ("Week of", "week") };
        for (index, bar) in history.bars.iter().enumerate() {
            #[expect(
                clippy::cast_precision_loss,
                reason = "counts and millisecond times stay far below 2^53, like the JavaScript numbers 4.x used"
            )]
            let x = rect.left() + index as f32 * slot + gap / 2.0;
            let mut top = rect.bottom();
            for part in bar.parts.iter().filter(|p| p.cost_usd > 0.0) {
                #[expect(clippy::cast_possible_truncation, reason = "a share of at most 1, drawn in f32")]
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
        response.widget_info(|| {
            let label = format!(
                "Estimated cost per {each}, last {range} days, peak {} on {}",
                format_cost(history.peak_usd),
                format_day(&history.busiest)
            );
            WidgetInfo::labeled(Role::Image, true, label)
        });
        ui.horizontal_wrapped(|ui| {
            ui.spacing_mut().item_spacing.x = 5.0;
            for part in &history.by_provider {
                let (swatch, _) = ui.allocate_exact_size(Vec2::splat(8.0), Sense::hover());
                ui.painter().rect_filled(swatch, CornerRadius::same(2), palette.provider(&part.key));
                let cost = if part.cost_usd > 0.0 { format_cost(part.cost_usd) } else { "—".into() };
                let partial = if part.has_unpriced_tokens { " (partial)" } else { "" };
                ui.label(text(format!("{} {cost}{partial}", part.label), 11.0, palette.ink2));
                ui.add_space(9.0);
            }
        });
        let by_week = if bucket == Bucket::Week { ", by week" } else { "" };
        let caption = format!(
            "Last {range} days{by_week} · {} a day · busiest {each} {}",
            format_cost(history.average_usd),
            format_day(&history.busiest)
        );
        ui.label(text(caption, 11.0, palette.ink2));
    });
}

fn breakdown(ui: &mut Ui, view: &mut View, model: &Model<'_>, frame: &Frame<'_>) {
    let palette = frame.palette;
    let machines = model.state.machines.as_ref().map_or(0, Vec::len);
    if view.by == By::Machine && machines == 0 {
        view.by = By::Model;
    }
    card(ui, &palette, |ui| {
        ui.spacing_mut().item_spacing.y = 6.0;
        ui.horizontal(|ui| {
            ui.label(text("By", 11.0, palette.ink2));
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                let mut options = vec![(By::Model, "Model"), (By::Project, "Project")];
                if machines > 0 {
                    options.push((By::Machine, "Machine"));
                }
                if segmented(ui, &palette, &mut view.by, &options) {
                    view.open_row = None;
                }
            });
        });
        match view.by {
            By::Model => models(ui, view, model, frame),
            By::Project => projects(ui, view, model, frame),
            By::Machine => machines_list(ui, view, model, frame),
        }
    });
}

fn span(period: Period) -> String {
    match period {
        Period::All => "yet".to_owned(),
        Period::Today => "today".to_owned(),
        period @ (Period::Week | Period::Month) => format!("in the last {}", period.label()),
    }
}

/// The line between two rows of a breakdown.
fn rule(ui: &mut Ui, palette: &Palette) {
    ui.add_space(2.0);
    ui.painter().hline(ui.max_rect().x_range(), ui.cursor().top(), Stroke::new(1.0, palette.rule));
    ui.add_space(4.0);
}

enum Lead<'a> {
    None,
    Provider(&'a str),
    Glyph(Glyph, Color32),
}

/// A breakdown row's first line: what it is and what it cost. An `id` makes it open and close.
struct Head<'a> {
    id: Option<&'a str>,
    lead: Lead<'a>,
    name: &'a str,
    muted: bool,
    spend: &'a Spend,
}

fn head(ui: &mut Ui, view: &mut View, frame: &Frame<'_>, head: &Head<'_>) -> bool {
    let palette = frame.palette;
    let open = head.id.is_some_and(|id| view.open_row.as_deref() == Some(id));
    let row = ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 7.0;
        match head.lead {
            Lead::None => {}
            Lead::Provider(key) => mark(ui, frame, key, 12.0),
            Lead::Glyph(glyph, color) => {
                let (rect, _) = ui.allocate_exact_size(Vec2::splat(13.0), Sense::hover());
                paint_glyph(ui.painter(), rect, glyph, color, 0.0);
            }
        }
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            if let Some(id) = head.id {
                chevron(ui, &palette, id, open);
            }
            ui.label(strong(spend_label(head.spend), 13.0, palette.ink));
            ui.with_layout(Layout::left_to_right(Align::Center), |ui| {
                let color = if head.muted { palette.ink2 } else { palette.ink };
                ui.add(egui::Label::new(text(head.name, 13.0, color)).truncate()).on_hover_text(head.name);
            });
        });
    });
    head.id.is_some_and(|id| expander(ui, view, id, row.response.rect))
}

fn expander(ui: &Ui, view: &mut View, id: &str, rect: Rect) -> bool {
    let response = ui.interact(rect, ui.scope_id().with(("row", id)), Sense::click());
    let open = view.open_row.as_deref() == Some(id);
    response.widget_info(|| WidgetInfo::selected(Role::Button, true, open, id));
    if response.clicked() {
        view.open_row = if open { None } else { Some(id.to_owned()) };
    }
    view.open_row.as_deref() == Some(id)
}

fn chevron(ui: &mut Ui, palette: &Palette, id: &str, open: bool) {
    let openness = ui.ctx().animate_bool_with_time(ui.scope_id().with(("chevron", id)), open, 0.16);
    let (rect, _) = ui.allocate_exact_size(Vec2::splat(13.0), Sense::hover());
    paint_glyph(ui.painter(), rect, Glyph::ChevronDown, palette.ink2, openness * std::f32::consts::PI);
}

/// The row's share of the whole, split by provider, with its tokens.
fn share<'a>(
    ui: &mut Ui,
    palette: &Palette,
    basis: &ShareBasis,
    spend: &Spend,
    parts: impl Iterator<Item = (&'a str, Spend)>,
) {
    let tokens = format_tokens(spend.tokens);
    let shown = basis.total > 0.0 && basis.measure(spend) > 0.0;
    let percent = format_percent(if shown { basis.measure(spend) / basis.total } else { 0.0 });
    let reading = if shown { format!("{percent} · {tokens}") } else { format!("{tokens} tokens") };
    let row = ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 10.0;
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            ui.add_sized([96.0, 14.0], egui::Label::new(text(reading, 11.0, palette.ink2)).halign(Align::Max));
            if shown {
                #[expect(clippy::cast_possible_truncation, reason = "a share of at most 1, drawn in f32")]
                let colored: Vec<(f32, Color32)> = parts
                    .map(|(key, part)| ((basis.measure(&part) / basis.total) as f32, palette.provider(key)))
                    .collect();
                let width = ui.available_width();
                stacked_bar(ui, palette, &colored, 4.0, width);
            }
        });
    });
    if shown {
        let what = if basis.by_cost { "cost" } else { "tokens" };
        row.response.on_hover_text(format!("{percent} of {what}"));
    }
}

/// What an opened row holds, set apart from the rows around it.
fn inset(ui: &mut Ui, palette: &Palette, add: impl FnOnce(&mut Ui)) {
    EguiFrame::new()
        .fill(palette.surface)
        .corner_radius(CornerRadius::same(8))
        .inner_margin(Margin::symmetric(10, 8))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.spacing_mut().item_spacing.y = 6.0;
            add(ui);
        });
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

fn models(ui: &mut Ui, view: &mut View, model: &Model<'_>, frame: &Frame<'_>) {
    let palette = frame.palette;
    let mut rows: Vec<(&str, &ModelUsage, Spend)> = model
        .state
        .providers
        .iter()
        .filter_map(|provider| provider.usage.as_ref().map(|usage| (provider.key.as_str(), usage)))
        .flat_map(|(key, usage)| period_usage(usage, view.period).models.iter().map(move |m| (key, m, Spend::from(m))))
        .filter(|(_, _, spend)| spend.tokens > 0.0)
        .collect();
    rows.sort_by(|a, b| by_cost_then_tokens(&a.2, &b.2));
    if rows.is_empty() {
        empty(ui, &palette, &format!("No model usage {}.", span(view.period)));
        return;
    }
    let basis = ShareBasis::new(rows.iter().map(|row| &row.2));
    for (key, usage, spend) in &rows {
        rule(ui, &palette);
        head(ui, view, frame, &Head { id: None, lead: Lead::Provider(key), name: &usage.model, muted: false, spend });
        share(ui, &palette, &basis, spend, std::iter::once((*key, *spend)));
    }
}

fn projects(ui: &mut Ui, view: &mut View, model: &Model<'_>, frame: &Frame<'_>) {
    let palette = frame.palette;
    let projects = model.state.projects.as_ref();
    let entries = period_projects(projects, view.period);
    let spends: Vec<Spend> = entries.iter().map(Spend::from).collect();
    let basis = ShareBasis::new(spends.iter());
    if entries.is_empty() {
        let message = if projects.is_some() {
            format!("No project usage {}.", span(view.period))
        } else {
            "No project usage yet. Usage is attributed to projects from the next sync or refresh onward.".to_owned()
        };
        empty(ui, &palette, &message);
        return;
    }
    for (entry, spend) in entries.iter().zip(&spends) {
        let id = format!("project:{}", entry.project);
        rule(ui, &palette);
        let row = Head { id: Some(&id), lead: Lead::None, name: &entry.project, muted: entry.unattributed, spend };
        let open = head(ui, view, frame, &row);
        share(ui, &palette, &basis, spend, entry.providers.iter().map(|p| (p.key.as_str(), Spend::from(p))));
        if open {
            inset(ui, &palette, |ui| {
                for part in &entry.providers {
                    provider_spend_row(ui, frame, &part.key, &part.label, &Spend::from(part));
                }
            });
        }
    }
    if model.state.providers.iter().any(|p| p.key == "cursor") {
        empty(ui, &palette, "Cursor is not attributed to projects and is not counted here.");
    }
}

/// A machine (or the account) in the machine breakdown, worked out once per state and period.
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
        keys.iter().filter_map(|key| usages.get(*key).map(|usage| (*key, period_usage(usage, period)))).collect();
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

fn machines_list(ui: &mut Ui, view: &mut View, model: &Model<'_>, frame: &Frame<'_>) {
    let palette = frame.palette;
    let state = model.state;
    let machines = state.machines.as_deref().unwrap_or_default();
    let period = view.period;
    let rows = view.machine_rows.get(model.state, period, || rows(state, period));
    let basis = ShareBasis::new(rows.iter().map(|r| &r.spend));
    let peak = rows.iter().flat_map(|r| r.daily.iter().map(|d| d.cost_usd)).fold(0.0, f64::max);
    for row in rows.iter() {
        let machine = row.machine.and_then(|i| machines.get(i));
        let current = machine.is_some_and(|m| m.current);
        let lead = Lead::Glyph(
            if machine.is_some() { Glyph::Laptop } else { Glyph::Cloud },
            if current { palette.focus } else { palette.ink2 },
        );
        rule(ui, &palette);
        let open =
            head(ui, view, frame, &Head { id: Some(&row.id), lead, name: &row.name, muted: false, spend: &row.spend });
        machine_status(ui, model, &palette, machine);
        share(ui, &palette, &basis, &row.spend, row.parts.iter().map(|(key, spend)| (key.as_str(), *spend)));
        if !row.daily.is_empty() {
            strip(ui, &palette, &row.daily, peak);
        }
        if open {
            inset(ui, &palette, |ui| machine_details(ui, period, state, frame, row));
        }
    }
    if machines.len() == 1 {
        empty(
            ui,
            &palette,
            &format!("Run {INIT_HINT} with the same data repo on another machine to compare them here."),
        );
    }
}

/// Whether the machine's numbers are current, and its local time when that differs from here.
fn machine_status(ui: &mut Ui, model: &Model<'_>, palette: &Palette, machine: Option<&MachineUsage>) {
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 6.0;
        let Some(machine) = machine else {
            ui.label(text("Account-wide, not tied to a machine", 11.0, palette.ink2));
            return;
        };
        let (status, stale) = sync_status(model.clock, machine, model.now);
        let (dot, _) = ui.allocate_exact_size(Vec2::splat(6.0), Sense::hover());
        ui.painter().circle_filled(dot.center(), 3.0, if stale { palette.warn } else { palette.ok });
        let here = if machine.current { "This machine · " } else { "" };
        let clock = zone_clock(model.clock, &machine.timezone, model.now);
        let meta = clock.map_or_else(|| format!("{here}{status}"), |clock| format!("{here}{status} · {clock} there"));
        ui.add(egui::Label::new(text(meta, 11.0, palette.ink2)).truncate())
            .on_hover_text(if machine.timezone.is_empty() { status } else { machine.timezone.clone() });
    });
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

/// The open row: each provider's spend and the machine's top models.
fn machine_details(ui: &mut Ui, period: Period, state: &AppState, frame: &Frame<'_>, row: &Row) {
    let palette = frame.palette;
    if row.parts.is_empty() {
        ui.label(text(format!("No usage · {}", period.label()), 12.0, palette.ink2));
    }
    for (key, spend) in &row.parts {
        let label = state.providers.iter().find(|p| &p.key == key).map_or(key.as_str(), |p| p.label.as_str());
        provider_spend_row(ui, frame, key, label, spend);
    }
    if !row.models.is_empty() {
        ui.label(text("Top models", 11.0, palette.ink2));
        for model in &row.models {
            spread(
                ui,
                text(&model.model, 12.0, palette.ink2),
                text(spend_reading(&Spend::from(model)), 12.0, palette.ink),
            );
        }
    }
}

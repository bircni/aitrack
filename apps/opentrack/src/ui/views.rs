//! The Usage tab: the total, the heatmap with its streaks, and one breakdown by model, project or machine.

use eframe::egui::{
    self, Align, Color32, CornerRadius, Frame as EguiFrame, Layout, Margin, Pos2, Rect, Role, Sense, Stroke, Ui, Vec2,
    WidgetInfo,
};

use super::dashboard::mark;
use super::format::{
    by_cost_then_tokens, combined_daily, day_cost_label, empty_usage_guidance, format_cost, format_day, format_percent,
    format_tokens, format_updated, intensity_level, is_priced, period_projects, period_usage, spend_label,
    spend_reading, sync_status, total_spend, usage_grid, usage_note, zone_clock, Availability, Period, ShareBasis,
    Spend, UsageGrid, GRID_WEEKS, INIT_HINT,
};
use super::icons::{paint_glyph, Glyph};
use super::theme::Palette;
use super::widgets::{
    banner, caps, caps_tabs, cells, empty, fixed, lit_cells, mono, section, segmented, spread, strong, text,
};
use super::{retry_banner, Action, By, Frame, Model, View};
use crate::state::{AppState, DailyUsage, MachineUsage, ModelUsage, ProviderUsages};

/// The cells of a row's share strip.
const SHARE_CELLS: usize = 24;

pub fn usage(ui: &mut Ui, view: &mut View, model: &Model<'_>, frame: &mut Frame<'_>, availability: Availability) {
    let palette = frame.palette;
    let state = model.state;
    ui.add_space(10.0);
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
    section(ui, &palette, |ui| {
        ui.spacing_mut().item_spacing.y = 12.0;
        total(ui, view, model, &palette);
        let daily = combined_daily(state.providers.iter().map(|p| p.usage.as_ref()), GRID_WEEKS * 7);
        let grid = view.grid.get(state, view.period, || usage_grid(&daily, view.period));
        heatmap(ui, &palette, &grid);
        stats(ui, &palette, &grid);
    });
    breakdown(ui, view, model, frame);
}

/// The period's estimated cost, and the switch every number on the tab follows.
fn total(ui: &mut Ui, view: &mut View, model: &Model<'_>, palette: &Palette) {
    let spend = total_spend(model.state.providers.iter().map(|p| p.usage.as_ref()), view.period);
    let size = Vec2::new(ui.available_width(), 30.0);
    ui.allocate_ui_with_layout(size, Layout::left_to_right(Align::BOTTOM), |ui| {
        ui.spacing_mut().item_spacing.x = 10.0;
        let figure = if is_priced(&spend) { format_cost(spend.cost_usd) } else { "—".into() };
        ui.label(mono(figure, 26.0, palette.ink));
        let kind = if spend.has_cost && spend.has_unpriced_tokens { "partial est." } else { "est." };
        ui.label(text(format!("{kind} · {} tokens", format_tokens(spend.tokens)), 11.0, palette.ink2));
    });
    let options: Vec<(Period, &str)> = Period::ALL.iter().map(|period| (*period, period.label())).collect();
    segmented(ui, palette, &mut view.period, &options);
}

/// The heatmap `aitrack show` draws: a column per week, Monday first, with the chosen period lit.
fn heatmap(ui: &mut Ui, palette: &Palette, grid: &UsageGrid) {
    const LABELS: f32 = 26.0;
    const MONTHS: f32 = 14.0;
    const GAP: f32 = 3.0;
    #[expect(clippy::cast_precision_loss, reason = "a few dozen columns and rows")]
    let at = |index: usize, cell: f32| index as f32 * (cell + GAP);
    let columns = grid.cells.last().map_or(1, |cell| cell.column + 1).max(GRID_WEEKS);
    #[expect(clippy::cast_precision_loss, reason = "a few dozen columns")]
    let cell = (ui.available_width() - LABELS - GAP * (columns - 1) as f32) / columns as f32;
    let size = Vec2::new(ui.available_width(), MONTHS + at(7, cell) - GAP);
    let (rect, response) = ui.allocate_exact_size(size, Sense::hover());
    let origin = Pos2::new(rect.left() + LABELS, rect.top() + MONTHS);
    let ramp = palette.ramp("all");
    let font = egui::FontId::proportional(9.5);
    for (column, month) in &grid.months {
        let place = Pos2::new(origin.x + at(*column, cell), rect.top());
        ui.painter().text(place, egui::Align2::LEFT_TOP, *month, font.clone(), palette.ink2);
    }
    for (row, day) in [(0, "Mon"), (2, "Wed"), (4, "Fri")] {
        let place = Pos2::new(rect.left(), origin.y + at(row, cell) + cell / 2.0);
        ui.painter().text(place, egui::Align2::LEFT_CENTER, day, font.clone(), palette.ink2);
    }
    let pointer = response.hover_pos();
    for day in &grid.cells {
        let min = Pos2::new(origin.x + at(day.column, cell), origin.y + at(day.row, cell));
        let square = Rect::from_min_size(min, Vec2::splat(cell));
        let color = if day.level == 0 { palette.track } else { ramp[usize::from(day.level - 1)] };
        // The days outside the chosen period stay, dimmed, so the period reads against them.
        let color = if day.lit { color } else { Palette::mix(color, 0.4, palette.surface) };
        ui.painter().rect_filled(square, CornerRadius::same(3), color);
        if pointer.is_some_and(|p| square.expand(GAP / 2.0).contains(p)) {
            let tip = format!("{} · {}", format_day(&day.day.date), day_cost_label(&day.day));
            response.clone().on_hover_text_at_pointer(tip);
        }
    }
    response.widget_info(|| {
        let label = grid.peak.as_ref().map_or_else(
            || format!("Estimated cost per day, last {GRID_WEEKS} weeks, nothing priced"),
            |day| {
                format!(
                    "Estimated cost per day, last {GRID_WEEKS} weeks, peak {} on {}",
                    format_cost(day.cost_usd),
                    format_day(&day.date)
                )
            },
        );
        WidgetInfo::labeled(Role::Image, true, label)
    });
}

/// The figures `aitrack show` prints under its heatmap, for the weeks shown here.
fn stats(ui: &mut Ui, palette: &Palette, grid: &UsageGrid) {
    let days = |count: usize| if count == 1 { "1 day".to_owned() } else { format!("{count} days") };
    let current = format!("{}{}", days(grid.current_streak), if grid.streak_capped { " or more" } else { "" });
    let peak = grid.peak.as_ref();
    let figures = [
        ("Current streak", current, String::new()),
        ("Longest streak", days(grid.longest_streak), format!("in {GRID_WEEKS} weeks")),
        (
            "Peak day",
            peak.map_or_else(|| "—".into(), |day| format_day(&day.date)),
            peak.map_or_else(String::new, |day| format_cost(day.cost_usd)),
        ),
    ];
    ui.columns(3, |columns| {
        for (column, (label, value, note)) in columns.iter_mut().zip(figures) {
            column.spacing_mut().item_spacing.y = 3.0;
            column.label(caps(label, palette.ink2));
            column.label(strong(value, 13.0, palette.ink));
            if !note.is_empty() {
                column.label(text(note, 11.0, palette.ink2));
            }
        }
    });
}

fn breakdown(ui: &mut Ui, view: &mut View, model: &Model<'_>, frame: &Frame<'_>) {
    let palette = frame.palette;
    let machines = model.state.machines.as_ref().map_or(0, Vec::len);
    if view.by == By::Machine && machines == 0 {
        view.by = By::Model;
    }
    section(ui, &palette, |ui| {
        ui.spacing_mut().item_spacing.y = 6.0;
        let mut options = vec![(By::Model, "By model"), (By::Project, "By project")];
        if machines > 0 {
            options.push((By::Machine, "By machine"));
        }
        if caps_tabs(ui, &palette, &mut view.by, &options) {
            view.open_row = None;
        }
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
            ui.label(mono(spend_label(head.spend), 12.0, palette.ink));
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

/// The row's share of the whole as cells, each in the colour of the provider it belongs to, with its tokens.
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
            fixed(ui, 96.0, Align::Max, text(reading, 11.0, palette.ink2));
            if shown {
                #[expect(clippy::cast_possible_truncation, reason = "a share of at most 1, drawn in f32")]
                let of_all = |part: &Spend| (basis.measure(part) / basis.total) as f32;
                // A share too small for a cell still gets one, so the row never reads as nothing.
                let colors: Vec<Color32> = parts
                    .flat_map(|(key, part)| {
                        let lit = lit_cells(of_all(&part), SHARE_CELLS).max(1);
                        std::iter::repeat_n(palette.ramp(key)[2], lit)
                    })
                    .collect();
                cells(
                    ui,
                    palette,
                    (SHARE_CELLS, 5.0),
                    |index| colors.get(index).copied().unwrap_or(palette.track),
                    None,
                );
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
        .fill(palette.card)
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
    let ramp = palette.ramp("all");
    let colors = [palette.track, ramp[0], ramp[1], ramp[2], ramp[3]];
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

//! The popup, drawn from the service's state; what the user asks for comes back as [`Action`]s.

mod dashboard;
pub mod format;
pub mod icons;
mod settings_screen;
pub mod theme;
mod views;
mod widgets;

use std::collections::HashSet;

use aitrack_core::time::Clock;
use eframe::egui::{self, Align, Color32, CornerRadius, Layout, Mesh, Rect, ScrollArea, Sense, Stroke, Ui, Vec2};
use indexmap::IndexMap;

use self::format::{freshness_line, Bucket, Period};
use self::icons::{Glyph, ProviderMarks};
use self::theme::Palette;
use self::widgets::{banner, icon_button, link, text, IconButton};
use crate::settings::Settings;
use crate::state::AppState;

pub const WIDTH: f32 = 320.0;
const FOOTER_HEIGHT: f32 = 48.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Screen {
    Dashboard,
    Settings,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tab {
    Providers,
    History,
    Projects,
    Machines,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    Refresh,
    Sync,
    Save(Settings),
    OpenDashboard(String),
    Hide,
    Quit,
    CheckUpdate,
    InstallUpdate,
    StartDrag,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum UpdateCheck {
    #[default]
    Idle,
    Checking,
    Current,
    Failed(String),
}

#[derive(Clone, Debug, Default)]
pub struct UpdateStatus {
    /// A newer version the latest release offers.
    pub available: Option<String>,
    pub installing: bool,
    pub error: Option<String>,
    pub check: UpdateCheck,
}

/// What the popup shows; read-only to the drawing code.
pub struct Model<'a> {
    pub state: &'a AppState,
    pub settings: &'a Settings,
    pub clock: &'a Clock,
    pub now: f64,
    pub update: &'a UpdateStatus,
    pub setting_errors: &'a IndexMap<String, String>,
    pub settings_error: Option<&'a str>,
    pub version: &'a str,
    /// The footer's note after a sync the user started.
    pub sync_note: Option<&'a str>,
}

/// What the popup remembers between frames: the screen, tabs, choices and open sections.
pub struct View {
    pub screen: Screen,
    pub period: Period,
    pub tab: Tab,
    pub history_range: usize,
    pub history_bucket: Bucket,
    pub open_providers: HashSet<String>,
    pub open_row: Option<String>,
    pub shortcut: Option<String>,
    pub scroll_to_top: bool,
}

impl Default for View {
    fn default() -> Self {
        Self {
            screen: Screen::Dashboard,
            period: Period::Today,
            tab: Tab::Providers,
            history_range: 30,
            history_bucket: Bucket::Day,
            open_providers: HashSet::new(),
            open_row: None,
            shortcut: None,
            scroll_to_top: false,
        }
    }
}

pub struct Assets {
    pub marks: ProviderMarks,
}

pub struct Frame<'a> {
    pub palette: Palette,
    pub assets: &'a Assets,
    pub actions: Vec<Action>,
}

impl Frame<'_> {
    fn act(&mut self, action: Action) {
        self.actions.push(action);
    }

    /// A settings change, saved right away like the renderer's `patch`.
    fn patch(&mut self, settings: &Settings, change: impl FnOnce(&mut Settings)) {
        let mut next = settings.clone();
        change(&mut next);
        if next != *settings {
            self.act(Action::Save(next));
        }
    }
}

/// Draws the whole popup; returns the actions and the height that shows everything without scrolling.
pub fn draw(ui: &mut Ui, view: &mut View, model: &Model, assets: &Assets, palette: Palette) -> (Vec<Action>, f32) {
    let mut frame = Frame { palette, assets, actions: Vec::new() };
    handle_keys(ui, view, model, &mut frame);
    let full = ui.max_rect();
    ui.painter().rect_filled(full, CornerRadius::ZERO, palette.surface);
    let footer = view.screen == Screen::Dashboard;
    let body_height = full.height() - if footer { FOOTER_HEIGHT } else { 0.0 };
    let mut content_height = 0.0;
    ui.allocate_ui_with_layout(Vec2::new(full.width(), body_height), Layout::top_down(Align::Min), |ui| {
        let mut area = ScrollArea::vertical().max_height(body_height).auto_shrink([false, false]);
        if std::mem::take(&mut view.scroll_to_top) {
            area = area.vertical_scroll_offset(0.0);
        }
        let output = area.show(ui, |ui| {
            ui.spacing_mut().item_spacing = Vec2::new(8.0, 0.0);
            ui.set_width(full.width());
            ui.set_max_width(full.width());
            body(ui, view, model, &mut frame);
        });
        content_height = output.content_size.y;
        let below = output.state.clamped_offset().y + output.inner_rect.height() < output.content_size.y - 1.0;
        if below {
            fade(ui, output.inner_rect, palette.surface);
        }
    });
    if footer {
        footer_bar(
            ui,
            view,
            model,
            &mut frame,
            Rect::from_min_max(egui::pos2(full.left(), full.bottom() - FOOTER_HEIGHT), full.max),
        );
    }
    (frame.actions, content_height + if footer { FOOTER_HEIGHT } else { 0.0 })
}

/// The cue that more follows, since overlay scrollbars stay hidden until scrolling starts.
fn fade(ui: &Ui, rect: Rect, surface: Color32) {
    let band = Rect::from_min_max(egui::pos2(rect.left(), rect.bottom() - 28.0), rect.max);
    let mut mesh = Mesh::default();
    let clear = Color32::from_rgba_unmultiplied(surface.r(), surface.g(), surface.b(), 0);
    mesh.colored_vertex(band.left_top(), clear);
    mesh.colored_vertex(band.right_top(), clear);
    mesh.colored_vertex(band.right_bottom(), surface);
    mesh.colored_vertex(band.left_bottom(), surface);
    mesh.add_triangle(0, 1, 2);
    mesh.add_triangle(0, 2, 3);
    ui.painter().add(mesh);
}

fn handle_keys(ui: &Ui, view: &mut View, model: &Model, frame: &mut Frame) {
    let typing = ui.ctx().egui_wants_keyboard_input();
    let (escape, left, right) = ui.input(|i| {
        (i.key_pressed(egui::Key::Escape), i.key_pressed(egui::Key::ArrowLeft), i.key_pressed(egui::Key::ArrowRight))
    });
    if escape && !typing {
        if view.screen == Screen::Settings {
            view.screen = Screen::Dashboard;
        } else if !model.settings.keep_open {
            frame.act(Action::Hide);
        }
    }
    if view.screen == Screen::Dashboard && !typing && (left || right) {
        let tabs = dashboard::tabs(model.state);
        let index = tabs.iter().position(|(tab, _)| *tab == view.tab).unwrap_or(0);
        let step = if right { 1 } else { tabs.len() - 1 };
        view.tab = tabs[(index + step) % tabs.len()].0;
    }
}

fn body(ui: &mut Ui, view: &mut View, model: &Model, frame: &mut Frame) {
    let palette = frame.palette;
    if let Some(error) = model.settings_error {
        let settings = model.settings.clone();
        banner(ui, &palette, |ui| {
            ui.label(text(format!("Could not save settings: {error}"), 12.0, palette.ink2));
            if link(ui, &palette, "Retry", true).clicked() {
                frame.act(Action::Save(settings));
            }
        });
    }
    if view.screen == Screen::Dashboard {
        if let Some(version) = &model.update.available {
            banner(ui, &palette, |ui| {
                if model.update.installing {
                    ui.label(text(format!("Installing opentrack {version}…"), 12.0, palette.ink2));
                    return;
                }
                let message = model.update.error.as_ref().map_or_else(
                    || format!("opentrack {version} is available."),
                    |error| format!("Could not install opentrack {version}: {error}"),
                );
                ui.label(text(message, 12.0, palette.ink2));
                let label = if model.update.error.is_some() { "Retry" } else { "Install and restart" };
                if link(ui, &palette, label, true).clicked() {
                    frame.act(Action::InstallUpdate);
                }
            });
        }
    }
    match view.screen {
        Screen::Settings => settings_screen::show(ui, view, model, frame),
        Screen::Dashboard if model.settings.compact => dashboard::compact(ui, model, frame),
        Screen::Dashboard => dashboard::show(ui, view, model, frame),
    }
}

fn footer_bar(ui: &mut Ui, view: &mut View, model: &Model, frame: &mut Frame, rect: Rect) {
    let palette = frame.palette;
    let state = model.state;
    ui.painter().hline(rect.x_range(), rect.top(), Stroke::new(1.0, palette.rule));
    let drag = ui.interact(rect, ui.scope_id().with("footer-drag"), Sense::drag());
    if model.settings.keep_open && drag.drag_started() {
        frame.act(Action::StartDrag);
    }
    let status = if state.syncing {
        "Syncing…".to_owned()
    } else if state.refreshing {
        "Updating…".to_owned()
    } else {
        model.sync_note.map_or_else(|| freshness_line(model.clock, state, model.now), str::to_owned)
    };
    let busy = state.syncing || state.refreshing;
    let spin = if state.refreshing { ui.input(|i| i.time) as f32 * std::f32::consts::TAU / 0.9 } else { 0.0 };
    let mut inner = ui.new_child(
        egui::UiBuilder::new().max_rect(rect.shrink2(Vec2::new(0.0, 0.0))).layout(Layout::left_to_right(Align::Center)),
    );
    inner.add_space(16.0);
    inner.spacing_mut().item_spacing.x = 4.0;
    inner.label(text(status, 11.5, palette.ink3));
    inner.with_layout(Layout::right_to_left(Align::Center), |ui| {
        ui.add_space(10.0);
        if icon_button(ui, &palette, IconButton::new(Glyph::Sliders, "Settings")).clicked() {
            view.screen = Screen::Settings;
            view.scroll_to_top = true;
        }
        if icon_button(
            ui,
            &palette,
            IconButton { enabled: !busy, rotation: spin, ..IconButton::new(Glyph::Refresh, "Refresh") },
        )
        .clicked()
        {
            frame.act(Action::Refresh);
        }
        let sync_label = state.sync_result.as_ref().map_or("Sync this machine (aitrack sync)", |r| r.message.as_str());
        let pulse = if state.syncing { 0.55 + 0.45 * (ui.input(|i| i.time) as f32 * 5.2).cos().abs() } else { 1.0 };
        let sync = ui.scope(|ui| {
            ui.set_opacity(pulse);
            icon_button(ui, &palette, IconButton { enabled: !busy, ..IconButton::new(Glyph::Sync, sync_label) })
        });
        if sync.inner.clicked() {
            frame.act(Action::Sync);
        }
        let compact = model.settings.compact;
        let label = if compact { "Full view" } else { "Compact view" };
        if icon_button(ui, &palette, IconButton { active: compact, ..IconButton::new(Glyph::Compact, label) }).clicked()
        {
            frame.patch(model.settings, |s| s.compact = !compact);
        }
    });
    if busy {
        ui.ctx().request_repaint_after(std::time::Duration::from_millis(16));
    }
}

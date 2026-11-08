//! The window: placing and hiding the popup, routing background events to the UI, and carrying out
//! what the UI asks for.

use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use aitrack_core::time::Clock;
use eframe::egui::{self, Pos2, Vec2, ViewportCommand};
use indexmap::IndexMap;

use crate::background::{Background, Event, TrayImage};
use crate::panel::{PanelState, ToggleAction};
use crate::position::{corner_tray, grown_bounds, popup_bounds, Rect};
use crate::settings::Settings;
use crate::state::AppState;
use crate::system::{notify, open_dashboard, System};
use crate::tray::Tray;
use crate::ui::format::refresh_outcome;
use crate::ui::icons::ProviderMarks;
use crate::ui::theme::{install_fonts, Palette};
use crate::ui::{draw, Action, Assets, Model, Screen, UpdateCheck, UpdateStatus, View, WIDTH};
use crate::updater::Updater;

pub enum Msg {
    Toggle(Option<Rect>),
    Show(Screen),
    Refresh,
    Quit,
    State(Box<AppState>),
    Settings(Box<Settings>),
    Alert { title: String, body: String },
    Tray(TrayImage),
    UpdateFound(Option<String>),
    UpdateCheckFailed(String),
    UpdateInstallFailed(String),
}

/// Sends to the UI thread and wakes it, hidden or not.
#[derive(Clone)]
pub struct Bus {
    tx: Sender<Msg>,
    ctx: egui::Context,
}

impl Bus {
    pub fn send(&self, msg: Msg) {
        let _ = self.tx.send(msg);
        self.ctx.request_repaint();
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Run {
    Sync,
    Refresh,
}

pub struct App {
    background: Arc<Background>,
    rx: Receiver<Msg>,
    bus: Bus,
    clock: Clock,
    state: AppState,
    settings: Settings,
    view: View,
    assets: Assets,
    panel: PanelState,
    visible: bool,
    focused: bool,
    /// eframe shows the window after its first frame; the app starts in the tray.
    started: bool,
    /// Content height in points, as last laid out.
    content_height: f32,
    tray: Tray,
    system: System,
    setting_errors: IndexMap<String, String>,
    settings_error: Option<String>,
    applied: Option<Settings>,
    update: UpdateStatus,
    updater: Updater,
    user_run: Option<Run>,
    was_busy: Option<Run>,
    sync_note: Option<(String, Instant)>,
}

impl App {
    pub fn new(cc: &eframe::CreationContext<'_>, background: Arc<Background>, listener: std::net::TcpListener) -> Self {
        let ctx = cc.egui_ctx.clone();
        install_fonts(&ctx);
        let (tx, rx) = channel();
        let bus = Bus { tx, ctx: ctx.clone() };
        let show_bus = bus.clone();
        crate::instance::listen(listener, move |request| {
            let screen = if request == "settings" { Screen::Settings } else { Screen::Dashboard };
            show_bus.send(Msg::Show(screen));
        });
        let tray = Tray::new(&bus);
        let system = System::new(&bus);
        let updater = Updater::default();
        updater.watch(bus.clone());
        let events = bus.clone();
        background.start(move |event| {
            let msg = match event {
                Event::State(state) => Msg::State(Box::new(state.clone())),
                Event::Settings(settings) => Msg::Settings(Box::new(settings.clone())),
                Event::Alert { title, body } => Msg::Alert { title: title.into(), body: body.into() },
                Event::Tray(image) => Msg::Tray(image),
            };
            events.send(msg);
        });
        #[cfg(target_os = "macos")]
        crate::macos::round_corners(cc);
        #[cfg(windows)]
        crate::windows::round_corners(cc);
        Self {
            state: background.service.state(),
            settings: background.service.settings(),
            background,
            rx,
            bus,
            clock: Clock::system(),
            view: View::default(),
            assets: Assets { marks: ProviderMarks::load(&ctx) },
            panel: PanelState::new(),
            visible: false,
            focused: false,
            started: false,
            content_height: 560.0,
            tray,
            system,
            setting_errors: IndexMap::new(),
            settings_error: None,
            applied: None,
            update: UpdateStatus::default(),
            updater,
            user_run: None,
            was_busy: None,
            sync_note: None,
        }
    }

    #[allow(clippy::cast_precision_loss)]
    fn now() -> f64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64)
    }

    fn work_area(ctx: &egui::Context, point: Option<(i32, i32)>) -> (Rect, f32) {
        #[cfg(target_os = "macos")]
        if let Some(area) = crate::macos::work_area(point) {
            return area;
        }
        #[cfg(windows)]
        if let Some(area) = crate::windows::work_area(point) {
            return area;
        }
        let _ = point;
        let (size, scale) = ctx.input(|i| {
            let viewport = i.viewport();
            (
                viewport.monitor_size.unwrap_or(Vec2::new(1920.0, 1080.0)),
                viewport.native_pixels_per_point.unwrap_or(1.0),
            )
        });
        #[allow(clippy::cast_possible_truncation)]
        let rect = Rect { x: 0, y: 0, width: (size.x * scale) as i32, height: (size.y * scale) as i32 };
        (rect, scale)
    }

    /// Size and position for the content height: at the tray for a popup, grown in place when kept open.
    #[allow(clippy::cast_possible_truncation, clippy::cast_precision_loss)]
    fn place(&self, ctx: &egui::Context, initial: bool) {
        let tray = self.panel.tray;
        let (work, scale) = Self::work_area(ctx, tray.map(|t| (t.x + t.width / 2, t.y + t.height / 2)));
        let width = (WIDTH * scale).round() as i32;
        let height = (self.content_height * scale).round() as i32;
        let bounds = if self.panel.floating && !initial {
            let top = ctx.input(|i| i.viewport().outer_rect).map_or(work.y, |r| (r.top() * scale) as i32);
            let left = ctx.input(|i| i.viewport().outer_rect).map_or(work.x, |r| (r.left() * scale) as i32);
            let (y, height) = grown_bounds(top, height, work);
            Rect { x: left, y, width, height }
        } else {
            let tray = tray.unwrap_or_else(|| corner_tray(work, !cfg!(windows)));
            popup_bounds(tray, work, width, height)
        };
        ctx.send_viewport_cmd(ViewportCommand::InnerSize(Vec2::new(bounds.width as f32, bounds.height as f32) / scale));
        ctx.send_viewport_cmd(ViewportCommand::OuterPosition(Pos2::new(bounds.x as f32, bounds.y as f32) / scale));
    }

    fn show(&mut self, ctx: &egui::Context, screen: Option<Screen>) {
        if !self.panel.floating || !self.visible {
            self.place(ctx, true);
        }
        if let Some(screen) = screen {
            self.view.screen = screen;
            self.view.scroll_to_top = true;
        }
        ctx.send_viewport_cmd(ViewportCommand::Visible(true));
        ctx.send_viewport_cmd(ViewportCommand::Focus);
        self.visible = true;
        // Focus arrives a frame later; only a loss after it counts as a blur.
        self.focused = false;
    }

    fn hide(&mut self, ctx: &egui::Context) {
        ctx.send_viewport_cmd(ViewportCommand::Visible(false));
        self.visible = false;
    }

    fn apply_settings(&mut self, ctx: &egui::Context) {
        if self.applied.as_ref() == Some(&self.settings) {
            return;
        }
        let theme = match self.settings.theme.as_str() {
            "light" => egui::ThemePreference::Light,
            "dark" => egui::ThemePreference::Dark,
            _ => egui::ThemePreference::System,
        };
        ctx.set_theme(theme);
        ctx.set_visuals_of(egui::Theme::Light, Palette::for_dark(false).visuals());
        ctx.set_visuals_of(egui::Theme::Dark, Palette::for_dark(true).visuals());
        self.panel.floating = self.settings.keep_open;
        let outside = self.applied.as_ref().is_none_or(|old| {
            old.launch_at_login != self.settings.launch_at_login || old.global_shortcut != self.settings.global_shortcut
        });
        if outside {
            self.setting_errors = self.system.apply(&self.settings);
        }
        self.applied = Some(self.settings.clone());
    }

    fn on_state(&mut self, state: AppState) {
        let busy = if state.syncing {
            Some(Run::Sync)
        } else if state.refreshing {
            Some(Run::Refresh)
        } else {
            None
        };
        if busy.is_none() && self.was_busy.is_some() {
            if self.user_run == Some(Run::Sync) {
                if let Some(result) = state.sync_result.as_ref().filter(|r| r.ok) {
                    self.sync_note = Some((result.message.clone(), Instant::now()));
                }
            }
            if self.user_run == Some(Run::Refresh) {
                log_outcome(&refresh_outcome(&state));
            }
            self.user_run = None;
        }
        self.was_busy = busy;
        self.state = state;
    }

    fn receive(&mut self, ctx: &egui::Context) {
        while let Ok(msg) = self.rx.try_recv() {
            match msg {
                Msg::Toggle(tray) => match self.panel.toggle(self.visible, tray, Instant::now()) {
                    ToggleAction::Hide => self.hide(ctx),
                    ToggleAction::Show => self.show(ctx, None),
                    ToggleAction::Ignore => {}
                },
                Msg::Show(screen) => self.show(ctx, Some(screen)),
                Msg::Refresh => self.background.refresh_in_background(true),
                Msg::Quit => std::process::exit(0),
                Msg::State(state) => self.on_state(*state),
                Msg::Settings(settings) => {
                    self.settings = *settings;
                    self.apply_settings(ctx);
                }
                Msg::Alert { title, body } => notify(&title, &body),
                Msg::Tray(image) => self.tray.set(image),
                Msg::UpdateFound(version) => {
                    self.update.check = if version.is_some() { UpdateCheck::Idle } else { UpdateCheck::Current };
                    if version.is_none() {
                        self.update.error = None;
                    }
                    self.update.available = version;
                }
                Msg::UpdateCheckFailed(error) => self.update.check = UpdateCheck::Failed(error),
                Msg::UpdateInstallFailed(error) => {
                    self.update.installing = false;
                    self.update.error = Some(error);
                }
            }
        }
    }

    fn act(&mut self, ctx: &egui::Context, action: Action) {
        match action {
            Action::Refresh => {
                self.user_run = Some(Run::Refresh);
                self.background.refresh_in_background(true);
            }
            Action::Sync => {
                self.user_run = Some(Run::Sync);
                self.background.sync_in_background();
            }
            Action::Save(settings) => {
                let input = serde_json::to_value(&settings).unwrap_or_default();
                // Applied now so a second change made before the save lands builds on this one.
                self.settings = settings;
                match self.background.save_settings(&input) {
                    Ok(saved) => {
                        self.settings = saved;
                        self.settings_error = None;
                    }
                    Err(error) => self.settings_error = Some(error),
                }
                self.apply_settings(ctx);
            }
            Action::OpenDashboard(provider) => {
                if let Err(error) = open_dashboard(&provider) {
                    log_outcome(&error);
                }
            }
            Action::Hide => self.hide(ctx),
            Action::Quit => std::process::exit(0),
            Action::CheckUpdate => {
                self.update.check = UpdateCheck::Checking;
                let (updater, bus) = (self.updater.clone(), self.bus.clone());
                std::thread::spawn(move || updater.check(&bus));
            }
            Action::InstallUpdate => {
                self.update.installing = true;
                self.update.error = None;
                self.updater.install(self.bus.clone());
            }
            Action::StartDrag => ctx.send_viewport_cmd(ViewportCommand::StartDrag),
        }
    }
}

fn log_outcome(message: &str) {
    eprintln!("opentrack: {message}");
}

impl eframe::App for App {
    fn logic(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.apply_settings(ctx);
        if !self.started {
            self.started = true;
            ctx.send_viewport_cmd(ViewportCommand::Visible(false));
        }
        self.receive(ctx);
        let focused = ctx.input(|i| i.viewport().focused).unwrap_or(false);
        if self.focused && !focused && self.panel.hide_on_blur(self.visible, Instant::now()) {
            self.hide(ctx);
        }
        self.focused = focused;
        if ctx.input(|i| i.viewport().close_requested()) {
            // Quitting is the tray's job; Alt+F4 or the taskbar's Close only dismiss the window.
            ctx.send_viewport_cmd(ViewportCommand::CancelClose);
            self.hide(ctx);
        }
        if self.sync_note.as_ref().is_some_and(|(_, at)| at.elapsed() > Duration::from_secs(6)) {
            self.sync_note = None;
        }
        // The footer's age and reset countdowns move on their own.
        ctx.request_repaint_after(Duration::from_secs(15));
    }

    fn ui(&mut self, ui: &mut egui::Ui, frame: &mut eframe::Frame) {
        let ctx = ui.ctx().clone();
        let palette = Palette::for_dark(ctx.theme() == egui::Theme::Dark);
        let now = Self::now();
        let model = Model {
            state: &self.state,
            settings: &self.settings,
            clock: &self.clock,
            now,
            update: &self.update,
            setting_errors: &self.setting_errors,
            settings_error: self.settings_error.as_deref(),
            version: env!("CARGO_PKG_VERSION"),
            sync_note: self.sync_note.as_ref().map(|(note, _)| note.as_str()),
        };
        let (actions, height) = draw(ui, &mut self.view, &model, &self.assets, palette);
        for action in actions {
            self.act(&ctx, action);
        }
        if (height - self.content_height).abs() > 0.5 {
            self.content_height = height.ceil();
            if self.visible {
                self.place(&ctx, false);
                #[cfg(target_os = "macos")]
                crate::macos::refresh_shadow(frame);
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = frame;
    }

    fn clear_color(&self, visuals: &egui::Visuals) -> [f32; 4] {
        visuals.panel_fill.to_normalized_gamma_f32()
    }
}

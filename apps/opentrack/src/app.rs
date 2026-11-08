//! The window: placing and hiding the popup, routing background events to the UI, and carrying out
//! what the UI asks for.

use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use aitrack_core::time::Clock;
use eframe::egui::{self, Pos2, Vec2, ViewportCommand};
use raw_window_handle::HasWindowHandle;

use crate::background::{Background, Event, TrayImage};
use crate::instance::{Listener, Request};
use crate::panel::{PanelState, ToggleAction};
use crate::platform;
use crate::position::{window_bounds, Rect};
use crate::settings::Settings;
use crate::state::AppState;
use crate::system::{notify, open_dashboard, set_launch_at_login, SettingErrors, System};
use crate::tray::Tray;
use crate::ui::format::refresh_outcome;
use crate::ui::icons::ProviderMarks;
use crate::ui::theme::{install_fonts, Palette};
use crate::ui::{draw, Action, Model, Screen, UpdateCheck, UpdateStatus, View, INITIAL_HEIGHT, WIDTH};
use crate::updater::Updater;

/// How long the footer shows the outcome of a sync the user started.
const SYNC_NOTE_FOR: Duration = Duration::from_secs(6);

pub enum Msg {
    Toggle(Option<Rect>),
    Show(Screen),
    Refresh,
    Quit,
    State(Arc<AppState>),
    Settings(Box<Settings>),
    SaveFailed(String),
    LaunchAtLogin(Option<String>),
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
    saves: Sender<Settings>,
    clock: Clock,
    state: Arc<AppState>,
    settings: Settings,
    view: View,
    marks: ProviderMarks,
    panel: PanelState,
    /// Whether the popup should be on screen; `shown` is what the window was last told.
    visible: bool,
    shown: Option<bool>,
    /// Content height in points, as last laid out.
    content_height: f32,
    tray: Tray,
    system: System,
    setting_errors: SettingErrors,
    settings_error: Option<String>,
    /// What the theme and OS hooks were last set from.
    applied: Option<Settings>,
    update: UpdateStatus,
    updater: Updater,
    /// What the user started, so its outcome is reported when it ends.
    user_run: Option<Run>,
    sync_note_until: Option<Instant>,
}

impl App {
    pub fn new(cc: &eframe::CreationContext<'_>, background: Arc<Background>, listener: Listener) -> Self {
        let ctx = cc.egui_ctx.clone();
        install_fonts(&ctx);
        let (tx, rx) = channel();
        let bus = Bus { tx, ctx: ctx.clone() };
        let show_bus = bus.clone();
        crate::instance::listen(listener, move |request| {
            let screen = if request == Request::Settings { Screen::Settings } else { Screen::Dashboard };
            show_bus.send(Msg::Show(screen));
        });
        let tray = Tray::new(&bus);
        let system = System::new(&bus);
        let updater = Updater::default();
        updater.watch(bus.clone());
        let events = bus.clone();
        background.start(move |event| {
            events.send(match event {
                Event::State(state) => Msg::State(state),
                Event::Settings(settings) => Msg::Settings(Box::new(settings.clone())),
                Event::Alert { title, body } => Msg::Alert { title: title.into(), body: body.into() },
                Event::Tray(image) => Msg::Tray(image),
            });
        });
        let failed = bus.clone();
        let saves = background.saver(move |error| failed.send(Msg::SaveFailed(error)));
        platform::round_corners(cc);
        let mut app = Self {
            state: Arc::new(background.service.state()),
            settings: background.service.settings(),
            background,
            rx,
            bus,
            saves,
            clock: Clock::system(),
            view: View::default(),
            marks: ProviderMarks::load(&ctx),
            panel: PanelState::default(),
            visible: false,
            shown: None,
            content_height: INITIAL_HEIGHT,
            tray,
            system,
            setting_errors: SettingErrors::default(),
            settings_error: None,
            applied: None,
            update: UpdateStatus::default(),
            updater,
            user_run: None,
            sync_note_until: None,
        };
        app.apply_settings(&ctx, cc);
        app
    }

    fn work_area(ctx: &egui::Context, point: Option<(i32, i32)>) -> (Rect, f32) {
        platform::work_area(point).unwrap_or_else(|| {
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
        })
    }

    /// Size and position for the content height: at the tray for a popup, grown in place when kept open.
    #[allow(clippy::cast_possible_truncation, clippy::cast_precision_loss)]
    fn place(&self, ctx: &egui::Context, in_place: bool) {
        let tray = self.panel.tray;
        let (work, scale) = Self::work_area(ctx, tray.map(|t| (t.x + t.width / 2, t.y + t.height / 2)));
        let window_scale = ctx.input(|i| i.viewport().native_pixels_per_point).unwrap_or(scale);
        let position_scale = platform::position_scale(scale, window_scale);
        let kept_at = in_place
            .then(|| ctx.input(|i| i.viewport().outer_rect))
            .flatten()
            .map(|r| ((r.left() * position_scale).round() as i32, (r.top() * position_scale).round() as i32));
        let width = (WIDTH * scale).round() as i32;
        let height = (self.content_height * scale).round() as i32;
        let bounds = window_bounds(tray, kept_at, work, width, height, platform::TRAY_ON_TOP);
        ctx.send_viewport_cmd(ViewportCommand::InnerSize(Vec2::new(bounds.width as f32, bounds.height as f32) / scale));
        ctx.send_viewport_cmd(ViewportCommand::OuterPosition(
            Pos2::new(bounds.x as f32, bounds.y as f32) / position_scale,
        ));
    }

    fn show(&mut self, ctx: &egui::Context, screen: Option<Screen>) {
        if !self.panel.floating || !self.visible {
            self.place(ctx, false);
        }
        if let Some(screen) = screen {
            self.view.screen = screen;
            self.view.scroll_to_top = true;
        }
        if self.shown == Some(true) {
            ctx.send_viewport_cmd(ViewportCommand::Focus);
        }
        self.visible = true;
        self.panel.shown();
    }

    fn hide(&mut self, ctx: &egui::Context) {
        self.visible = false;
        ctx.request_repaint();
    }

    /// Tells the window what `visible` says, once per change. eframe also shows the window after its
    /// first frame, which the first call here undoes.
    fn sync_window(&mut self, ctx: &egui::Context) {
        if self.shown != Some(self.visible) {
            self.shown = Some(self.visible);
            ctx.send_viewport_cmd(ViewportCommand::Visible(self.visible));
            if self.visible {
                ctx.send_viewport_cmd(ViewportCommand::Focus);
            }
        }
    }

    fn apply_settings(&mut self, ctx: &egui::Context, window: &impl HasWindowHandle) {
        let old = self.applied.replace(self.settings.clone());
        if old.as_ref() == Some(&self.settings) {
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
        let settings = &self.settings;
        if old.as_ref().is_none_or(|old| old.keep_open != settings.keep_open) {
            self.panel.floating = settings.keep_open;
            platform::show_in_taskbar(window, settings.keep_open);
        }
        if old.as_ref().is_none_or(|old| old.launch_at_login != settings.launch_at_login) {
            set_launch_at_login(settings.launch_at_login, self.bus.clone());
        }
        if old.as_ref().is_none_or(|old| old.global_shortcut != settings.global_shortcut) {
            self.setting_errors.global_shortcut = self.system.set_shortcut(&settings.global_shortcut);
        }
    }

    fn on_state(&mut self, state: Arc<AppState>) {
        let was_busy = self.state.syncing || self.state.refreshing;
        if was_busy && !(state.syncing || state.refreshing) {
            match self.user_run.take() {
                Some(Run::Sync) if state.sync_result.as_ref().is_some_and(|r| r.ok) => {
                    self.sync_note_until = Some(Instant::now() + SYNC_NOTE_FOR);
                }
                Some(Run::Refresh) => log_outcome(&refresh_outcome(&state)),
                _ => {}
            }
        }
        self.state = state;
    }

    fn receive(&mut self, ctx: &egui::Context, window: &impl HasWindowHandle) {
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
                Msg::State(state) => self.on_state(state),
                Msg::Settings(settings) => {
                    self.settings = *settings;
                    self.apply_settings(ctx, window);
                }
                Msg::SaveFailed(error) => self.settings_error = Some(error),
                Msg::LaunchAtLogin(error) => self.setting_errors.launch_at_login = error,
                Msg::Alert { title, body } => notify(title, body),
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

    fn act(&mut self, ctx: &egui::Context, window: &impl HasWindowHandle, action: Action) {
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
                let _ = self.saves.send(settings.clone());
                self.settings = settings;
                self.settings_error = None;
                self.apply_settings(ctx, window);
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
                std::thread::spawn(move || updater.check(&bus, true));
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
    fn logic(&mut self, ctx: &egui::Context, frame: &mut eframe::Frame) {
        self.receive(ctx, frame);
        let focused = ctx.input(|i| i.viewport().focused).unwrap_or(false);
        if self.panel.blurred(self.visible, focused, Instant::now()) {
            self.hide(ctx);
        }
        if ctx.input(|i| i.viewport().close_requested()) {
            // Quitting is the tray's job; Alt+F4 or the taskbar's Close only dismiss the window.
            ctx.send_viewport_cmd(ViewportCommand::CancelClose);
            self.hide(ctx);
        }
        if let Some(until) = self.sync_note_until {
            match until.checked_duration_since(Instant::now()) {
                Some(left) => ctx.request_repaint_after(left),
                None => self.sync_note_until = None,
            }
        }
        self.sync_window(ctx);
        if self.visible {
            // The footer's age and reset countdowns move on their own.
            ctx.request_repaint_after(Duration::from_secs(15));
        }
    }

    fn ui(&mut self, ui: &mut egui::Ui, frame: &mut eframe::Frame) {
        if !self.visible {
            return;
        }
        let ctx = ui.ctx().clone();
        let palette = Palette::for_dark(ctx.theme() == egui::Theme::Dark);
        #[allow(clippy::cast_precision_loss)]
        let now = self.clock.now().as_millisecond() as f64;
        let (actions, height) = {
            let model = Model {
                state: &self.state,
                settings: &self.settings,
                clock: &self.clock,
                now,
                update: &self.update,
                setting_errors: &self.setting_errors,
                settings_error: self.settings_error.as_deref(),
                sync_note: self
                    .sync_note_until
                    .and(self.state.sync_result.as_ref())
                    .map(|result| result.message.as_str()),
            };
            draw(ui, &mut self.view, &model, &self.marks, palette)
        };
        for action in actions {
            self.act(&ctx, frame, action);
        }
        if (height - self.content_height).abs() > 0.5 {
            self.content_height = height.ceil();
            if self.visible {
                self.place(&ctx, self.panel.floating);
                platform::refresh_shadow(frame);
            }
        }
        self.sync_window(&ctx);
    }

    fn clear_color(&self, visuals: &egui::Visuals) -> [f32; 4] {
        visuals.panel_fill.to_normalized_gamma_f32()
    }
}

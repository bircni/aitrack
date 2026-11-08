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
use crate::system::{notify, open_dashboard, SettingErrors, System};
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
    /// A numbered save's normalized settings, or why it failed.
    Saved(u64, Result<Box<Settings>, String>),
    LaunchAtLogin(Option<String>),
    Alert {
        title: String,
        body: String,
    },
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
    saves: Sender<(u64, Settings)>,
    /// The newest save sent, so an older one's outcome is ignored.
    save_seq: u64,
    clock: Clock,
    state: Arc<AppState>,
    settings: Settings,
    view: View,
    marks: ProviderMarks,
    panel: PanelState,
    /// Whether the popup is meant to be on screen.
    visible: bool,
    /// Shown, waiting for a frame laid out at its content; `true` places it at the tray first.
    /// eframe shows the window after its first frame; the app starts in the tray.
    started: bool,
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
    /// What the user's sync ended with, shown until the deadline.
    sync_note: Option<(String, Instant)>,
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
        let saved = bus.clone();
        let save_count = background.saver(move |seq, result| saved.send(Msg::Saved(seq, result.map(Box::new))));
        platform::round_corners(cc);
        let mut app = Self {
            state: Arc::new(background.service.state()),
            settings: background.service.settings(),
            background,
            rx,
            bus,
            saves: save_count,
            save_seq: 0,
            clock: Clock::system(),
            view: View::default(),
            marks: ProviderMarks::load(&ctx),
            panel: PanelState::default(),
            visible: false,
            started: false,
            content_height: INITIAL_HEIGHT,
            tray,
            system,
            setting_errors: SettingErrors::default(),
            settings_error: None,
            applied: None,
            update: UpdateStatus::default(),
            updater,
            user_run: None,
            sync_note: None,
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
            #[expect(
                clippy::cast_possible_truncation,
                reason = "the value is rounded and bounded to the target range first"
            )]
            let rect = Rect { x: 0, y: 0, width: (size.x * scale) as i32, height: (size.y * scale) as i32 };
            (rect, scale)
        })
    }

    /// Size and position for the content height: at the tray for a popup, grown in place when kept open,
    /// on the screen the kept-open window was dragged to.
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_precision_loss,
        reason = "a bounded, rounded number converted between float and integer"
    )]
    fn place(&self, ctx: &egui::Context, in_place: bool) {
        let window_scale = ctx.input(|i| i.viewport().native_pixels_per_point).unwrap_or(1.0);
        let kept = in_place.then(|| ctx.input(|i| i.viewport().outer_rect)).flatten();
        let tray = self.panel.tray;
        let point = kept.map_or_else(
            || tray.map(|t| (t.x + t.width / 2, t.y + t.height / 2)),
            |r| Some(((r.center().x * window_scale) as i32, (r.center().y * window_scale) as i32)),
        );
        let (work, scale) = Self::work_area(ctx, point);
        let position_scale = platform::position_scale(scale, window_scale);
        let kept_at =
            kept.map(|r| ((r.left() * position_scale).round() as i32, (r.top() * position_scale).round() as i32));
        let width = (WIDTH * scale).round() as i32;
        let height = (self.content_height * scale).round() as i32;
        let bounds = window_bounds(tray, kept_at, work, width, height, platform::TRAY_ON_TOP);
        ctx.send_viewport_cmd(ViewportCommand::InnerSize(Vec2::new(bounds.width as f32, bounds.height as f32) / scale));
        ctx.send_viewport_cmd(ViewportCommand::OuterPosition(
            Pos2::new(bounds.x as f32, bounds.y as f32) / position_scale,
        ));
    }

    fn show(&mut self, ctx: &egui::Context, screen: Option<Screen>) {
        if let Some(screen) = screen {
            self.view.screen = screen;
            self.view.scroll_to_top = true;
        }
        // eframe runs no UI frames for a hidden window, so it is placed with the last measured height and
        // shown here; the next frame refits it if the content changed.
        if !self.panel.floating || !self.visible {
            self.place(ctx, false);
        }
        self.visible = true;
        self.panel.shown();
        ctx.send_viewport_cmd(ViewportCommand::Visible(true));
        ctx.send_viewport_cmd(ViewportCommand::Focus);
    }

    fn hide(&mut self, ctx: &egui::Context) {
        self.visible = false;
        ctx.send_viewport_cmd(ViewportCommand::Visible(false));
    }

    fn apply_settings(&mut self, ctx: &egui::Context, window: &impl HasWindowHandle) {
        if self.applied.as_ref() == Some(&self.settings) {
            return;
        }
        let old = self.applied.replace(self.settings.clone());
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
            self.system.set_launch_at_login(settings.launch_at_login);
        }
        if old.as_ref().is_none_or(|old| old.global_shortcut != settings.global_shortcut) {
            self.setting_errors.global_shortcut = self.system.set_shortcut(&settings.global_shortcut);
        }
    }

    /// An equal state keeps the one the UI's caches were built from.
    fn on_state(&mut self, state: Arc<AppState>) {
        if *state == *self.state {
            return;
        }
        let was_busy = self.state.syncing || self.state.refreshing;
        if was_busy && !(state.syncing || state.refreshing) {
            match self.user_run.take() {
                Some(Run::Sync) => {
                    if let Some(result) = state.sync_result.as_ref().filter(|r| r.ok) {
                        self.sync_note = Some((result.message.clone(), Instant::now() + SYNC_NOTE_FOR));
                    }
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
                Msg::Saved(seq, result) if seq == self.save_seq => match result {
                    Ok(saved) => {
                        self.settings_error = None;
                        if *saved != self.settings {
                            self.settings = *saved;
                            self.apply_settings(ctx, window);
                        }
                    }
                    Err(error) => self.settings_error = Some(error),
                },
                Msg::Saved(..) => {}
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
                self.save_seq += 1;
                let _ = self.saves.send((self.save_seq, settings.clone()));
                self.settings = settings;
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
        if !self.started {
            self.started = true;
            ctx.send_viewport_cmd(ViewportCommand::Visible(false));
        }
        self.receive(ctx, frame);
        // Focus changes, not the polled flag: that one can be stale from before the window was hidden.
        let changes: Vec<bool> = ctx.input(|i| {
            i.events
                .iter()
                .filter_map(|e| if let egui::Event::WindowFocused(f) = e { Some(*f) } else { None })
                .collect()
        });
        for focused in changes {
            if self.panel.blurred(self.visible, focused, Instant::now()) {
                self.hide(ctx);
            }
        }
        if ctx.input(|i| i.viewport().close_requested()) {
            // Quitting is the tray's job; Alt+F4 or the taskbar's Close only dismiss the window.
            ctx.send_viewport_cmd(ViewportCommand::CancelClose);
            self.hide(ctx);
        }
        if let Some((_, until)) = &self.sync_note {
            match until.checked_duration_since(Instant::now()) {
                Some(left) => ctx.request_repaint_after(left),
                None => self.sync_note = None,
            }
        }
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
        #[expect(
            clippy::cast_precision_loss,
            reason = "counts and millisecond times stay far below 2^53, like the JavaScript numbers 4.x used"
        )]
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
                sync_note: self.sync_note.as_ref().map(|(message, _)| message.as_str()),
            };
            draw(ui, &mut self.view, &model, &self.marks, palette)
        };
        for action in actions {
            self.act(&ctx, frame, action);
        }
        let resized = (height - self.content_height).abs() > 0.5;
        if resized {
            self.content_height = height.ceil();
        }
        if resized {
            self.place(&ctx, self.panel.floating);
            platform::refresh_shadow(frame);
        }
    }

    fn clear_color(&self, visuals: &egui::Visuals) -> [f32; 4] {
        visuals.panel_fill.to_normalized_gamma_f32()
    }
}

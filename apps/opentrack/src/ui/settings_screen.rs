//! Settings: providers, appearance, tray, alerts, data repo, general and about.

use eframe::egui::{
    self, Align, Align2, CornerRadius, FontId, Frame as EguiFrame, Layout, Margin, Role, Sense, Stroke, Ui, Vec2,
    WidgetInfo,
};

use super::dashboard::mark;
use super::format::INIT_HINT;
use super::icons::{paint_glyph, square, Glyph};
use super::theme::{bold, Palette};
use super::widgets::{icon_button, link, paint_focus, segmented, strong, switch, text, IconButton};
use super::{Action, Frame, Model, Screen, UpdateCheck, View};
use crate::settings::{Settings, ALERT_THRESHOLDS};
use crate::whats_new;

const ROW_HEIGHT: f32 = 32.0;
const HEAD_HEIGHT: f32 = 40.0;

/// A card under a small heading, as the release notes use.
pub fn group(ui: &mut Ui, palette: &Palette, title: &str, add: impl FnOnce(&mut Ui)) {
    EguiFrame::new().outer_margin(Margin { left: 12, right: 12, top: 0, bottom: 14 }).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.label(strong(title, 12.0, palette.ink2));
        ui.add_space(6.0);
        card(ui, palette, add);
    });
}

fn card(ui: &mut Ui, palette: &Palette, add: impl FnOnce(&mut Ui)) {
    EguiFrame::new()
        .fill(palette.card)
        .stroke(Stroke::new(1.0, palette.edge))
        .corner_radius(CornerRadius::same(12))
        .inner_margin(Margin::symmetric(12, 0))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            add(ui);
        });
}

pub fn rule(ui: &mut Ui, palette: &Palette) {
    let (rect, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 1.0), Sense::hover());
    ui.painter().hline(rect.x_range(), rect.center().y, Stroke::new(1.0, palette.rule));
}

/// A card that folds to its title and a summary of what it holds; one with an error stays open.
fn section(
    ui: &mut Ui,
    view: &mut View,
    palette: &Palette,
    (title, summary): (&'static str, &str),
    forced_open: bool,
    add: impl FnOnce(&mut Ui, &mut View),
) {
    EguiFrame::new().outer_margin(Margin { left: 12, right: 12, top: 0, bottom: 8 }).show(ui, |ui| {
        card(ui, palette, |ui| {
            let open = forced_open || view.open_settings.contains(title);
            let (rect, response) = ui.allocate_exact_size(Vec2::new(ui.available_width(), HEAD_HEIGHT), Sense::click());
            let response = response.on_hover_cursor(egui::CursorIcon::PointingHand);
            let painter = ui.painter();
            painter.text(rect.left_center(), Align2::LEFT_CENTER, title, FontId::new(13.0, bold()), palette.ink);
            let openness = ui.ctx().animate_bool_with_time(response.id, open, 0.16);
            let chevron = square(egui::pos2(rect.right() - 7.0, rect.center().y), 14.0);
            paint_glyph(painter, chevron, Glyph::ChevronDown, palette.ink2, openness * std::f32::consts::PI);
            if !open {
                let at = egui::pos2(chevron.left() - 8.0, rect.center().y);
                painter.text(at, Align2::RIGHT_CENTER, summary, FontId::proportional(11.5), palette.ink2);
            }
            response.widget_info(|| WidgetInfo::selected(Role::Button, true, open, title));
            paint_focus(ui, palette, &response, rect, 6);
            if response.clicked() && !forced_open && !view.open_settings.remove(title) {
                view.open_settings.insert(title);
            }
            if open {
                add(ui, view);
                ui.add_space(4.0);
            }
        });
    });
}

/// One setting under a rule: its label, with `hint` on hover, and `control` on the right; an error
/// shows below it.
fn line(
    ui: &mut Ui,
    palette: &Palette,
    label: &str,
    hint: Option<&str>,
    error: Option<&str>,
    control: impl FnOnce(&mut Ui),
) {
    rule(ui, palette);
    ui.allocate_ui_with_layout(
        Vec2::new(ui.available_width(), ROW_HEIGHT),
        Layout::left_to_right(Align::Center),
        |ui| {
            ui.set_min_height(ROW_HEIGHT);
            let label = ui.label(text(label, 13.0, palette.ink));
            if let Some(hint) = hint {
                label.on_hover_text(hint);
            }
            ui.with_layout(Layout::right_to_left(Align::Center), control);
        },
    );
    if let Some(error) = error {
        ui.add(egui::Label::new(text(error, 11.0, palette.crit_text)).wrap());
        ui.add_space(6.0);
    }
}

fn choice_line<T: Copy + PartialEq>(
    ui: &mut Ui,
    frame: &mut Frame<'_>,
    settings: &Settings,
    label: &str,
    current: T,
    options: &[(T, &str)],
    set: impl FnOnce(&mut Settings, T),
) {
    let palette = frame.palette;
    let mut value = current;
    let mut changed = false;
    line(ui, &palette, label, None, None, |ui| changed = segmented(ui, &palette, &mut value, options));
    if changed {
        frame.patch(settings, |s| set(s, value));
    }
}

fn switch_line(
    ui: &mut Ui,
    frame: &mut Frame<'_>,
    settings: &Settings,
    (label, hint, error): (&str, Option<&str>, Option<&str>),
    value: bool,
    set: impl FnOnce(&mut Settings, bool),
) {
    let palette = frame.palette;
    let mut on = value;
    let mut changed = false;
    line(ui, &palette, label, hint, error, |ui| changed = switch(ui, &palette, &mut on, label));
    if changed {
        frame.patch(settings, |s| set(s, on));
    }
}

fn label_of<'a>(options: &[(&str, &'a str)], value: &str) -> &'a str {
    options.iter().find(|(v, _)| *v == value).map_or("", |(_, label)| label)
}

pub fn show(ui: &mut Ui, view: &mut View, model: &Model<'_>, frame: &mut Frame<'_>) {
    let palette = frame.palette;
    ui.horizontal(|ui| {
        ui.add_space(8.0);
        ui.set_min_height(48.0);
        if icon_button(ui, &palette, IconButton::new(Glyph::Back, "Back")).clicked() {
            view.screen = Screen::Dashboard;
        }
        ui.label(strong("Settings", 15.0, palette.ink));
    });

    providers(ui, view, model, frame);
    appearance(ui, view, model, frame);
    tray(ui, view, model, frame);
    alerts(ui, view, model, frame);
    data_repo(ui, view, model, frame);
    general(ui, view, model, frame);
    ui.add_space(6.0);
    about(ui, view, model, frame);
}

fn providers(ui: &mut Ui, view: &mut View, model: &Model<'_>, frame: &mut Frame<'_>) {
    let palette = frame.palette;
    let settings = model.settings;
    let on: Vec<&str> = settings.providers.iter().filter(|p| p.enabled).map(|p| p.label.as_str()).collect();
    let summary = if on.is_empty() { "None on".to_owned() } else { on.join(", ") };
    section(ui, view, &palette, ("Providers", &summary), false, |ui, _| {
        let count = settings.providers.len();
        for (index, provider) in settings.providers.iter().enumerate() {
            let mut moved = None;
            let mut enabled = provider.enabled;
            let mut toggled = false;
            rule(ui, &palette);
            ui.horizontal(|ui| {
                ui.set_min_height(ROW_HEIGHT);
                ui.spacing_mut().item_spacing.x = 8.0;
                mark(ui, frame, &provider.key, 14.0);
                ui.label(text(&provider.label, 13.0, palette.ink));
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    ui.spacing_mut().item_spacing.x = 2.0;
                    let track = format!("Track {}", provider.label);
                    toggled = switch(ui, &palette, &mut enabled, &track);
                    ui.add_space(6.0);
                    let down = format!("Move {} down", provider.label);
                    let down = IconButton {
                        enabled: index + 1 < count,
                        size: 22.0,
                        ..IconButton::new(Glyph::ChevronDown, &down)
                    };
                    if icon_button(ui, &palette, down).clicked() {
                        moved = Some(index + 1);
                    }
                    let up = format!("Move {} up", provider.label);
                    let up = IconButton { enabled: index > 0, size: 22.0, ..IconButton::new(Glyph::ChevronUp, &up) };
                    if icon_button(ui, &palette, up).clicked() {
                        moved = index.checked_sub(1);
                    }
                });
            })
            .response
            .on_hover_text("A provider turned off is not read or contacted.");
            if let Some(target) = moved {
                frame.patch(settings, |s| {
                    let entry = s.providers.remove(index);
                    s.providers.insert(target.min(s.providers.len()), entry);
                });
            }
            if toggled {
                let key = provider.key.clone();
                frame.patch(settings, |s| {
                    if let Some(entry) = s.providers.iter_mut().find(|p| p.key == key) {
                        entry.enabled = enabled;
                    }
                });
            }
        }
    });
}

const THEMES: &[(&str, &str)] = &[("system", "System"), ("light", "Light"), ("dark", "Dark")];
const DISPLAYS: &[(&str, &str)] = &[("used", "Used"), ("left", "Left")];
const RESETS: &[(&str, &str)] = &[("absolute", "Clock time"), ("relative", "Countdown")];
const TRAY_STYLES: &[(&str, &str)] = &[("icon", "Icon"), ("bars", "Bars")];
const TRAY_WINDOWS: &[(&str, &str)] = &[("highest", "Most used"), ("session", "Session"), ("weekly", "Weekly")];

fn appearance(ui: &mut Ui, view: &mut View, model: &Model<'_>, frame: &mut Frame<'_>) {
    let palette = frame.palette;
    let settings = model.settings;
    let summary = format!("{} · {}", label_of(THEMES, &settings.theme), label_of(DISPLAYS, &settings.display));
    section(ui, view, &palette, ("Appearance", &summary), false, |ui, _| {
        choice_line(ui, frame, settings, "Theme", settings.theme.as_str(), THEMES, |s, v| v.clone_into(&mut s.theme));
        choice_line(ui, frame, settings, "Limits show", settings.display.as_str(), DISPLAYS, |s, v| {
            v.clone_into(&mut s.display);
        });
        choice_line(ui, frame, settings, "Reset times", settings.reset_display.as_str(), RESETS, |s, v| {
            v.clone_into(&mut s.reset_display);
        });
    });
}

fn tray(ui: &mut Ui, view: &mut View, model: &Model<'_>, frame: &mut Frame<'_>) {
    let palette = frame.palette;
    let settings = model.settings;
    let auto = if settings.tray_style == "bars" { "All" } else { "Most used" };
    let mut providers: Vec<(&str, &str)> = vec![("auto", auto)];
    providers.extend(settings.providers.iter().filter(|p| p.enabled).map(|p| (p.key.as_str(), p.label.as_str())));
    let current = if providers.iter().any(|(k, _)| *k == settings.tray_provider) {
        settings.tray_provider.as_str()
    } else {
        "auto"
    };
    let summary = format!("{} · {}", label_of(TRAY_STYLES, &settings.tray_style), label_of(&providers, current));
    section(ui, view, &palette, ("Tray", &summary), false, |ui, _| {
        choice_line(ui, frame, settings, "Style", settings.tray_style.as_str(), TRAY_STYLES, |s, v| {
            v.clone_into(&mut s.tray_style);
        });
        choice_line(ui, frame, settings, "Provider", current, &providers, |s, v| v.clone_into(&mut s.tray_provider));
        if settings.tray_style == "icon" {
            choice_line(ui, frame, settings, "Limit", settings.tray_window.as_str(), TRAY_WINDOWS, |s, v| {
                v.clone_into(&mut s.tray_window);
            });
        }
        switch_line(ui, frame, settings, ("Colored", None, None), settings.tray_colored, |s, v| s.tray_colored = v);
    });
}

fn alerts(ui: &mut Ui, view: &mut View, model: &Model<'_>, frame: &mut Frame<'_>) {
    let palette = frame.palette;
    let settings = model.settings;
    let summary =
        if settings.notifications { format!("At {}% left", settings.alert_threshold) } else { "Off".to_owned() };
    section(ui, view, &palette, ("Alerts", &summary), false, |ui, _| {
        let hint = Some("When a limit is almost used up or will run out");
        switch_line(ui, frame, settings, ("Notify", hint, None), settings.notifications, |s, v| s.notifications = v);
        if settings.notifications {
            let labels: Vec<String> = ALERT_THRESHOLDS.iter().map(|t| format!("{t}%")).collect();
            let options: Vec<(u32, &str)> =
                ALERT_THRESHOLDS.iter().copied().zip(labels.iter().map(String::as_str)).collect();
            choice_line(ui, frame, settings, "Almost used up at", settings.alert_threshold, &options, |s, v| {
                s.alert_threshold = v;
            });
            let hint = Some("When a weekly limit resets within a day with over half left");
            switch_line(ui, frame, settings, ("Unused limit", hint, None), settings.alert_unused, |s, v| {
                s.alert_unused = v;
            });
        }
    });
}

fn data_repo(ui: &mut Ui, view: &mut View, model: &Model<'_>, frame: &mut Frame<'_>) {
    let palette = frame.palette;
    let settings = model.settings;
    let summary = match (settings.pull_synced_data, settings.sync) {
        (false, false) => "Off",
        (true, false) => "Other machines",
        (false, true) => "Settings",
        (true, true) => "Machines, settings",
    };
    section(ui, view, &palette, ("Data repo", summary), false, |ui, _| {
        let hint = format!("Pulls your aitrack data repo. Set one up with {INIT_HINT}");
        switch_line(
            ui,
            frame,
            settings,
            ("Include other machines", Some(&hint), None),
            settings.pull_synced_data,
            |s, v| s.pull_synced_data = v,
        );
        let hint =
            Some("Shares look, providers, limits and alerts through your data repo. Changes go out when you sync");
        switch_line(ui, frame, settings, ("Sync settings", hint, None), settings.sync, |s, v| s.sync = v);
    });
}

fn general(ui: &mut Ui, view: &mut View, model: &Model<'_>, frame: &mut Frame<'_>) {
    let palette = frame.palette;
    let settings = model.settings;
    let login_error = model.setting_errors.launch_at_login.as_deref();
    let shortcut_error = model.setting_errors.global_shortcut.as_deref();
    let summary = if settings.global_shortcut.is_empty() { "" } else { settings.global_shortcut.as_str() };
    let failed = login_error.is_some() || shortcut_error.is_some();
    section(ui, view, &palette, ("General", summary), failed, |ui, view| {
        let hint = Some("Stays open when you click elsewhere");
        switch_line(ui, frame, settings, ("Keep open", hint, None), settings.keep_open, |s, v| s.keep_open = v);
        switch_line(ui, frame, settings, ("Start at login", None, login_error), settings.launch_at_login, |s, v| {
            s.launch_at_login = v;
        });
        let mut submitted = None;
        line(ui, &palette, "Shortcut", Some("For example CommandOrControl+Shift+O"), shortcut_error, |ui| {
            let buffer = view.shortcut.get_or_insert_with(|| settings.global_shortcut.clone());
            let response = ui.add(egui::TextEdit::singleline(buffer).hint_text("None").desired_width(150.0));
            if response.lost_focus() && *buffer != settings.global_shortcut {
                submitted = Some(buffer.trim().to_owned());
            }
            if !response.has_focus() {
                view.shortcut = None;
            }
        });
        if let Some(value) = submitted {
            frame.patch(settings, |s| s.global_shortcut = value);
        }
    });
}

fn about(ui: &mut Ui, view: &mut View, model: &Model<'_>, frame: &mut Frame<'_>) {
    let palette = frame.palette;
    EguiFrame::new().outer_margin(Margin { left: 12, right: 12, top: 0, bottom: 14 }).show(ui, |ui| {
        card(ui, &palette, |ui| {
            let mut open_notes = false;
            ui.allocate_ui_with_layout(
                Vec2::new(ui.available_width(), ROW_HEIGHT),
                Layout::left_to_right(Align::Center),
                |ui| {
                    ui.set_min_height(ROW_HEIGHT);
                    ui.label(text(format!("opentrack {}", whats_new::VERSION), 13.0, palette.ink));
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        if !whats_new::current().is_empty() {
                            open_notes = link(ui, &palette, "What's new", true).clicked();
                        }
                    });
                },
            );
            if open_notes {
                view.open_notes();
                frame.patch(model.settings, whats_new::dismiss);
            }

            let update = model.update;
            let failed = update.error.is_some() || matches!(update.check, UpdateCheck::Failed(_));
            let (status, below) = match (&update.available, &update.check) {
                (Some(version), _) => (String::new(), Some(update.offer(version))),
                (None, UpdateCheck::Checking) => ("Checking…".into(), None),
                (None, UpdateCheck::Failed(error)) => (String::new(), Some(format!("Could not check: {error}"))),
                (None, UpdateCheck::Current) => ("Up to date".into(), None),
                (None, UpdateCheck::Idle) => ("Every 6 hours".into(), None),
            };
            line(ui, &palette, "Updates", None, None, |ui| {
                if update.available.is_none() {
                    let checking = update.check == UpdateCheck::Checking;
                    if link(ui, &palette, "Check now", !checking).clicked() {
                        frame.act(Action::CheckUpdate);
                    }
                } else if update.install_label().is_some_and(|label| link(ui, &palette, label, true).clicked()) {
                    frame.act(Action::InstallUpdate);
                }
                ui.add_space(6.0);
                ui.label(text(status, 11.5, palette.ink2));
            });
            if let Some(below) = below {
                let color = if failed { palette.crit_text } else { palette.ink2 };
                ui.add(egui::Label::new(text(below, 11.0, color)).wrap());
                ui.add_space(6.0);
            }

            let mut quit = false;
            line(ui, &palette, "Logs", Some("A zip to attach to a bug report"), None, |ui| {
                if link(ui, &palette, "Export…", true).clicked() {
                    frame.act(Action::ExportLogs);
                }
            });
            rule(ui, &palette);
            ui.allocate_ui_with_layout(
                Vec2::new(ui.available_width(), ROW_HEIGHT),
                Layout::left_to_right(Align::Center),
                |ui| {
                    ui.set_min_height(ROW_HEIGHT);
                    let galley = ui.painter().layout_no_wrap(
                        "Quit opentrack".into(),
                        FontId::new(13.0, bold()),
                        palette.crit_text,
                    );
                    let (rect, response) = ui.allocate_exact_size(galley.size(), Sense::click());
                    let response = response.on_hover_cursor(egui::CursorIcon::PointingHand);
                    ui.painter().galley(rect.min, galley, palette.crit_text);
                    if response.hovered() {
                        ui.painter().hline(rect.x_range(), rect.bottom() + 1.0, Stroke::new(1.0, palette.crit_text));
                    }
                    response.widget_info(|| WidgetInfo::labeled(Role::Button, true, "Quit opentrack"));
                    paint_focus(ui, &palette, &response, rect, 3);
                    quit = response.clicked();
                },
            );
            if quit {
                frame.act(Action::Quit);
            }
        });
    });
}

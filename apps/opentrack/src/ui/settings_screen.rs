//! Settings: providers, display, general and about.

use eframe::egui::{self, Align, ComboBox, CornerRadius, Frame as EguiFrame, Layout, Margin, Sense, Stroke, Ui, Vec2};

use super::dashboard::mark;
use super::format::INIT_HINT;
use super::icons::Glyph;
use super::theme::Palette;
use super::widgets::{icon_button, link, strong, switch, text, IconButton};
use super::{Action, Frame, Model, Screen, UpdateCheck, View};
use crate::settings::Settings;

fn group(ui: &mut Ui, palette: &Palette, title: &str, add: impl FnOnce(&mut Ui)) {
    EguiFrame::new().outer_margin(Margin { left: 12, right: 12, top: 0, bottom: 14 }).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.label(strong(title, 12.0, palette.ink2));
        ui.add_space(6.0);
        EguiFrame::new()
            .fill(palette.card)
            .stroke(Stroke::new(1.0, palette.edge))
            .corner_radius(CornerRadius::same(12))
            .inner_margin(Margin::symmetric(12, 4))
            .show(ui, |ui| {
                ui.set_width(ui.available_width());
                add(ui);
            });
    });
}

/// A setting's label and notes, with `control` in the `control_width` on the right.
fn line(
    ui: &mut Ui,
    palette: &Palette,
    label: &str,
    hint: Option<&str>,
    error: Option<&str>,
    control_width: f32,
    control: impl FnOnce(&mut Ui),
) {
    ui.horizontal(|ui| {
        ui.set_min_height(36.0);
        let width = ui.available_width() - control_width;
        ui.vertical(|ui| {
            ui.set_max_width(width);
            ui.spacing_mut().item_spacing.y = 1.0;
            ui.add_space(4.0);
            ui.label(text(label, 13.0, palette.ink));
            if let Some(hint) = hint {
                ui.add(egui::Label::new(text(hint, 11.0, palette.ink2)).wrap());
            }
            if let Some(error) = error {
                ui.add(egui::Label::new(text(error, 11.0, palette.crit_text)).wrap());
            }
            ui.add_space(4.0);
        });
        ui.with_layout(Layout::right_to_left(Align::Center), control);
    });
}

fn rule(ui: &mut Ui, palette: &Palette) {
    let (rect, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 1.0), Sense::hover());
    ui.painter().hline(rect.x_range(), rect.center().y, Stroke::new(1.0, palette.rule));
}

fn select(ui: &mut Ui, id: &str, current: &str, options: &[(&str, &str)]) -> Option<String> {
    let shown = options.iter().find(|(value, _)| *value == current).map_or(current, |(_, label)| *label);
    let mut chosen = None;
    ComboBox::from_id_salt(id).selected_text(shown).width(130.0).show_ui(ui, |ui| {
        for (value, label) in options {
            if ui.selectable_label(*value == current, *label).clicked() && *value != current {
                chosen = Some((*value).to_owned());
            }
        }
    });
    chosen
}

fn select_line(
    ui: &mut Ui,
    frame: &mut Frame<'_>,
    settings: &Settings,
    label: &str,
    current: &str,
    options: &[(&str, &str)],
    set: impl FnOnce(&mut Settings, String),
) {
    let palette = frame.palette;
    let mut chosen = None;
    line(ui, &palette, label, None, None, 150.0, |ui| chosen = select(ui, label, current, options));
    if let Some(value) = chosen {
        frame.patch(settings, |s| set(s, value));
    }
    rule(ui, &palette);
}

/// A setting's name with its optional hint and error.
struct Note<'a> {
    label: &'a str,
    hint: Option<&'a str>,
    error: Option<&'a str>,
}

fn switch_line(
    ui: &mut Ui,
    frame: &mut Frame<'_>,
    settings: &Settings,
    note: &Note<'_>,
    value: bool,
    set: impl FnOnce(&mut Settings, bool),
) {
    let Note { label, hint, error } = *note;
    let palette = frame.palette;
    let mut on = value;
    let mut changed = false;
    line(ui, &palette, label, hint, error, 50.0, |ui| changed = switch(ui, &palette, &mut on, label));
    if changed {
        frame.patch(settings, |s| set(s, on));
    }
    rule(ui, &palette);
}

pub fn show(ui: &mut Ui, view: &mut View, model: &Model<'_>, frame: &mut Frame<'_>) {
    let palette = frame.palette;
    let settings = model.settings;
    ui.horizontal(|ui| {
        ui.add_space(8.0);
        ui.set_min_height(48.0);
        if icon_button(ui, &palette, IconButton::new(Glyph::Back, "Back")).clicked() {
            view.screen = Screen::Dashboard;
        }
        ui.label(strong("Settings", 15.0, palette.ink));
    });

    group(ui, &palette, "Providers", |ui| {
        let count = settings.providers.len();
        for (index, provider) in settings.providers.iter().enumerate() {
            let mut moved = None;
            let mut enabled = provider.enabled;
            let mut toggled = false;
            ui.horizontal(|ui| {
                ui.set_min_height(36.0);
                ui.spacing_mut().item_spacing.x = 8.0;
                mark(ui, frame, &provider.key, 14.0);
                ui.label(text(&provider.label, 13.0, palette.ink));
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    ui.spacing_mut().item_spacing.x = 2.0;
                    toggled = switch(ui, &palette, &mut enabled, &format!("Track {}", provider.label));
                    ui.add_space(6.0);
                    let down = format!("Move {} down", provider.label);
                    if icon_button(
                        ui,
                        &palette,
                        IconButton {
                            enabled: index + 1 < count,
                            size: 24.0,
                            ..IconButton::new(Glyph::ChevronDown, &down)
                        },
                    )
                    .clicked()
                    {
                        moved = Some(index + 1);
                    }
                    let up = format!("Move {} up", provider.label);
                    if icon_button(
                        ui,
                        &palette,
                        IconButton { enabled: index > 0, size: 24.0, ..IconButton::new(Glyph::ChevronUp, &up) },
                    )
                    .clicked()
                    {
                        moved = index.checked_sub(1);
                    }
                });
            });
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
            rule(ui, &palette);
        }
        ui.add_space(6.0);
        ui.label(text("A provider turned off is not read or contacted.", 11.0, palette.ink2));
        ui.add_space(6.0);
    });

    group(ui, &palette, "Display", |ui| {
        select_line(
            ui,
            frame,
            settings,
            "Theme",
            &settings.theme,
            &[("system", "System"), ("light", "Light"), ("dark", "Dark")],
            |s, v| s.theme = v,
        );
        select_line(
            ui,
            frame,
            settings,
            "Limits show",
            &settings.display,
            &[("used", "Used"), ("left", "Left")],
            |s, v| s.display = v,
        );
        select_line(
            ui,
            frame,
            settings,
            "Reset times",
            &settings.reset_display,
            &[("absolute", "Clock time"), ("relative", "Countdown")],
            |s, v| s.reset_display = v,
        );
        let enabled: Vec<(String, String)> =
            settings.providers.iter().filter(|p| p.enabled).map(|p| (p.key.clone(), p.label.clone())).collect();
        let auto = if settings.tray_style == "bars" { "All providers" } else { "Most used" };
        let mut tray_options: Vec<(&str, &str)> = vec![("auto", auto)];
        tray_options.extend(enabled.iter().map(|(k, l)| (k.as_str(), l.as_str())));
        let current = if enabled.iter().any(|(k, _)| *k == settings.tray_provider) {
            settings.tray_provider.as_str()
        } else {
            "auto"
        };
        select_line(ui, frame, settings, "Tray provider", current, &tray_options, |s, v| s.tray_provider = v);
        if settings.tray_style == "icon" {
            select_line(
                ui,
                frame,
                settings,
                "Tray limit",
                &settings.tray_window,
                &[("highest", "Most used"), ("session", "Session"), ("weekly", "Weekly")],
                |s, v| s.tray_window = v,
            );
        }
        select_line(
            ui,
            frame,
            settings,
            "Tray style",
            &settings.tray_style,
            &[("icon", "Icon"), ("bars", "Bars")],
            |s, v| s.tray_style = v,
        );
        switch_line(
            ui,
            frame,
            settings,
            &Note { label: "Colored tray icon", hint: None, error: None },
            settings.tray_colored,
            |s, v| s.tray_colored = v,
        );
    });

    group(ui, &palette, "General", |ui| {
        switch_line(
            ui,
            frame,
            settings,
            &Note { label: "Alerts", hint: Some("When a limit is almost used up or will run out"), error: None },
            settings.notifications,
            |s, v| s.notifications = v,
        );
        switch_line(
            ui,
            frame,
            settings,
            &Note { label: "Keep open", hint: Some("Stays open when you click elsewhere"), error: None },
            settings.keep_open,
            |s, v| {
                s.keep_open = v;
            },
        );
        let hint = format!("Pulls your aitrack data repo. Set one up with {INIT_HINT}");
        switch_line(
            ui,
            frame,
            settings,
            &Note { label: "Include other machines", hint: Some(&hint), error: None },
            settings.pull_synced_data,
            |s, v| {
                s.pull_synced_data = v;
            },
        );
        let login_error = model.setting_errors.launch_at_login.as_deref();
        switch_line(
            ui,
            frame,
            settings,
            &Note { label: "Start at login", hint: None, error: login_error },
            settings.launch_at_login,
            |s, v| {
                s.launch_at_login = v;
            },
        );
        let shortcut_error = model.setting_errors.global_shortcut.as_deref();
        ui.vertical(|ui| {
            ui.add_space(6.0);
            ui.label(text("Open/close shortcut", 13.0, palette.ink));
            ui.label(text("For example CommandOrControl+Shift+O", 11.0, palette.ink2));
            if let Some(error) = shortcut_error {
                ui.label(text(error, 11.0, palette.crit_text));
            }
            ui.add_space(4.0);
            let buffer = view.shortcut.get_or_insert_with(|| settings.global_shortcut.clone());
            let response = ui.add(egui::TextEdit::singleline(buffer).hint_text("None").desired_width(f32::INFINITY));
            let submitted = response.lost_focus();
            if submitted && *buffer != settings.global_shortcut {
                let value = buffer.trim().to_owned();
                frame.patch(settings, |s| s.global_shortcut = value);
            }
            if !response.has_focus() && !submitted {
                view.shortcut = None;
            }
            ui.add_space(8.0);
        });
    });

    group(ui, &palette, "About", |ui| {
        line(ui, &palette, "Version", None, None, 80.0, |ui| {
            ui.label(text(env!("CARGO_PKG_VERSION"), 13.0, palette.ink2));
        });
        rule(ui, &palette);
        let update = model.update;
        let status = match (&update.available, &update.check) {
            (Some(version), _) => update.offer(version),
            (None, UpdateCheck::Checking) => "Checking…".into(),
            (None, UpdateCheck::Failed(error)) => format!("Could not check: {error}"),
            (None, UpdateCheck::Current) => "Up to date".into(),
            (None, UpdateCheck::Idle) => "Checked every 6 hours".into(),
        };
        let failed = update.error.is_some() || matches!(update.check, UpdateCheck::Failed(_));
        let (hint, error) = if failed { (None, Some(status.as_str())) } else { (Some(status.as_str()), None) };
        line(ui, &palette, "Updates", hint, error, 130.0, |ui| {
            if update.available.is_some() && !update.installing {
                if link(ui, &palette, update.install_label(), true).clicked() {
                    frame.act(Action::InstallUpdate);
                }
            } else if update.available.is_none() {
                let checking = update.check == UpdateCheck::Checking;
                if link(ui, &palette, "Check now", !checking).clicked() {
                    frame.act(Action::CheckUpdate);
                }
            }
        });
    });

    EguiFrame::new().outer_margin(Margin { left: 12, right: 12, top: 0, bottom: 16 }).show(ui, |ui| {
        let (rect, response) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 34.0), Sense::click());
        let fill = if response.hovered() { Palette::mix(palette.crit, 0.12, palette.card) } else { palette.card };
        ui.painter().rect(rect, CornerRadius::same(10), fill, Stroke::new(1.0, palette.edge), egui::StrokeKind::Inside);
        ui.painter().text(
            rect.center(),
            egui::Align2::CENTER_CENTER,
            "Quit opentrack",
            egui::FontId::new(13.0, super::theme::bold()),
            palette.crit_text,
        );
        response.widget_info(|| egui::WidgetInfo::labeled(egui::Role::Button, true, "Quit opentrack"));
        if response.clicked() {
            frame.act(Action::Quit);
        }
    });
}

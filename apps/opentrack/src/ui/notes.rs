//! What's new: the running version's release notes.

use eframe::egui::{self, Frame as EguiFrame, Margin, Ui};

use super::icons::Glyph;
use super::settings_screen::{group, rule};
use super::widgets::{icon_button, link, strong, text, IconButton};
use super::{Action, Frame, View};
use crate::whats_new::{current, VERSION};

pub fn show(ui: &mut Ui, view: &mut View, frame: &mut Frame<'_>) {
    let palette = frame.palette;
    ui.horizontal(|ui| {
        ui.add_space(8.0);
        ui.set_min_height(48.0);
        if icon_button(ui, &palette, IconButton::new(Glyph::Back, "Back")).clicked() {
            view.screen = view.notes_from;
        }
        ui.label(strong(format!("What's new in {VERSION}"), 15.0, palette.ink));
    });
    for notes in current() {
        group(ui, &palette, notes.title, |ui| {
            for (index, item) in notes.items.iter().enumerate() {
                if index > 0 {
                    rule(ui, &palette);
                }
                ui.add_space(8.0);
                ui.add(egui::Label::new(text(item, 13.0, palette.ink)).wrap());
                ui.add_space(8.0);
            }
        });
    }
    EguiFrame::new().outer_margin(Margin { left: 24, right: 12, top: 0, bottom: 16 }).show(ui, |ui| {
        if link(ui, &palette, "Full release notes", true).clicked() {
            frame.act(Action::OpenReleaseNotes);
        }
    });
}

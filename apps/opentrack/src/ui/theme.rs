//! The renderer's design tokens: quiet surfaces, provider accents, warnings in the strongest colour.

use std::sync::{Arc, LazyLock};

use eframe::egui::{self, Color32, CornerRadius, FontData, FontDefinitions, FontFamily, Stroke, Visuals};
use eframe::epaint::text::VariationCoords;

use crate::pace::Tone;

#[derive(Clone, Copy, Debug)]
pub struct Palette {
    pub dark: bool,
    pub surface: Color32,
    pub card: Color32,
    pub raised: Color32,
    pub ink: Color32,
    pub ink2: Color32,
    pub ink3: Color32,
    pub rule: Color32,
    pub track: Color32,
    pub meter: Color32,
    pub warn: Color32,
    pub crit: Color32,
    pub warn_text: Color32,
    pub crit_text: Color32,
    pub ok: Color32,
    pub focus: Color32,
    pub edge: Color32,
    pub claude: Color32,
    pub codex: Color32,
    pub copilot: Color32,
    pub cursor: Color32,
    pub curve: Color32,
    pub curve_fill: Color32,
}

const fn hex(rgb: u32) -> Color32 {
    let [_, r, g, b] = rgb.to_be_bytes();
    Color32::from_rgb(r, g, b)
}

pub const LIGHT: Palette = Palette {
    dark: false,
    surface: hex(0x00f6_f7f9),
    card: hex(0x00ff_ffff),
    raised: hex(0x00f1_f1f3),
    ink: hex(0x0018_181b),
    ink2: hex(0x005f_6068),
    ink3: hex(0x006a_6d76),
    rule: hex(0x00ec_ecef),
    track: hex(0x00e4_e4e8),
    meter: hex(0x002a_2a2f),
    warn: hex(0x00b9_7800),
    crit: hex(0x00d8_432f),
    warn_text: hex(0x0094_6000),
    crit_text: hex(0x00c2_3a27),
    ok: hex(0x0027_876d),
    focus: hex(0x002f_6fe4),
    edge: Color32::from_rgba_premultiplied(0, 0, 0, 20),
    claude: hex(0x00c9_6442),
    codex: hex(0x0027_876d),
    copilot: hex(0x0082_50df),
    cursor: hex(0x0062_73bc),
    curve: Color32::from_rgba_premultiplied(38, 38, 42, 230),
    curve_fill: Color32::from_rgba_premultiplied(3, 3, 3, 15),
};

pub const DARK: Palette = Palette {
    dark: true,
    surface: hex(0x0019_1c20),
    card: hex(0x0022_262b),
    raised: hex(0x002b_3036),
    ink: hex(0x00f3_f3f5),
    ink2: hex(0x00a3_a4ab),
    ink3: hex(0x0096_9ca6),
    rule: hex(0x0030_363d),
    track: hex(0x0035_3c44),
    meter: hex(0x00e9_e9ec),
    warn: hex(0x00f5_b945),
    crit: hex(0x00ff_7a66),
    warn_text: hex(0x00f5_b945),
    crit_text: hex(0x00ff_7a66),
    ok: hex(0x0065_c3a3),
    focus: hex(0x008a_b4ff),
    edge: Color32::from_rgba_premultiplied(18, 18, 18, 18),
    claude: hex(0x00d9_7757),
    codex: hex(0x0065_c3a3),
    copilot: hex(0x00a3_71f7),
    cursor: hex(0x009b_a9ee),
    curve: Color32::from_rgba_premultiplied(210, 210, 212, 230),
    curve_fill: Color32::from_rgba_premultiplied(19, 19, 19, 20),
};

impl Palette {
    pub const fn for_dark(dark: bool) -> Self {
        if dark {
            DARK
        } else {
            LIGHT
        }
    }

    pub fn provider(&self, key: &str) -> Color32 {
        match key {
            "claude_code" => self.claude,
            "copilot" => self.copilot,
            "cursor" => self.cursor,
            _ => self.codex,
        }
    }

    /// A meter's fill; a calm one wears its provider's colour.
    pub fn tone(&self, tone: Tone, provider: &str) -> Color32 {
        match tone {
            Tone::Neutral => self.track,
            Tone::Calm => self.provider(provider),
            Tone::Warn => self.warn,
            Tone::Crit => self.crit,
        }
    }

    pub const fn tone_text(&self, tone: Tone) -> Color32 {
        match tone {
            Tone::Warn => self.warn_text,
            Tone::Crit => self.crit_text,
            Tone::Neutral | Tone::Calm => self.ink2,
        }
    }

    /// `color-mix(in srgb, a share, b)`.
    pub fn mix(a: Color32, share: f32, b: Color32) -> Color32 {
        let lerp = |x: u8, y: u8| {
            let value = f32::from(x) * share + f32::from(y) * (1.0 - share);
            #[expect(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "clamped to 0..=255 just before"
            )]
            let byte = value.round().clamp(0.0, 255.0) as u8;
            byte
        };
        Color32::from_rgb(lerp(a.r(), b.r()), lerp(a.g(), b.g()), lerp(a.b(), b.b()))
    }

    pub fn visuals(&self) -> Visuals {
        let mut visuals = if self.dark { Visuals::dark() } else { Visuals::light() };
        visuals.panel_fill = self.surface;
        visuals.window_fill = self.card;
        visuals.extreme_bg_color = self.card;
        visuals.faint_bg_color = self.raised;
        visuals.override_text_color = Some(self.ink);
        visuals.hyperlink_color = self.ink;
        visuals.selection.bg_fill = Self::mix(self.focus, 0.3, self.card);
        visuals.selection.stroke = Stroke::new(1.0, self.focus);
        visuals.window_stroke = Stroke::new(1.0, self.edge);
        visuals.window_corner_radius = CornerRadius::same(10);
        visuals.menu_corner_radius = CornerRadius::same(8);
        let widgets = &mut visuals.widgets;
        for (state, fill) in [
            (&mut widgets.inactive, self.raised),
            (&mut widgets.hovered, Self::mix(self.ink, 0.06, self.raised)),
            (&mut widgets.active, Self::mix(self.ink, 0.1, self.raised)),
            (&mut widgets.open, self.raised),
        ] {
            state.bg_fill = fill;
            state.weak_bg_fill = fill;
            state.bg_stroke = Stroke::new(1.0, self.edge);
            state.fg_stroke = Stroke::new(1.0, self.ink);
            state.corner_radius = CornerRadius::same(6);
        }
        widgets.noninteractive.bg_fill = self.card;
        widgets.noninteractive.weak_bg_fill = self.card;
        widgets.noninteractive.bg_stroke = Stroke::new(1.0, self.rule);
        widgets.noninteractive.fg_stroke = Stroke::new(1.0, self.ink);
        visuals
    }
}

/// Built once: a named family holds an `Arc<str>`, and text asks for it every frame.
static BOLD: LazyLock<FontFamily> = LazyLock::new(|| FontFamily::Name("semibold".into()));

pub fn bold() -> FontFamily {
    BOLD.clone()
}

/// The system UI font at two weights, ahead of egui's own as a fallback.
pub fn install_fonts(ctx: &egui::Context) {
    let mut fonts = FontDefinitions::default();
    let fallback = fonts.families.get(&FontFamily::Proportional).cloned().unwrap_or_default();
    let mut regular = Vec::new();
    let mut semibold = Vec::new();
    for (path, weight_axis) in system_fonts() {
        let Ok(bytes) = std::fs::read(path) else { continue };
        let data = FontData::from_owned(bytes);
        if weight_axis {
            let mut light = data.clone();
            light.tweak.coords = VariationCoords::new([(b"wght", 400.0)]);
            let mut heavy = data;
            heavy.tweak.coords = VariationCoords::new([(b"wght", 620.0)]);
            fonts.font_data.insert("ui".into(), Arc::new(light));
            fonts.font_data.insert("ui-semibold".into(), Arc::new(heavy));
            regular.push("ui".to_owned());
            semibold.push("ui-semibold".to_owned());
            break;
        }
        let name = format!("ui-{}", regular.len() + semibold.len());
        fonts.font_data.insert(name.clone(), Arc::new(data));
        if regular.is_empty() {
            regular.push(name);
        } else {
            semibold.push(name);
            break;
        }
    }
    if semibold.is_empty() {
        semibold.clone_from(&regular);
    }
    regular.extend(fallback.iter().cloned());
    semibold.extend(fallback);
    fonts.families.insert(FontFamily::Proportional, regular);
    fonts.families.insert(bold(), semibold);
    ctx.set_fonts(fonts);
}

/// Candidates in order; a variable font with a weight axis covers both weights, otherwise regular then bold.
fn system_fonts() -> Vec<(&'static str, bool)> {
    if cfg!(target_os = "macos") {
        vec![("/System/Library/Fonts/SFNS.ttf", true)]
    } else if cfg!(windows) {
        vec![
            ("C:\\Windows\\Fonts\\SegUIVar.ttf", true),
            ("C:\\Windows\\Fonts\\segoeui.ttf", false),
            ("C:\\Windows\\Fonts\\seguisb.ttf", false),
        ]
    } else {
        vec![
            ("/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf", false),
            ("/usr/share/fonts/truetype/noto/NotoSans-SemiBold.ttf", false),
            ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", false),
            ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", false),
        ]
    }
}

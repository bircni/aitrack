//! Heatmap color themes.

use crate::providers::get_provider;

pub type CellRamp = [&'static str; 5];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ColorMode {
    #[default]
    Light,
    Dark,
}

#[derive(Debug, Clone)]
pub struct Palette {
    pub bg: &'static str,
    pub divider: &'static str,
    pub title: &'static str,
    pub label: &'static str,
    pub value: &'static str,
    pub muted: &'static str,
}

pub const PALETTE_LIGHT: Palette = Palette {
    bg: "#ffffff",
    divider: "#e0e0e0",
    title: "#1c1c1e",
    label: "#888888",
    value: "#1c1c1e",
    muted: "#999999",
};

pub const PALETTE_DARK: Palette = Palette {
    bg: "#0d1117",
    divider: "#30363d",
    title: "#e6edf3",
    label: "#7d8590",
    value: "#e6edf3",
    muted: "#7d8590",
};

/// Cell ramps for the merged "all" view and the default fallback
const BUILTIN_ALL_LIGHT: CellRamp = ["#ebedf0", "#d4e8f4", "#8ab8d4", "#4a8ab8", "#1e4a6e"];
const BUILTIN_ALL_DARK: CellRamp = ["#1e1e24", "#0c2438", "#1a4a6e", "#2e7ab0", "#5cb8e8"];
const BUILTIN_DEFAULT_LIGHT: CellRamp = ["#ebedf0", "#c6e48b", "#7bc96f", "#239a3b", "#196127"];
const BUILTIN_DEFAULT_DARK: CellRamp = ["#1e1e24", "#0e4429", "#006d32", "#26a641", "#39d353"];

pub fn get_palette(mode: ColorMode) -> &'static Palette {
    match mode {
        ColorMode::Light => &PALETTE_LIGHT,
        ColorMode::Dark => &PALETTE_DARK,
    }
}

pub fn get_provider_theme(provider_key: &str, dark: bool) -> CellRamp {
    // Handle special "all" key
    if provider_key == "all" {
        return if dark {
            BUILTIN_ALL_DARK
        } else {
            BUILTIN_ALL_LIGHT
        };
    }

    // Try to get from provider registry
    if let Some(provider) = get_provider(provider_key) {
        let ramp = if dark {
            &provider.heatmap.dark
        } else {
            &provider.heatmap.light
        };
        return *ramp;
    }

    // Fallback for unknown providers
    if dark {
        BUILTIN_DEFAULT_DARK
    } else {
        BUILTIN_DEFAULT_LIGHT
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_palette() {
        let light = get_palette(ColorMode::Light);
        assert_eq!(light.bg, "#ffffff");

        let dark = get_palette(ColorMode::Dark);
        assert_eq!(dark.bg, "#0d1117");
    }

    #[test]
    fn test_get_provider_theme() {
        let theme = get_provider_theme("claude_code", false);
        assert_eq!(theme.len(), 5);

        let all_theme = get_provider_theme("all", false);
        assert_eq!(all_theme[0], "#ebedf0");
    }
}

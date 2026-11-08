use crate::providers::provider;

/// Five cell colours, empty to busiest.
pub type CellRamp = [&'static str; 5];

const ALL_LIGHT: CellRamp = ["#ebedf0", "#d4e8f4", "#8ab8d4", "#4a8ab8", "#1e4a6e"];
const ALL_DARK: CellRamp = ["#1e1e24", "#0c2438", "#1a4a6e", "#2e7ab0", "#5cb8e8"];
const DEFAULT_LIGHT: CellRamp = ["#ebedf0", "#c6e48b", "#7bc96f", "#239a3b", "#196127"];
const DEFAULT_DARK: CellRamp = ["#1e1e24", "#0e4429", "#006d32", "#26a641", "#39d353"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Palette {
    pub bg: &'static str,
    pub divider: &'static str,
    pub title: &'static str,
    pub label: &'static str,
    pub value: &'static str,
    pub muted: &'static str,
}

pub const LIGHT: Palette = Palette {
    bg: "#ffffff",
    divider: "#e0e0e0",
    title: "#1c1c1e",
    label: "#888888",
    value: "#1c1c1e",
    muted: "#999999",
};

pub const DARK: Palette = Palette {
    bg: "#0d1117",
    divider: "#30363d",
    title: "#e6edf3",
    label: "#7d8590",
    value: "#e6edf3",
    muted: "#7d8590",
};

pub fn palette(dark: bool) -> Palette {
    if dark { DARK } else { LIGHT }
}

/// The registry's ramp, the merged view's for `all`, or the default for a provider that declared none.
pub fn provider_cells(key: &str, dark: bool) -> CellRamp {
    match (key, provider(key)) {
        ("all", _) => {
            if dark {
                ALL_DARK
            } else {
                ALL_LIGHT
            }
        }
        (_, Some(p)) => {
            if dark {
                p.heatmap_dark
            } else {
                p.heatmap_light
            }
        }
        (_, None) => {
            if dark {
                DEFAULT_DARK
            } else {
                DEFAULT_LIGHT
            }
        }
    }
}

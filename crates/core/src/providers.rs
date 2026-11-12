//! The providers aitrack knows, in display order; every other list of providers derives from this.

use crate::data::types::ProviderData;
use crate::js::locale_compare;

pub struct Descriptor {
    /// As used in the data files.
    pub key: &'static str,
    pub label: &'static str,
    /// Friendly spellings `--providers` accepts, lower case.
    pub aliases: &'static [&'static str],
    /// Money column heading: estimates say "Est. cost".
    pub cost_label: &'static str,
    /// Read from local logs and written to git during sync; otherwise fetched live (Cursor).
    pub synced: bool,
    /// Five-stop heatmap ramp, lightest to darkest.
    pub heatmap_light: [&'static str; 5],
    pub heatmap_dark: [&'static str; 5],
}

pub const PROVIDERS: [Descriptor; 4] = [
    Descriptor {
        key: "claude_code",
        label: "Claude Code",
        aliases: &["claude", "claude-code", "claude_code", "claudecode"],
        cost_label: "Est. cost",
        synced: true,
        heatmap_light: ["#ebedf0", "#fde8cf", "#fbba77", "#e87820", "#b04b10"],
        heatmap_dark: ["#1e1e24", "#3d1a06", "#7c3610", "#c4621a", "#f08030"],
    },
    Descriptor {
        key: "codex",
        label: "Codex",
        aliases: &["codex"],
        cost_label: "Est. cost",
        synced: true,
        heatmap_light: ["#ebedf0", "#cde4f8", "#7db9ea", "#2472c8", "#0b3d7a"],
        heatmap_dark: ["#1e1e24", "#0c2240", "#0d4a8a", "#1a7fd4", "#4db8ff"],
    },
    Descriptor {
        key: "copilot",
        label: "GitHub Copilot",
        aliases: &["copilot", "github-copilot", "github_copilot", "githubcopilot"],
        cost_label: "Est. cost",
        synced: true,
        heatmap_light: ["#ebedf0", "#e7dcfa", "#b99bef", "#8250df", "#4c2889"],
        heatmap_dark: ["#1e1e24", "#2a1a4a", "#4c2889", "#8250df", "#b99bef"],
    },
    Descriptor {
        key: "cursor",
        label: "Cursor",
        aliases: &["cursor"],
        cost_label: "Est. cost",
        synced: false,
        heatmap_light: ["#ebedf0", "#fde8c8", "#f8a855", "#e56b10", "#8b2e00"],
        heatmap_dark: ["#1e1e24", "#3a1800", "#7a3200", "#c45a00", "#f08820"],
    },
];

#[must_use]
pub fn provider(key: &str) -> Option<&'static Descriptor> {
    PROVIDERS.iter().find(|p| p.key == key)
}

#[must_use]
pub fn is_synced_provider(key: &str) -> bool {
    provider(key).is_some_and(|p| p.synced)
}

pub fn synced_provider_keys() -> impl Iterator<Item = &'static str> {
    PROVIDERS.iter().filter(|p| p.synced).map(|p| p.key)
}

/// The label, `All providers` for `all`, or the key itself for a provider a newer version wrote.
#[must_use]
pub fn provider_label(key: &str) -> &str {
    if key == "all" {
        return "All providers";
    }
    provider(key).map_or(key, |p| p.label)
}

#[must_use]
pub fn cost_column_label(key: &str, uppercase: bool) -> String {
    let label = provider(key).map_or("Est. cost", |p| p.cost_label);
    if uppercase { label.to_uppercase() } else { label.to_owned() }
}

/// A user-supplied name (any case, friendly aliases) as its canonical key.
#[must_use]
pub fn normalize_provider_key(input: &str) -> Option<&'static str> {
    let name = crate::js::trim(input).to_lowercase();
    PROVIDERS.iter().find(|p| p.aliases.contains(&name.as_str())).map(|p| p.key)
}

/// Known providers in display order, then any others in the order they appear.
#[must_use]
pub fn ordered_provider_keys(data: &ProviderData) -> Vec<String> {
    PROVIDERS
        .iter()
        .filter(|p| data.contains_key(p.key))
        .map(|p| p.key.to_owned())
        .chain(data.keys().filter(|k| provider(k).is_none()).cloned())
        .collect()
}

#[must_use]
pub fn active_provider_keys(data: &ProviderData) -> Vec<String> {
    ordered_provider_keys(data).into_iter().filter(|k| data.get(k).is_some_and(|d| !d.is_empty())).collect()
}

/// Known providers in display order, then unknown ones by `localeCompare`.
#[must_use]
pub fn sort_provider_keys(keys: &[String]) -> Vec<String> {
    let rank = |key: &str| PROVIDERS.iter().position(|p| p.key == key);
    let mut sorted = keys.to_vec();
    sorted.sort_by(|a, b| match (rank(a), rank(b)) {
        (None, None) => locale_compare(a, b),
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (Some(_), None) => std::cmp::Ordering::Less,
        (Some(x), Some(y)) => x.cmp(&y),
    });
    sorted
}

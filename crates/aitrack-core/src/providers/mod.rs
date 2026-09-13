//! Provider registry with descriptors, pricing, and heatmap colors.

use crate::data::types::ProviderData;
use std::collections::HashMap;
use std::sync::LazyLock;

#[derive(Debug, Clone)]
pub struct ProviderDescriptor {
    pub key: &'static str,
    pub label: &'static str,
    pub aliases: &'static [&'static str],
    pub synced: bool,
    pub cost_label: &'static str,
}

/// Five-stop heatmap cell ramp, lightest (empty) to darkest (busiest).
pub type CellRamp = [&'static str; 5];

#[derive(Debug, Clone)]
pub struct ProviderHeatmap {
    pub light: CellRamp,
    pub dark: CellRamp,
}

#[derive(Debug, Clone)]
pub struct Provider {
    pub descriptor: ProviderDescriptor,
    pub heatmap: ProviderHeatmap,
}

static CLAUDE_CODE_PROVIDER: LazyLock<Provider> = LazyLock::new(|| Provider {
    descriptor: ProviderDescriptor {
        key: "claude_code",
        label: "Claude Code",
        aliases: &["claude", "claude_code", "claudecode"],
        synced: true,
        cost_label: "Est. cost",
    },
    heatmap: ProviderHeatmap {
        light: ["#f0f4ff", "#c7d9ff", "#8fb3ff", "#578cff", "#1f66ff"],
        dark: ["#0a1628", "#1a2d4f", "#2a4477", "#3a5b9f", "#4a72c7"],
    },
});

static CODEX_PROVIDER: LazyLock<Provider> = LazyLock::new(|| Provider {
    descriptor: ProviderDescriptor {
        key: "codex",
        label: "Codex",
        aliases: &["codex", "openai"],
        synced: true,
        cost_label: "Est. cost",
    },
    heatmap: ProviderHeatmap {
        light: ["#f0fff4", "#c7ffd9", "#8fffb3", "#57ff8c", "#1fff66"],
        dark: ["#0a2816", "#1a4f2d", "#2a7744", "#3a9f5b", "#4ac772"],
    },
});

static CURSOR_PROVIDER: LazyLock<Provider> = LazyLock::new(|| Provider {
    descriptor: ProviderDescriptor {
        key: "cursor",
        label: "Cursor",
        aliases: &["cursor"],
        synced: false,
        cost_label: "N/A",
    },
    heatmap: ProviderHeatmap {
        light: ["#fff0f4", "#ffc7d9", "#ff8fb3", "#ff578c", "#ff1f66"],
        dark: ["#280a16", "#4f1a2d", "#772a44", "#9f3a5b", "#c74a72"],
    },
});

static PROVIDERS: LazyLock<Vec<&'static Provider>> =
    LazyLock::new(|| vec![&*CLAUDE_CODE_PROVIDER, &*CODEX_PROVIDER, &*CURSOR_PROVIDER]);

static PROVIDER_BY_KEY: LazyLock<HashMap<&'static str, &'static Provider>> =
    LazyLock::new(|| PROVIDERS.iter().map(|p| (p.descriptor.key, *p)).collect());

static PROVIDER_BY_ALIAS: LazyLock<HashMap<&'static str, &'static Provider>> =
    LazyLock::new(|| {
        let mut map = HashMap::new();
        for provider in PROVIDERS.iter() {
            for alias in provider.descriptor.aliases {
                map.insert(*alias, *provider);
            }
        }
        map
    });

static PROVIDER_LABELS: LazyLock<HashMap<&'static str, &'static str>> = LazyLock::new(|| {
    let mut map: HashMap<_, _> = PROVIDERS
        .iter()
        .map(|p| (p.descriptor.key, p.descriptor.label))
        .collect();
    map.insert("all", "All providers");
    map
});

pub fn get_provider(key: &str) -> Option<&'static Provider> {
    PROVIDER_BY_KEY.get(key).copied()
}

pub fn provider_keys() -> Vec<&'static str> {
    PROVIDERS.iter().map(|p| p.descriptor.key).collect()
}

pub fn synced_providers() -> Vec<&'static Provider> {
    PROVIDERS
        .iter()
        .filter(|p| p.descriptor.synced)
        .copied()
        .collect()
}

pub fn synced_provider_keys() -> Vec<&'static str> {
    synced_providers()
        .iter()
        .map(|p| p.descriptor.key)
        .collect()
}

pub fn is_synced_provider(key: &str) -> bool {
    PROVIDER_BY_KEY
        .get(key)
        .map(|p| p.descriptor.synced)
        .unwrap_or(false)
}

pub fn live_providers() -> Vec<&'static Provider> {
    PROVIDERS
        .iter()
        .filter(|p| !p.descriptor.synced)
        .copied()
        .collect()
}

pub fn normalize_provider_key(input: &str) -> Option<&'static str> {
    PROVIDER_BY_ALIAS
        .get(input.trim().to_lowercase().as_str())
        .map(|p| p.descriptor.key)
}

pub fn provider_label(provider_key: &str) -> String {
    PROVIDER_LABELS
        .get(provider_key)
        .map(|s| s.to_string())
        .unwrap_or_else(|| provider_key.to_string())
}

pub fn cost_column_label(provider_key: &str, uppercase: bool) -> String {
    let label = PROVIDER_BY_KEY
        .get(provider_key)
        .map(|p| p.descriptor.cost_label)
        .unwrap_or("Est. cost");

    if uppercase {
        label.to_uppercase()
    } else {
        label.to_string()
    }
}

pub fn active_provider_keys(provider_data: &ProviderData) -> Vec<String> {
    let provider_order = provider_keys();
    let mut active: Vec<String> = provider_order
        .iter()
        .filter(|k| {
            provider_data
                .get(&k.to_string())
                .map(|m| !m.is_empty())
                .unwrap_or(false)
        })
        .map(|k| k.to_string())
        .collect();

    for (k, data) in provider_data {
        if !active.contains(k) && !data.is_empty() {
            active.push(k.clone());
        }
    }

    active
}

pub fn ordered_provider_keys(provider_data: &ProviderData) -> Vec<String> {
    let provider_order = provider_keys();
    let provider_order_set: std::collections::HashSet<_> = provider_order.iter().copied().collect();

    let mut ordered: Vec<String> = provider_order
        .iter()
        .filter(|k| provider_data.contains_key(&k.to_string()))
        .map(|k| k.to_string())
        .collect();

    for k in provider_data.keys() {
        if !provider_order_set.contains(k.as_str()) {
            ordered.push(k.clone());
        }
    }

    ordered
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_provider() {
        let provider = get_provider("claude_code").unwrap();
        assert_eq!(provider.descriptor.label, "Claude Code");
    }

    #[test]
    fn test_normalize_provider_key() {
        assert_eq!(normalize_provider_key("Claude"), Some("claude_code"));
        assert_eq!(normalize_provider_key("CODEX"), Some("codex"));
    }

    #[test]
    fn test_provider_label() {
        assert_eq!(provider_label("claude_code"), "Claude Code".to_string());
        assert_eq!(provider_label("cursor"), "Cursor".to_string());
    }

    #[test]
    fn test_synced_providers() {
        let synced = synced_provider_keys();
        assert!(synced.contains(&"claude_code"));
        assert!(synced.contains(&"codex"));
        assert!(!synced.contains(&"cursor"));
    }
}

//! Model ID normalization and canonicalization.

use regex::Regex;
use std::sync::LazyLock;

/// Claude families, in fallback-pricing order.
pub const CLAUDE_FAMILIES: &[&str] = &["fable", "mythos", "opus", "haiku", "sonnet"];

static CLAUDE_VERSION_FIRST: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^claude-(\d+)(?:-(\d+))?-(fable|mythos|opus|haiku|sonnet)$")
        .expect("claude version regex")
});

/// Cursor/Claude Code effort labels that are not part of the priced model id.
static MODEL_EFFORT_SUFFIX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:-thinking)?(?:-(?:low|medium|high|xhigh|max))+(?:-thinking)?$")
        .expect("effort suffix regex")
});

/// Strip the `-latest` alias suffix. Applied by readers before storing a model.
pub fn strip_model_alias_suffix(model: &str) -> String {
    model.strip_suffix("-latest").unwrap_or(model).to_string()
}

/// Strip both the `-latest` alias and a `-YYYYMMDD` release suffix.
pub fn strip_model_version_suffixes(model: &str) -> String {
    let re = Regex::new(r"-(?:latest|\d{8})$").unwrap();
    re.replace(model, "").to_string()
}

/// Strip a trailing thinking/effort label.
pub fn strip_model_effort_suffix(model: &str) -> String {
    let mut current = model.to_string();
    loop {
        let next = MODEL_EFFORT_SUFFIX.replace(&current, "").to_string();
        let next = next.strip_suffix("-thinking").unwrap_or(&next).to_string();
        if next == current {
            return current;
        }
        current = next;
    }
}

/// Fold a Claude id onto the family-first, hyphenated key the pricing table uses.
pub fn canonicalize_claude_model_id(model: &str) -> String {
    let id = strip_model_effort_suffix(&strip_model_version_suffixes(model))
        .to_lowercase()
        .replace('.', "-");

    if let Some(caps) = CLAUDE_VERSION_FIRST.captures(&id) {
        let major = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let minor = caps.get(2).map(|m| m.as_str());
        let family = caps.get(3).map(|m| m.as_str()).unwrap_or("");

        if !major.is_empty() && !family.is_empty() {
            return format!(
                "claude-{}-{}{}",
                family,
                major,
                minor.map(|m| format!("-{}", m)).unwrap_or_default()
            );
        }
    }

    id
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_strip_model_alias_suffix() {
        assert_eq!(
            strip_model_alias_suffix("claude-opus-4-latest"),
            "claude-opus-4"
        );
        assert_eq!(strip_model_alias_suffix("gpt-5-codex"), "gpt-5-codex");
    }

    #[test]
    fn test_strip_model_effort_suffix() {
        assert_eq!(
            strip_model_effort_suffix("claude-opus-4-thinking-high"),
            "claude-opus-4"
        );
        assert_eq!(strip_model_effort_suffix("gpt-5-medium"), "gpt-5");
    }

    #[test]
    fn test_canonicalize_claude_model_id() {
        assert_eq!(
            canonicalize_claude_model_id("claude-4.6-opus"),
            "claude-opus-4-6"
        );
        assert_eq!(
            canonicalize_claude_model_id("claude-4-opus-latest"),
            "claude-opus-4"
        );
    }
}

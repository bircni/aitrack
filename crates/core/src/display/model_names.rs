//! Friendly model names: `claude-haiku-4-5-20251001` as `Haiku 4.5`.

use crate::data::model_id::{
    CLAUDE_FAMILIES, canonical_model_id, canonicalize_claude_model_id, model_effort_label, strip_claude_tier_suffix,
};

fn title_case(word: &str) -> String {
    let mut chars = word.chars();
    chars.next().map(|first| first.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

/// Hyphens as spaces, the first character of each ASCII `\w` run upper-cased.
fn title_case_rest(rest: &str) -> String {
    let mut in_word = false;
    rest.replace('-', " ")
        .chars()
        .map(|c| {
            let word = c.is_ascii_alphanumeric() || c == '_';
            let out = if word && !in_word { c.to_ascii_uppercase() } else { c };
            in_word = word;
            out
        })
        .collect()
}

fn display_stem(model: &str) -> String {
    let lowered = model.to_lowercase();
    let stripped = strip_claude_tier_suffix(&lowered);
    let stem = stripped.strip_prefix("cursor-").unwrap_or(stripped);
    let canonical =
        if stem.starts_with("claude-") { canonicalize_claude_model_id(stem) } else { canonical_model_id(stem) };
    canonical.strip_prefix("claude-").map_or_else(|| canonical.clone(), str::to_owned)
}

fn digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// `(\d+)(?:-(\d+))?` as `4` or `4.5`.
fn version(text: &str) -> Option<String> {
    match text.split_once('-') {
        None if digits(text) => Some(text.to_owned()),
        Some((major, minor)) if digits(major) && digits(minor) => Some(format!("{major}.{minor}")),
        _ => None,
    }
}

/// `^prefix([\d.]+)(?:-(.+))?$` as the number and the rest.
fn numbered<'a>(cleaned: &'a str, prefix: &str) -> Option<(&'a str, Option<&'a str>)> {
    let rest = cleaned.strip_prefix(prefix)?;
    let end = rest.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(rest.len());
    let (number, tail) = rest.split_at(end);
    if number.is_empty() {
        return None;
    }
    if tail.is_empty() {
        return Some((number, None));
    }
    let suffix =
        tail.strip_prefix('-').filter(|s| !s.is_empty() && !s.contains(['\n', '\r', '\u{2028}', '\u{2029}']))?;
    Some((number, Some(suffix)))
}

fn pretty_model_stem(model: &str) -> String {
    let cleaned = display_stem(model);
    for family in CLAUDE_FAMILIES {
        let found = cleaned
            .strip_prefix(family)
            .and_then(|r| r.strip_prefix('-'))
            .and_then(version)
            .or_else(|| cleaned.strip_suffix(family).and_then(|r| r.strip_suffix('-')).and_then(version));
        if let Some(version) = found {
            return format!("{} {version}", title_case(family));
        }
    }
    let suffix = |rest: Option<&str>| rest.map_or_else(String::new, |r| format!(" {}", title_case_rest(r)));
    if let Some((number, rest)) = numbered(&cleaned, "gpt-") {
        return format!("GPT-{number}{}", suffix(rest));
    }
    if let Some((number, rest)) = numbered(&cleaned, "grok-") {
        return format!("Grok {number}{}", suffix(rest));
    }
    if let Some(rest) = cleaned.strip_prefix("composer-") {
        return format!("Composer {rest}");
    }
    match cleaned.as_str() {
        "auto" => "Auto".to_owned(),
        "composer" => "Composer".to_owned(),
        family if CLAUDE_FAMILIES.contains(&family) => title_case(family),
        _ => cleaned,
    }
}

/// `effort` keeps `-thinking-medium` rows apart from `-high`.
#[must_use]
pub fn display_model_name(model: &str, effort: bool) -> String {
    let base = pretty_model_stem(model);
    match model_effort_label(model) {
        Some(label) if effort => format!("{base} {label}"),
        _ => base,
    }
}

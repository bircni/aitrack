//! Model-id suffix rules shared by readers, pricing and display.
//!
//! Readers strip only `-latest`; dated releases and effort labels stay in stored keys and are folded
//! only for pricing and display.

/// Claude families, in fallback-pricing order.
pub const CLAUDE_FAMILIES: [&str; 5] = ["fable", "mythos", "opus", "haiku", "sonnet"];

/// Effort labels Cursor and Claude Code append that are not part of the priced model id.
const EFFORT_TOKENS: [&str; 9] = ["low", "medium", "extra-high", "xhigh", "high", "max", "none", "minimal", "ultra"];

/// Rate tiers a reader appends to a Claude id per message.
const TIER_SUFFIXES: [&str; 2] = ["-fast", "-long-context"];

/// The id without a `-fast` or `-long-context` rate tier.
#[must_use]
pub fn strip_claude_tier_suffix(model: &str) -> &str {
    TIER_SUFFIXES.iter().find_map(|suffix| model.strip_suffix(suffix)).unwrap_or(model)
}

/// Readers apply this before storing a model.
#[must_use]
pub fn strip_model_alias_suffix(model: &str) -> &str {
    model.strip_suffix("-latest").unwrap_or(model)
}

/// Strip a `-latest` alias or a `-YYYYMMDD` release.
#[must_use]
pub fn strip_model_version_suffixes(model: &str) -> &str {
    if let Some(base) = model.strip_suffix("-latest") {
        return base;
    }
    let bytes = model.as_bytes();
    let dated =
        bytes.len() >= 9 && bytes[bytes.len() - 9] == b'-' && bytes[bytes.len() - 8..].iter().all(u8::is_ascii_digit);
    if dated { &model[..model.len() - 9] } else { model }
}

/// Strip trailing thinking and effort labels (`-thinking-high`, `-xhigh`, `-max`); `-mini`, `-codex` and the like stay.
#[must_use]
pub fn strip_model_effort_suffix(model: &str) -> &str {
    let mut current = model;
    loop {
        let without_effort = effort_suffix_start(current).map_or(current, |start| &current[..start]);
        let next = without_effort.strip_suffix("-thinking").unwrap_or(without_effort);
        if next.len() == current.len() {
            return current;
        }
        current = next;
    }
}

/// The thinking, effort and tier knobs on a raw id (`medium`, `xhigh fast`), or `None` for a plain priced id.
#[must_use]
pub fn model_effort_label(model: &str) -> Option<String> {
    let lowered = model.to_lowercase();
    let without_tier = strip_claude_tier_suffix(&lowered);
    let tier = lowered[without_tier.len()..].trim_start_matches('-').replacen('-', " ", 1);
    let rest = strip_model_version_suffixes(without_tier);
    let effort = effort_suffix_start(rest).map_or_else(String::new, |start| {
        let matched = rest[start..].replace("-thinking", "");
        matched.strip_prefix('-').unwrap_or(&matched).replace('-', " ")
    });
    let parts: Vec<&str> = [effort.as_str(), tier.as_str()].into_iter().filter(|part| !part.is_empty()).collect();
    (!parts.is_empty()).then(|| parts.join(" "))
}

/// Lowercased id without release, alias or effort suffixes: the key pricing and display share.
#[must_use]
pub fn canonical_model_id(model: &str) -> String {
    let lowered = model.to_lowercase();
    strip_model_effort_suffix(strip_model_version_suffixes(&lowered)).to_owned()
}

/// Fold a Claude id onto the family-first, hyphenated key the pricing table uses
/// (`claude-4.6-opus` becomes `claude-opus-4-6`), keeping a rate tier at the end.
#[must_use]
pub fn canonicalize_claude_model_id(model: &str) -> String {
    let lowered = model.to_lowercase();
    let base = strip_claude_tier_suffix(&lowered);
    let tier = &lowered[base.len()..];
    let id = hyphenate_first_dotted_version(&canonical_model_id(base));
    let folded = version_first(&id).map_or_else(
        || id.clone(),
        |(major, minor, family)| {
            minor.map_or_else(|| format!("claude-{family}-{major}"), |minor| format!("claude-{family}-{major}-{minor}"))
        },
    );
    format!("{folded}{tier}")
}

/// Where the leftmost `(?:-thinking)?(?:-(?:TOKEN))+(?:-thinking)?$` match starts, `max` excepted after `-codex-`.
fn effort_suffix_start(model: &str) -> Option<usize> {
    model.match_indices('-').map(|(i, _)| i).find(|&start| {
        let rest = &model[start..];
        let rest = rest.strip_prefix("-thinking").filter(|r| r.starts_with('-')).unwrap_or(rest);
        matches_tokens_to_end(model, model.len() - rest.len(), 0)
    })
}

fn matches_tokens_to_end(model: &str, at: usize, matched: usize) -> bool {
    let rest = &model[at..];
    if matched > 0 && (rest.is_empty() || rest == "-thinking") {
        return true;
    }
    let Some(after_dash) = rest.strip_prefix('-') else { return false };
    EFFORT_TOKENS.iter().any(|token| {
        // gpt-5.1-codex-max is a priced model, not codex at max effort.
        let blocked = *token == "max" && model[..=at].ends_with("-codex-");
        !blocked && after_dash.starts_with(token) && matches_tokens_to_end(model, at + 1 + token.len(), matched + 1)
    })
}

/// `id.replace(/(\d+)\.(\d+)/u, '$1-$2')`: only the first dotted version.
fn hyphenate_first_dotted_version(id: &str) -> String {
    let bytes = id.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let run_end = i + bytes[i..].iter().take_while(|b| b.is_ascii_digit()).count();
            if bytes.get(run_end) == Some(&b'.') && bytes.get(run_end + 1).is_some_and(u8::is_ascii_digit) {
                return format!("{}-{}", &id[..run_end], &id[run_end + 1..]);
            }
            i = run_end;
        } else {
            i += 1;
        }
    }
    id.to_owned()
}

/// `claude-<major>[-<minor>]-<family>` split into its parts.
fn version_first(id: &str) -> Option<(&str, Option<&str>, &str)> {
    let rest = id.strip_prefix("claude-")?;
    let digits = |s: &str| s.bytes().take_while(u8::is_ascii_digit).count();
    let major_len = digits(rest);
    if major_len == 0 {
        return None;
    }
    let (major, rest) = rest.split_at(major_len);
    let rest = rest.strip_prefix('-')?;
    if let Some(family) = CLAUDE_FAMILIES.iter().find(|family| rest == **family) {
        return Some((major, None, family));
    }
    let minor_len = digits(rest);
    if minor_len == 0 {
        return None;
    }
    let (minor, family) = rest.split_at(minor_len);
    let family = family.strip_prefix('-')?;
    CLAUDE_FAMILIES.iter().find(|f| family == **f).map(|f| (major, Some(minor), *f))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_typescript_library_for_every_fixture_id() {
        type Row = (String, String, String, String, String, Option<String>, String, String);
        let rows: Vec<Row> = serde_json::from_str(include_str!("../../tests/fixtures/js/model-ids.json")).unwrap();
        for (id, tier, alias, version, effort, label, canonical, claude) in rows {
            assert_eq!(strip_claude_tier_suffix(&id), tier, "tier of {id}");
            assert_eq!(strip_model_alias_suffix(&id), alias, "alias of {id}");
            assert_eq!(strip_model_version_suffixes(&id), version, "version of {id}");
            assert_eq!(strip_model_effort_suffix(&id), effort, "effort of {id}");
            assert_eq!(model_effort_label(&id), label, "label of {id}");
            assert_eq!(canonical_model_id(&id), canonical, "canonical of {id}");
            assert_eq!(canonicalize_claude_model_id(&id), claude, "claude of {id}");
        }
    }
}

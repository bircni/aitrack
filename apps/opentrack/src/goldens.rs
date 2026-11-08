//! The tray pixels, settings and cache.json normalization against 4.x's sidecar, from `tests/fixtures/generate.ts`.

use aitrack_core::time::Clock;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::cache::load_cached_state;
use crate::pace::Tone;
use crate::settings::{normalize_settings, settings_json};
use crate::tray_icon::{render_tray_icon, TrayAppearance, TrayBar};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Bar {
    used_percent: f64,
    tone: Tone,
}

#[derive(Deserialize)]
struct TrayCase {
    size: u32,
    used: f64,
    tone: Tone,
    style: String,
    colored: bool,
    bars: Vec<Bar>,
    sha256: String,
}

#[derive(Deserialize)]
struct Case {
    input: Option<Value>,
    output: String,
}

#[derive(Deserialize)]
struct Expected {
    tray: Vec<TrayCase>,
    settings: Vec<Case>,
    cache: Vec<Case>,
}

impl<'de> Deserialize<'de> for Tone {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match String::deserialize(deserializer)?.as_str() {
            "neutral" => Ok(Self::Neutral),
            "calm" => Ok(Self::Calm),
            "warn" => Ok(Self::Warn),
            "crit" => Ok(Self::Crit),
            other => Err(serde::de::Error::custom(format!("unknown tone {other}"))),
        }
    }
}

fn expected() -> Expected {
    serde_json::from_str(include_str!("../tests/fixtures/expected.json")).unwrap()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn renders_the_tray_icon_pixel_for_pixel() {
    let cases = expected().tray;
    let mismatched: Vec<String> = cases
        .iter()
        .filter_map(|case| {
            let appearance = TrayAppearance {
                style: case.style.clone(),
                colored: case.colored,
                bars: case.bars.iter().map(|b| TrayBar { used_percent: b.used_percent, tone: b.tone }).collect(),
            };
            let pixels = render_tray_icon(case.size, case.used, case.tone, &appearance);
            let digest = hex(&Sha256::digest(&pixels));
            (digest != case.sha256)
                .then(|| format!("{}px {} {}% {} bars", case.size, case.style, case.used, case.bars.len()))
        })
        .collect();
    assert!(cases.len() > 100);
    assert!(mismatched.is_empty(), "{mismatched:#?}");
}

#[test]
fn normalizes_settings_byte_for_byte() {
    for case in expected().settings {
        let input = case.input.unwrap_or(Value::Null);
        assert_eq!(settings_json(&normalize_settings(&input)), case.output, "{input}");
    }
}

/// Compared as parsed JSON: the normalized cache is only ever read back, never diffed as text.
#[test]
fn normalizes_a_hand_edited_cache_like_4x() {
    let clock = Clock::in_zone("UTC").unwrap();
    for case in expected().cache {
        let input = case.input.unwrap_or(Value::Null);
        let ours = aitrack_core::js::to_string(&load_cached_state(&clock, &input)).unwrap();
        let ours: Value = serde_json::from_str(&ours).unwrap();
        let theirs: Value = serde_json::from_str(&case.output).unwrap();
        assert_eq!(ours, theirs, "{input}");
    }
}

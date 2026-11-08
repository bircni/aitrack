use std::f64::consts::PI;

use aitrack_core::js::number_to_string;
use aitrack_core::quota::pacing::{js_round, project_pace};
use aitrack_core::quota::{clamp_percent, QuotaWindow};
use aitrack_core::time::Clock;
use serde::Serialize;

use crate::pace::{has_reset, meter_tone, Tone};
use crate::state::ProviderState;

const fn tone_rgb(tone: Tone) -> [u8; 3] {
    match tone {
        Tone::Neutral => [140, 140, 150],
        Tone::Calm => [52, 168, 83],
        Tone::Warn => [242, 153, 0],
        Tone::Crit => [217, 48, 37],
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayBar {
    pub tone: Tone,
    pub used_percent: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraySummary {
    pub tone: Tone,
    /// Percent used of the shown window, the highest over the followed providers, 0–100.
    pub used_percent: f64,
    pub tooltip: String,
    pub bars: Vec<TrayBar>,
}

/// Which provider, window and style the icon follows, from the settings.
#[derive(Clone, Copy, Debug)]
pub struct TrayChoice<'a> {
    pub provider: &'a str,
    pub window: &'a str,
    pub style: &'a str,
}

/// The chosen window, falling back to the most used one when the provider has no such window.
fn pick_window<'a>(windows: &[&'a QuotaWindow], choice: &str) -> Option<&'a QuotaWindow> {
    let preferred = if choice == "highest" { None } else { windows.iter().find(|w| w.id == choice) };
    preferred
        .copied()
        .or_else(|| windows.iter().copied().reduce(|a, b| if b.used_percent > a.used_percent { b } else { a }))
}

fn percent(value: f64) -> String {
    number_to_string(js_round(value))
}

/// One picture for the tray icon: the chosen provider (or the most used one) and window. With
/// `highest`, the tone is the most urgent pace of any window shown, so a weekly limit running out
/// still colours a session-heavy icon.
pub fn summarize_tray(clock: &Clock, providers: &[ProviderState], now: f64, choice: TrayChoice<'_>) -> TraySummary {
    let mut tone = Tone::Neutral;
    let mut used_percent: f64 = 0.0;
    let mut lines = vec!["opentrack".to_owned()];
    let mut bar_lines = vec!["opentrack".to_owned()];
    let mut bars = Vec::new();
    // A provider that was turned off is not in `providers`; follow the most used one instead.
    let follow = if providers.iter().any(|p| p.key == choice.provider) { choice.provider } else { "auto" };
    for provider in providers {
        let followed = follow == "auto" || follow == provider.key;
        let windows: Vec<&QuotaWindow> =
            provider.quota.iter().flat_map(|q| &q.windows).filter(|w| !has_reset(clock, w, now)).collect();
        let Some(shown) = pick_window(&windows, choice.window) else { continue };
        lines.push(format!("{}: {}% {}", provider.label, percent(shown.used_percent), shown.label.to_lowercase()));
        if !followed {
            continue;
        }
        used_percent = used_percent.max(shown.used_percent);
        for window in windows {
            let window_tone = meter_tone(window, &project_pace(window, now));
            bars.push(TrayBar { tone: window_tone, used_percent: clamp_percent(window.used_percent) });
            bar_lines.push(format!("{} {}: {}%", provider.label, window.label, percent(window.used_percent)));
            if (choice.window == "highest" || std::ptr::eq(window, shown)) && window_tone > tone {
                tone = window_tone;
            }
        }
    }
    TraySummary {
        tone,
        used_percent: clamp_percent(used_percent),
        tooltip: if choice.style == "bars" { bar_lines } else { lines }.join("\n"),
        bars,
    }
}

const SUBSAMPLES: u32 = 4; // Per axis: smooth wedge edges once Windows scales the icon down.
const EMPTY_ALPHA: f64 = 0.28;

/// V8's `Math.hypot`, so a point on an edge falls on the same side as it did in 4.x.
fn hypot(x: f64, y: f64) -> f64 {
    let (x, y) = (x.abs(), y.abs());
    if x.is_infinite() || y.is_infinite() {
        return f64::INFINITY;
    }
    let max = x.max(y);
    if max == 0.0 {
        return 0.0;
    }
    let (mut sum, mut compensation) = (0.0, 0.0);
    for value in [x, y] {
        let n = value / max;
        let summand = n * n - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    sum.sqrt() * max
}

struct IconShape {
    outer: f64,
    ring_inner: f64,
    pie: f64,
    sweep: f64,
}

/// Opacity of one point `dx, dy` from the centre.
fn shape_alpha(dx: f64, dy: f64, shape: &IconShape) -> f64 {
    let distance = hypot(dx, dy);
    if distance > shape.outer {
        return 0.0;
    }
    if distance >= shape.ring_inner {
        return 1.0;
    }
    if distance > shape.pie {
        return 0.0;
    }
    let angle = (dx.atan2(-dy) + 2.0 * PI) % (2.0 * PI);
    if angle < shape.sweep {
        1.0
    } else {
        EMPTY_ALPHA
    }
}

fn bar_alpha(x: f64, y: f64, size: f64, height: f64, bar: Option<&TrayBar>) -> f64 {
    let Some(bar) = bar else { return 0.0 };
    let radius = height / 2.0;
    let left = size * 0.06;
    let right = size * 0.94;
    let nearest_x = (left + radius).max((right - radius).min(x));
    if hypot(x - nearest_x, y - radius) > radius {
        return 0.0;
    }
    if x < left + (clamp_percent(bar.used_percent) / 100.0) * (right - left) {
        1.0
    } else {
        EMPTY_ALPHA
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct TrayAppearance {
    /// `icon` or `bars`.
    pub style: String,
    pub colored: bool,
    pub bars: Vec<TrayBar>,
}

impl Default for TrayAppearance {
    fn default() -> Self {
        Self { style: "icon".into(), colored: true, bars: Vec::new() }
    }
}

/// The "O" filled like a pie, or one bar per limit, as straight RGBA for Tauri's tray image.
#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    reason = "icon sizes, bar counts and pixel indices are small non-negative values; percentages stay within 0..=100"
)]
pub fn render_tray_icon(size: u32, used_percent: f64, tone: Tone, appearance: &TrayAppearance) -> Vec<u8> {
    let mut pixels = vec![0u8; (size * size * 4) as usize];
    let fallback = [TrayBar { used_percent: 0.0, tone: Tone::Neutral }];
    let bars: &[TrayBar] = if appearance.bars.is_empty() { &fallback } else { &appearance.bars };
    let bars_style = appearance.style == "bars";
    let sizef = f64::from(size);
    let centre = sizef / 2.0;
    let outer = sizef / 2.0;
    let ring = 1.5f64.max(sizef * 0.11);
    let shape = IconShape {
        outer,
        ring_inner: outer - ring,
        pie: outer - ring - 1f64.max(sizef * 0.08),
        sweep: (clamp_percent(used_percent) / 100.0) * 2.0 * PI,
    };
    let step = 1.0 / f64::from(SUBSAMPLES);
    let count = bars.len() as f64;
    let bar_gap = (sizef * 0.07).min((sizef * 0.2) / 1f64.max(count - 1.0));
    let bar_height = (sizef * 0.18).min((sizef * 0.88 - (count - 1.0) * bar_gap) / count);
    let bars_top = (sizef - (count * bar_height + (count - 1.0) * bar_gap)) / 2.0;
    for y in 0..size {
        let yf = f64::from(y);
        let bar_index = ((yf + 0.5 - bars_top) / (bar_height + bar_gap)).floor();
        let bar = if bar_index >= 0.0 { bars.get(bar_index as usize) } else { None };
        let rgb = if appearance.colored {
            tone_rgb(if bars_style { bar.map_or(Tone::Neutral, |b| b.tone) } else { tone })
        } else {
            [150, 150, 150]
        };
        for x in 0..size {
            let xf = f64::from(x);
            let mut alpha = 0.0;
            for sample_y in 0..SUBSAMPLES {
                let sy = (f64::from(sample_y) + 0.5) * step;
                for sample_x in 0..SUBSAMPLES {
                    let sx = (f64::from(sample_x) + 0.5) * step;
                    alpha += if bars_style {
                        bar_alpha(
                            xf + sx,
                            yf + sy - bars_top - bar_index * (bar_height + bar_gap),
                            sizef,
                            bar_height,
                            bar,
                        )
                    } else {
                        shape_alpha(xf + sx - centre, yf + sy - centre, &shape)
                    };
                }
            }
            let offset = ((y * size + x) * 4) as usize;
            pixels[offset..offset + 3].copy_from_slice(&rgb);
            pixels[offset + 3] = js_round((alpha / f64::from(SUBSAMPLES * SUBSAMPLES)) * 255.0) as u8;
        }
    }
    pixels
}

#[cfg(test)]
mod tests {
    use aitrack_core::quota::{QuotaFormat, QuotaSnapshot};

    use super::*;
    use crate::alerts::fixtures::{iso, session_window, snapshot, NOW};

    const AUTO: TrayChoice<'static> = TrayChoice { provider: "auto", window: "highest", style: "icon" };

    fn clock() -> Clock {
        Clock::in_zone("UTC").unwrap()
    }

    fn provider(windows: Vec<QuotaWindow>) -> ProviderState {
        ProviderState {
            key: "claude_code".into(),
            label: "Claude Code".into(),
            quota: Some(snapshot(windows)),
            quota_error: None,
            retry_at: None,
            usage: None,
            refreshing: false,
        }
    }

    fn keyed(key: &str, label: &str, windows: Vec<QuotaWindow>) -> ProviderState {
        let mut state = provider(windows);
        state.key = key.into();
        state.label = label.into();
        state.quota = state.quota.map(|q| QuotaSnapshot { provider: key.into(), ..q });
        state
    }

    fn weekly(used: f64) -> QuotaWindow {
        QuotaWindow { id: "weekly".into(), label: "Weekly".into(), ..session_window(used, 2.5) }
    }

    fn used(summary: &TraySummary) -> Vec<f64> {
        summary.bars.iter().map(|b| b.used_percent).collect()
    }

    #[test]
    fn ignores_a_cached_window_whose_reset_has_passed() {
        let past = QuotaWindow { resets_at: Some(iso(NOW - 1.0)), ..session_window(95.0, 2.5) };
        let summary = summarize_tray(&clock(), &[provider(vec![past, session_window(20.0, 2.5)])], NOW, AUTO);
        assert_eq!((summary.used_percent, summary.tone, summary.bars.len()), (20.0, Tone::Calm, 1));
    }

    #[test]
    fn takes_the_most_urgent_tone_and_the_highest_usage() {
        let none = ProviderState { quota: None, ..provider(vec![]) };
        let providers = [provider(vec![session_window(20.0, 2.5)]), provider(vec![session_window(48.0, 2.5)]), none];
        assert_eq!(
            summarize_tray(&clock(), &providers, NOW, AUTO),
            TraySummary {
                tone: Tone::Warn,
                used_percent: 48.0,
                tooltip: "opentrack\nClaude Code: 20% session\nClaude Code: 48% session".into(),
                bars: vec![
                    TrayBar { tone: Tone::Calm, used_percent: 20.0 },
                    TrayBar { tone: Tone::Warn, used_percent: 48.0 }
                ],
            }
        );
        assert_eq!(summarize_tray(&clock(), &[], NOW, AUTO).tone, Tone::Neutral);
        // No reset time means no pace, so fullness alone decides, as on the meter.
        let unpaced = QuotaWindow { resets_at: None, ..session_window(95.0, 2.5) };
        assert_eq!(summarize_tray(&clock(), &[provider(vec![unpaced])], NOW, AUTO).tone, Tone::Crit);
    }

    #[test]
    #[expect(clippy::float_cmp, reason = "test values are sums of small integers and halves, exact in f64")]
    fn follows_the_chosen_provider_and_window() {
        let codex = keyed("codex", "Codex", vec![session_window(90.0, 2.5), weekly(10.0)]);
        let providers = [provider(vec![session_window(60.0, 2.5)]), codex.clone()];
        let choose = |provider, window| TrayChoice { provider, window, style: "icon" };
        let summary = summarize_tray(&clock(), &providers, NOW, choose("codex", "weekly"));
        assert_eq!((summary.used_percent, summary.tone), (10.0, Tone::Calm));
        assert_eq!(
            summary.bars,
            [TrayBar { used_percent: 90.0, tone: Tone::Crit }, TrayBar { used_percent: 10.0, tone: Tone::Calm }]
        );
        // Claude has no weekly window, so it falls back to its most used one.
        assert_eq!(summarize_tray(&clock(), &providers, NOW, choose("claude_code", "weekly")).used_percent, 60.0);
        assert_eq!(summarize_tray(&clock(), &[codex], NOW, choose("claude_code", "session")).used_percent, 90.0);
    }

    #[test]
    fn includes_monetary_limits_in_tray_usage_tone_and_bars() {
        let money = QuotaWindow {
            id: "onDemand".into(),
            label: "On-demand".into(),
            format: QuotaFormat::Dollars,
            used_value: Some(95.0),
            limit_value: Some(100.0),
            ..session_window(95.0, 2.5)
        };
        let cursor = keyed("cursor", "Cursor", vec![money]);
        assert_eq!(
            summarize_tray(&clock(), &[cursor], NOW, TrayChoice { style: "bars", ..AUTO }),
            TraySummary {
                tone: Tone::Crit,
                used_percent: 95.0,
                bars: vec![TrayBar { tone: Tone::Crit, used_percent: 95.0 }],
                tooltip: "opentrack\nCursor On-demand: 95%".into(),
            }
        );
    }

    #[test]
    fn shows_session_and_weekly_bars_for_each_provider() {
        let providers = [
            provider(vec![session_window(20.0, 2.5), weekly(40.0)]),
            keyed("codex", "Codex", vec![session_window(60.0, 2.5), weekly(80.0)]),
        ];
        let summary = summarize_tray(
            &clock(),
            &providers,
            NOW,
            TrayChoice { provider: "auto", window: "session", style: "bars" },
        );
        assert_eq!(used(&summary), [20.0, 40.0, 60.0, 80.0]);
        assert_eq!(
            summary.tooltip,
            "opentrack\nClaude Code Session: 20%\nClaude Code Weekly: 40%\nCodex Session: 60%\nCodex Weekly: 80%"
        );
        let selected = summarize_tray(
            &clock(),
            &providers,
            NOW,
            TrayChoice { provider: "codex", window: "weekly", style: "bars" },
        );
        assert_eq!(used(&selected), [60.0, 80.0]);
        assert_eq!(selected.tooltip, "opentrack\nCodex Session: 60%\nCodex Weekly: 80%");
    }

    #[test]
    fn draws_the_outline_ring_the_used_wedge_solid_and_the_rest_faint() {
        let size = 32;
        let pixels = render_tray_icon(size, 25.0, Tone::Crit, &TrayAppearance::default());
        assert_eq!(pixels.len(), (size * size * 4) as usize);
        let alpha_at = |x: u32, y: u32| pixels[((y * size + x) * 4 + 3) as usize];
        assert_eq!(alpha_at(0, 0), 0); // Corner, outside the O
        assert_eq!(alpha_at(16, 1), 255); // Outline ring
        assert_eq!(alpha_at(16, 5), 0); // Gap between ring and pie
        assert_eq!(alpha_at(19, 10), 255); // Just clockwise of 12 o'clock: used
        assert_eq!(alpha_at(16, 16), 71); // Past the wedge: left, faint
    }

    #[test]
    fn fits_four_or_more_limit_bars_inside_the_tray_without_clipping() {
        for count in [4, 6] {
            let bars = vec![TrayBar { used_percent: 100.0, tone: Tone::Calm }; count];
            let pixels =
                render_tray_icon(32, 100.0, Tone::Calm, &TrayAppearance { style: "bars".into(), colored: false, bars });
            let filled: Vec<bool> = (0..32).map(|y| pixels[(y * 32 + 16) * 4 + 3] > 150).collect();
            let starts = (0..32).filter(|&y| filled[y] && (y == 0 || !filled[y - 1])).count();
            assert_eq!(starts, count);
            assert!(!filled[0] && !filled[31]);
        }
    }

    #[test]
    fn draws_separate_rounded_progress_bars_with_gaps_and_individual_tones() {
        let size = 32;
        let bars = vec![
            TrayBar { used_percent: 25.0, tone: Tone::Calm },
            TrayBar { used_percent: 60.0, tone: Tone::Warn },
            TrayBar { used_percent: 100.0, tone: Tone::Crit },
        ];
        let pixels =
            render_tray_icon(size, 100.0, Tone::Crit, &TrayAppearance { style: "bars".into(), colored: true, bars });
        let at = |x: u32, y: u32| {
            let offset = ((y * size + x) * 4) as usize;
            pixels[offset..offset + 4].to_vec()
        };
        assert_eq!(at(6, 7), [52, 168, 83, 255]);
        assert_eq!(at(20, 7), [52, 168, 83, 71]);
        assert_eq!(at(16, 11)[3], 0);
        assert_eq!(at(10, 15), [242, 153, 0, 255]);
        assert_eq!(at(25, 23), [217, 48, 37, 255]);
        assert_eq!(at(0, 0)[3], 0);
    }

    #[test]
    fn keeps_progress_but_removes_tone_colours_for_both_monochrome_styles() {
        for style in ["icon", "bars"] {
            let appearance = |tone| TrayAppearance {
                style: style.into(),
                colored: false,
                bars: vec![TrayBar { used_percent: 50.0, tone }],
            };
            let pixels = render_tray_icon(32, 50.0, Tone::Crit, &appearance(Tone::Crit));
            assert_eq!(pixels, render_tray_icon(32, 50.0, Tone::Calm, &appearance(Tone::Calm)));
            assert!(pixels.chunks(4).all(|p| p[0] == p[1] && p[1] == p[2]));
            assert!(pixels.contains(&255) && pixels.contains(&71));
        }
    }
}

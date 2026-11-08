use aitrack_core::js::number_to_string;
use aitrack_core::quota::pacing::{js_round, project_pace, PaceSeverity};
use aitrack_core::quota::{QuotaFormat, QuotaSnapshot};
use aitrack_core::time::Clock;
use indexmap::IndexMap;

use crate::pace::{format_when, parse_ms};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Alert {
    /// Stable per window, so each alert fires once until its window resets.
    pub key: String,
    pub resets_at: String,
    pub title: String,
    pub body: String,
}

/// Alert key to the reset it belongs to, persisted so restarts do not re-alert.
pub type FiredAlerts = IndexMap<String, String>;

const ALMOST_OUT_LEFT_PERCENT: f64 = 10.0;
const RESET_GRACE_MS: f64 = 5.0 * 60_000.0; // The old window can still be reported just after its reset.

fn is_live(clock: &Clock, resets_at: Option<&String>, now: f64) -> bool {
    resets_at.is_some_and(|at| parse_ms(clock, at) + RESET_GRACE_MS > now)
}

pub fn due_alerts(clock: &Clock, label: &str, snapshot: &QuotaSnapshot, fired: &FiredAlerts, now: f64) -> Vec<Alert> {
    let mut alerts = Vec::new();
    for window in &snapshot.windows {
        let Some(resets_at) = window.resets_at.as_ref().filter(|_| window.format == QuotaFormat::Percent) else {
            continue;
        };
        if parse_ms(clock, resets_at).partial_cmp(&now) != Some(std::cmp::Ordering::Greater) {
            continue;
        }
        let scope = format!("{}:{}", snapshot.provider, window.id);
        let left = 100.0 - window.used_percent;
        let name = format!("{label} {}", window.label.to_lowercase());
        if left <= ALMOST_OUT_LEFT_PERCENT {
            let key = format!("{scope}:almostOut");
            if !is_live(clock, fired.get(&key), now) {
                alerts.push(Alert {
                    key,
                    resets_at: resets_at.clone(),
                    title: format!("{name} almost used up"),
                    body: format!("{}% left until it resets.", number_to_string(0f64.max(js_round(left)))),
                });
            }
            continue;
        }
        let pace = project_pace(window, now);
        let key = format!("{scope}:willRunOut");
        if let (PaceSeverity::RunningOut, Some(run_out_at)) = (pace.severity, pace.run_out_at) {
            if !is_live(clock, fired.get(&key), now) {
                alerts.push(Alert {
                    key,
                    resets_at: resets_at.clone(),
                    title: format!("{name} on pace to run out"),
                    body: format!(
                        "At this rate it runs out around {}, before it resets.",
                        format_when(run_out_at, now, clock.zone())
                    ),
                });
            }
        }
    }
    alerts
}

pub fn prune_fired(clock: &Clock, fired: &FiredAlerts, now: f64) -> FiredAlerts {
    fired.iter().filter(|(_, at)| is_live(clock, Some(at), now)).map(|(k, v)| (k.clone(), v.clone())).collect()
}

#[cfg(test)]
pub mod fixtures {
    use aitrack_core::quota::{QuotaFormat, QuotaSnapshot, QuotaWindow};
    use aitrack_core::time::iso_millis;

    pub const NOW: f64 = 1_780_315_200_000.0; // 2026-06-01T12:00:00.000Z
    pub const HOUR: f64 = 3_600_000.0;

    pub fn iso(ms: f64) -> String {
        iso_millis(aitrack_core::time::from_js_millis(ms).unwrap())
    }

    pub fn snapshot(windows: Vec<QuotaWindow>) -> QuotaSnapshot {
        QuotaSnapshot { provider: "claude_code".into(), plan: None, windows, values: vec![], fetched_at: iso(NOW) }
    }

    pub fn session_window(used_percent: f64, elapsed_hours: f64) -> QuotaWindow {
        QuotaWindow {
            id: "session".into(),
            label: "Session".into(),
            used_percent,
            resets_at: Some(iso(NOW + (5.0 - elapsed_hours) * HOUR)),
            period_seconds: 5.0 * 3600.0,
            format: QuotaFormat::Percent,
            used_value: None,
            limit_value: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use aitrack_core::quota::QuotaWindow;

    use super::fixtures::*;
    use super::*;

    fn clock() -> Clock {
        Clock::in_zone("UTC").unwrap()
    }

    fn fired_from(alerts: &[Alert]) -> FiredAlerts {
        alerts.iter().map(|a| (a.key.clone(), a.resets_at.clone())).collect()
    }

    #[test]
    fn fires_almost_out_once_per_reset() {
        let quota = snapshot(vec![session_window(95.0, 2.0)]);
        let alerts = due_alerts(&clock(), "Claude Code", &quota, &FiredAlerts::new(), NOW);
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].title, "Claude Code session almost used up");
        assert_eq!(alerts[0].body, "5% left until it resets.");
        let fired = fired_from(&alerts);
        assert!(due_alerts(&clock(), "Claude Code", &quota, &fired, NOW).is_empty());
        let drifted = QuotaWindow { resets_at: Some(iso(NOW + 3.0 * HOUR + 1000.0)), ..session_window(95.0, 2.0) };
        assert!(due_alerts(&clock(), "Claude Code", &snapshot(vec![drifted]), &fired, NOW).is_empty());
    }

    #[test]
    fn fires_will_run_out_from_the_pace_and_skips_windows_it_cannot_judge() {
        let at = |resets_at: &str| QuotaWindow { resets_at: Some(resets_at.into()), ..session_window(95.0, 1.0) };
        let windows = vec![
            session_window(80.0, 2.5),
            session_window(10.0, 2.5),
            QuotaWindow { resets_at: None, ..session_window(50.0, 1.0) },
            QuotaWindow { format: QuotaFormat::Dollars, ..session_window(99.0, 1.0) },
            at(&iso(NOW - 1.0)),
            at(&iso(NOW)),
            at("invalid"),
        ];
        let alerts = due_alerts(&clock(), "Codex", &snapshot(windows), &FiredAlerts::new(), NOW);
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].title, "Codex session on pace to run out");
        assert_eq!(alerts[0].body, "At this rate it runs out around 12:37\u{202f}PM, before it resets.");
        let fired = fired_from(&alerts);
        assert!(due_alerts(&clock(), "Codex", &snapshot(vec![session_window(80.0, 2.5)]), &fired, NOW).is_empty());
    }

    #[test]
    fn prunes_alerts_for_windows_that_have_reset() {
        let fired: FiredAlerts =
            [("old".into(), iso(NOW - 5.0 * 60_000.0 - 1.0)), ("grace".into(), iso(NOW - 1.0))].into_iter().collect();
        assert_eq!(prune_fired(&clock(), &fired, NOW).keys().collect::<Vec<_>>(), ["grace"]);
    }
}

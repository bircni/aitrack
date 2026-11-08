//! Whether a quota will last until it resets, projected from the pace so far.
//! Ported from `OpenQuota`'s `src/lib/pacing.ts` (MIT, deviffyy/OpenQuota).

use serde::Serialize;

use super::{QuotaWindow, clamp_percent};
use crate::time::Clock;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PaceSeverity {
    Level,
    Healthy,
    Close,
    RunningOut,
    Spent,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaceProjection {
    pub severity: PaceSeverity,
    pub projected_used_percent: Option<f64>,
    pub even_pace_percent: Option<f64>,
    /// Epoch ms the quota runs out, when that falls before the reset.
    pub run_out_at: Option<f64>,
}

const LEVEL: PaceProjection = PaceProjection {
    severity: PaceSeverity::Level,
    projected_used_percent: None,
    even_pace_percent: None,
    run_out_at: None,
};

/// JS `Math.round`: halves go up; `x + 0.5` would round 0.49999999999999994 up as well.
pub fn js_round(x: f64) -> f64 {
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}

#[allow(clippy::cast_precision_loss)]
pub fn project_pace(window: &QuotaWindow, now_ms: f64) -> PaceProjection {
    let used = clamp_percent(window.used_percent);
    if js_round(used) >= 100.0 {
        return PaceProjection {
            severity: PaceSeverity::Spent,
            projected_used_percent: Some(100.0),
            even_pace_percent: None,
            run_out_at: Some(now_ms),
        };
    }
    if used <= 0.0 {
        return LEVEL;
    }
    let reset =
        window.resets_at.as_deref().and_then(|r| Clock::system().parse_timestamp(r)).map(|t| t.as_millisecond() as f64);
    let Some(reset) = reset.filter(|r| *r > now_ms) else { return LEVEL };
    if window.period_seconds <= 0.0 {
        return LEVEL;
    }
    let period_ms = window.period_seconds * 1000.0;
    let start = reset - period_ms;
    let elapsed = (now_ms - start).max(0.0);
    // Too early in the window for a projection to mean anything.
    if elapsed < 60_000f64.max(period_ms * 0.01) {
        return LEVEL;
    }
    let progress = (elapsed / period_ms).clamp(0.0, 1.0);
    let projected = used / progress;
    let even = progress * 100.0;
    if projected <= 90.0 {
        return PaceProjection {
            severity: PaceSeverity::Healthy,
            projected_used_percent: Some(projected),
            even_pace_percent: Some(even),
            run_out_at: None,
        };
    }
    if used < 5.0 {
        return LEVEL;
    }
    if projected <= 100.0 {
        let severity = if js_round(100.0 - projected) >= 1.0 { PaceSeverity::Close } else { PaceSeverity::RunningOut };
        return PaceProjection {
            severity,
            projected_used_percent: Some(projected),
            even_pace_percent: Some(even),
            run_out_at: None,
        };
    }
    let run_out = start + (elapsed * 100.0) / used;
    PaceProjection {
        severity: PaceSeverity::RunningOut,
        projected_used_percent: Some(projected),
        even_pace_percent: Some(even),
        run_out_at: (run_out > now_ms && run_out < reset).then_some(run_out),
    }
}

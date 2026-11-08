use jiff::{SignedDuration, Timestamp};

use crate::time::Clock;

/// A machine that synced before but not for three days; one that never synced is reported separately.
pub fn is_stale_sync(clock: &Clock, last_updated: &str, now: Timestamp) -> bool {
    clock.parse_timestamp(last_updated).is_some_and(|at| now.duration_since(at) > SignedDuration::from_hours(72))
}

use serde_json::Value;

use crate::data::model_id::strip_model_alias_suffix;
use crate::day::Day;
use crate::js::is_inherited_key;
use crate::time::Clock;

/// Past this, enough records could sum beyond 2^53 and round differently per model, and a machine
/// file's totals must equal the sum of its rows exactly.
const MAX_TOKENS_PER_RECORD: u64 = 1 << 40;

/// A non-negative integer token count, as `Number.isInteger` sees it (`5.0` counts).
#[must_use]
pub fn token_count(value: &Value) -> Option<u64> {
    let n = value.as_u64().or_else(|| {
        let x = value.as_f64()?;
        #[expect(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "the value is rounded and bounded to the target range first"
        )]
        (x == 0.0 || (x > 0.0 && x.fract() == 0.0 && x <= 2f64.powi(40))).then(|| x.abs() as u64)
    })?;
    (n <= MAX_TOKENS_PER_RECORD).then_some(n)
}

/// A token field a log may leave out or null, or a real count.
#[must_use]
pub fn is_optional_token_count(value: Option<&Value>) -> bool {
    value.is_none_or(|v| v.is_null() || token_count(v).is_some())
}

/// The count, or 0 when left out or null.
#[must_use]
pub fn tokens_or_zero(value: Option<&Value>) -> u64 {
    value.and_then(token_count).unwrap_or(0)
}

fn plain_key(value: &str) -> bool {
    !value.is_empty() && !is_inherited_key(value)
}

#[must_use]
pub fn log_cwd(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|cwd| plain_key(cwd))
}

#[must_use]
pub fn log_model(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).map(strip_model_alias_suffix).filter(|model| plain_key(model))
}

/// The local day of a log timestamp; JS prints years below 1000 unpadded, which no day key matches.
#[must_use]
pub fn log_day(clock: &Clock, value: Option<&Value>) -> Option<Day> {
    clock.parse_local_day(value?.as_str()?).filter(|day| day.year() >= 1000)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn accepts_only_bounded_non_negative_integers() {
        for (value, expected) in [
            (json!(5), Some(5)),
            (json!(5.0), Some(5)),
            (json!(-0.0), Some(0)),
            (json!(1u64 << 40), Some(1 << 40)),
            (json!((1u64 << 40) + 1), None),
            (json!(-1), None),
            (json!(1.5), None),
            (json!("5"), None),
        ] {
            assert_eq!(token_count(&value), expected, "{value}");
        }
        assert!(is_optional_token_count(None) && is_optional_token_count(Some(&json!(null))));
        assert!(!is_optional_token_count(Some(&json!(-1))));
        assert_eq!(log_model(Some(&json!("claude-opus-4-latest"))), Some("claude-opus-4"));
        assert_eq!(log_model(Some(&json!("-latest"))), None);
        assert_eq!(log_cwd(Some(&json!("constructor"))), None);
    }
}

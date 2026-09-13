//! Type guards and validation helpers.

use serde_json::Value;

/// A real number: rejects NaN and ±Infinity.
pub fn is_finite_number(value: &Value) -> bool {
    value.as_f64().map(|n| n.is_finite()).unwrap_or(false)
}

/// Check if value is a non-null JSON object (not an array).
pub fn is_record(value: &Value) -> bool {
    value.is_object()
}

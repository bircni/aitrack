//! Cursor's usage CSV export, as day maps priced at list rates.

use crate::data::day_map::{add_model_usage, get_or_create_day};
use crate::data::types::{DayMap, TokenCounts};
use crate::day::Day;
use crate::js::{parse_number, trim};
use crate::pricing::cost::estimate_cursor_cost;
use crate::pricing::model_pricing::ModelPricing;
use crate::quota::pacing::js_round;
use crate::readers::log_values::{log_day, log_model};
use crate::time::Clock;

fn parse_csv_line(line: &str) -> Vec<String> {
    let mut values = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '"' {
            if quoted && chars.peek() == Some(&'"') {
                current.push('"');
                chars.next();
            } else {
                quoted = !quoted;
            }
        } else if c == ',' && !quoted {
            values.push(std::mem::take(&mut current));
        } else {
            current.push(c);
        }
    }
    values.push(current);
    values
}

/// A positive whole count, from cells like `"1,000"`; JS `Number` then `Math.round`.
#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "checked just above: positive and at most 2^40 once rounded"
)]
fn parse_cursor_number(value: Option<&str>) -> Option<u64> {
    let numeric = parse_number(&value.unwrap_or_default().replace(',', ""))?;
    let rounded = js_round(numeric);
    (numeric > 0.0 && rounded <= 2f64.powi(40)).then_some(rounded as u64)
}

#[must_use]
pub fn parse_cursor_date(clock: &Clock, value: Option<&str>) -> Option<Day> {
    let trimmed = trim(value?);
    if trimmed.is_empty() {
        return None;
    }
    Day::parse(trimmed).or_else(|| log_day(clock, Some(&serde_json::Value::from(trimmed))))
}

/// The breakdown when the four columns carry usage, else the legacy aggregate column as input.
fn token_totals(cell: &dyn Fn(&str) -> Option<String>) -> Option<TokenCounts> {
    let number = |name: &str| parse_cursor_number(cell(name).as_deref());
    let cache_write = number("Input (w/ Cache Write)").unwrap_or(0);
    let raw = number("Input (w/o Cache Write)").unwrap_or(0);
    let cache_read = number("Cache Read").unwrap_or(0);
    let output = number("Output Tokens").unwrap_or(0);
    if raw + cache_write + cache_read > 0 || output > 0 {
        return Some(TokenCounts {
            input_tokens: raw + cache_write + cache_read,
            output_tokens: output,
            raw_input_tokens: Some(raw),
            cached_input_tokens: Some(cache_read),
            cache_creation_input_tokens: Some(cache_write),
            ..TokenCounts::default()
        });
    }
    let total = number("Total Tokens").or_else(|| number("Tokens")).filter(|t| *t > 0)?;
    Some(TokenCounts { input_tokens: total, ..TokenCounts::default() })
}

/// Cursor's own Cost column is plan-included, "Free" or vendor-billed amounts, so it is ignored:
/// costs are estimated from the token buckets where the model has a list rate.
pub fn aggregate_cursor_csv(content: &str, clock: &Clock, pricing: &ModelPricing) -> DayMap {
    let mut days = DayMap::new();
    let mut headers: Option<Vec<String>> = None;
    for raw_line in content.split('\n') {
        let line = trim(raw_line.strip_suffix('\r').unwrap_or(raw_line));
        if line.is_empty() {
            continue;
        }
        let values = parse_csv_line(line);
        let Some(headers) = &headers else {
            headers = Some(values);
            continue;
        };
        let cell =
            |name: &str| headers.iter().rposition(|h| h == name).map(|i| values.get(i).cloned().unwrap_or_default());
        let Some(date) = parse_cursor_date(clock, cell("Date").as_deref()) else { continue };
        let Some(raw_model) = cell("Model").map(|m| trim(&m).to_owned()).filter(|m| !m.is_empty()) else { continue };
        let Some(mut counts) = token_totals(&cell) else { continue };
        let model = log_model(Some(&serde_json::Value::from(raw_model.as_str()))).unwrap_or("unknown").to_owned();
        counts.cost_usd = estimate_cursor_cost(pricing, &model, &counts, Some(&date.to_string()));
        add_model_usage(get_or_create_day(&mut days, date), &model, &counts, None);
    }
    days
}

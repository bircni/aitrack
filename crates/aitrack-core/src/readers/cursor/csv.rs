//! Cursor CSV export parsing.

use crate::data::day_map::add_model_usage;
use crate::data::model_id::strip_model_alias_suffix;
use crate::data::types::DayMap;
use std::collections::HashMap;

#[derive(Debug)]
struct CursorCsvRow {
    date: Option<String>,
    model: Option<String>,
    tokens: Option<String>,
    input_with_cache_write: Option<String>,
    input_without_cache_write: Option<String>,
    cache_read: Option<String>,
    output_tokens: Option<String>,
    total_tokens: Option<String>,
}

fn parse_csv_line(line: &str) -> Vec<String> {
    let mut values = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();

    while let Some(ch) = chars.next() {
        match ch {
            '"' => {
                if in_quotes && chars.peek() == Some(&'"') {
                    current.push('"');
                    chars.next();
                } else {
                    in_quotes = !in_quotes;
                }
            }
            ',' if !in_quotes => {
                values.push(current.clone());
                current.clear();
            }
            _ => current.push(ch),
        }
    }
    values.push(current);
    values
}

fn create_cursor_csv_row(headers: &[String], values: &[String]) -> CursorCsvRow {
    let mut row: HashMap<String, String> = HashMap::new();
    for (i, header) in headers.iter().enumerate() {
        if let Some(value) = values.get(i) {
            row.insert(header.clone(), value.clone());
        }
    }

    CursorCsvRow {
        date: row.get("Date").cloned(),
        model: row.get("Model").cloned(),
        tokens: row.get("Tokens").cloned(),
        input_with_cache_write: row.get("Input (w/ Cache Write)").cloned(),
        input_without_cache_write: row.get("Input (w/o Cache Write)").cloned(),
        cache_read: row.get("Cache Read").cloned(),
        output_tokens: row.get("Output Tokens").cloned(),
        total_tokens: row.get("Total Tokens").cloned(),
    }
}

fn parse_cursor_number(value: Option<&String>) -> Option<u64> {
    value
        .map(|s| s.replace(',', "").trim().to_string())
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|&n| n.is_finite() && n > 0.0)
        .map(|n| n.round() as u64)
}

/// Parse Cursor CSV date to YYYY-MM-DD.
pub fn parse_cursor_date_string(value: Option<&String>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        return None;
    }

    // Check if already in YYYY-MM-DD format
    if trimmed.len() == 10
        && trimmed.chars().nth(4) == Some('-')
        && trimmed.chars().nth(7) == Some('-')
    {
        return Some(trimmed.to_string());
    }

    // Try parsing as date
    // Simplified: assume ISO date or common formats
    Some(trimmed.to_string())
}

struct CursorTokenTotals {
    input: u64,
    output: u64,
}

fn create_cursor_token_totals(row: &CursorCsvRow) -> Option<CursorTokenTotals> {
    let cache_write = parse_cursor_number(row.input_with_cache_write.as_ref()).unwrap_or(0);
    let raw_input = parse_cursor_number(row.input_without_cache_write.as_ref()).unwrap_or(0);
    let cache_read = parse_cursor_number(row.cache_read.as_ref()).unwrap_or(0);
    let output_tokens = parse_cursor_number(row.output_tokens.as_ref()).unwrap_or(0);
    let input_tokens = cache_write + raw_input + cache_read;

    if input_tokens > 0 || output_tokens > 0 {
        return Some(CursorTokenTotals {
            input: input_tokens,
            output: output_tokens,
        });
    }

    // Fallback to aggregate Tokens column
    let total = parse_cursor_number(row.total_tokens.as_ref())
        .or_else(|| parse_cursor_number(row.tokens.as_ref()))?;

    Some(CursorTokenTotals {
        input: total,
        output: 0,
    })
}

/// Aggregate Cursor CSV text into a DayMap.
pub fn aggregate_cursor_csv_to_day_map(content: &str) -> DayMap {
    let mut result = DayMap::new();
    let mut headers: Option<Vec<String>> = None;

    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }

        let values = parse_csv_line(line);

        if headers.is_none() {
            headers = Some(values);
            continue;
        }

        let row = create_cursor_csv_row(headers.as_ref().unwrap(), &values);
        let date_string = match parse_cursor_date_string(row.date.as_ref()) {
            Some(ds) => ds,
            None => continue,
        };

        let raw_model = match row
            .model
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            Some(m) => m,
            None => continue,
        };

        let token_totals = match create_cursor_token_totals(&row) {
            Some(tt) => tt,
            None => continue,
        };

        let model = strip_model_alias_suffix(raw_model);
        let day = result.entry(date_string).or_default();

        // Cursor CSV has no cost data we can trust
        add_model_usage(
            day,
            &model,
            &crate::data::types::TokenCounts {
                input_tokens: token_totals.input,
                output_tokens: token_totals.output,
                cached_input_tokens: None,
                raw_input_tokens: None,
                cache_creation_input_tokens: None,
                cost_usd: None,
            },
        );
    }

    result
}

/// `String(x)` / `JSON.stringify(x)` for a finite double: shortest round-trip digits, laid out per ECMAScript.
#[must_use]
pub fn number_to_string(x: f64) -> String {
    debug_assert!(x.is_finite(), "JSON has no representation for {x}");
    if x == 0.0 {
        return "0".to_owned(); // Also -0.
    }
    // ryu picks the closest of the shortest round-trip digit strings, as ECMAScript requires; `{:e}` does not.
    let (digits, n) = shortest_digits(x.abs());
    let k = count(&digits);

    let mut out = String::with_capacity(24);
    if x < 0.0 {
        out.push('-');
    }
    if k <= n && n <= 21 {
        out.push_str(&digits);
        out.extend(std::iter::repeat_n('0', usize::try_from(n - k).unwrap_or(0)));
    } else if 0 < n && n <= 21 {
        let (int, frac) = digits.split_at(usize::try_from(n).unwrap_or(0));
        out.push_str(int);
        out.push('.');
        out.push_str(frac);
    } else if -6 < n && n <= 0 {
        out.push_str("0.");
        out.extend(std::iter::repeat_n('0', usize::try_from(-n).unwrap_or(0)));
        out.push_str(&digits);
    } else {
        let (first, rest) = digits.split_at(1);
        out.push_str(first);
        if !rest.is_empty() {
            out.push('.');
            out.push_str(rest);
        }
        out.push('e');
        out.push(if n > 0 { '+' } else { '-' });
        out.push_str(&(n - 1).abs().to_string());
    }
    out
}

/// The significant digits of `x` and the position of the decimal point relative to them.
pub fn shortest_digits(x: f64) -> (String, i32) {
    let mut buffer = ryu::Buffer::new();
    let text = buffer.format_finite(x);
    let (mantissa, exponent) = text.split_once('e').unwrap_or((text, "0"));
    let (int, frac) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let all = format!("{int}{frac}");
    let trimmed = all.trim_start_matches('0');
    let point = count(int) + exponent_value(exponent) - (count(&all) - count(trimmed));
    (trimmed.trim_end_matches('0').to_owned(), point)
}

/// The length of one of ryu's at most 17-digit strings.
fn count(digits: &str) -> i32 {
    digits.bytes().fold(0, |n, _| n + 1)
}

/// ryu's exponent: an optional minus and decimal digits.
fn exponent_value(text: &str) -> i32 {
    let (sign, digits) = text.strip_prefix('-').map_or((1, text), |digits| (-1, digits));
    sign * digits.bytes().fold(0, |n, b| n * 10 + i32::from(b.wrapping_sub(b'0')))
}

#[cfg(test)]
mod tests {
    use super::number_to_string;

    #[test]
    fn matches_node_for_every_fixture_number() {
        let rows: Vec<(String, String)> =
            serde_json::from_str(include_str!("../../tests/fixtures/js/numbers.json")).unwrap();
        for (bits, expected) in rows {
            let x = f64::from_bits(u64::from_str_radix(&bits, 16).unwrap());
            assert_eq!(number_to_string(x), expected, "bits {bits}");
            // Machine files are read back too, and the default parser can land a bit off.
            if x != 0.0 {
                assert_eq!(
                    serde_json::from_str::<f64>(&expected).unwrap().to_bits(),
                    x.to_bits(),
                    "parsing {expected}"
                );
            }
        }
    }
}

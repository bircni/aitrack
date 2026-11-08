/// `String(x)` / `JSON.stringify(x)` for a finite double: shortest round-trip digits, laid out per ECMAScript.
#[must_use]
pub fn number_to_string(x: f64) -> String {
    debug_assert!(x.is_finite(), "JSON has no representation for {x}");
    if x == 0.0 {
        return "0".to_owned(); // Also -0.
    }
    // ryu picks the closest of the shortest round-trip digit strings, as ECMAScript requires; `{:e}` does not.
    let (digits, n) = shortest_digits(x.abs());
    let k = i32::try_from(digits.len()).expect("a double has at most 17 significant digits");

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
fn shortest_digits(x: f64) -> (String, i32) {
    let mut buffer = ryu::Buffer::new();
    let text = buffer.format_finite(x);
    let (mantissa, exponent) = text.split_once('e').unwrap_or((text, "0"));
    let (int, frac) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let mut point =
        i32::try_from(int.len()).expect("short") + exponent.parse::<i32>().expect("ryu writes an integer exponent");
    let all = format!("{int}{frac}");
    let trimmed = all.trim_start_matches('0');
    point -= i32::try_from(all.len() - trimmed.len()).expect("short");
    (trimmed.trim_end_matches('0').to_owned(), point)
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
        }
    }
}

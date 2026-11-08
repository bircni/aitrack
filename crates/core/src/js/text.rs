/// JavaScript's `\s` and `String.prototype.trim` set: Unicode spaces, line terminators and the BOM, not NEL.
#[must_use]
pub const fn is_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

#[must_use]
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_space)
}

/// `decodeURIComponent`, or `None` where it throws: a stray `%` or escapes that are not UTF-8.
#[must_use]
pub fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `Number(text)`: trimmed, empty is 0, `0x`/`0o`/`0b` integers, `Infinity`, else a decimal literal; `None` for NaN.
#[must_use]
pub fn parse_number(text: &str) -> Option<f64> {
    let text = trim(text);
    if text.is_empty() {
        return Some(0.0);
    }
    let (sign, unsigned) = match text.as_bytes()[0] {
        b'-' => (-1.0, &text[1..]),
        b'+' => (1.0, &text[1..]),
        _ => (1.0, text),
    };
    if unsigned == "Infinity" {
        return Some(sign * f64::INFINITY);
    }
    for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(digits) = text.strip_prefix(prefix) {
            if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
                return None;
            }
            return Some(
                digits.chars().fold(0.0, |n, c| n * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0))),
            );
        }
    }
    let literal = unsigned.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-'))
        && unsigned.bytes().any(|b| b.is_ascii_digit());
    if !literal {
        return None;
    }
    text.parse::<f64>().ok()
}

#[cfg(test)]
mod tests {
    use super::parse_number;

    #[test]
    fn parses_numbers_as_node_does() {
        let rows: Vec<(String, Option<String>)> =
            serde_json::from_str(include_str!("../../tests/fixtures/js/number-parsing.json")).unwrap();
        for (text, expected) in rows {
            let ours = parse_number(&text).map(|x| {
                if x.is_infinite() {
                    if x > 0.0 { "Infinity".to_owned() } else { "-Infinity".to_owned() }
                } else {
                    super::super::number_to_string(x)
                }
            });
            assert_eq!(ours, expected, "{text:?}");
        }
    }
}

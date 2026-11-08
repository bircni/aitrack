/// JavaScript's `\s` and `String.prototype.trim` set: Unicode spaces, line terminators and the BOM, not NEL.
#[must_use]
pub fn is_space(c: char) -> bool {
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

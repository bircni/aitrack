//! Numbers as 4.x prints them: `toFixed`, `toLocaleString('en-US')` and the K/M/B token scale.

use crate::js::number::shortest_digits;
use crate::js::number_to_string;

/// `x.toFixed(digits)`: rounded from the exact binary value, an exact tie going away from zero.
pub fn to_fixed(x: f64, digits: usize) -> String {
    if !x.is_finite() || x.abs() >= 1e21 {
        return number_to_string(x);
    }
    let exact = format!("{:.1100}", x.abs());
    let (int, frac) = exact.split_once('.').expect("a fractional part was asked for");
    let mut kept = format!("{int}{}", &frac[..digits]).into_bytes();
    if frac.as_bytes()[digits] >= b'5' {
        increment(&mut kept);
    }
    let sign = if x < 0.0 { "-" } else { "" };
    with_point(sign, &kept, digits)
}

/// `x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })`: ICU rounds
/// the shortest decimal rather than the binary value, half away from zero, and groups thousands.
pub fn en_us_2dp(x: f64) -> String {
    if x == 0.0 {
        return "0.00".to_owned();
    }
    let (digits, point) = shortest_digits(x.abs());
    let (int, frac) = match usize::try_from(point) {
        Ok(point) if point >= digits.len() => (format!("{digits}{}", "0".repeat(point - digits.len())), String::new()),
        Ok(point) => (digits[..point].to_owned(), digits[point..].to_owned()),
        Err(_) => ("0".to_owned(), format!("{}{digits}", "0".repeat(point.unsigned_abs() as usize))),
    };
    let frac = format!("{frac}000");
    let mut kept = format!("{int}{}", &frac[..2]).into_bytes();
    if frac.as_bytes()[2] >= b'5' {
        increment(&mut kept);
    }
    let text = with_point("", &kept, 2);
    let (int, cents) = text.split_once('.').expect("two decimals");
    let int = int.trim_start_matches('0');
    let sign = if x < 0.0 { "-" } else { "" };
    format!("{sign}{}.{cents}", group_thousands(if int.is_empty() { "0" } else { int }))
}

/// Adds one to a decimal digit string, growing it on a carry out of the top digit.
fn increment(digits: &mut Vec<u8>) {
    for digit in digits.iter_mut().rev() {
        if *digit == b'9' {
            *digit = b'0';
        } else {
            *digit += 1;
            return;
        }
    }
    digits.insert(0, b'1');
}

fn with_point(sign: &str, digits: &[u8], decimals: usize) -> String {
    let text = std::str::from_utf8(digits).expect("ASCII digits");
    let padded = if text.len() <= decimals {
        format!("{}{text}", "0".repeat(decimals + 1 - text.len()))
    } else {
        text.to_owned()
    };
    let (int, frac) = padded.split_at(padded.len() - decimals);
    if decimals == 0 { format!("{sign}{int}") } else { format!("{sign}{int}.{frac}") }
}

fn group_thousands(int: &str) -> String {
    let mut out = String::with_capacity(int.len() + int.len() / 3);
    for (i, c) in int.chars().enumerate() {
        if i > 0 && (int.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// Whether rounding at `divisor` lands on 1000, past what the unit holds: 999 999 is "1.0M", not "1000.0K".
fn rounds_past_unit(n: f64, divisor: f64) -> bool {
    to_fixed(n / divisor, 1).parse::<f64>().is_ok_and(|x| x >= 1000.0)
}

/// Tokens on the K/M/B scale.
pub fn fmt(n: f64) -> String {
    if n >= 1e9 || rounds_past_unit(n, 1e6) {
        format!("{}B", to_fixed(n / 1e9, 2))
    } else if n >= 1e6 || rounds_past_unit(n, 1e3) {
        format!("{}M", to_fixed(n / 1e6, 1))
    } else if n >= 1e3 {
        format!("{}K", to_fixed(n / 1e3, 1))
    } else {
        number_to_string(n)
    }
}

/// A USD amount; missing or non-positive shows as an em dash.
pub fn fmt_usd(n: Option<f64>) -> String {
    match n {
        Some(n) if n > 0.0 => fmt_usd_cost(n),
        _ => "—".to_owned(),
    }
}

/// A USD amount known to exist; zero shows as $0.00.
pub fn fmt_usd_cost(n: f64) -> String {
    if n > 0.0 && n < 0.01 { "<$0.01".to_owned() } else { format!("${}", en_us_2dp(n)) }
}

/// Pads to `width` UTF-16 units, as `String.length` counts.
pub fn pad(value: &str, width: usize, left: bool) -> String {
    let len = value.encode_utf16().count();
    if len >= width {
        return value.to_owned();
    }
    let padding = " ".repeat(width - len);
    if left { format!("{value}{padding}") } else { format!("{padding}{value}") }
}

/// The footnote naming models left out of a cost, or `None` when every model was priced.
pub fn unpriced_footnote(models: &[String]) -> Option<String> {
    (!models.is_empty()).then(|| format!("Unpriced models: {}", models.join(", ")))
}

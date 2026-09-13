//! Formatting utilities for numbers and USD amounts.

/// Whether rounding at `divisor` lands on 1000, i.e. past what the unit holds.
/// toFixed rounds up, so 999_999 scaled by 1e3 gives "1000.0" — which has to be
/// shown as "1.0M" rather than "1000.0K".
fn rounds_past_unit(n: f64, divisor: f64) -> bool {
    let scaled = n / divisor;
    let rounded = (scaled * 10.0).round() / 10.0;
    rounded >= 1000.0
}

pub fn fmt(n: u64) -> String {
    let n_f = n as f64;
    if n >= 1_000_000_000 || rounds_past_unit(n_f, 1e6) {
        format!("{:.2}B", n_f / 1e9)
    } else if n >= 1_000_000 || rounds_past_unit(n_f, 1e3) {
        format!("{:.1}M", n_f / 1e6)
    } else if n >= 1_000 {
        format!("{:.1}K", n_f / 1e3)
    } else {
        n.to_string()
    }
}

/// Format a USD amount. Null/undefined/non-positive values render as an em dash.
pub fn fmt_usd(n: Option<f64>) -> String {
    match n {
        Some(v) if v > 0.0 => {
            if v < 0.01 {
                "<$0.01".to_string()
            } else {
                format!("${:.2}", v)
            }
        }
        _ => "—".to_string(),
    }
}

/// Format a USD amount when cost is known to exist (e.g. heatmap stats). Zero shows as $0.00.
pub fn fmt_usd_cost(n: f64) -> String {
    if n > 0.0 && n < 0.01 {
        "<$0.01".to_string()
    } else {
        format!("${:.2}", n)
    }
}

pub fn pad(value: &str, width: usize, align: &str) -> String {
    if value.len() >= width {
        return value.to_string();
    }
    let pad_string = " ".repeat(width - value.len());
    if align == "left" {
        format!("{}{}", value, pad_string)
    } else {
        format!("{}{}", pad_string, value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fmt() {
        assert_eq!(fmt(500), "500");
        assert_eq!(fmt(1_500), "1.5K");
        assert_eq!(fmt(1_500_000), "1.5M");
    }

    #[test]
    fn test_fmt_usd() {
        assert_eq!(fmt_usd(Some(10.5)), "$10.50");
        assert_eq!(fmt_usd(Some(0.005)), "<$0.01");
        assert_eq!(fmt_usd(None), "—");
        assert_eq!(fmt_usd(Some(0.0)), "—");
    }

    #[test]
    fn test_pad() {
        assert_eq!(pad("hi", 5, "left"), "hi   ");
        assert_eq!(pad("hi", 5, "right"), "   hi");
        assert_eq!(pad("hello", 3, "left"), "hello");
    }
}

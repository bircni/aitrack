use std::cmp::Ordering;

/// ASCII in the order `String.prototype.localeCompare` (ICU root) sorts it; a letter's two cases share a slot.
const ORDER: &str = "\t\n\u{b}\u{c}\r _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789\
                     aAbBcCdDeEfFgGhHiIjJkKlLmMnNoOpPqQrRsStTuUvVwWxXyYzZ";

/// `a.localeCompare(b)` for the strings aitrack sorts: project names, provider keys, model ids, dates.
///
/// Control characters are ignored, punctuation sorts before digits, digits before letters, and letter
/// case only breaks ties. Non-ASCII characters sort after ASCII by code point, where ICU would fold accents.
#[must_use]
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    let (a, b) = (weights(a), weights(b));
    let primary = |w: &[(u32, u8)]| w.iter().map(|&(p, _)| p).collect::<Vec<_>>();
    let tertiary = |w: &[(u32, u8)]| w.iter().map(|&(_, t)| t).collect::<Vec<_>>();
    primary(&a).cmp(&primary(&b)).then_with(|| tertiary(&a).cmp(&tertiary(&b)))
}

fn weights(s: &str) -> Vec<(u32, u8)> {
    s.chars()
        .filter_map(|c| {
            if c.is_ascii() {
                let index = ORDER.find(c)?; // Control characters are not listed: ignorable.
                let index = u32::try_from(index).expect("ORDER is short");
                if c.is_ascii_alphabetic() {
                    let letter = index - letter_start();
                    Some((letter_start() + letter / 2, u8::from(c.is_ascii_uppercase())))
                } else {
                    Some((index, 0))
                }
            } else {
                Some((0x100 + u32::from(c), 0))
            }
        })
        .collect()
}

fn letter_start() -> u32 {
    u32::try_from(ORDER.find('a').expect("ORDER lists letters")).expect("ORDER is short")
}

#[cfg(test)]
mod tests {
    use super::locale_compare;

    #[test]
    fn matches_node_for_every_ascii_fixture_pair() {
        let rows: Vec<(String, String, i8)> =
            serde_json::from_str(include_str!("../../tests/fixtures/js/collation.json")).unwrap();
        let mut checked = 0;
        for (a, b, expected) in rows {
            if !(a.is_ascii() && b.is_ascii()) {
                continue; // Accents fold in ICU; aitrack's sorted keys are ASCII.
            }
            assert_eq!(locale_compare(&a, &b) as i8, expected, "{a:?} vs {b:?}");
            checked += 1;
        }
        assert!(checked > 2000, "only {checked} ASCII pairs");
    }
}

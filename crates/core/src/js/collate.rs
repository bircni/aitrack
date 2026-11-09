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

/// Where `a` sits in ORDER; a test pins it.
const LETTER_START: u32 = 48;

fn weights(s: &str) -> Vec<(u32, u8)> {
    s.chars()
        .filter_map(|c| {
            if c.is_ascii() {
                let index = ORDER.find(c)?; // Control characters are not listed: ignorable.
                let index = u32::try_from(index).ok()?;
                if c.is_ascii_alphabetic() {
                    let letter = index - LETTER_START;
                    Some((LETTER_START + letter / 2, u8::from(c.is_ascii_uppercase())))
                } else {
                    Some((index, 0))
                }
            } else {
                Some((0x100 + u32::from(c), 0))
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{LETTER_START, ORDER, locale_compare};

    #[test]
    fn letters_start_where_order_lists_a() {
        assert_eq!(ORDER.find('a').map(|i| u32::try_from(i).unwrap()), Some(LETTER_START));
    }

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

use std::fs::File;
use std::io::{self, Read};
use std::path::Path;

use memchr::memmem;

use crate::fs::is_missing_path;

pub const CHUNK_BYTES: usize = 4 * 1024 * 1024;

/// Which lines a reader needs. Lines holding none of `needles` as raw bytes are never parsed:
/// in Claude and Codex logs they are most of the bytes.
pub struct Filter<'a, T> {
    pub needles: &'a [&'a str],
    pub carry: Option<Carry<'a, T>>,
}

/// State that skipped lines still carry, such as Claude's `cwd`.
///
/// A record for which `holds` is true replaces the state entirely, so before a record that does not
/// hold, the last skipped line that does is passed on first.
pub struct Carry<'a, T> {
    pub needle: &'a str,
    pub holds: &'a dyn Fn(&T) -> bool,
}

/// Every object line of a JSONL file that `filter` selects, parsed by `parse`, in file order.
/// A missing file has no lines.
///
/// # Errors
///
/// When the file cannot be read.
pub fn for_each_object<T>(
    path: &Path,
    filter: &Filter<'_, T>,
    chunk_bytes: usize,
    parse: impl Fn(&[u8]) -> Option<T>,
    mut visit: impl FnMut(T),
) -> io::Result<()> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if is_missing_path(&error) => return Ok(()), // Deleted since listing.
        Err(error) => return Err(error),
    };
    let size = usize::try_from(file.metadata()?.len()).unwrap_or(usize::MAX);
    let mut buffer = vec![0u8; size.saturating_add(1).max(1024).min(chunk_bytes.max(1))];
    let mut filled = 0;
    loop {
        if filled == buffer.len() {
            buffer.resize(buffer.len() * 2, 0); // A line longer than the buffer.
        }
        let read = file.read(&mut buffer[filled..])?;
        filled += read;
        let is_last = read == 0;
        if !is_last && filled < buffer.len() {
            continue; // Fill the chunk, so a file that fits is one pass.
        }
        let end = if is_last { filled } else { memchr::memrchr(b'\n', &buffer[..filled]).map_or(0, |i| i + 1) };
        if end > 0 {
            matching_lines(&buffer[..end], filter, is_last, &parse, &mut visit);
            buffer.copy_within(end..filled, 0);
            filled -= end;
        }
        if is_last {
            return Ok(());
        }
    }
}

fn matching_lines<T>(
    view: &[u8],
    filter: &Filter<'_, T>,
    is_last: bool,
    parse: &impl Fn(&[u8]) -> Option<T>,
    visit: &mut impl FnMut(T),
) {
    if filter.needles.is_empty() {
        let mut start = 0;
        while start < view.len() {
            let end = line_end(view, start, view.len());
            if let Some(record) = parse_line(view, start, end, parse) {
                visit(record);
            }
            start = end + 1;
        }
        return;
    }
    let finders: Vec<memmem::Finder<'_>> = filter.needles.iter().map(|n| memmem::Finder::new(n.as_bytes())).collect();
    let mut next: Vec<Option<usize>> = finders.iter().map(|f| f.find(view)).collect();
    let mut search_from = 0;
    let mut gap_start = 0;
    loop {
        let mut hit: Option<usize> = None;
        for (finder, at) in finders.iter().zip(next.iter_mut()) {
            if at.is_some_and(|i| i < search_from) {
                *at = view.get(search_from..).and_then(|rest| finder.find(rest)).map(|i| i + search_from);
            }
            if let Some(i) = *at {
                hit = Some(hit.map_or(i, |h| h.min(i)));
            }
        }
        let Some(hit) = hit else { break };
        let start = line_start(view, hit);
        let end = line_end(view, hit, view.len());
        search_from = end + 1;
        let Some(record) = parse_line(view, start, end, parse) else { continue }; // Left in the gap.
        if let Some(carry) = &filter.carry
            && start > gap_start
            && !(carry.holds)(&record)
            && let Some(carrier) = last_carrier(view, gap_start, start, carry, parse)
        {
            visit(carrier);
        }
        gap_start = search_from;
        visit(record);
    }
    // The next chunk cannot look back into this one, so its carrier is resolved now.
    if !is_last
        && let Some(carry) = &filter.carry
        && gap_start < view.len()
        && let Some(carrier) = last_carrier(view, gap_start, view.len(), carry, parse)
    {
        visit(carrier);
    }
}

/// The last line in `[from, to)` that carries state, parsed.
fn last_carrier<T>(
    view: &[u8],
    from: usize,
    to: usize,
    carry: &Carry<'_, T>,
    parse: &impl Fn(&[u8]) -> Option<T>,
) -> Option<T> {
    let needle = carry.needle.as_bytes();
    let finder = memmem::FinderRev::new(needle);
    let gap = &view[from..to];
    let mut at = gap.len();
    while at > 0 {
        let window = &gap[..(at - 1 + needle.len()).min(gap.len())];
        let hit = finder.rfind(window)?;
        let start = line_start(view, from + hit);
        if let Some(record) = parse_line(view, start, line_end(view, from + hit, to), parse)
            && (carry.holds)(&record)
        {
            return Some(record);
        }
        at = start - from;
    }
    None
}

fn parse_line<T>(view: &[u8], start: usize, end: usize, parse: &impl Fn(&[u8]) -> Option<T>) -> Option<T> {
    (start < end).then(|| parse(&view[start..end])).flatten()
}

fn line_start(view: &[u8], index: usize) -> usize {
    memchr::memrchr(b'\n', &view[..index]).map_or(0, |i| i + 1)
}

fn line_end(view: &[u8], index: usize, limit: usize) -> usize {
    memchr::memchr(b'\n', &view[index.min(view.len())..]).map_or(limit, |i| (index + i).min(limit))
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;
    use crate::js::parse_object;

    fn collect(text: &str, filter: &Filter<'_, Value>, chunk: usize) -> Vec<Value> {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("log.jsonl");
        std::fs::write(&path, text).unwrap();
        let mut out = Vec::new();
        for_each_object(&path, filter, chunk, parse_object::<Value>, |v| out.push(v)).unwrap();
        out
    }

    const LOG: &str = concat!(
        "{\"cwd\":\"/a\"}\n",
        "{\"usage\":1}\n",
        "{\"cwd\":\"/b\"}\n",
        "{\"cwd\":\"/c\",\"skip\":true}\n",
        "not json \"usage\"\n",
        "{\"usage\":2}\n",
        "{\"cwd\":\"/d\",\"usage\":3}\n",
        "[\"usage\"]\n",
        "{\"usage\":4}\n",
        "{\"cwd\":\"/e\"}\n",
        "{\"usage\":5,\"trunc"
    );

    fn holds_cwd(v: &Value) -> bool {
        v.get("cwd").is_some_and(Value::is_string) && v.get("skip").is_none()
    }

    #[test]
    fn yields_needle_lines_with_the_last_carrier_before_them() {
        let carry = Carry { needle: "\"cwd\"", holds: &holds_cwd };
        let filter = Filter { needles: &["\"usage\""], carry: Some(carry) };
        let lines: Vec<String> = collect(LOG, &filter, CHUNK_BYTES).iter().map(Value::to_string).collect();
        assert_eq!(
            lines,
            [
                r#"{"cwd":"/a"}"#,
                r#"{"usage":1}"#,
                r#"{"cwd":"/b"}"#,
                r#"{"usage":2}"#,
                r#"{"cwd":"/d","usage":3}"#,
                r#"{"usage":4}"#
            ]
        );
        let all = Filter::<Value> { needles: &[], carry: None };
        assert_eq!(collect(LOG, &all, CHUNK_BYTES).len(), 8);
    }

    #[test]
    fn results_do_not_depend_on_the_chunk_size() {
        let carry = Carry { needle: "\"cwd\"", holds: &holds_cwd };
        let filter = Filter { needles: &["\"usage\""], carry: Some(carry) };
        let whole = collect(LOG, &filter, CHUNK_BYTES);
        let apply = |lines: &[Value]| {
            let mut cwd = Value::Null;
            lines
                .iter()
                .filter_map(|v| {
                    if holds_cwd(v) {
                        cwd = v["cwd"].clone();
                    }
                    v.get("usage").map(|u| (u.clone(), cwd.clone()))
                })
                .collect::<Vec<_>>()
        };
        for chunk in [1, 7, 16, 33, 64, 100] {
            assert_eq!(apply(&collect(LOG, &filter, chunk)), apply(&whole), "chunk {chunk}");
        }
    }
}

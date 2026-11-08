//! Per-file parse cache and per-provider merged snapshot, so an unchanged corpus costs a stat per file.
//!
//! Format 8 is Rust's own; files are keyed by format, version and pricing, so 4.x caches sit beside
//! these untouched and each side keeps the newest file of the other.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use sha2::{Digest, Sha256};

use super::provider::{CachedMessage, CachedParse, Messages};
use crate::data::day_map::Attribution;
use crate::data::types::{DayEntry, DayMap, TokenCounts};
use crate::day::Day;
use crate::fs::write_file_atomic;
use crate::hex;

/// Bump when the cached shape or baked-in cost changes; old caches are rebuilt, not migrated.
const CACHE_FORMAT: u32 = 8;
const STALE_SIBLING: Duration = Duration::from_hours(7 * 24);
/// A transcript written this recently is likely to be appended to again.
const ACTIVE_FILE: Duration = Duration::from_mins(10);

/// What a cached entry is valid for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct FileStamp {
    pub mtime_ns: u64,
    pub size: u64,
}

impl FileStamp {
    #[must_use]
    pub fn of(path: &Path) -> Option<Self> {
        let meta = std::fs::metadata(path).ok()?;
        let mtime = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
        Some(Self { mtime_ns: u64::try_from(mtime.as_nanos()).ok()?, size: meta.len() })
    }

    fn modified(self) -> SystemTime {
        UNIX_EPOCH + Duration::from_nanos(self.mtime_ns)
    }
}

/// Where caches live and what keys them; `None` dir disables caching (`AITRACK_NO_CACHE`).
#[derive(Clone, Debug)]
pub struct CacheContext {
    pub dir: Option<PathBuf>,
    pub version: String,
    pub pricing_fingerprint: String,
    pub timezone: String,
}

impl CacheContext {
    fn file_name(&self, name: &str) -> String {
        let key = Sha256::digest(format!("{CACHE_FORMAT}\0{}\0{}", self.version, self.pricing_fingerprint));
        format!("{name}-{}.json", &hex(&key)[..12])
    }
}

#[derive(Serialize, Deserialize)]
struct CacheFile {
    timezone: String,
    entries: IndexMap<String, CacheEntry>,
}

#[derive(Clone, Serialize, Deserialize)]
struct CacheEntry {
    stamp: FileStamp,
    days: Vec<(Day, DayEntry)>,
    keys: Vec<String>,
    /// Left encoded until a merge needs it: only a file sharing keys with an earlier one does.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    messages: Option<Box<RawValue>>,
}

/// Messages over a string table; `key` indexes the entry's keys, or the table as `-(i + 1)`.
#[derive(Serialize, Deserialize)]
struct EncodedMessages {
    strings: Vec<String>,
    rows: Vec<EncodedMessage>,
}

#[derive(Serialize, Deserialize)]
struct EncodedMessage {
    key: Option<i64>,
    date: u32,
    model: u32,
    project: u32,
    cwd: Option<u32>,
    counts: TokenCounts,
}

#[expect(clippy::expect_used, reason = "a cache holds far fewer than 2^31 strings and our own types serialize")]
fn encode_messages(messages: &[CachedMessage], keys: &[String]) -> Box<RawValue> {
    let mut strings: Vec<String> = Vec::new();
    let mut indexes: HashMap<String, u32> = HashMap::new();
    let mut intern = |value: &str| -> u32 {
        *indexes.entry(value.to_owned()).or_insert_with(|| {
            strings.push(value.to_owned());
            u32::try_from(strings.len() - 1).expect("fewer than 2^32 strings")
        })
    };
    let key_indexes: HashMap<&str, i64> =
        keys.iter().enumerate().map(|(i, k)| (k.as_str(), i64::try_from(i).expect("small"))).collect();
    let rows = messages
        .iter()
        .map(|m| EncodedMessage {
            key: m
                .key
                .as_deref()
                .map(|key| key_indexes.get(key).copied().unwrap_or_else(|| -i64::from(intern(key)) - 1)),
            date: intern(&m.date.to_string()),
            model: intern(&m.model),
            project: intern(&m.attribution.project),
            cwd: m.attribution.cwd.as_deref().map(&mut intern),
            counts: m.counts.clone(),
        })
        .collect();
    let json = serde_json::to_string(&EncodedMessages { strings, rows }).expect("messages serialize");
    RawValue::from_string(json).expect("valid JSON")
}

/// `None` when the blob is corrupt, so the file's days count as a whole.
pub(super) fn decode_messages(raw: &RawValue, keys: &[String]) -> Option<Vec<CachedMessage>> {
    let encoded: EncodedMessages = serde_json::from_str(raw.get()).ok()?;
    let text = |i: u32| encoded.strings.get(i as usize).cloned();
    encoded
        .rows
        .iter()
        .map(|row| {
            let key = match row.key {
                None => None,
                Some(i) if i >= 0 => Some(keys.get(usize::try_from(i).ok()?)?.clone()),
                Some(i) => Some(text(u32::try_from(-i - 1).ok()?)?),
            };
            Some(CachedMessage {
                key,
                date: Day::parse(&text(row.date)?)?,
                model: text(row.model)?,
                counts: row.counts.clone(),
                attribution: Attribution {
                    project: text(row.project)?,
                    cwd: match row.cwd {
                        Some(i) => Some(text(i)?),
                        None => None,
                    },
                },
            })
        })
        .collect()
}

fn to_parse(entry: &CacheEntry) -> CachedParse {
    CachedParse {
        days: entry.days.iter().cloned().collect(),
        keys: entry.keys.clone(),
        messages: entry.messages.clone().map(Messages::Encoded),
    }
}

/// One provider's per-file cache for one run.
pub struct ParseCache {
    path: Option<PathBuf>,
    name: String,
    timezone: String,
    previous: IndexMap<String, CacheEntry>,
    next: IndexMap<String, CacheEntry>,
    missed: IndexMap<String, FileStamp>,
    recorded: Vec<FileStamp>,
}

impl ParseCache {
    #[must_use]
    pub fn open(context: &CacheContext, name: &str) -> Self {
        let path = context.dir.as_ref().map(|dir| dir.join(context.file_name(name)));
        let previous = path.as_deref().map(|p| read_cache_file(p, &context.timezone)).unwrap_or_default();
        Self {
            path,
            name: name.to_owned(),
            timezone: context.timezone.clone(),
            previous,
            next: IndexMap::new(),
            missed: IndexMap::new(),
            recorded: Vec::new(),
        }
    }

    /// The cached parse for `file`, or `None` when absent or stale.
    pub fn lookup(&mut self, file: &Path, stamp: Option<FileStamp>) -> Option<CachedParse> {
        let stamp = stamp?;
        let key = file.to_string_lossy().into_owned();
        if self.path.is_none() {
            self.missed.insert(key, stamp);
            return None;
        }
        match self.previous.get(&key) {
            Some(entry) if entry.stamp == stamp => {
                let parse = to_parse(entry);
                self.next.insert(key, entry.clone());
                Some(parse)
            }
            _ => {
                self.missed.insert(key, stamp); // Before the parse, so a write during it reads as a change next run.
                None
            }
        }
    }

    pub fn record(&mut self, file: &Path, parse: &CachedParse) {
        let key = file.to_string_lossy().into_owned();
        let Some(stamp) = self.missed.get(&key).copied().or_else(|| FileStamp::of(file)) else { return };
        self.recorded.push(stamp);
        if self.path.is_none() {
            return;
        }
        let messages = match &parse.messages {
            Some(Messages::Decoded(messages)) => Some(encode_messages(messages, &parse.keys)),
            Some(Messages::Encoded(raw)) => Some(raw.clone()),
            None => None,
        };
        let days = parse.days.iter().map(|(d, e)| (*d, e.clone())).collect();
        self.next.insert(key, CacheEntry { stamp, days, keys: parse.keys.clone(), messages });
    }

    /// Total size of the files looked up and missed so far.
    #[must_use]
    pub fn missed_bytes(&self) -> u64 {
        self.missed.values().map(|s| s.size).sum()
    }

    /// Persist. Entries never looked up this run are dropped, so deleted logs age out.
    pub fn save(self) {
        let Some(path) = &self.path else { return };
        let evicted = self.previous.keys().any(|file| !self.next.contains_key(file));
        if self.recorded.is_empty() && !evicted {
            return;
        }
        let update = !evicted && !self.previous.is_empty();
        if update && is_cheaper_to_rescan(&self.recorded, FileStamp::of(path)) {
            return;
        }
        let file = CacheFile { timezone: self.timezone.clone(), entries: self.next };
        let Ok(json) = serde_json::to_string(&file) else { return };
        if write_file_atomic(path, &json, None).is_ok() {
            prune_siblings(path, &self.name);
        }
    }
}

/// Only live transcripts changed, and rescanning them next run costs less than rewriting all of history.
fn is_cheaper_to_rescan(recorded: &[FileStamp], cache_file: Option<FileStamp>) -> bool {
    let Some(cache_file) = cache_file else { return false };
    let active_since = SystemTime::now() - ACTIVE_FILE;
    let mut bytes = 0;
    for stamp in recorded {
        if stamp.modified() < active_since {
            return false;
        }
        bytes += stamp.size;
    }
    bytes < cache_file.size
}

fn read_cache_file(path: &Path, timezone: &str) -> IndexMap<String, CacheEntry> {
    let Ok(text) = std::fs::read_to_string(path) else { return IndexMap::new() }; // Only costs a full parse.
    match serde_json::from_str::<CacheFile>(&text) {
        Ok(file) if file.timezone == timezone => file.entries,
        _ => IndexMap::new(),
    }
}

/// Keeps the newest other keyed file, which another live writer (CLI, app, or 4.x) refreshes on each save.
fn prune_siblings(current: &Path, name: &str) {
    let Some(dir) = current.parent() else { return };
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let current_name = current.file_name().map(|n| n.to_string_lossy().into_owned());
    let mut others: Vec<(PathBuf, SystemTime)> = entries
        .filter_map(Result::ok)
        .filter(|entry| {
            let file = entry.file_name().to_string_lossy().into_owned();
            Some(&file) != current_name.as_ref() && is_keyed_sibling(&file, name)
        })
        .map(|entry| (entry.path(), entry.metadata().and_then(|m| m.modified()).unwrap_or(UNIX_EPOCH)))
        .collect();
    others.sort_by_key(|other| std::cmp::Reverse(other.1));
    for (path, _) in others.iter().skip(1) {
        let _ = std::fs::remove_file(path);
    }
    let legacy = dir.join(format!("{name}.json"));
    let stale = std::fs::metadata(&legacy)
        .and_then(|m| m.modified())
        .is_ok_and(|modified| SystemTime::now().duration_since(modified).unwrap_or_default() > STALE_SIBLING);
    if stale {
        let _ = std::fs::remove_file(legacy);
    }
}

/// `^<name>-[0-9a-f]+\.json$`, the pattern 4.x prunes with.
fn is_keyed_sibling(file: &str, name: &str) -> bool {
    file.strip_prefix(name)
        .and_then(|rest| rest.strip_prefix('-'))
        .and_then(|rest| rest.strip_suffix(".json"))
        .is_some_and(|key| !key.is_empty() && key.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

/// One provider's merged result for an exact list of source files.
pub struct MergedSnapshot {
    path: Option<PathBuf>,
    name: String,
    sources: String,
}

#[derive(Serialize, Deserialize)]
struct SnapshotFile {
    sources: String,
    days: Vec<(Day, DayEntry)>,
}

impl MergedSnapshot {
    #[must_use]
    pub fn open(context: &CacheContext, name: &str, files: &[PathBuf], stamps: &[Option<FileStamp>]) -> Self {
        let name = format!("{name}-merged");
        let mut hash = Sha256::new();
        hash.update(context.timezone.as_bytes());
        for (file, stamp) in files.iter().zip(stamps) {
            let (mtime, size) = stamp.map_or_else(
                || ("none".to_owned(), "none".to_owned()),
                |s| (s.mtime_ns.to_string(), s.size.to_string()),
            );
            hash.update(format!("\0{}\0{mtime}\0{size}", file.to_string_lossy()).as_bytes());
        }
        let path =
            (!files.is_empty()).then(|| context.dir.as_ref().map(|dir| dir.join(context.file_name(&name)))).flatten();
        Self { path, name, sources: hex(&hash.finalize()) }
    }

    #[must_use]
    pub fn read(&self) -> Option<DayMap> {
        let text = std::fs::read_to_string(self.path.as_ref()?).ok()?;
        let file: SnapshotFile = serde_json::from_str(&text).ok()?;
        (file.sources == self.sources).then(|| file.days.into_iter().collect())
    }

    pub fn write(&self, days: &DayMap) {
        let Some(path) = &self.path else { return };
        let file =
            SnapshotFile { sources: self.sources.clone(), days: days.iter().map(|(d, e)| (*d, e.clone())).collect() };
        if let Ok(json) = serde_json::to_string(&file)
            && write_file_atomic(path, &json, None).is_ok()
        {
            prune_siblings(path, &self.name);
        }
    }
}

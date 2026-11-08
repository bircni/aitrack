//! A provider's days from its log roots: listing, the parse cache, scanning, pricing and merging.

use std::io;
use std::path::PathBuf;

use super::cache::{CacheContext, FileStamp, MergedSnapshot, ParseCache};
use super::claude_scan::scan_claude_file;
use super::codex_scan::scan_codex_file;
use super::jsonl::CHUNK_BYTES;
use super::paths::{claude_home_dirs, codex_home_dirs, list_unique_source_files, resolve_source_roots};
use super::pool::scan_all;
use super::project::ProjectResolver;
use super::provider::{
    CachedParse, Pricing, finish_claude_scan, finish_codex_scan, merge_claude_parsed, merge_codex_parsed,
};
use crate::Core;
use crate::data::project::normalize_remote_url;
use crate::data::types::DayMap;

pub fn claude_roots(core: &Core) -> Vec<PathBuf> {
    let config = core.try_load_config();
    let defaults: Vec<PathBuf> =
        claude_home_dirs(&core.env, false).into_iter().map(|dir| dir.join("projects")).collect();
    resolve_source_roots(
        core.env.var("AITRACK_CLAUDE_PROJECTS_DIRS"),
        config.as_ref().and_then(|c| c.claude_projects_dir.as_deref()),
        &defaults,
    )
}

pub fn codex_roots(core: &Core) -> Vec<PathBuf> {
    let config = core.try_load_config();
    let defaults: Vec<PathBuf> =
        codex_home_dirs(&core.env, false).into_iter().map(|dir| dir.join("sessions")).collect();
    resolve_source_roots(
        core.env.var("AITRACK_CODEX_SESSION_DIRS"),
        config.as_ref().and_then(|c| c.codex_sessions_dir.as_deref()),
        &defaults,
    )
}

/// Caches live in `~/.config/aitrack/cache` unless `AITRACK_NO_CACHE` is set.
pub fn cache_context(core: &Core, pricing: &dyn Pricing) -> CacheContext {
    CacheContext {
        dir: core.env.var("AITRACK_NO_CACHE").is_none().then(|| core.paths.cache.clone()),
        version: crate::VERSION.to_owned(),
        pricing_fingerprint: pricing.fingerprint(),
        timezone: core.clock.zone_name().to_owned(),
    }
}

#[derive(Clone, Copy)]
enum Kind {
    Claude,
    Codex,
}

impl Kind {
    const fn name(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }
}

pub fn read_claude_days(core: &Core, pricing: &dyn Pricing, resolver: &dyn ProjectResolver) -> io::Result<DayMap> {
    read_days(core, Kind::Claude, &claude_roots(core), pricing, resolver)
}

pub fn read_codex_days(core: &Core, pricing: &dyn Pricing, resolver: &dyn ProjectResolver) -> io::Result<DayMap> {
    read_days(core, Kind::Codex, &codex_roots(core), pricing, resolver)
}

fn read_days(
    core: &Core,
    kind: Kind,
    roots: &[PathBuf],
    pricing: &dyn Pricing,
    resolver: &dyn ProjectResolver,
) -> io::Result<DayMap> {
    let context = cache_context(core, pricing);
    // Stamped before any scan, so a write during one reads as a change next run.
    let files = list_unique_source_files(roots)?;
    let stamps: Vec<Option<FileStamp>> = files.iter().map(|f| FileStamp::of(f)).collect();
    let snapshot = MergedSnapshot::open(&context, kind.name(), &files, &stamps);
    if let Some(days) = snapshot.read() {
        return Ok(days);
    }
    let mut cache = ParseCache::open(&context, kind.name());
    let mut parsed: Vec<Option<CachedParse>> = files.iter().zip(&stamps).map(|(f, s)| cache.lookup(f, *s)).collect();
    let missed: Vec<PathBuf> = files.iter().zip(&parsed).filter(|(_, p)| p.is_none()).map(|(f, _)| f.clone()).collect();
    let clock = &core.clock;
    let scans: Vec<io::Result<CachedParse>> = match kind {
        Kind::Claude => {
            let scanned = scan_all(&missed, cache.missed_bytes(), |f| scan_claude_file(f, clock, CHUNK_BYTES));
            let cwds = scanned.iter().flatten().flatten().filter_map(|m| m.cwd.as_deref());
            resolver.prefetch(&unique(cwds));
            scanned.into_iter().map(|scan| scan.map(|scanned| finish_claude_scan(scanned, pricing, resolver))).collect()
        }
        Kind::Codex => {
            let scanned = scan_all(&missed, cache.missed_bytes(), |f| scan_codex_file(f, clock, CHUNK_BYTES));
            let unknown = scanned
                .iter()
                .flatten()
                .filter(|s| s.repository_url.as_deref().and_then(normalize_remote_url).is_none());
            resolver.prefetch(&unique(unknown.filter_map(|s| s.cwd.as_deref())));
            scanned.into_iter().map(|scan| scan.map(|scan| finish_codex_scan(&scan, pricing, resolver))).collect()
        }
    };
    let mut scans = missed.iter().zip(scans);
    for slot in &mut parsed {
        if slot.is_none() {
            let (file, parse) = scans.next().expect("one scan per missed file");
            let parse = parse?;
            cache.record(file, &parse);
            *slot = Some(parse);
        }
    }
    cache.save();
    let parsed: Vec<CachedParse> = parsed.into_iter().flatten().collect();
    let days = match kind {
        Kind::Claude => merge_claude_parsed(&parsed),
        Kind::Codex => merge_codex_parsed(&parsed),
    };
    snapshot.write(&days);
    Ok(days)
}

fn unique<'a>(cwds: impl Iterator<Item = &'a str>) -> Vec<&'a str> {
    let mut seen = std::collections::HashSet::new();
    cwds.filter(|cwd| seen.insert(*cwd)).collect()
}

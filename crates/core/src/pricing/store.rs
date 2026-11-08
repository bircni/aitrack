//! The bundled tables with a complete, validated pack from the `pricing` branch laid over them.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use indexmap::IndexMap;
use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::catalog::{Catalog, parse_compact_catalog};
use super::model_pricing::ModelPricing;
use super::supplement::{Override, Overrides, Supplement, bundled_supplement, parse_supplement};
use crate::Locked;
use crate::env::Env;
use crate::fs::write_file_atomic;
use crate::http::{HttpClient, Request};
use crate::js::locale_compare;
use crate::time::{Clock, iso_millis};

const REFRESH_INTERVAL: jiff::SignedDuration = jiff::SignedDuration::from_hours(24);
const FAILURE_RETRY: jiff::SignedDuration = jiff::SignedDuration::from_mins(30);
const FETCH_TIMEOUT: Duration = Duration::from_secs(5);
const SOURCES: [&str; 4] = ["manifest", "supplement", "litellm", "modelsDev"];

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    etag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fetched_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    failed_at: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
struct CacheState {
    sources: IndexMap<String, SourceState>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RefreshResult {
    pub updated: bool,
    pub reason: String,
    pub updated_at: String,
    pub failed: bool,
    /// The active pack's manifest carries no checksums, so its content was not verified.
    pub unverified: bool,
}

struct Manifest {
    hashes: Option<IndexMap<String, String>>,
}

fn parse_manifest(value: &Value) -> Option<Manifest> {
    let files = value.get("files")?;
    let valid = value.get("schemaVersion").and_then(Value::as_f64) == Some(1.0)
        && value.get("updatedAt").and_then(Value::as_str).is_some_and(|t| Clock::system().parse_timestamp(t).is_some())
        && files.get("supplement").and_then(Value::as_str) == Some("supplement.json")
        && files.get("litellm").and_then(Value::as_str) == Some("litellm.json")
        && files.get("modelsDev").and_then(Value::as_str) == Some("models_dev.json");
    if !valid {
        return None;
    }
    let hashes = match value.get("hashes") {
        None => None,
        Some(hashes) => {
            let hashes = hashes.as_object()?;
            let mut out = IndexMap::new();
            for key in ["supplement", "litellm", "modelsDev"] {
                let hash = hashes.get(key)?.as_str()?;
                if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
                    return None;
                }
                out.insert(key.to_owned(), hash.to_owned());
            }
            Some(out)
        }
    };
    Some(Manifest { hashes })
}

fn parse_body(body: &str, hash: Option<&str>) -> Result<Value, String> {
    if let Some(hash) = hash {
        let digest = crate::hex(&Sha256::digest(body.as_bytes()));
        if digest != hash {
            return Err("hash mismatch".to_owned());
        }
    }
    serde_json::from_str(body).map_err(|e| e.to_string())
}

fn instant(text: Option<&str>) -> Option<Timestamp> {
    Clock::system().parse_timestamp(text?)
}

fn is_stale(state: Option<&SourceState>, now: Timestamp) -> bool {
    let since = |at: Option<Timestamp>| at.map(|at| now.duration_since(at));
    if let Some(failed) = since(instant(state.and_then(|s| s.failed_at.as_deref())))
        && failed < FAILURE_RETRY
    {
        return false;
    }
    since(instant(state.and_then(|s| s.fetched_at.as_deref()))).is_none_or(|age| age >= REFRESH_INTERVAL)
}

fn merge_overrides<P: Clone>(local: &Overrides<P>, remote: &Overrides<P>) -> Overrides<P> {
    let mut merged = local.clone();
    for (model, entries) in remote {
        let mut by_cutoff: IndexMap<String, Override<P>> = IndexMap::new();
        for entry in local.get(model).into_iter().flatten().chain(entries) {
            by_cutoff.insert(entry.before.clone(), entry.clone());
        }
        let mut list: Vec<Override<P>> = by_cutoff.into_values().collect();
        list.sort_by(|a, b| locale_compare(&a.before, &b.before));
        merged.insert(model.clone(), list);
    }
    merged
}

/// Remote rules in order, with each bundled-only rule kept ahead of the next shared, possibly broader one.
fn merge_rules<T: Clone>(local: &[T], remote: &[T], key: impl Fn(&T) -> &str) -> Vec<T> {
    let mut merged: Vec<T> = remote.to_vec();
    let remote_keys: std::collections::HashSet<&str> = remote.iter().map(&key).collect();
    for (index, rule) in local.iter().enumerate() {
        if remote_keys.contains(key(rule)) {
            continue;
        }
        let next = local[index + 1..].iter().find(|entry| remote_keys.contains(key(entry)));
        let position = next.map_or(merged.len(), |next| {
            merged.iter().position(|entry| key(entry) == key(next)).unwrap_or(merged.len())
        });
        merged.insert(position, rule.clone());
    }
    merged
}

fn merge_maps<V: Clone>(local: &IndexMap<String, V>, remote: &IndexMap<String, V>) -> IndexMap<String, V> {
    let mut merged = local.clone();
    for (key, value) in remote {
        merged.insert(key.clone(), value.clone());
    }
    merged
}

/// A newer remote supplement over the bundled one: pack build times do not guarantee every bundled entry exists remotely.
fn merge_supplement(local: &Supplement, remote: &Supplement) -> Supplement {
    let newer = match (instant(Some(&remote.updated_at)), instant(Some(&local.updated_at))) {
        (Some(remote_at), Some(local_at)) => remote_at > local_at,
        _ => false,
    };
    if !newer {
        return local.clone();
    }
    let mut merged = remote.clone();
    merged.claude.models = merge_maps(&local.claude.models, &remote.claude.models);
    merged.claude.overrides = merge_overrides(&local.claude.overrides, &remote.claude.overrides);
    merged.claude.family_fallback = merge_maps(&local.claude.family_fallback, &remote.claude.family_fallback);
    merged.codex.current = merge_maps(&local.codex.current, &remote.codex.current);
    merged.codex.historical = merge_maps(&local.codex.historical, &remote.codex.historical);
    merged.codex.overrides = merge_overrides(&local.codex.overrides, &remote.codex.overrides);
    merged.codex.family_fallback =
        merge_rules(&local.codex.family_fallback, &remote.codex.family_fallback, |rule| rule.pattern.as_str());
    merged.cursor.models = merge_maps(&local.cursor.models, &remote.cursor.models);
    merged.cursor.fast_multipliers = merge_maps(&local.cursor.fast_multipliers, &remote.cursor.fast_multipliers);
    merged.cursor.aliases = merge_rules(&local.cursor.aliases, &remote.cursor.aliases, |rule| rule.pattern.as_str());
    merged
}

struct Loaded {
    pricing: ModelPricing,
    files: Option<IndexMap<String, String>>,
    unverified: bool,
}

/// The rates in use, refreshed from the `pricing` branch at most daily.
pub struct PricingStore {
    dir: PathBuf,
    local: Supplement,
    snapshot: RwLock<Arc<ModelPricing>>,
    pack: Mutex<PackState>,
}

/// What is known about the cached pack: per-source fetch state, its file bodies, and whether it was verified.
struct PackState {
    sources: CacheState,
    files: Option<IndexMap<String, String>>,
    unverified: bool,
}

impl PricingStore {
    /// Reads `<dir>/pack.json` and `state.json`; an incomplete pack falls back to the bundled tables.
    #[must_use]
    pub fn open(dir: &Path) -> Self {
        let local = bundled_supplement();
        let mut state: CacheState = std::fs::read_to_string(dir.join("state.json"))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        let loaded = Self::load(dir, &local).unwrap_or_else(|| {
            // An incomplete cache must recover at once, except during failure backoff.
            for source in state.sources.values_mut() {
                source.fetched_at = None;
            }
            Loaded {
                pricing: ModelPricing::new(local.clone(), Catalog::default(), Catalog::default()),
                files: None,
                unverified: false,
            }
        });
        Self {
            dir: dir.to_owned(),
            local,
            snapshot: RwLock::new(Arc::new(loaded.pricing)),
            pack: Mutex::new(PackState { sources: state, files: loaded.files, unverified: loaded.unverified }),
        }
    }

    /// The bundled tables only, for tests and offline tools.
    #[must_use]
    pub fn bundled() -> ModelPricing {
        ModelPricing::new(bundled_supplement(), Catalog::default(), Catalog::default())
    }

    fn load(dir: &Path, local: &Supplement) -> Option<Loaded> {
        let files: IndexMap<String, String> =
            serde_json::from_str(&std::fs::read_to_string(dir.join("pack.json")).ok()?).ok()?;
        let body = |name: &str| files.get(name).map(String::as_str);
        let manifest = parse_manifest(&parse_body(body("manifest.json")?, None).ok()?)?;
        let hash = |key: &str| manifest.hashes.as_ref().and_then(|h| h.get(key)).map(String::as_str);
        let supplement = parse_supplement(&parse_body(body("supplement.json")?, hash("supplement")).ok()?)?;
        let litellm = parse_compact_catalog(&parse_body(body("litellm.json")?, hash("litellm")).ok()?)?;
        let models_dev = parse_compact_catalog(&parse_body(body("models_dev.json")?, hash("modelsDev")).ok()?)?;
        let unverified = manifest.hashes.is_none();
        Some(Loaded {
            pricing: ModelPricing::new(merge_supplement(local, &supplement), litellm, models_dev),
            files: Some(files),
            unverified,
        })
    }

    pub fn current(&self) -> Arc<ModelPricing> {
        self.snapshot.read().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
    }

    fn result(&self, updated: bool, reason: impl Into<String>, failed: bool) -> RefreshResult {
        RefreshResult {
            updated,
            reason: reason.into(),
            updated_at: self.current().updated_at().to_owned(),
            failed,
            unverified: self.pack.locked().unverified,
        }
    }

    /// Refreshes when a source is stale or `force`; failures keep the current rates.
    pub fn refresh_if_due(&self, http: &dyn HttpClient, env: &Env, now: Timestamp, force: bool) -> RefreshResult {
        if env.var("AITRACK_NO_PRICING_REFRESH") == Some("1") {
            return self.result(false, "disabled by AITRACK_NO_PRICING_REFRESH=1", false);
        }
        let due = {
            let pack = self.pack.locked();
            SOURCES.iter().any(|key| is_stale(pack.sources.sources.get(*key), now))
        };
        if !force && !due {
            return self.result(false, "cache still fresh", false);
        }
        let now_iso = iso_millis(now);
        match self.refresh(http, env, &now_iso) {
            Ok(updated) => self.result(
                updated,
                if updated { "pricing pack refreshed from pricing branch" } else { "remote pack unchanged" },
                false,
            ),
            Err(error) => {
                let mut pack = self.pack.locked();
                for key in SOURCES {
                    pack.sources.sources.entry(key.to_owned()).or_default().failed_at = Some(now_iso.clone());
                }
                if let Ok(json) = serde_json::to_string(&pack.sources) {
                    let _ = write_file_atomic(&self.dir.join("state.json"), &json, None);
                }
                drop(pack);
                self.result(false, format!("refresh failed: {error}"), true)
            }
        }
    }

    #[expect(
        clippy::expect_used,
        reason = "map keys are strings or dates and the output is an in-memory buffer, so serializing cannot fail"
    )]
    fn refresh(&self, http: &dyn HttpClient, env: &Env, now_iso: &str) -> Result<bool, String> {
        let base = env.var("AITRACK_PRICING_URL").map_or_else(
            || "https://raw.githubusercontent.com/bircni/aitrack/pricing".to_owned(),
            |url| url.trim_end_matches('/').to_owned(),
        );
        let (etags, cached) = {
            let pack = self.pack.locked();
            let etags: IndexMap<String, Option<String>> = SOURCES
                .iter()
                .map(|k| ((*k).to_owned(), pack.sources.sources.get(*k).and_then(|s| s.etag.clone())))
                .collect();
            (etags, pack.files.clone())
        };
        let fetch = |name: &str, file: &str, hash: Option<&str>| -> Result<Fetched, String> {
            let url = format!("{base}/{file}");
            let etag = etags.get(name).cloned().flatten();
            let get = |conditional: bool| {
                let mut request = Request::get(&url, FETCH_TIMEOUT).header("user-agent", "aitrack-pricing-store");
                if conditional && let Some(etag) = &etag {
                    request = request.header("if-none-match", etag);
                }
                http.send(&request).map_err(|e| e.to_string())
            };
            let mut response = get(true)?;
            if response.status == 304 {
                if let Some(body) = cached.as_ref().and_then(|files| files.get(file))
                    && let Ok(value) = parse_body(body, hash)
                {
                    let etag = response.header("etag").map(str::to_owned).or(etag);
                    return Ok(Fetched {
                        name: name.to_owned(),
                        file: file.to_owned(),
                        body: body.clone(),
                        value,
                        etag,
                        changed: false,
                    });
                }
                response = get(false)?;
            }
            if !response.is_ok() {
                return Err(format!("HTTP {} for {url}", response.status));
            }
            let body = response.text();
            let value = parse_body(&body, hash)?;
            Ok(Fetched {
                name: name.to_owned(),
                file: file.to_owned(),
                body,
                value,
                etag: response.header("etag").map(str::to_owned),
                changed: true,
            })
        };
        let invalid = || "invalid pricing payload".to_owned();
        let manifest_file = fetch("manifest", "manifest.json", None)?;
        let manifest = parse_manifest(&manifest_file.value).ok_or_else(invalid)?;
        let hash = |key: &str| manifest.hashes.as_ref().and_then(|h| h.get(key)).cloned();
        let supplement_file = fetch("supplement", "supplement.json", hash("supplement").as_deref())?;
        let litellm_file = fetch("litellm", "litellm.json", hash("litellm").as_deref())?;
        let models_dev_file = fetch("modelsDev", "models_dev.json", hash("modelsDev").as_deref())?;
        let supplement = parse_supplement(&supplement_file.value).ok_or_else(invalid)?;
        let litellm = parse_compact_catalog(&litellm_file.value).ok_or_else(invalid)?;
        let models_dev = parse_compact_catalog(&models_dev_file.value).ok_or_else(invalid)?;
        let next = ModelPricing::new(merge_supplement(&self.local, &supplement), litellm, models_dev);

        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let files = [&supplement_file, &litellm_file, &models_dev_file, &manifest_file];
        let pack: IndexMap<String, String> = files.iter().map(|f| (f.file.clone(), f.body.clone())).collect();
        // A single rename commits a whole generation, even with concurrent writers.
        if cached.is_none() || files.iter().any(|f| f.changed) {
            let json = serde_json::to_string(&pack).map_err(|e| e.to_string())?;
            write_file_atomic(&self.dir.join("pack.json"), json, None).map_err(|e| e.to_string())?;
        }
        let next_state = CacheState {
            sources: files
                .iter()
                .map(|f| {
                    (
                        f.name.clone(),
                        SourceState { etag: f.etag.clone(), fetched_at: Some(now_iso.to_owned()), failed_at: None },
                    )
                })
                .collect(),
        };
        let json = serde_json::to_string(&next_state).map_err(|e| e.to_string())?;
        write_file_atomic(&self.dir.join("state.json"), json, None).map_err(|e| e.to_string())?;
        let updated = next.updated_at() != self.current().updated_at() || files[..3].iter().any(|f| f.changed);
        *self.pack.locked() =
            PackState { sources: next_state, files: Some(pack), unverified: manifest.hashes.is_none() };
        *self.snapshot.write().unwrap_or_else(std::sync::PoisonError::into_inner) = Arc::new(next);
        Ok(updated)
    }
}

struct Fetched {
    name: String,
    file: String,
    body: String,
    value: Value,
    etag: Option<String>,
    changed: bool,
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use super::*;
    use crate::http::{HttpError, Response};

    /// A scripted answer: the file it is for, the status, the `ETag` and the body.
    type Reply = (&'static str, u16, Option<&'static str>, String);

    /// Answers each request with the next scripted response for its file, and records what was asked.
    #[derive(Default)]
    struct Script {
        replies: Mutex<VecDeque<Reply>>,
        asked: Mutex<Vec<(String, Option<String>)>>,
    }

    impl Script {
        fn reply(&self, file: &'static str, status: u16, etag: Option<&'static str>, body: &str) {
            self.replies.lock().unwrap().push_back((file, status, etag, body.to_owned()));
        }
    }

    impl HttpClient for Script {
        fn send(&self, request: &Request) -> Result<Response, HttpError> {
            let if_none_match = request.headers.iter().find(|(n, _)| n == "if-none-match").map(|(_, v)| v.clone());
            self.asked.lock().unwrap().push((request.url.clone(), if_none_match));
            let mut replies = self.replies.lock().unwrap();
            let index = replies
                .iter()
                .position(|(file, ..)| request.url.ends_with(file))
                .ok_or_else(|| HttpError(format!("unexpected {}", request.url)))?;
            let (_, status, etag, body) = replies.remove(index).unwrap();
            drop(replies);
            Ok(Response {
                status,
                headers: etag.map(|e| vec![("etag".into(), e.into())]).unwrap_or_default(),
                body: body.into_bytes(),
            })
        }
    }

    fn pack_files() -> IndexMap<String, String> {
        let text = include_str!("../../tests/fixtures/pricing/synthetic-pack.json");
        serde_json::from_str(text).unwrap()
    }

    fn serve_pack(script: &Script, files: &IndexMap<String, String>) {
        for (file, etag) in
            [("manifest.json", "m1"), ("supplement.json", "s1"), ("litellm.json", "l1"), ("models_dev.json", "d1")]
        {
            script.reply(file, 200, Some(etag), &files[file]);
        }
    }

    fn env() -> Env {
        Env::new("/nowhere", [("AITRACK_PRICING_URL", "https://mirror.test/pack/")])
    }

    fn at(text: &str) -> Timestamp {
        text.parse().unwrap()
    }

    #[test]
    fn downloads_a_pack_then_stays_fresh_for_a_day_and_revalidates_with_etags() {
        let dir = tempfile::tempdir().unwrap();
        let store = PricingStore::open(dir.path());
        assert_eq!(store.current().updated_at(), "2026-09-29T00:00:00.000Z");
        let script = Script::default();
        let files = pack_files();
        serve_pack(&script, &files);
        let first = store.refresh_if_due(&script, &env(), at("2099-01-02T00:00:00Z"), false);
        assert!(first.updated && !first.failed && !first.unverified, "{first:?}");
        assert_eq!(store.current().updated_at(), "2099-01-01T00:00:00.000Z");
        assert!(
            script
                .asked
                .lock()
                .unwrap()
                .iter()
                .all(|(url, etag)| url.starts_with("https://mirror.test/pack/") && etag.is_none())
        );
        assert_eq!(PricingStore::open(dir.path()).current().updated_at(), "2099-01-01T00:00:00.000Z");

        let fresh = store.refresh_if_due(&script, &env(), at("2099-01-02T12:00:00Z"), false);
        assert_eq!(fresh.reason, "cache still fresh");

        for file in ["manifest.json", "supplement.json", "litellm.json", "models_dev.json"] {
            script.reply(file, 304, None, "");
        }
        script.asked.lock().unwrap().clear();
        let revalidated = store.refresh_if_due(&script, &env(), at("2099-01-04T00:00:00Z"), false);
        assert_eq!((revalidated.updated, revalidated.reason.as_str()), (false, "remote pack unchanged"));
        let etags: Vec<Option<String>> = script.asked.lock().unwrap().iter().map(|(_, e)| e.clone()).collect();
        assert_eq!(etags, ["m1", "s1", "l1", "d1"].map(|e| Some(e.to_owned())));
    }

    #[test]
    fn a_bad_download_keeps_the_rates_and_backs_off_for_half_an_hour() {
        let dir = tempfile::tempdir().unwrap();
        let store = PricingStore::open(dir.path());
        let script = Script::default();
        let mut files = pack_files();
        files.insert("supplement.json".into(), files["supplement.json"].replace("2099-01-01", "2099-01-02"));
        serve_pack(&script, &files);
        let failed = store.refresh_if_due(&script, &env(), at("2099-01-02T00:00:00Z"), false);
        assert!(failed.failed && failed.reason == "refresh failed: hash mismatch", "{failed:?}");
        assert_eq!(store.current().updated_at(), "2026-09-29T00:00:00.000Z");
        let backing_off = store.refresh_if_due(&script, &env(), at("2099-01-02T00:29:00Z"), false);
        assert_eq!(backing_off.reason, "cache still fresh");
        let retried = store.refresh_if_due(&script, &env(), at("2099-01-02T00:31:00Z"), false);
        assert!(retried.failed, "{retried:?}"); // Due again; nothing scripted, so it fails at the transport.
    }

    #[test]
    fn a_pack_without_hashes_loads_but_is_reported_unverified() {
        let dir = tempfile::tempdir().unwrap();
        let mut files = pack_files();
        let mut manifest: Value = serde_json::from_str(&files["manifest.json"]).unwrap();
        manifest.as_object_mut().unwrap().remove("hashes");
        files.insert("manifest.json".into(), manifest.to_string());
        std::fs::write(dir.path().join("pack.json"), serde_json::to_string(&files).unwrap()).unwrap();
        let store = PricingStore::open(dir.path());
        assert_eq!(store.current().updated_at(), "2099-01-01T00:00:00.000Z");
        let disabled = Env::new("/nowhere", [("AITRACK_NO_PRICING_REFRESH", "1")]);
        let result = store.refresh_if_due(&Script::default(), &disabled, at("2099-01-02T00:00:00Z"), true);
        assert!(result.unverified && result.reason == "disabled by AITRACK_NO_PRICING_REFRESH=1", "{result:?}");
    }
}

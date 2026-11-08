//! cache.json: what survives a restart, so the popup has numbers before the first refresh.

use aitrack_core::providers::PROVIDERS;
use aitrack_core::quota::QuotaSnapshot;
use aitrack_core::time::Clock;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::alerts::FiredAlerts;
use crate::pace::parse_ms;
use crate::state::{MachineUsage, ProjectUsageEntry, ProjectUsages, ProviderUsage, ProviderUsages, UsageSummary};

/// 4.x's sidecar wrote this format; anything else is ignored.
pub const CACHE_FORMAT: u64 = 2;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedState {
    pub quotas: IndexMap<String, QuotaSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<UsageSummary>,
    pub fired: FiredAlerts,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pull_error: Option<String>,
    /// Epoch ms a provider's retry-after ends; kept so a relaunch does not hit it again.
    pub rate_limited_until: IndexMap<String, f64>,
}

/// The file's contents: the format first, then the state.
#[expect(clippy::expect_used, reason = "our own types always serialize to JSON")]
pub fn cache_json(cache: &CachedState) -> String {
    #[derive(Serialize)]
    struct File<'a> {
        format: u64,
        #[serde(flatten)]
        cache: &'a CachedState,
    }
    aitrack_core::js::to_string(&File { format: CACHE_FORMAT, cache }).expect("cache serializes")
}

fn finite(value: Option<&Value>) -> bool {
    value.and_then(Value::as_f64).is_some_and(f64::is_finite)
}

fn optional_finite(value: Option<&Value>) -> bool {
    value.is_none() || finite(value)
}

fn optional_string(value: Option<&Value>) -> bool {
    value.is_none_or(Value::is_string)
}

fn optional_bool(value: Option<&Value>) -> bool {
    value.is_none_or(Value::is_boolean)
}

fn is_timestamp(clock: &Clock, value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|text| parse_ms(clock, text).is_finite())
}

fn is_spend(value: &Value) -> bool {
    value.as_object().is_some_and(|v| {
        finite(v.get("tokens"))
            && finite(v.get("costUSD"))
            && v.get("hasCost").is_some_and(Value::is_boolean)
            && optional_bool(v.get("hasUnpricedTokens"))
    })
}

fn is_period(value: Option<&Value>) -> bool {
    value.is_some_and(|v| {
        is_spend(v)
            && v.get("models").and_then(Value::as_array).is_some_and(|models| {
                models.iter().all(|m| is_spend(m) && m.get("model").is_some_and(Value::is_string))
            })
    })
}

fn from<T: serde::de::DeserializeOwned>(value: Value) -> Option<T> {
    serde_json::from_value(value).ok()
}

fn read_provider_usage(value: Option<&Value>) -> Option<ProviderUsage> {
    let v = value?.as_object()?;
    if !["today", "yesterday", "last7Days", "last30Days", "allTime"].iter().all(|k| is_period(v.get(*k))) {
        return None;
    }
    let mut daily = Vec::new();
    for day in v.get("daily")?.as_array()? {
        let day = day.as_object()?;
        if !day.get("date").is_some_and(Value::is_string) || !finite(day.get("costUSD")) {
            return None;
        }
        let mut kept = Map::new();
        kept.insert("date".into(), day["date"].clone());
        kept.insert("costUSD".into(), day["costUSD"].clone());
        if day.get("hasUnpricedTokens") == Some(&Value::Bool(true)) {
            kept.insert("hasUnpricedTokens".into(), true.into());
        }
        daily.push(Value::Object(kept));
    }
    let mut usage = v.clone();
    usage.insert("daily".into(), daily.into());
    from(Value::Object(usage))
}

fn usage_map(value: Option<&Value>) -> ProviderUsages {
    let Some(map) = value.and_then(Value::as_object) else { return ProviderUsages::new() };
    PROVIDERS
        .iter()
        .filter_map(|p| read_provider_usage(map.get(p.key)).map(|usage| (p.key.to_owned(), usage)))
        .collect()
}

fn read_project_entries(value: Option<&Value>) -> Option<Vec<ProjectUsageEntry>> {
    let entries = value?.as_array()?;
    let valid = entries.iter().all(|entry| {
        is_spend(entry)
            && entry.get("project").is_some_and(Value::is_string)
            && entry.get("providers").and_then(Value::as_array).is_some_and(|parts| {
                parts.iter().all(|part| {
                    is_spend(part)
                        && part.get("key").is_some_and(Value::is_string)
                        && part.get("label").is_some_and(Value::is_string)
                })
            })
    });
    valid.then(|| from(Value::Array(entries.clone()))).flatten()
}

fn read_projects(value: Option<&Value>) -> Option<ProjectUsages> {
    let v = value?.as_object()?;
    Some(ProjectUsages {
        today: read_project_entries(v.get("today"))?,
        last7_days: read_project_entries(v.get("last7Days"))?,
        last30_days: read_project_entries(v.get("last30Days"))?,
        all_time: read_project_entries(v.get("allTime"))?,
    })
}

fn read_machine_usage(value: &Value) -> Option<MachineUsage> {
    let v = value.as_object()?;
    let text = |key: &str| v.get(key).and_then(Value::as_str).map(str::to_owned);
    Some(MachineUsage {
        name: text("name")?,
        timezone: text("timezone")?,
        last_updated: text("lastUpdated")?,
        current: v.get("current")?.as_bool()?,
        providers: usage_map(v.get("providers")),
    })
}

fn is_window(value: &Value) -> bool {
    value.as_object().is_some_and(|w| {
        w.get("id").is_some_and(Value::is_string)
            && w.get("label").is_some_and(Value::is_string)
            && finite(w.get("usedPercent"))
            && finite(w.get("periodSeconds"))
            && w.get("format").and_then(Value::as_str).is_some_and(|f| ["percent", "dollars", "count"].contains(&f))
            && optional_string(w.get("resetsAt"))
            && optional_finite(w.get("usedValue"))
            && optional_finite(w.get("limitValue"))
    })
}

fn is_snapshot(clock: &Clock, value: &Value, key: &str) -> bool {
    value.as_object().is_some_and(|s| {
        s.get("provider").and_then(Value::as_str) == Some(key)
            && optional_string(s.get("plan"))
            && is_timestamp(clock, s.get("fetchedAt"))
            && s.get("windows").and_then(Value::as_array).is_some_and(|w| w.iter().all(is_window))
            && s.get("values").and_then(Value::as_array).is_some_and(|values| {
                values.iter().all(|entry| {
                    entry.get("id").is_some_and(Value::is_string)
                        && entry.get("label").is_some_and(Value::is_string)
                        && finite(entry.get("value"))
                        && entry.get("format").and_then(Value::as_str).is_some_and(|f| f == "dollars" || f == "count")
                })
            })
    })
}

fn quota_map<T>(value: Option<&Value>, read: impl Fn(&Value, &str) -> Option<T>) -> IndexMap<String, T> {
    let Some(map) = value.and_then(Value::as_object) else { return IndexMap::new() };
    PROVIDERS
        .iter()
        .filter_map(|p| map.get(p.key).and_then(|entry| read(entry, p.key)).map(|entry| (p.key.to_owned(), entry)))
        .collect()
}

/// A cache.json read from disk, which may be hand-edited: whatever does not fit is dropped.
fn normalize_cached_state(clock: &Clock, raw: &Map<String, Value>) -> CachedState {
    let text = |key: &str| raw.get(key).and_then(Value::as_str).map(str::to_owned);
    let stamp = |key: &str| text(key).filter(|_| is_timestamp(clock, raw.get(key)));
    let usage = raw.get("usage").and_then(Value::as_object).map(|usage| UsageSummary {
        providers: usage_map(usage.get("providers")),
        machines: usage
            .get("machines")
            .and_then(Value::as_array)
            .map(|machines| machines.iter().filter_map(read_machine_usage).collect()),
        account: usage.get("account").filter(|a| a.is_object()).map(|a| usage_map(Some(a))),
        projects: read_projects(usage.get("projects")),
    });
    CachedState {
        updated_at: stamp("updatedAt"),
        usage_updated_at: stamp("usageUpdatedAt"),
        pull_error: text("pullError"),
        quotas: quota_map(raw.get("quotas"), |entry, key| {
            is_snapshot(clock, entry, key).then(|| from(entry.clone())).flatten()
        }),
        usage,
        fired: raw
            .get("fired")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
            .filter_map(|(key, at)| at.as_str().map(|at| (key.clone(), at.to_owned())))
            .collect(),
        rate_limited_until: quota_map(raw.get("rateLimitedUntil"), |entry, _| entry.as_f64().filter(|n| n.is_finite())),
    }
}

pub fn load_cached_state(clock: &Clock, input: &Value) -> CachedState {
    let empty = Map::new();
    #[expect(
        clippy::cast_precision_loss,
        reason = "counts and millisecond times stay far below 2^53, like the JavaScript numbers 4.x used"
    )]
    let current = |v: &&Map<String, Value>| v.get("format").and_then(Value::as_f64) == Some(CACHE_FORMAT as f64);
    let raw = input.as_object().filter(current);
    normalize_cached_state(clock, raw.unwrap_or(&empty))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn clock() -> Clock {
        Clock::in_zone("UTC").unwrap()
    }

    fn snapshot() -> Value {
        json!({
            "provider": "codex",
            "windows": [{
                "id": "session", "label": "Session", "usedPercent": 10, "periodSeconds": 18000,
                "resetsAt": "2026-06-01T13:00:00.000Z", "format": "percent",
            }],
            "values": [],
            "fetchedAt": "2026-06-01T12:00:00.000Z",
        })
    }

    /// As JSON reads it back, so `10.0` and `10` compare equal.
    fn load(value: &Value) -> Value {
        serde_json::from_str(&aitrack_core::js::to_string(&load_cached_state(&clock(), value)).unwrap()).unwrap()
    }

    #[test]
    fn drops_malformed_parts_of_a_hand_edited_cache() {
        let loaded = load(&json!({
            "format": 2,
            "quotas": { "claude_code": {}, "codex": snapshot(), "x": {} },
            "usage": {
                "providers": { "claude_code": { "today": {} } },
                "machines": [
                    { "name": "old" },
                    { "name": "work", "timezone": "UTC", "lastUpdated": "", "current": false, "providers": [] },
                ],
                "account": { "cursor": { "today": {} } },
            },
            "fired": { "a": "2026-06-01T12:00:00.000Z", "b": 123 },
            "rateLimitedUntil": { "cursor": "soon", "codex": 1_780_315_200_000_i64 },
        }));
        assert_eq!(
            loaded,
            json!({
                "quotas": { "codex": snapshot() },
                "usage": {
                    "providers": {},
                    "machines": [{ "name": "work", "timezone": "UTC", "lastUpdated": "", "current": false, "providers": {} }],
                    "account": {},
                },
                "fired": { "a": "2026-06-01T12:00:00.000Z" },
                "rateLimitedUntil": { "codex": 1_780_315_200_000_i64 },
            })
        );
    }

    #[test]
    fn reads_only_the_current_cache_format() {
        let cache = json!({ "format": 2, "updatedAt": "2026-06-01T12:00:00.000Z", "fired": { "alert": "soon" } });
        assert_eq!(load(&cache)["fired"], json!({ "alert": "soon" }));
        for input in [json!({ "format": 1, "fired": { "a": "b" } }), json!({ "format": 3 }), json!("garbage")] {
            assert_eq!(load(&input), json!({ "quotas": {}, "fired": {}, "rateLimitedUntil": {} }));
        }
    }

    #[test]
    fn drops_malformed_quota_snapshot_fields() {
        let patches = [
            json!({ "provider": "claude_code" }),
            json!({ "plan": {} }),
            json!({ "fetchedAt": "soon" }),
            json!({ "windows": [{ "id": "s", "label": "S", "usedPercent": 1, "periodSeconds": 1, "format": "dollars", "usedValue": null }] }),
            json!({ "windows": [{ "id": "s", "label": "S", "usedPercent": 1, "periodSeconds": 1, "format": "dollars", "limitValue": "50" }] }),
        ];
        for patch in patches {
            let mut quota = snapshot();
            quota.as_object_mut().unwrap().extend(patch.as_object().unwrap().clone());
            assert_eq!(load(&json!({ "format": 2, "quotas": { "codex": quota } }))["quotas"], json!({}));
        }
    }

    #[test]
    fn keeps_cached_project_usage_only_when_every_period_is_well_formed() {
        let entry = json!({
            "project": "acme/widget", "tokens": 1, "costUSD": 0, "hasCost": false,
            "providers": [{ "key": "codex", "label": "Codex", "tokens": 1, "costUSD": 0, "hasCost": false }],
        });
        let projects = json!({ "today": [entry], "last7Days": [], "last30Days": [], "allTime": [] });
        let load_projects = |value: Value| {
            load(&json!({ "format": 2, "usage": { "providers": {}, "projects": value } }))["usage"]["projects"].clone()
        };
        assert_eq!(load_projects(projects.clone()), projects);
        let mut broken = projects.clone();
        broken["today"][0]["providers"] = json!([{ "key": 1 }]);
        assert_eq!(load_projects(broken), Value::Null);
        let mut missing = projects;
        missing.as_object_mut().unwrap().remove("allTime");
        assert_eq!(load_projects(missing), Value::Null);
        assert_eq!(load_projects(json!("nope")), Value::Null);
    }

    #[test]
    fn drops_a_cached_provider_with_a_missing_period_and_keeps_the_unpriced_mark_on_its_days() {
        let period = json!({ "tokens": 10, "costUSD": 1, "hasCost": true, "models": [] });
        let empty = json!({ "tokens": 0, "costUSD": 0, "hasCost": false, "models": [] });
        let usage = json!({
            "today": period, "yesterday": empty, "last7Days": empty, "last30Days": empty, "allTime": period,
            "daily": [
                { "date": "2026-06-01", "costUSD": 1, "hasUnpricedTokens": true },
                { "date": "2026-06-02", "costUSD": 0 },
            ],
        });
        let mut without_all_time = usage.clone();
        without_all_time.as_object_mut().unwrap().remove("allTime");
        let loaded = load(
            &json!({ "format": 2, "usage": { "providers": { "claude_code": usage, "codex": without_all_time } } }),
        );
        assert_eq!(loaded["usage"]["providers"], json!({ "claude_code": usage }));
    }

    #[test]
    fn writes_the_format_first_and_reads_back_what_it_wrote() {
        let cache =
            load_cached_state(&clock(), &json!({ "format": 2, "quotas": { "codex": snapshot() }, "fired": {} }));
        let text = cache_json(&cache);
        assert!(text.starts_with(r#"{"format":2,"quotas":{"codex":"#), "{text}");
        assert_eq!(load_cached_state(&clock(), &serde_json::from_str(&text).unwrap()), cache);
    }
}

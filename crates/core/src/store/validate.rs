//! Reading a machine file the way 4.x does: skip what cannot be trusted, drop only what can be lost.

use indexmap::IndexMap;
use serde_json::{Map, Value};

use super::encryption::{ENCRYPTION_PASSPHRASE_ENV, decrypt_envelope, is_encrypted_envelope};
use crate::data::types::{CURRENT_SCHEMA_VERSION, CountsByKey, DayBucket, MachineFile, ProviderDay, TokenCounts};
use crate::day::Day;
use crate::js::is_inherited_key;
use crate::time::UNKNOWN_TIMEZONE;

#[derive(Clone, Copy, Debug, Default)]
pub struct ValidationOptions {
    /// Lets recompute-costs load a file whose aggregate cost is the value being repaired.
    pub allow_inconsistent_cost_totals: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Diagnostic {
    FileSkipped { file: String, reason: String },
    DayDropped { file: String, date: String, reason: String },
    ProjectsDropped { file: String, date: String, provider: String, reason: String },
}

impl Diagnostic {
    #[must_use]
    pub fn file(&self) -> &str {
        match self {
            Self::FileSkipped { file, .. } | Self::DayDropped { file, .. } | Self::ProjectsDropped { file, .. } => file,
        }
    }
}

impl std::fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::FileSkipped { file, reason } => write!(f, "Skipping invalid machine file {file}: {reason}"),
            Self::DayDropped { file, date, reason } => {
                write!(f, "Dropping day {date} from machine file {file}: {reason}")
            }
            Self::ProjectsDropped { file, date, provider, reason } => {
                write!(f, "Ignoring the project split of {date} ({provider}) in machine file {file}: {reason}")
            }
        }
    }
}

/// Only `Corrupt` can be repaired by rewriting: the others are healthy files this process cannot read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    Corrupt,
    FutureSchema,
    Encrypted,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MachineFileCheck {
    pub machine: Option<MachineFile>,
    pub diagnostics: Vec<Diagnostic>,
    pub failure: Option<Failure>,
    /// The raw file was an encrypted envelope, readable or not.
    pub encrypted: bool,
}

/// Float comparison with a relative epsilon, used for cost totals.
#[must_use]
pub fn approximately_equal(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-9 * 1f64.max(a.abs()).max(b.abs())
}

const COUNT_FIELDS: [&str; 6] = [
    "inputTokens",
    "outputTokens",
    "rawInputTokens",
    "cachedInputTokens",
    "cacheCreationInputTokens",
    "cacheCreation1hInputTokens",
];

/// 4.x accepts any finite number; aitrack only ever writes non-negative integers, so anything else is corrupt.
fn token_count(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| {
        let x = value.as_f64()?;
        #[expect(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "checked just above: a whole number in 0..=2^53"
        )]
        (x == 0.0 || (x > 0.0 && x.fract() == 0.0 && x <= 2f64.powi(53))).then(|| x.abs() as u64)
    })
}

fn check_token_counts(value: &Value, path: &str) -> Result<TokenCounts, String> {
    let fields = value.as_object().ok_or_else(|| format!("{path} must be an object"))?;
    let mut counts = [None; 6];
    for (slot, field) in counts.iter_mut().zip(COUNT_FIELDS) {
        let present = fields.get(field);
        let required = field == "inputTokens" || field == "outputTokens";
        match present {
            None if !required => {}
            Some(v) if v.as_f64().is_some_and(f64::is_finite) => {
                *slot = Some(token_count(v).ok_or_else(|| format!("{path}.{field} must be a non-negative integer"))?);
            }
            _ => return Err(format!("{path}.{field} must be a number")),
        }
    }
    let cost_usd = match fields.get("costUSD") {
        None => None,
        Some(v) => {
            Some(v.as_f64().filter(|x| x.is_finite()).ok_or_else(|| format!("{path}.costUSD must be a number"))?)
        }
    };
    let has_unpriced_tokens = match fields.get("hasUnpricedTokens") {
        None => None,
        Some(v) => Some(v.as_bool().ok_or_else(|| format!("{path}.hasUnpricedTokens must be a boolean"))?),
    };
    let [Some(input_tokens), Some(output_tokens), ..] = counts else {
        return Err(format!("{path}.inputTokens must be a number"));
    };
    Ok(TokenCounts {
        input_tokens,
        output_tokens,
        raw_input_tokens: counts[2],
        cached_input_tokens: counts[3],
        cache_creation_input_tokens: counts[4],
        cache_creation_1h_input_tokens: counts[5],
        unpriced_before_cost: cost_usd.is_some()
            && has_unpriced_tokens.is_some()
            && fields.keys().position(|k| k == "hasUnpricedTokens") < fields.keys().position(|k| k == "costUSD"),
        cost_usd,
        has_unpriced_tokens,
    })
}

#[must_use]
pub fn is_token_counts(value: &Value) -> bool {
    check_token_counts(value, "").is_ok()
}

fn check_counts_by_key(value: &Map<String, Value>, path: &str, what: &str) -> Result<CountsByKey, String> {
    let mut out = CountsByKey::with_capacity(value.len());
    for (key, counts) in value {
        if is_inherited_key(key) {
            return Err(format!("{path}.{what} has the reserved key {key}"));
        }
        out.insert(key.clone(), check_token_counts(counts, &format!("{path}.{what}.{key}"))?);
    }
    Ok(out)
}

const fn field(counts: &TokenCounts, index: usize) -> Option<u64> {
    [
        Some(counts.input_tokens),
        Some(counts.output_tokens),
        counts.raw_input_tokens,
        counts.cached_input_tokens,
        counts.cache_creation_input_tokens,
        counts.cache_creation_1h_input_tokens,
    ][index]
}

fn check_provider_day(
    value: &Map<String, Value>,
    path: &str,
    options: ValidationOptions,
) -> Result<ProviderDay, String> {
    let totals = check_token_counts(value.get("totals").unwrap_or(&Value::Null), &format!("{path}.totals"))?;
    let by_model =
        value.get("byModel").and_then(Value::as_object).ok_or_else(|| format!("{path}.byModel must be an object"))?;
    let by_model = check_counts_by_key(by_model, path, "byModel")?;
    for (index, name) in COUNT_FIELDS.iter().enumerate() {
        if let Some(total) = field(&totals, index) {
            let sum: u64 = by_model.values().map(|c| field(c, index).unwrap_or(0)).sum();
            if total != sum {
                return Err(format!("{path}.totals.{name} must equal the sum of byModel.{name}"));
            }
        }
    }
    if !options.allow_inconsistent_cost_totals
        && let Some(total) = totals.cost_usd
        && !by_model.is_empty()
        && by_model.values().all(|c| c.cost_usd.is_some())
    {
        let sum = by_model.values().fold(0.0, |sum, c| sum + c.cost_usd.unwrap_or(0.0));
        if !approximately_equal(total, sum) {
            return Err(format!("{path}.totals.costUSD must equal the sum of byModel.costUSD"));
        }
    }
    let by_project = match value.get("byProject") {
        None => None,
        Some(v) => {
            let projects = v.as_object().ok_or_else(|| format!("{path}.byProject must be an object"))?;
            Some(check_counts_by_key(projects, path, "byProject")?)
        }
    };
    Ok(ProviderDay { by_model, totals, by_project, by_cwd: None })
}

/// The first problem with a day's `byProject`, which is optional detail and never worth losing the day over.
fn projects_problem(value: &Value, path: &str) -> Option<String> {
    let Some(projects) = value.as_object() else { return Some(format!("{path}.byProject must be an object")) };
    check_counts_by_key(projects, path, "byProject").err()
}

fn schema_version(file: &Map<String, Value>) -> u64 {
    file.get("schemaVersion").and_then(token_count).filter(|v| *v > 0).unwrap_or(1)
}

/// Brings a parsed file up to the current schema; v1 files gain `timezone: "unknown"` and `dayBucket: "local"`.
fn apply_migrations(file: &Map<String, Value>) -> Result<Map<String, Value>, (String, Failure)> {
    let version = schema_version(file);
    let current = u64::from(CURRENT_SCHEMA_VERSION);
    if version > current {
        return Err((
            format!(
                "machine file schemaVersion {version} is newer than this aitrack understands (supports up to {current}); upgrade aitrack"
            ),
            Failure::FutureSchema,
        ));
    }
    let mut file = file.clone();
    if version == 1 {
        let zone = file
            .get("timezone")
            .and_then(Value::as_str)
            .filter(|z| !z.is_empty())
            .unwrap_or(UNKNOWN_TIMEZONE)
            .to_owned();
        file.insert("schemaVersion".into(), Value::from(2));
        file.insert("timezone".into(), Value::from(zone));
        file.insert("dayBucket".into(), Value::from("local"));
    }
    Ok(file)
}

/// Validates a parsed machine file, reporting nothing.
pub fn check_machine_file(data: &Value, file: &str, options: ValidationOptions) -> MachineFileCheck {
    let skip = |reason: String, failure: Failure| MachineFileCheck {
        machine: None,
        diagnostics: vec![Diagnostic::FileSkipped { file: file.to_owned(), reason }],
        failure: Some(failure),
        encrypted: false,
    };
    let Some(root) = data.as_object() else { return skip("root must be an object".into(), Failure::Corrupt) };
    let migrated = match apply_migrations(root) {
        Ok(migrated) => migrated,
        Err((reason, failure)) => return skip(reason, failure),
    };
    let non_empty = |key: &str| migrated.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
    let Some(hostname) = non_empty("hostname") else {
        return skip("hostname must be a non-empty string".into(), Failure::Corrupt);
    };
    let Some(last_updated) = non_empty("lastUpdated") else {
        return skip("lastUpdated must be a non-empty string".into(), Failure::Corrupt);
    };
    // Tolerated, not required: there is no repair path for another machine's file.
    let timezone = non_empty("timezone").unwrap_or_else(|| UNKNOWN_TIMEZONE.to_owned());
    let day_bucket = match migrated.get("dayBucket").and_then(Value::as_str) {
        Some("utc") => DayBucket::Utc,
        _ => DayBucket::Local,
    };
    let Some(raw_days) = migrated.get("days").and_then(Value::as_object) else {
        return skip("days must be an object".into(), Failure::Corrupt);
    };
    let mut diagnostics = Vec::new();
    let mut days = IndexMap::new();
    for (date, providers) in raw_days {
        // Drop the day, not the file: the sync merge would otherwise carry it forward forever.
        let Some(day) = Day::parse(date) else {
            diagnostics.push(Diagnostic::DayDropped {
                file: file.to_owned(),
                date: date.clone(),
                reason: "not a YYYY-MM-DD date".into(),
            });
            continue;
        };
        let Some(providers) = providers.as_object() else {
            return skip(format!("days.{date} must be an object"), Failure::Corrupt);
        };
        let mut provider_days = IndexMap::new();
        for (provider, data) in providers {
            let path = format!("days.{date}.{provider}");
            if is_inherited_key(provider) {
                return skip(format!("{path} has a reserved provider key"), Failure::Corrupt);
            }
            let Some(fields) = data.as_object() else {
                return skip(format!("{path} must be an object"), Failure::Corrupt);
            };
            let mut fields = fields.clone();
            fields.remove("byCwd"); // In memory only; it would go unchecked into the merge otherwise.
            if let Some(projects) = fields.get("byProject")
                && let Some(reason) = projects_problem(projects, &path)
            {
                fields.remove("byProject");
                diagnostics.push(Diagnostic::ProjectsDropped {
                    file: file.to_owned(),
                    date: date.clone(),
                    provider: provider.clone(),
                    reason,
                });
            }
            match check_provider_day(&fields, &path, options) {
                Ok(provider_day) => {
                    provider_days.insert(provider.clone(), provider_day);
                }
                Err(reason) => return skip(reason, Failure::Corrupt),
            }
        }
        days.insert(day, provider_days);
    }
    MachineFileCheck {
        machine: Some(MachineFile {
            schema_version: CURRENT_SCHEMA_VERSION,
            hostname,
            timezone,
            day_bucket,
            last_updated,
            days,
        }),
        diagnostics,
        failure: None,
        encrypted: false,
    }
}

/// Parses and validates raw JSON, decrypting an encrypted file first; reports nothing.
#[must_use]
pub fn check_raw_machine_file(
    raw: &str,
    file: &str,
    passphrase: Option<&str>,
    options: ValidationOptions,
) -> MachineFileCheck {
    let skip = |reason: String, failure: Failure, encrypted: bool| MachineFileCheck {
        machine: None,
        diagnostics: vec![Diagnostic::FileSkipped { file: file.to_owned(), reason }],
        failure: Some(failure),
        encrypted,
    };
    let mut parsed: Value = match serde_json::from_str(raw) {
        Ok(parsed) => parsed,
        Err(error) => return skip(format!("invalid JSON ({error})"), Failure::Corrupt, false),
    };
    let encrypted = is_encrypted_envelope(&parsed);
    if encrypted {
        let Some(passphrase) = passphrase else {
            return skip(
                format!("it is encrypted; set {ENCRYPTION_PASSPHRASE_ENV} to the data repo passphrase"),
                Failure::Encrypted,
                true,
            );
        };
        let plaintext = match decrypt_envelope(&parsed, passphrase) {
            Ok(plaintext) => plaintext,
            Err(error) => {
                return skip(
                    format!(
                        "it could not be decrypted ({error}); check {ENCRYPTION_PASSPHRASE_ENV} matches the passphrase it was written with, or restore the file if it was modified"
                    ),
                    Failure::Encrypted,
                    true,
                );
            }
        };
        parsed = match serde_json::from_str(&plaintext) {
            Ok(parsed) => parsed,
            Err(error) => return skip(format!("invalid JSON ({error})"), Failure::Corrupt, true),
        };
    }
    MachineFileCheck { encrypted, ..check_machine_file(&parsed, file, options) }
}

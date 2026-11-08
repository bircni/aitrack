//! Maintainer tasks: pricing pack, release, packaging and publishing.

mod manifests;
mod npm;
mod pricing;
mod release;
mod smoke;
mod updater_artifacts;

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use aitrack_core::http::UreqClient;
use aitrack_core::time::iso_millis;
use jiff::Timestamp;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::pricing::{
    CURSOR_PROVIDERS, Catalogs, Finding, Result, Tables, apply_catalog_rates, compare_table, fetch_catalogs, pretty,
    summary,
};

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(2).expect("crates/xtask sits two levels down").to_owned()
}

fn tables_dir() -> PathBuf {
    root().join("crates/core/pricing-tables")
}

/// Published by CI to the orphan `pricing` branch.
fn pack_dir() -> PathBuf {
    root().join("artifacts/pricing-pack")
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes.iter().fold(String::new(), |mut hex, b| {
        let _ = write!(hex, "{b:02x}");
        hex
    })
}

fn sha256(text: &str) -> String {
    hex(&Sha256::digest(text.as_bytes()))
}

fn sha256_file(path: &Path) -> Result<String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(hex(&Sha256::digest(bytes)))
}

fn write(path: &Path, text: &str) -> Result<()> {
    std::fs::write(path, text).map_err(|e| format!("{}: {e}", path.display()))
}

fn read_json(path: &Path) -> Result<Value> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))
}

fn pricing_pack(write_tables: bool, offline: bool) -> Result<()> {
    let pack = pack_dir();
    std::fs::create_dir_all(&pack).map_err(|e| format!("{}: {e}", pack.display()))?;
    let now = Timestamp::now();
    let (litellm, models_dev) = if offline {
        (read_json(&pack.join("litellm.json"))?, read_json(&pack.join("models_dev.json"))?)
    } else {
        println!("Fetching LiteLLM + models.dev…");
        fetch_catalogs(&UreqClient::default(), now)?
    };
    let mut tables = Tables::read(&tables_dir())?;
    let mut supplement = tables.supplement()?;
    let changes = apply_catalog_rates(&mut supplement, &Catalogs::from_compact(&litellm, &models_dev)?);
    let list = |ids: &[String]| if ids.is_empty() { "none".to_owned() } else { ids.join(", ") };
    let merged = format!("Claude [{}], Codex [{}]", list(&changes.claude), list(&changes.codex));
    let any = !changes.claude.is_empty() || !changes.codex.is_empty();
    if write_tables {
        let today = &iso_millis(now)[..10];
        if !changes.claude.is_empty() {
            tables.claude.insert("updatedAt".into(), json!(today));
            tables.claude.insert("models".into(), supplement["claude"]["models"].clone());
            write(&tables_dir().join("claude.json"), &pretty(&Value::Object(tables.claude.clone())))?;
        }
        if !changes.codex.is_empty() {
            tables.codex.insert("updatedAt".into(), json!(today));
            tables.codex.insert("current".into(), supplement["codex"]["current"].clone());
            write(&tables_dir().join("codex.json"), &pretty(&Value::Object(tables.codex.clone())))?;
        }
        println!(
            "{}",
            if any {
                format!("Wrote table updates: {merged}")
            } else {
                "Tables already match catalog input/output rates.".into()
            }
        );
    } else if any {
        println!("Supplement catalog merge: {merged}");
    }
    // Always stamped, so the branch sorts newer than the rates a release bundles.
    supplement["updatedAt"] = json!(iso_millis(now));
    let (litellm_body, models_dev_body, supplement_body) = (pretty(&litellm), pretty(&models_dev), pretty(&supplement));
    write(&pack.join("litellm.json"), &litellm_body)?;
    write(&pack.join("models_dev.json"), &models_dev_body)?;
    write(&pack.join("supplement.json"), &supplement_body)?;
    let manifest = json!({
        "schemaVersion": 1,
        "updatedAt": supplement["updatedAt"],
        "files": { "supplement": "supplement.json", "litellm": "litellm.json", "modelsDev": "models_dev.json" },
        "hashes": {
            "supplement": sha256(&supplement_body),
            "litellm": sha256(&litellm_body),
            "modelsDev": sha256(&models_dev_body),
        },
    });
    write(&pack.join("manifest.json"), &pretty(&manifest))?;
    let count = |catalog: &Value| catalog["models"].as_object().map_or(0, Map::len);
    println!(
        "Pack written to {} (LiteLLM {} models, models.dev {} models)",
        pack.display(),
        count(&litellm),
        count(&models_dev)
    );
    Ok(())
}

fn saw(rates: (f64, f64)) -> String {
    format!("{}/{}", aitrack_core::js::number_to_string(rates.0), aitrack_core::js::number_to_string(rates.1))
}

/// Prints each row; returns how many drift from the catalogs and how many they do not list.
fn check_table(heading: &str, table: &Map<String, Value>, providers: &[&str], catalogs: &Catalogs) -> (usize, usize) {
    println!("\n── {heading} ──");
    let (mut drift, mut unverified) = (0, 0);
    for (id, row, finding) in compare_table(table, providers, catalogs) {
        match finding {
            Finding::Ok => println!("✓ {id:<28} {}", summary(row)),
            Finding::Drift { input_ok, output_ok, saw: rates } => {
                drift += 1;
                let ok = |b: bool| if b { "ok" } else { "MISS" };
                println!(
                    "✗ {id:<28} {}  — input={} output={}  (catalog: {})",
                    summary(row),
                    ok(input_ok),
                    ok(output_ok),
                    saw(rates)
                );
            }
            Finding::Unverified => {
                unverified += 1;
                println!("? {id:<28} {}  — not in catalogs ({}/{id})", summary(row), providers.join("|"));
            }
        }
    }
    (drift, unverified)
}

fn pricing_check() -> Result<bool> {
    let supplement = Tables::read(&tables_dir())?.supplement()?;
    println!("Fetching LiteLLM + models.dev for compare…");
    let (litellm, models_dev) =
        fetch_catalogs(&UreqClient::default(), Timestamp::now()).map_err(|e| format!("Catalog fetch failed: {e}"))?;
    let catalogs = Catalogs::from_compact(&litellm, &models_dev)?;
    let empty = Map::new();
    let table = |pointer: &str| supplement.pointer(pointer).and_then(Value::as_object).unwrap_or(&empty);
    let claude =
        check_table("Claude (LiteLLM anthropic/* + models.dev)", table("/claude/models"), &["anthropic"], &catalogs);
    let codex =
        check_table("Codex current (LiteLLM openai/* + models.dev)", table("/codex/current"), &["openai"], &catalogs);

    println!("\n── Cursor natives (supplement is authoritative; catalogs are informational) ──");
    let (mut ok, mut overrides, mut only) = (0, 0, 0);
    for (id, row, finding) in compare_table(table("/cursor/models"), &CURSOR_PROVIDERS, &catalogs) {
        match finding {
            Finding::Ok => {
                ok += 1;
                println!("✓ {id:<28} {}", summary(row));
            }
            Finding::Drift { saw: rates, .. } => {
                overrides += 1;
                println!("i {id:<28} {}  — catalog {} (supplement wins)", summary(row), saw(rates));
            }
            Finding::Unverified => only += 1,
        }
    }
    println!("  ({ok} match catalogs, {overrides} intentional overrides, {only} supplement-only)");

    let (drift, unverified) = (claude.0 + codex.0, claude.1 + codex.1);
    println!();
    if drift > 0 {
        println!("{drift} model(s) drift from catalogs — update the tables or run: cargo xtask pricing-pack --write");
    } else if unverified > 0 {
        println!(
            "No drift on verified models; {unverified} Claude/Codex model(s) not in catalogs (aliases/historical OK)."
        );
    } else {
        println!("All verified pricing matches LiteLLM / models.dev catalogs.");
    }
    Ok(drift == 0)
}

const USAGE: &str = "Usage: cargo xtask <command>
  pricing-pack [--write] [--offline]   rebuild the pricing pack (and tables with --write)
  pricing-check                        compare the tables with LiteLLM and models.dev
  version                              print the workspace version
  release [bump|version] [--dry-run]   bump, changelog, commit, tag and push from main
  release-notes <tag> [changelog]      print one changelog section
  updater-manifest <tag> <dir> [repo]  print latest.json for the signed installers in <dir>
  homebrew-cask <tag> <dmg>            print Casks/opentrack.rb
  winget-manifest <tag> <setup-exe> [out]
  npm-pack <version> <binaries-dir> <out-dir>
  publish-npm <tag> <tarball-dir>
  updater-artifacts <packager-out> <bundle-dir>
  smoke-bundle                         start the app inside each built installer";

fn print(text: &str) -> bool {
    print!("{text}");
    true
}

fn dispatch(args: &[String]) -> Option<Result<bool>> {
    let has = |flag: &str| args.iter().any(|a| a == flag);
    let arg = |i: usize| args.get(i).map(String::as_str);
    let version = || {
        let toml = std::fs::read_to_string(root().join("Cargo.toml")).map_err(|e| e.to_string())?;
        release::workspace_version(&toml)
    };
    Some(match (arg(0)?, arg(1), arg(2), arg(3)) {
        ("pricing-pack", ..) => pricing_pack(has("--write"), has("--offline")).map(|()| true),
        ("pricing-check", ..) => pricing_check(),
        ("version", ..) => version().map(|v| print(&format!("{v}\n"))),
        ("release", ..) => release::release(&args[1..]).map(|()| true),
        ("release-notes", Some(tag), changelog, _) => {
            let path = changelog.unwrap_or("CHANGELOG.md");
            std::fs::read_to_string(path)
                .map_err(|e| format!("{path}: {e}"))
                .and_then(|log| release::release_notes(&log, tag))
                .map(|notes| print(&notes))
        }
        ("updater-manifest", Some(tag), Some(dir), repo) => {
            let repo = repo.map(str::to_owned).or_else(|| std::env::var("GITHUB_REPOSITORY").ok())?;
            manifests::updater_manifest(tag, Path::new(dir), &repo, &iso_millis(Timestamp::now()))
                .map(|manifest| print(&pricing::pretty(&manifest)))
        }
        ("homebrew-cask", Some(tag), Some(dmg), _) => sha256_file(Path::new(dmg))
            .map(|sha| print(&manifests::homebrew_cask(manifests::version_from_tag(tag), &sha))),
        ("winget-manifest", Some(tag), Some(installer), out) => {
            manifests::write_winget(tag, Path::new(installer), Path::new(out.unwrap_or(".")))
                .map(|dir| print(&format!("{}\n", dir.display())))
        }
        ("npm-pack", Some(version), Some(binaries), Some(out)) => {
            npm::pack(version, Path::new(binaries), Path::new(out)).map(|packs| {
                for pack in packs {
                    println!("{}", pack.display());
                }
                true
            })
        }
        ("publish-npm", Some(tag), Some(dir), _) => {
            let cwd = std::env::current_dir().map_err(|e| e.to_string());
            cwd.and_then(|cwd| npm::publish(tag, dir, Path::new("npm"), &cwd)).map(|()| true)
        }
        ("updater-artifacts", Some(out), Some(bundle), None) => {
            updater_artifacts::run(Path::new(out), Path::new(bundle)).map(|()| true)
        }
        ("smoke-bundle", ..) => version().and_then(|v| smoke::smoke_bundle(&v)).map(|()| true),
        _ => return None,
    })
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(result) = dispatch(&args) else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    match result {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}

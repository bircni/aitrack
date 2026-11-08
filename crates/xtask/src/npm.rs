//! `cargo xtask npm-pack` and `publish-npm`: the launcher plus one package per platform binary.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{Map, Value, json};

use crate::manifests::version_from_tag;
use crate::{Result, cmd, io, pretty, read_json, root};

/// npm's own fixed mtime, so a pack is reproducible.
const NPM_MTIME: u64 = 499_162_500;

/// `<platform>-<arch>` to the npm package holding that binary, as the launcher resolves it, in order.
pub fn targets() -> Result<Vec<(String, String)>> {
    let Value::Object(map) = read_json(&root().join("npm/aitrack/targets.json"))? else {
        return Err("npm/aitrack/targets.json is not an object".into());
    };
    map.into_iter()
        .map(|(target, name)| match name {
            Value::String(name) => Ok((target, name)),
            _ => Err(format!("targets.json: {target} does not name a package")),
        })
        .collect()
}

/// The release asset and the file inside the platform package.
pub fn binary_name(target: &str) -> (String, String) {
    let exe = if target.starts_with("win32-") { ".exe" } else { "" };
    (format!("aitrack-{target}{exe}"), format!("aitrack{exe}"))
}

/// `npm pack`'s file name: a scope's `@` dropped and its `/` turned into `-`.
pub fn tarball_name(name: &str, version: &str) -> String {
    format!("{}-{version}.tgz", name.trim_start_matches('@').replacen('/', "-", 1))
}

/// Platform packages first: the launcher pins their exact version.
pub fn publish_order() -> Result<Vec<String>> {
    let mut names: Vec<String> = targets()?.into_iter().map(|(_, name)| name).collect();
    names.push("aitrack".into());
    Ok(names)
}

/// A gzipped tar with every file under `package/`, as `npm pack` writes it.
fn write_tarball(path: &Path, files: &[(&str, Vec<u8>, u32)]) -> Result<()> {
    let file = std::fs::File::create(path).map_err(io(path))?;
    let mut tar = tar::Builder::new(flate2::write::GzEncoder::new(file, flate2::Compression::best()));
    for (name, data, mode) in files {
        let mut header = tar::Header::new_ustar();
        header.set_size(data.len() as u64);
        header.set_mode(*mode);
        header.set_mtime(NPM_MTIME);
        header.set_entry_type(tar::EntryType::Regular);
        tar.append_data(&mut header, format!("package/{name}"), data.as_slice()).map_err(|e| e.to_string())?;
    }
    tar.into_inner().and_then(flate2::write::GzEncoder::finish).and_then(|mut f| f.flush()).map_err(|e| e.to_string())
}

fn read(path: &Path) -> Result<Vec<u8>> {
    std::fs::read(path).map_err(io(path))
}

/// Builds the launcher and one package per platform from the release binaries.
pub fn pack(version: &str, binaries: &Path, out: &Path) -> Result<Vec<PathBuf>> {
    let targets = targets()?;
    for (target, _) in &targets {
        let path = binaries.join(binary_name(target).0);
        if !path.exists() {
            return Err(format!("Missing binary: {}", path.display()));
        }
    }
    let Value::Object(launcher) = read_json(&root().join("npm/aitrack/package.json"))? else {
        return Err("npm/aitrack/package.json is not an object".into());
    };
    std::fs::create_dir_all(out).map_err(io(out))?;
    let mut written = Vec::new();
    for (target, name) in &targets {
        let (os, cpu) = target.split_once('-').ok_or_else(|| format!("bad target {target}"))?;
        let (asset, file) = binary_name(target);
        let mut manifest = json!({
            "name": name,
            "version": version,
            "description": format!("The aitrack binary for {target}; install aitrack instead."),
            "homepage": launcher["homepage"],
            "license": launcher["license"],
            "author": launcher["author"],
            "repository": launcher["repository"],
            "os": [os],
            "cpu": [cpu],
            "files": [format!("bin/{file}")],
            "publishConfig": launcher["publishConfig"],
        });
        if os == "linux" {
            manifest["libc"] = json!(["glibc"]);
        }
        let path = out.join(tarball_name(name, version));
        write_tarball(
            &path,
            &[
                ("package.json", pretty(&manifest).into_bytes(), 0o644),
                (&format!("bin/{file}"), read(&binaries.join(asset))?, 0o755),
            ],
        )?;
        written.push(path);
    }
    let mut manifest = launcher.clone();
    manifest.insert("version".into(), json!(version));
    let pins: Map<String, Value> = targets.into_iter().map(|(_, name)| (name, json!(version))).collect();
    manifest.insert("optionalDependencies".into(), Value::Object(pins));
    let path = out.join(tarball_name("aitrack", version));
    write_tarball(
        &path,
        &[
            ("package.json", pretty(&Value::Object(manifest)).into_bytes(), 0o644),
            ("bin/aitrack.js", read(&root().join("npm/aitrack/bin/aitrack.js"))?, 0o755),
            ("targets.json", read(&root().join("npm/aitrack/targets.json"))?, 0o644),
            ("README.md", read(&root().join("README.md"))?, 0o644),
        ],
    )?;
    written.push(path);
    Ok(written)
}

/// Publishes in order with provenance, skipping what the registry has; a prerelease goes to `next`.
pub fn publish(tag: &str, directory: &str, npm: &Path, cwd: &Path) -> Result<()> {
    let version = version_from_tag(tag);
    // The leading ./ stops npm reading the path as a GitHub shorthand.
    let tarballs: Vec<(String, String)> = publish_order()?
        .into_iter()
        .map(|name| {
            let path = format!("./{directory}/{}", tarball_name(&name, version));
            (name, path)
        })
        .collect();
    if let Some((_, missing)) = tarballs.iter().find(|(_, path)| !cwd.join(path).exists()) {
        return Err(format!("Missing tarball: {missing}"));
    }
    for (name, path) in &tarballs {
        let view = cmd(&npm.to_string_lossy(), &["view", &format!("{name}@{version}"), "version"], Some(cwd));
        if view.is_ok_and(|published| published == version) {
            println!("{name}@{version} is already on the registry, skipping.");
            continue;
        }
        let mut publish = Command::new(npm);
        publish.current_dir(cwd).args(["publish", path, "--provenance"]);
        // npm refuses a prerelease without a dist-tag, so it can never become `latest`.
        if version.contains('-') {
            publish.args(["--tag", "next"]);
        }
        let status = publish.status().map_err(|e| format!("npm: {e}"))?;
        if !status.success() {
            return Err(format!("npm publish failed for {path}"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names() -> Vec<String> {
        publish_order().unwrap().iter().map(|n| tarball_name(n, "1.2.3").replace("-1.2.3.tgz", "")).collect()
    }

    #[test]
    fn names_packages_and_assets_like_npm() {
        assert_eq!(tarball_name("@aitrack/cli-linux-x64", "1.0.0"), "aitrack-cli-linux-x64-1.0.0.tgz");
        assert_eq!(binary_name("win32-x64"), ("aitrack-win32-x64.exe".into(), "aitrack.exe".into()));
        assert_eq!(names().last().unwrap(), "aitrack");
    }

    #[test]
    fn packs_the_launcher_pinned_to_every_platform_package() {
        let dir = tempfile::tempdir().unwrap();
        for (target, _) in targets().unwrap() {
            std::fs::write(dir.path().join(binary_name(&target).0), &target).unwrap();
        }
        let packs = pack("1.2.3", dir.path(), &dir.path().join("out")).unwrap();
        assert_eq!(packs.len(), targets().unwrap().len() + 1);
        let launcher = packs.last().unwrap();
        let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(std::fs::File::open(launcher).unwrap()));
        let mut entries = Vec::new();
        for entry in archive.entries().unwrap() {
            let mut entry = entry.unwrap();
            let path = entry.path().unwrap().to_string_lossy().into_owned();
            let mut body = String::new();
            std::io::Read::read_to_string(&mut entry, &mut body).unwrap();
            entries.push((path, entry.header().mode().unwrap(), body));
        }
        let paths: Vec<&str> = entries.iter().map(|(p, _, _)| p.as_str()).collect();
        assert_eq!(
            paths,
            ["package/package.json", "package/bin/aitrack.js", "package/targets.json", "package/README.md"]
        );
        assert_eq!(entries[1].1, 0o755);
        let manifest: Value = serde_json::from_str(&entries[0].2).unwrap();
        assert_eq!(manifest["version"], "1.2.3");
        assert_eq!(manifest["bin"]["aitrack"], "bin/aitrack.js");
        assert_eq!(manifest["optionalDependencies"]["@aitrack/cli-linux-x64"], "1.2.3");
        assert!(
            pack("1.2.3", &dir.path().join("none"), &dir.path().join("out")).unwrap_err().starts_with("Missing binary")
        );
    }

    #[cfg(unix)]
    mod publishing {
        use std::os::unix::fs::PermissionsExt;

        use super::*;

        /// Only `npm view` answers from the list and only `npm publish` is logged.
        fn fake_npm(published: &str, fail: &str, log: &Path) -> String {
            format!(
                r#"#!/bin/sh
if [ "$1" = view ]; then
  case " {published} " in *" $2 "*) echo "${{2##*@}}"; exit 0 ;; esac
  exit 1
fi
echo "$*" >> "{}"
case "$2" in */"{fail}"-*) exit 1 ;; esac
"#,
                log.display()
            )
        }

        fn run(version: &str, published: &str, fail: &str, tarballs: bool) -> (Result<()>, Vec<String>) {
            let dir = tempfile::tempdir().unwrap();
            let log = dir.path().join("npm.log");
            std::fs::write(&log, "").unwrap();
            let npm = dir.path().join("npm");
            let fail = if fail.is_empty() { "nothing-fails" } else { fail };
            std::fs::write(&npm, fake_npm(published, fail, &log)).unwrap();
            std::fs::set_permissions(&npm, std::fs::Permissions::from_mode(0o755)).unwrap();
            std::fs::create_dir(dir.path().join("packs")).unwrap();
            if tarballs {
                for name in publish_order().unwrap() {
                    std::fs::write(dir.path().join("packs").join(tarball_name(&name, version)), "").unwrap();
                }
            }
            let result = publish(&format!("v{version}"), "packs", &npm, dir.path());
            let calls = std::fs::read_to_string(&log).unwrap().lines().map(str::to_owned).collect();
            (result, calls)
        }

        fn published(version: &str, names: &[String], extra: &str) -> Vec<String> {
            names.iter().map(|n| format!("publish ./packs/{n}-{version}.tgz --provenance{extra}")).collect()
        }

        #[test]
        fn publishes_platforms_before_the_launcher_and_resumes_and_stops() {
            let all = names();
            let (result, calls) = run("1.2.3", "", "", true);
            assert!(result.is_ok());
            assert_eq!(calls, published("1.2.3", &all, ""));

            let (_, calls) = run("1.2.3-0", "", "", true);
            assert_eq!(calls.last().unwrap(), "publish ./packs/aitrack-1.2.3-0.tgz --provenance --tag next");

            let order = publish_order().unwrap();
            let done = format!("{}@1.2.3 {}@1.2.3", order[0], order[1]);
            let (result, calls) = run("1.2.3", &done, "", true);
            assert!(result.is_ok());
            assert_eq!(calls, published("1.2.3", &all[2..], ""));

            let (result, calls) = run("1.2.3", "", &all[1], true);
            assert!(result.is_err());
            assert_eq!(calls, published("1.2.3", &all[..2], ""));

            let (result, calls) = run("1.2.3", "", "", false);
            assert!(result.unwrap_err().starts_with("Missing tarball: ./packs/"));
            assert!(calls.is_empty());
        }
    }

    /// The npm credential belongs to the one job that runs only the repo's own publish step.
    #[test]
    fn keeps_the_publish_workflow_credential_isolated() {
        let workflow = std::fs::read_to_string(root().join(".github/workflows/publish.yml")).unwrap();
        let mut jobs: Vec<(String, String)> = Vec::new();
        for line in workflow[workflow.find("\njobs:\n").unwrap() + 7..].lines() {
            let is_job = line.starts_with("  ") && !line.starts_with("   ") && line.trim_end().ends_with(':');
            if is_job {
                jobs.push((line.trim().trim_end_matches(':').to_owned(), String::new()));
            } else if let Some((_, body)) = jobs.last_mut() {
                body.push_str(line);
                body.push('\n');
            }
        }
        let job = |name: &str| jobs.iter().find(|(n, _)| n == name).map_or("", |(_, b)| b.as_str());
        let credentialed: Vec<&str> =
            jobs.iter().filter(|(_, b)| b.contains("id-token: write")).map(|(n, _)| n.as_str()).collect();
        assert_eq!(credentialed, ["publish"]);
        assert!(!job("publish").contains("validate"));
        assert!(job("publish").contains("needs: draft-release"));
        assert!(job("draft-release").contains("needs: [npm-tarballs, opentrack]"));
    }
}

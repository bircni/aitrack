//! The settings every machine can use, shared through the aitrack data repo: the newest change wins.

use aitrack_core::error::Error;
use aitrack_core::git::{commit_and_push_shared_settings, is_cloned};
use aitrack_core::store::shared_settings::{read_shared_settings, write_shared_settings, SharedSettings};
use aitrack_core::time::iso_millis;
use aitrack_core::Core;

use crate::settings::Settings;
use crate::usage::GIT_TIMEOUT;

fn take_newer(core: &Core, settings: &mut Settings) -> Result<Option<SharedSettings>, Error> {
    let shared = read_shared_settings(core)?;
    let newer = |shared: &&SharedSettings| settings.shared_time().is_none_or(|own| shared.updated_at > own);
    if let Some(shared) = shared.as_ref().filter(newer) {
        *settings = settings.with_shared(&shared.settings);
        settings.shared_at = Some(iso_millis(shared.updated_at));
    }
    Ok(shared)
}

/// Takes the clone's shared settings when they are newer than `settings`; with `push`, shares
/// `settings` when they are the newer ones. `settings` holds the outcome even when the push fails.
pub fn reconcile(core: &Core, settings: &mut Settings, push: bool) -> Result<(), String> {
    let Some(config) = core.try_load_config().filter(|_| is_cloned(core)) else { return Ok(()) };
    let reconciled: Result<(), Error> = core.with_repo_lock(|guard| {
        let shared = take_newer(core, settings)?;
        // Once encrypted it stays so: another machine's config may not ask for it.
        let encrypt = config.encrypt_data == Some(true) || shared.as_ref().is_some_and(|shared| shared.encrypted);
        let same = shared
            .as_ref()
            .is_some_and(|shared| shared.encrypted == encrypt && settings.with_shared(&shared.settings) == *settings);
        if !push || same {
            return Ok(());
        }
        let updated_at = settings.shared_time().unwrap_or_else(|| core.clock.now());
        settings.shared_at = Some(iso_millis(updated_at));
        let mut merged = shared.map(|shared| shared.settings).unwrap_or_default();
        merged.extend(settings.shared());
        write_shared_settings(core, updated_at, &merged, encrypt)?;
        let git = guard.git().clone().with_timeout(Some(GIT_TIMEOUT));
        let pushed = commit_and_push_shared_settings(core, guard, &git);
        take_newer(core, settings)?; // The push may have replayed this commit under another machine's newer one.
        Ok(pushed.map(|_| ())?)
    });
    reconciled.map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::process::Command;

    use aitrack_core::env::Env;
    use aitrack_core::git::pull;
    use aitrack_core::output::VecOutput;
    use aitrack_core::time::Clock;

    use super::*;

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git").args(args).current_dir(dir).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_owned()
    }

    struct Machine {
        home: PathBuf,
        settings: Settings,
    }

    impl Machine {
        fn new(root: &Path, name: &str, config: &str) -> Self {
            let home = root.join(name);
            let app = home.join(".config/aitrack");
            std::fs::create_dir_all(&app).unwrap();
            let remote = root.join("remote.git").to_string_lossy().into_owned();
            let mut config: serde_json::Value = serde_json::from_str(config).unwrap();
            config["repoUrl"] = remote.as_str().into();
            config["machineId"] = name.into();
            std::fs::write(app.join("config.json"), config.to_string()).unwrap();
            git(&app, &["clone", "-q", &remote, "repo"]);
            git(&app.join("repo"), &["config", "user.email", "test@example.invalid"]);
            git(&app.join("repo"), &["config", "user.name", "Test"]);
            git(&app.join("repo"), &["config", "core.autocrlf", "false"]); // Windows runners check out CRLF.
            Self { home, settings: Settings { sync: true, ..Settings::default() } }
        }

        fn core(&self, now: &str, passphrase: Option<&str>) -> Core {
            let vars = passphrase.map(|p| ("AITRACK_ENCRYPTION_PASSPHRASE", p));
            let clock = Clock::fixed(now.parse().unwrap(), "UTC").unwrap();
            Core::new(Env::new(&self.home, vars), clock, Box::new(VecOutput::default()))
        }

        /// A pull, then what the app does after one (`push` false) or on the sync button.
        fn sync(&mut self, now: &str, passphrase: Option<&str>, push: bool) -> Result<(), String> {
            let core = self.core(now, passphrase);
            core.with_repo_lock(|guard| pull(&core, guard, guard.git())).unwrap();
            reconcile(&core, &mut self.settings, push)
        }

        fn change(&mut self, now: &str, change: impl FnOnce(&mut Settings)) {
            let mut changed = self.settings.clone();
            change(&mut changed);
            self.settings = changed.dated(&self.settings, now.parse().unwrap());
        }

        fn file(&self) -> String {
            std::fs::read_to_string(self.home.join(".config/aitrack/repo/opentrack/settings.json")).unwrap()
        }
    }

    #[test]
    fn shares_the_newest_settings_between_machines_and_keeps_each_machines_own() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("remote.git")).unwrap();
        git(&root.path().join("remote.git"), &["init", "--bare", "-q", "-b", "main"]);
        let mut desk = Machine::new(root.path(), "desk", "{}");
        let mut laptop = Machine::new(root.path(), "laptop", r#"{"encryptData":true}"#);
        desk.settings.theme = "dark".into();
        desk.settings.keep_open = true;
        laptop.settings.tray_style = "bars".into();

        desk.sync("2026-06-01T10:00:00Z", None, false).unwrap();
        assert_eq!(desk.settings.shared_at, None, "a pull alone shares nothing");
        desk.sync("2026-06-01T10:00:00Z", None, true).unwrap();
        assert!(desk.file().contains("\"updatedAt\": \"2026-06-01T10:00:00.000Z\""));
        assert!(desk.file().contains("\"theme\": \"dark\"") && !desk.file().contains("keepOpen"));

        laptop.settings.compact = true; // Before it ever saw the repo's settings, so they win.
        laptop.sync("2026-06-01T11:00:00Z", Some("pass"), false).unwrap();
        let taken = Settings {
            theme: "dark".into(),
            tray_style: "bars".into(),
            sync: true,
            shared_at: Some("2026-06-01T10:00:00.000Z".into()),
            ..Settings::default()
        };
        assert_eq!(laptop.settings, taken);

        laptop.change("2026-06-01T12:00:00Z", |s| s.alert_unused = true);
        desk.change("2026-06-01T13:00:00Z", |s| s.display = "left".into());
        laptop.sync("2026-06-01T14:00:00Z", Some("pass"), true).unwrap();
        assert!(laptop.file().contains("\"encrypted\""), "this machine encrypts what it pushes");
        assert!(desk.sync("2026-06-01T14:00:00Z", None, true).unwrap_err().contains("AITRACK_ENCRYPTION_PASSPHRASE"));
        assert_eq!(desk.file(), laptop.file(), "a file that cannot be read is left alone");

        desk.sync("2026-06-01T14:00:00Z", Some("pass"), true).unwrap();
        assert!(desk.file().contains("\"encrypted\""), "and stays encrypted when another machine rewrites it");
        laptop.sync("2026-06-01T15:00:00Z", Some("pass"), true).unwrap();
        assert_eq!(laptop.settings.display, "left");
        assert!(!laptop.settings.alert_unused, "the later change replaced the earlier one");
        assert_eq!(laptop.settings.shared(), desk.settings.shared());
        assert_eq!((laptop.settings.tray_style.as_str(), desk.settings.keep_open), ("bars", true));
        assert_eq!(laptop.file(), desk.file(), "nothing to push once they agree");
    }
}

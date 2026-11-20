//! What's new: this version's changelog section as the desktop app's release notes, and whether the
//! popup still has to point at them.

use std::path::Path;
use std::sync::LazyLock;

use aitrack_core::update::is_newer;

use crate::settings::{NotesMark, Settings};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Written by `cargo xtask release` in the commit it tags, so a release build finds its section.
const CHANGELOG: &str = include_str!("../../../CHANGELOG.md");

const BREAKING: &str = "Breaking Changes";
/// The changelog groups that say something to whoever uses the app.
const GROUPS: [&str; 4] = [BREAKING, "Features", "Bug Fixes", "Performance"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Group {
    pub title: &'static str,
    pub items: Vec<String>,
}

/// An entry as plain text: without its pull request number and code marks.
fn plain(entry: &str) -> String {
    let entry = entry.trim();
    let number = entry.strip_suffix(')').and_then(|rest| rest.rsplit_once(" (#"));
    let text = number.filter(|(_, n)| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())).map_or(entry, |(t, _)| t);
    text.replace('`', "")
}

/// The entries of `version`'s section that concern opentrack: those scoped to it, and breaking
/// changes without a scope. Empty when the changelog has no such section or nothing in it applies.
pub fn notes(changelog: &str, version: &str) -> Vec<Group> {
    let heading = format!("## [v{version}]");
    let section =
        changelog.lines().skip_while(|l| !l.starts_with(&heading)).skip(1).take_while(|l| !l.starts_with("## "));
    let mut groups: Vec<Group> = Vec::new();
    let mut group = None;
    let mut wrapped = false; // The entry above was kept and may run on.
    for line in section {
        if let Some(title) = line.strip_prefix("### ") {
            let title = title.trim_start_matches(|c: char| !c.is_ascii_alphabetic());
            group = GROUPS.into_iter().find(|known| *known == title);
            wrapped = false;
        } else if let Some(entry) = line.strip_prefix("- ") {
            wrapped = false;
            let Some(title) = group else { continue };
            let scoped = entry.strip_prefix("**").and_then(|rest| rest.split_once(":** "));
            let text = match scoped {
                Some((scope, text)) if scope.starts_with("opentrack") => text,
                None if title == BREAKING => entry,
                _ => continue,
            };
            match groups.last_mut() {
                Some(last) if last.title == title => last.items.push(text.to_owned()),
                _ => groups.push(Group { title, items: vec![text.to_owned()] }),
            }
            wrapped = true;
        } else if wrapped && !line.trim().is_empty() {
            if let Some(entry) = groups.last_mut().and_then(|g| g.items.last_mut()) {
                entry.push(' ');
                entry.push_str(line.trim());
            }
        } else {
            wrapped = false;
        }
    }
    for item in groups.iter_mut().flat_map(|g| &mut g.items) {
        *item = plain(item);
    }
    groups
}

/// The running version's notes.
pub fn current() -> &'static [Group] {
    static NOTES: LazyLock<Vec<Group>> = LazyLock::new(|| notes(CHANGELOG, VERSION));
    &NOTES
}

pub fn release_url(version: &str) -> String {
    format!("https://github.com/bircni/aitrack/releases/tag/v{version}")
}

/// Whether the app starts in a data dir no opentrack has used; asked before anything is written.
pub fn is_fresh(data_dir: &Path) -> bool {
    !["settings.json", "cache.json"].iter().any(|file| data_dir.join(file).exists())
}

/// The mark for a version with notes that starts for the first time. An older build run after a
/// newer one keeps the newer mark, so going back up does not announce the same notes again.
fn first_start(mark: Option<&NotesMark>, version: &str, has_notes: bool, fresh: bool) -> Option<NotesMark> {
    let known = mark.is_some_and(|m| m.version == version || is_newer(&m.version, version));
    (has_notes && !known).then(|| NotesMark {
        version: version.to_owned(),
        update: mark.is_some() || !fresh,
        seen: false,
    })
}

/// The settings to save when this start has notes to announce; development builds stay quiet.
pub fn on_start(settings: &Settings, fresh: bool) -> Option<Settings> {
    if cfg!(debug_assertions) {
        return None;
    }
    let mark = first_start(settings.release_notes.as_ref(), VERSION, !current().is_empty(), fresh)?;
    Some(Settings { release_notes: Some(mark), ..settings.clone() })
}

fn banner_for(mark: Option<&NotesMark>, version: &str) -> Option<String> {
    let mark = mark.filter(|m| m.version == version && !m.seen)?;
    Some(if mark.update { format!("Updated to {version}") } else { format!("opentrack {version}") })
}

/// What the dashboard says until the notes are opened or dismissed.
pub fn banner(settings: &Settings) -> Option<String> {
    banner_for(settings.release_notes.as_ref(), VERSION).filter(|_| !current().is_empty())
}

fn dismiss_for(mark: Option<&mut NotesMark>, version: &str) {
    if let Some(mark) = mark.filter(|m| m.version == version) {
        mark.seen = true;
    }
}

pub fn dismiss(settings: &mut Settings) {
    dismiss_for(settings.release_notes.as_mut(), VERSION);
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "# Changelog

## [v6.0.0] - 2027-01-01


### ⚠ Breaking Changes

- Settings from 4.x are
no longer read, see `docs`.
- **aitrack:** Drop --legacy

### Features

- **opentrack:** Add a `What's new` view (#160)
- **cli:** Add a flag (#161)
- Add something unscoped
- **opentrack-ui:** Round (#3) corners

### Tests

- **opentrack:** Cover the view

## [v5.9.0] - 2026-12-01

### Bug Fixes

- **cli:** Fix a flag
- **opentrack:** Keep the tray icon (#150)
";

    fn shown(changelog: &str, version: &str) -> Vec<(&'static str, Vec<String>)> {
        notes(changelog, version).into_iter().map(|g| (g.title, g.items)).collect()
    }

    #[test]
    fn keeps_what_concerns_the_app_from_its_version_as_plain_text() {
        assert_eq!(
            shown(SAMPLE, "6.0.0"),
            [
                ("Breaking Changes", vec!["Settings from 4.x are no longer read, see docs.".to_owned()]),
                ("Features", vec!["Add a What's new view".to_owned(), "Round (#3) corners".to_owned()]),
            ]
        );
        assert_eq!(shown(SAMPLE, "5.9.0"), [("Bug Fixes", vec!["Keep the tray icon".to_owned()])]);
        for (changelog, version) in
            [(SAMPLE, "6.0"), (SAMPLE, "7.0.0"), ("", "6.0.0"), ("## [v1.0.0]\n- **cli:** x", "1.0.0")]
        {
            assert_eq!(notes(changelog, version), [], "{version}");
        }
        let released: Vec<String> = notes(CHANGELOG, "5.2.0").into_iter().flat_map(|g| g.items).collect();
        assert_eq!(released, ["Add a log export to settings", "Sync portable settings through the data repo"]);
        let breaking = &notes(CHANGELOG, "5.0.0")[0];
        assert!(breaking.items[0].starts_with("Node is no longer needed") && breaking.items[0].ends_with("data repo."));
        assert_eq!(release_url("6.0.0-beta.1"), "https://github.com/bircni/aitrack/releases/tag/v6.0.0-beta.1");
    }

    #[test]
    fn announces_a_version_once_until_its_notes_are_opened_or_dismissed() {
        let mark = |version: &str, update, seen| NotesMark { version: version.into(), update, seen };
        let installed = first_start(None, "6.0.0", true, true);
        assert_eq!(installed, Some(mark("6.0.0", false, false)));
        assert_eq!(banner_for(installed.as_ref(), "6.0.0").as_deref(), Some("opentrack 6.0.0"));
        let from_before = first_start(None, "6.0.0", true, false);
        assert_eq!(banner_for(from_before.as_ref(), "6.0.0").as_deref(), Some("Updated to 6.0.0"));
        assert_eq!(first_start(installed.as_ref(), "6.0.0", true, false), None, "a restart keeps what is pending");
        assert_eq!(first_start(None, "6.0.0", false, true), None, "nothing to announce without notes");

        let mut seen = installed;
        dismiss_for(seen.as_mut(), "6.0.0");
        assert_eq!(seen, Some(mark("6.0.0", false, true)));
        assert_eq!(banner_for(seen.as_ref(), "6.0.0"), None);
        assert_eq!(first_start(seen.as_ref(), "6.0.0", true, false), None);
        assert_eq!(first_start(seen.as_ref(), "6.1.0", true, false), Some(mark("6.1.0", true, false)));

        let newer = Some(mark("6.1.0", true, false));
        assert_eq!(first_start(newer.as_ref(), "6.0.0", true, false), None, "a downgrade keeps the newer mark");
        assert_eq!(banner_for(newer.as_ref(), "6.0.0"), None);
        let mut untouched = newer.clone();
        dismiss_for(untouched.as_mut(), "6.0.0");
        assert_eq!(untouched, newer);
        assert_eq!(banner_for(newer.as_ref(), "6.1.0").as_deref(), Some("Updated to 6.1.0"), "back up, still pending");
        let unknown = Some(mark("someday", false, true));
        assert_eq!(first_start(unknown.as_ref(), "6.0.0", true, true), Some(mark("6.0.0", true, false)));
        assert_eq!(banner_for(None, "6.0.0"), None);

        let dir = tempfile::tempdir().unwrap();
        assert!(is_fresh(dir.path()));
        std::fs::write(dir.path().join("cache.json"), "{}").unwrap();
        assert!(!is_fresh(dir.path()));
    }
}

//! The installers a release ships, named as Tauri's bundler named them: Homebrew, winget, 4.x's
//! updater and the smoke test all find them by these names.

use aitrack_core::update;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Installer {
    Dmg,
    /// The `.app` archive the macOS updater downloads.
    AppArchive,
    Nsis,
    AppImage,
    Deb,
}

impl Installer {
    /// The folder under `target/release/bundle` it is laid out in.
    pub const fn dir(self) -> &'static str {
        match self {
            Self::Dmg => "dmg",
            Self::AppArchive => "macos",
            Self::Nsis => "nsis",
            Self::AppImage => "appimage",
            Self::Deb => "deb",
        }
    }

    /// How its file name ends, whatever the version.
    pub const fn suffix(self) -> &'static str {
        match self {
            Self::Dmg => "_aarch64.dmg",
            Self::AppArchive => ".app.tar.gz",
            Self::Nsis => "_x64-setup.exe",
            Self::AppImage => "_amd64.AppImage",
            Self::Deb => "_amd64.deb",
        }
    }

    pub fn file_name(self, version: &str) -> String {
        match self {
            Self::AppArchive => format!("opentrack{}", self.suffix()),
            Self::Dmg | Self::Nsis | Self::AppImage | Self::Deb => format!("opentrack_{version}{}", self.suffix()),
        }
    }
}

/// The updater's platform key for each installer it can install, as `aitrack_core::update` reads them.
/// 4.x's `.deb` installs read `linux-x86_64-deb` and update through pkexec; 5.0 leaves a `.deb` to
/// the package manager.
pub const UPDATER_PLATFORMS: [(&str, Installer); 4] = [
    (update::MAC_TARGET, Installer::AppArchive),
    (update::WINDOWS_TARGET, Installer::Nsis),
    (update::LINUX_TARGET, Installer::AppImage),
    ("linux-x86_64-deb", Installer::Deb),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publishes_every_platform_the_updater_asks_for() {
        if let Ok(target) = update::updater_target() {
            assert!(UPDATER_PLATFORMS.iter().any(|(key, _)| *key == target), "{target}");
        }
    }
}

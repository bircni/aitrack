//! Release versions: precedence for the updater, the parts `cargo xtask release` bumps.

use std::cmp::Ordering;
use std::fmt;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Version {
    pub core: [u64; 3],
    /// Dot-separated prerelease identifiers; empty for a release.
    pub pre: Vec<String>,
}

impl Version {
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        let (core, pre) = text.split_once('-').map_or((text, None), |(c, p)| (c, Some(p)));
        let parts: Vec<u64> = core.split('.').map(|part| part.parse().ok()).collect::<Option<_>>()?;
        let pre: Vec<String> = pre.map(|p| p.split('.').map(str::to_owned).collect()).unwrap_or_default();
        if pre.iter().any(String::is_empty) {
            return None;
        }
        Some(Self { core: parts.try_into().ok()?, pre })
    }
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let [major, minor, patch] = self.core;
        write!(f, "{major}.{minor}.{patch}")?;
        if !self.pre.is_empty() {
            write!(f, "-{}", self.pre.join("."))?;
        }
        Ok(())
    }
}

/// Semver precedence: a prerelease sorts before its release, numeric identifiers compare as numbers.
impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        self.core.cmp(&other.core).then_with(|| match (self.pre.is_empty(), other.pre.is_empty()) {
            (true, true) => Ordering::Equal,
            (true, false) => Ordering::Greater,
            (false, true) => Ordering::Less,
            (false, false) => {
                for (a, b) in self.pre.iter().zip(&other.pre) {
                    let order = match (a.parse::<u64>(), b.parse::<u64>()) {
                        (Ok(a), Ok(b)) => a.cmp(&b),
                        (Ok(_), Err(_)) => Ordering::Less,
                        (Err(_), Ok(_)) => Ordering::Greater,
                        (Err(_), Err(_)) => a.cmp(b),
                    };
                    if order != Ordering::Equal {
                        return order;
                    }
                }
                self.pre.len().cmp(&other.pre.len())
            }
        })
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(text: &str) -> Version {
        Version::parse(text).unwrap()
    }

    #[test]
    fn orders_prereleases_by_semver_precedence() {
        assert!(v("5.0.0-beta.10") > v("5.0.0-beta.9"));
        assert!(v("5.0.0-beta") < v("5.0.0-beta.1"));
        assert!(v("5.0.0-1") < v("5.0.0-alpha"));
        assert!(v("5.0.0") > v("5.0.0-rc.1"));
        assert!(v("4.10.0") > v("4.9.9"));
        assert_eq!(v("5.0.0-beta.2").to_string(), "5.0.0-beta.2");
        assert!(Version::parse("5.0").is_none());
        assert!(Version::parse("5.0.0-").is_none());
    }
}

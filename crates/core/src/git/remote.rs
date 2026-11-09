//! Telling remotes apart however they are written, and keeping tokens out of what is printed.

use super::{Git, is_cloned};
use crate::Core;

/// An HTTPS remote can hold a token, and this output gets pasted into bug reports; an SSH user name is no secret.
#[must_use]
pub fn redact_url(url: &str) -> String {
    let Some(scheme_end) = url.find("://") else { return url.to_owned() };
    let scheme = &url[..scheme_end];
    let valid_scheme = scheme.starts_with(|c: char| c.is_ascii_alphabetic())
        && scheme.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'));
    let rest = &url[scheme_end + 3..];
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let Some(at) = rest[..authority_end].rfind('@') else { return url.to_owned() };
    if !valid_scheme {
        return url.to_owned();
    }
    let userinfo = &rest[..at];
    if scheme.eq_ignore_ascii_case("ssh") && !userinfo.contains(':') {
        return url.to_owned();
    }
    format!("{}://***@{}", &url[..scheme_end], &rest[at + 1..])
}

#[derive(Debug, PartialEq, Eq)]
struct Identity {
    /// Empty for a local path.
    host: String,
    path: String,
    transport: &'static str,
    port: String,
}

fn repo_path(path: &str) -> &str {
    let path = path.trim_end_matches('/');
    path.strip_suffix(".git").unwrap_or(path)
}

fn transport(scheme: &str) -> Option<(&'static str, &'static str)> {
    match scheme.to_ascii_lowercase().as_str() {
        "ssh" | "git+ssh" => Some(("ssh", "22")),
        "http" => Some(("http", "80")),
        "https" => Some(("http", "443")),
        "git" => Some(("git", "9418")),
        _ => None,
    }
}

/// `scheme://[user@]host[:port][/path]`, as `/^([a-z][a-z\d+.-]*):\/\/(?:[^/?#]*@)?(\[[^\]]*\]|[^/:?#]*)(?::(\d+))?(\/.*)?$/iu` reads it.
fn parse_full(url: &str) -> Option<(&str, &str, Option<&str>, &str)> {
    let (scheme, rest) = url.split_once("://")?;
    let scheme_ok = scheme.starts_with(|c: char| c.is_ascii_alphabetic())
        && scheme.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'));
    if !scheme_ok {
        return None;
    }
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (mut authority, path) = rest.split_at(authority_end);
    if path.starts_with(['?', '#']) {
        return None;
    }
    if let Some(at) = authority.rfind('@') {
        authority = &authority[at + 1..];
    }
    let (host, port) = if authority.starts_with('[') {
        let close = authority.find(']')?;
        let (host, after) = authority.split_at(close + 1);
        match after.strip_prefix(':') {
            Some(port) => (host, Some(port)),
            None if after.is_empty() => (host, None),
            None => return None,
        }
    } else {
        match authority.split_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (authority, None),
        }
    };
    if port.is_some_and(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit())) {
        return None;
    }
    Some((scheme, host, port, path))
}

fn identity(url: &str) -> Identity {
    let full = parse_full(url);
    if let Some((scheme, host, port, path)) = full {
        if let Some((name, default_port)) = transport(scheme) {
            return Identity {
                host: host.to_lowercase(),
                path: repo_path(path).trim_start_matches('/').to_owned(),
                transport: name,
                port: if port == Some(default_port) { String::new() } else { port.unwrap_or_default().to_owned() },
            };
        }
        if scheme.eq_ignore_ascii_case("file") {
            return Identity {
                host: String::new(),
                path: repo_path(path).to_owned(),
                transport: "file",
                port: String::new(),
            };
        }
    }
    // Scp form, as git reads it: a colon before any slash. One letter is a Windows drive.
    if full.is_none()
        && let Some((host, path)) = scp(url)
    {
        return Identity {
            host: host.to_lowercase(),
            path: repo_path(path).trim_start_matches('/').to_owned(),
            transport: "ssh",
            port: String::new(),
        };
    }
    Identity { host: String::new(), path: repo_path(url).to_owned(), transport: "file", port: String::new() }
}

/// `/^(?:[^/@:]+@)?(\[[^\]]+\]|[^/:@]{2,}):(.*)$/u`
fn scp(url: &str) -> Option<(&str, &str)> {
    let starts = [url.find('@').filter(|&at| at > 0 && !url[..at].contains(['/', ':'])).map(|at| at + 1), Some(0)];
    starts.into_iter().flatten().find_map(|start| {
        let rest = &url[start..];
        if rest.starts_with('[') {
            let close = rest.find(']')?;
            let after = rest[close + 1..].strip_prefix(':')?;
            (close > 1).then_some((&rest[..=close], after))
        } else {
            let colon = rest.find(':')?;
            let host = &rest[..colon];
            (host.chars().count() >= 2 && !host.contains(['/', ':', '@'])).then_some((host, &rest[colon + 1..]))
        }
    })
}

/// Whether two URLs name one repository. A port only tells servers apart over one transport.
#[must_use]
pub fn same_remote(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let (left, right) = (identity(a), identity(b));
    left.host == right.host && left.path == right.path && (left.transport != right.transport || left.port == right.port)
}

/// The clone's origin when it is not `url`; `None` without a clone, an unreadable origin, or an empty url.
pub fn differing_origin(core: &Core, git: &Git, url: &str) -> Option<String> {
    if url.is_empty() || !is_cloned(core) {
        return None;
    }
    git.clone_origin_url().filter(|origin| !same_remote(origin, url))
}

#[must_use]
pub fn origin_mismatch_message(origin: &str, repo_url: &str) -> String {
    format!(
        "The local clone pushes to {}, but repoUrl is {}. To move to repoUrl, run: aitrack init --repo <url> (replaces the clone after asking). To stay on the clone's remote, run: aitrack config set repoUrl <url>.",
        redact_url(origin),
        redact_url(repo_url)
    )
}

#[cfg(test)]
mod tests {
    use super::{redact_url, same_remote};

    #[test]
    fn matches_the_typescript_library_for_every_fixture_remote() {
        let rows: Vec<(String, String, Vec<String>)> =
            serde_json::from_str(include_str!("../../tests/fixtures/js/remotes.json")).unwrap();
        let urls: Vec<&str> = rows.iter().map(|(url, ..)| url.as_str()).collect();
        for (url, redacted, same) in &rows {
            assert_eq!(&redact_url(url), redacted, "redact {url}");
            let ours: Vec<&str> = urls.iter().copied().filter(|other| same_remote(url, other)).collect();
            assert_eq!(ours, same.iter().map(String::as_str).collect::<Vec<_>>(), "same remote as {url}");
        }
    }
}

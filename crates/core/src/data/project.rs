use crate::js;

pub const NO_REMOTE_PROJECT: &str = "(no remote)";
pub const UNATTRIBUTED_PROJECT: &str = "(unattributed)";
/// The one model row of a project-scoped report, which has no per-model split.
pub const ALL_MODELS: &str = "(all models)";

/// `owner/repo` for a git remote (ssh, scp-like or http(s)), or `None` when it names none.
/// Host, credentials, ports and local paths are never kept.
#[must_use]
pub fn normalize_remote_url(url: &str) -> Option<String> {
    let text = js::trim(url);
    if let Some(path) = scp_like_path(text) {
        return owner_and_repo(path);
    }
    owner_and_repo(&js::decode_uri_component(&url_pathname(text)?)?)
}

/// The path of `[user@]host:path`, as `/^(?:[^@/\s]+@)?([^:/\s]{2,}):(?!\/\/)(.+)$/u` captures it.
fn scp_like_path(text: &str) -> Option<&str> {
    let user_end = text
        .find('@')
        .filter(|&at| at > 0 && !text[..at].contains(|c: char| c == '/' || js::is_space(c)))
        .map(|at| at + 1);
    [user_end, Some(0)].into_iter().flatten().find_map(|start| {
        let rest = &text[start..];
        let colon = rest.find(':')?;
        let host = &rest[..colon];
        let path = &rest[colon + 1..];
        let host_ok = host.chars().count() >= 2 && !host.contains(|c: char| c == '/' || js::is_space(c));
        let path_ok =
            !path.is_empty() && !path.starts_with("//") && !path.contains(['\n', '\r', '\u{2028}', '\u{2029}']);
        (host_ok && path_ok).then_some(path)
    })
}

/// The WHATWG `URL.pathname` of a hierarchical URL with a non-empty host, still percent-encoded.
fn url_pathname(text: &str) -> Option<String> {
    let text: String = text.chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).collect();
    let colon = text.find(':')?;
    let scheme = text[..colon].to_ascii_lowercase();
    let scheme_ok = scheme.starts_with(|c: char| c.is_ascii_alphabetic())
        && scheme.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
    if !scheme_ok || scheme == "file" {
        return None; // A file URL has no host.
    }
    let special = matches!(scheme.as_str(), "http" | "https" | "ws" | "wss" | "ftp");
    let mut rest = text[colon + 1..].to_owned();
    if special {
        rest = rest.replace('\\', "/");
        rest = rest.trim_start_matches('/').to_owned();
    } else {
        rest = rest.strip_prefix("//")?.to_owned();
    }
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    let host_and_port = authority.rsplit_once('@').map_or(authority, |(_, host)| host);
    let (host, port) = match host_and_port.rsplit_once(':') {
        Some((host, port)) if !host.ends_with(']') || host.starts_with('[') => (host, port),
        _ => (host_and_port, ""),
    };
    let port_ok =
        port.is_empty() || (port.chars().all(|c| c.is_ascii_digit()) && port.parse::<u32>().is_ok_and(|p| p <= 65_535));
    let host_ok = !host.is_empty() && !host.contains(|c: char| js::is_space(c) || "<>[]^|\\%".contains(c));
    if !(port_ok && host_ok) {
        return None;
    }
    let path = &rest[end..];
    let path = &path[..path.find(['?', '#']).unwrap_or(path.len())];
    let mut segments: Vec<&str> = Vec::new();
    for segment in path.split('/').skip(1) {
        match segment.to_ascii_lowercase().as_str() {
            "." | "%2e" => {}
            ".." | ".%2e" | "%2e." | "%2e%2e" => {
                segments.pop();
            }
            _ => segments.push(segment),
        }
    }
    Some(format!("/{}", segments.join("/")))
}

fn owner_and_repo(path: &str) -> Option<String> {
    let path = path.trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let segments: Vec<&str> = path.split('/').filter(|segment| !segment.is_empty() && *segment != "~").collect();
    let [.., owner, repo] = segments.as_slice() else { return None };
    let bad = |part: &str| part.contains(js::is_space) || part == "." || part == "..";
    if bad(owner) || bad(repo) {
        return None;
    }
    Some(format!("{owner}/{repo}").to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::normalize_remote_url;

    #[test]
    fn matches_the_typescript_library_for_every_fixture_url() {
        let rows: Vec<(String, Option<String>)> =
            serde_json::from_str(include_str!("../../tests/fixtures/js/remote-urls.json")).unwrap();
        for (url, expected) in rows {
            assert_eq!(normalize_remote_url(&url), expected, "{url:?}");
        }
    }
}

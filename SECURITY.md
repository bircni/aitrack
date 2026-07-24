# Security & privacy

## What leaves your machine

| Action                                      | Data sent                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aitrack sync`                              | Claude Code and Codex usage JSON is committed and pushed to **your** git remote (the repo you configured in `init`).                                                                                                                                                                                                   |
| Provider-aware command with Cursor selected | Reads `cursorAuth/accessToken` from local Cursor `state.vscdb`, then requests the usage CSV from `CURSOR_WEB_BASE_URL` (`https://cursor.com` by default). aitrack requires a credential-free HTTPS URL, but any configured origin receives the token in request headers. The token is never written to your data repo. |

## What stays local

- **Cursor usage** is never synced to git. It is available only from the current machine when Cursor is selected for `show`, `usage`, `export`, `top`, or `daemon`.
- `aitrack doctor` reads the local Cursor auth state to report whether a token exists, but does not request the usage export.
- Config (`~/.config/aitrack/config.json`) stays on disk locally. It can contain the git remote URL, machine ID, additional Claude/Codex source paths, and daemon defaults; none of the config file itself is copied into the data repo.

## Recommendations

- Use a **private** git repository for your usage data.
- Provider-aware commands select Cursor by default. Pass `--providers claude,codex` if you do not want Cursor credential access or network requests (for example, `npx aitrack show --providers claude,codex`).
- Override `CURSOR_WEB_BASE_URL` only with an HTTPS origin you trust; that origin receives the Cursor access token.
- Do not commit your data repo URL or machine JSON files into this project’s source tree.

## Reporting vulnerabilities

If you find a security issue in aitrack itself, please
[report it privately through GitHub Security Advisories](https://github.com/bircni/aitrack/security/advisories/new).
Do not disclose sensitive details in a public issue.

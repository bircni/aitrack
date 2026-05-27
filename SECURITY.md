# Security & privacy

## What leaves your machine

| Action                  | Data sent                                                                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aitrack sync`          | Claude Code and Codex usage JSON is committed and pushed to **your** git remote (the repo you configured in `init`).                                                                                                |
| `aitrack show` (Cursor) | Reads `cursorAuth/accessToken` from local Cursor `state.vscdb`, then requests Cursor’s usage CSV export over HTTPS. Token is used only for that request; it is not written to your data repo or sent anywhere else. |

## What stays local

- **Cursor usage** is never synced to git. It is merged only when you run `show` on a machine that has Cursor installed.
- Config (`~/.config/aitrack/config.json`) stays on disk locally; only the repo URL is stored there.

## Recommendations

- Use a **private** git repository for your usage data.
- Run `npx aitrack show --no-cursor` if you do not want Cursor auth or network access (offline, CI, or privacy).
- Do not commit your data repo URL or machine JSON files into this project’s source tree.

## Reporting vulnerabilities

If you find a security issue in aitrack itself, please open a [GitHub issue](https://github.com/bircni/aitrack/issues) or contact the maintainers privately. Do not disclose sensitive details in a public issue until a fix is available.

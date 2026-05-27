# aitrack

Sync your AI coding assistant usage across multiple machines and visualize it as a combined heatmap, without being locked to one PC.

Each machine pushes a single JSON file to a git repository you own. Any machine can then pull all files and render a merged heatmap PNG.

Uses your locally installed `git` for all sync operations — no API tokens required for git. Any auth that already works in your terminal (SSH keys, credential manager, etc.) will work here too.

**Supported providers (synced via git):**

- Claude Code
- Codex (OpenAI)

**Cursor** usage appears only in `aitrack show`, on the machine where you run it: it reads your local Cursor login from `state.vscdb` and fetches usage from Cursor’s dashboard CSV export. Cursor data is **never** written to your data repo.

---

## Quick start

You can preview usage **before** running `init` or `sync`:

```
npx aitrack tui     # stats table from local Claude/Codex (+ Cursor if available)
npx aitrack show    # heatmap PNG from the same local-first read
```

Local Claude/Codex data is staged at `~/.config/aitrack/pending/data/{machineId}.json` so a later `init`/`sync` can adopt it into your git repo.

### 1. Create an empty git repository

Create a new **empty** repo on GitHub (or any git host). Do not initialize it with a README — it needs to be empty so the clone works cleanly.

Example: go to https://github.com/new, name it `aitrack-data`, leave all checkboxes unchecked, click **Create repository**.

### 2. Run the setup wizard

```
npx aitrack init
```

This will ask for the remote URL of your repo (SSH or HTTPS — whichever you normally use with git) and clone it locally to `~/.config/aitrack/repo/`.

### 3. Push your data

```
npx aitrack sync
```

Reads your local Claude Code and Codex session files and pushes a file named `data/{your-hostname}.json` to the repo.

### 4. View the heatmap

```
npx aitrack show
```

Reads **fresh local** Claude/Codex session data on this machine, merges data from other machines in the repo (if initialized), adds **local Cursor** usage if available, and renders a heatmap PNG with tokens and known USD cost where available (by default **one row per provider**; use `--all` for a single merged heatmap). No `sync` push is required to see your latest local usage.

---

## Multi-machine setup

Run `npx aitrack init` once per machine using the same repo URL. From then on:

```
npx aitrack sync   # run on each machine to push its data
npx aitrack show   # run anywhere to see all machines combined
```

Each machine writes its own file (`data/{hostname}.json`) so there are no merge conflicts.

---

## Commands

| Command                        | Description                                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `npx aitrack init`             | Interactive setup — provide repo URL and clone it locally                                                 |
| `npx aitrack sync`             | Read local data, write to the cloned repo, and push                                                       |
| `npx aitrack show`             | Merge synced data + fresh local Claude/Codex + local Cursor, render heatmap PNG (per provider by default) |
| `npx aitrack show --all`       | Single merged heatmap across all providers                                                                |
| `npx aitrack show --dark`      | Dark mode output                                                                                          |
| `npx aitrack show --no-cursor` | Skip local Cursor usage (offline, CI, or privacy)                                                         |
| `npx aitrack show --no-open`   | Don't auto-open the generated PNG (useful for scripts / CI)                                               |
| `npx aitrack show -o path.png` | Write PNG to a custom path                                                                                |
| `npx aitrack tui`              | Terminal stats table (same local-first merge as `show`, no PNG)                                           |
| `npx aitrack summary`          | Print per-provider monthly token + cost totals to stdout (no PNG)                                         |
| `npx aitrack recompute-costs`  | Refresh costs: local JSONL on this machine; reprice others from stored cache breakdown                    |

---

## How it works

`sync` and `show`/`tui` both use a local git clone at `~/.config/aitrack/repo/` for **Claude Code** and **Codex** data from other machines when initialized: normal git pulls and pushes with your existing git credentials. **`show` and `tui` always read fresh local Claude/Codex JSONL on this machine** — you do not need to run `sync` first to preview your latest usage.

Before `init`, local usage is written to `~/.config/aitrack/pending/data/` and adopted into the repo on the next `init` or pushed on `sync`.

`show`/`tui` also try to load **Cursor** on the current machine: it reads `cursorAuth/accessToken` from Cursor’s SQLite `state.vscdb`, then requests Cursor’s CSV usage export over HTTPS. Use `npx aitrack show --no-cursor` to skip that step (offline, CI, or privacy).
By default you get **one heatmap row per provider** (Claude Code, Codex, Cursor, …). Use `npx aitrack show --all` for **one** combined heatmap across all providers.

aitrack reads (and never transmits) your local Cursor access token solely to call Cursor's own usage export endpoint on your behalf. The token is not written to your data repo or sent anywhere else.

Cost handling follows OpenUsage-style semantics: Claude Code cost is an API-equivalent estimate from per-model pricing and token/cache usage. Pricing is keyed by Claude API model id (date suffix stripped) — see [`src/readers/claude.ts`](src/readers/claude.ts). Cursor and Codex local session cost are left unknown because their available local data does not expose a reliable all-history cost.

If stored costs are missing or pricing changed, run `npx aitrack recompute-costs`. It re-reads local JSONL on this machine (same accuracy as `sync`) and reprices other machines from the cache breakdown stored at sync time. Legacy synced data without a breakdown is left unchanged — re-sync from that machine to upgrade it.

Heatmap intensity anchors on the 90th-percentile day rather than the absolute maximum, so a single huge day doesn't flatten the rest of the year into the lightest shade.

```
~/.config/aitrack/
├── config.json          # repo URL
├── pending/
│   └── data/            # staged machine JSON before init/sync
│       └── my-pc.json
└── repo/                # local clone of your data repo
    └── data/
        ├── my-pc.json
        └── work-laptop.json
```

---

## Configuration

Config is stored at `~/.config/aitrack/config.json`:

```json
{
  "repoUrl": "git@github.com:your-username/aitrack-data.git",
  "machineId": "work-laptop"
}
```

`machineId` is optional — if omitted, `sync` uses your OS hostname as the filename (`data/{machineId}.json`). Set a stable name during `init` if your hostname might collide across machines or change after reinstall. Existing hostname-based files in the repo continue to work when reading; only new syncs use the configured ID.

---

## Where data comes from

| Provider           | Source                                                                                |
| ------------------ | ------------------------------------------------------------------------------------- |
| Claude Code        | `~/.claude/projects/**/*.jsonl` or `$XDG_CONFIG_HOME/claude/projects/**/*.jsonl`      |
| Codex              | `~/.codex/sessions/*.jsonl` or `$CODEX_HOME/sessions/*.jsonl`                         |
| Cursor (show only) | `state.vscdb` under `User/globalStorage/` (see below), then Cursor’s HTTPS CSV export |

Default `state.vscdb` locations (override with `CURSOR_STATE_DB_PATH` or `CURSOR_CONFIG_DIR`):

- macOS: `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
- Windows: `%APPDATA%\Cursor\User\globalStorage\state.vscdb`
- Linux: `~/.config/Cursor/User/globalStorage/state.vscdb`

Optional: `CURSOR_WEB_BASE_URL` (default `https://cursor.com`).

Synced JSON in git never includes Cursor; only Claude Code and Codex are pushed.

---

## Data format

Each machine's file in the repo looks like:

```json
{
  "hostname": "my-pc",
  "lastUpdated": "2026-04-12T10:00:00.000Z",
  "days": {
    "2026-04-12": {
      "claude_code": {
        "byModel": {
          "claude-sonnet-4-6": { "inputTokens": 45000, "outputTokens": 3200, "costUSD": 0.183 }
        },
        "totals": { "inputTokens": 45000, "outputTokens": 3200, "costUSD": 0.183 }
      },
      "codex": {
        "byModel": {
          "codex-1": { "inputTokens": 12000, "outputTokens": 800 }
        },
        "totals": { "inputTokens": 12000, "outputTokens": 800 }
      }
    }
  }
}
```

---

## Requirements

- Node.js 22 or later
- `git` installed and accessible in your PATH
- A GitHub account (or any git remote) with a repo you can push to

Native dependencies (`better-sqlite3`, `@napi-rs/canvas`) are installed automatically; on some systems you may need build tools if prebuilt binaries are unavailable.

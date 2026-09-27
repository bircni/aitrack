# aitrack Desktop — implementation plan

> **How much real leverage are AI coding tools giving you?**
> It watches Claude Code, Codex, and Cursor activity, links sessions to git commits, and turns
> that into explainable metrics for speed, quality, and cost — without mutating your tools,
> repos, or the outside world.

This document is the complete plan for `packages/aitrack-desktop`. It is written so that
implementation can proceed milestone by milestone across several sessions without re-deciding
anything. Decisions that were made with the maintainer are marked **Decided**; everything else
is derived from them and from what the repo and the raw data on disk actually look like.

---

## 0. Decisions (locked)

| Area             | Decision                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| Shell            | **Electron** (reuse `aitrack-lib` in the main process; `@napi-rs/canvas` is N-API, no rebuild)   |
| Renderer         | **React 19 + Vite + TypeScript**                                                                 |
| Styling          | **Tailwind v4 + headless components (shadcn-style, copied in, restyled)** — see §8 design system |
| Charts           | **Recharts** (heatmap is custom SVG; Recharts for bars/lines/areas)                              |
| Scope            | **v1 is the full vision, nothing left open**: watcher, sessions, commit linking, metrics, GUI    |
| Quality metrics  | **Short-term churn**, **test-touch ratio**, **manual rating** (kept / reworked / discarded)      |
| Run mode         | **Tray/menu-bar app** with background watcher; main window on demand                             |
| Storage          | **`node:sqlite`** at `~/.config/aitrack/desktop.sqlite`; the synced day-map JSON is untouched    |
| Repo discovery   | **Auto-discover from session `cwd`**; read-only git only                                         |
| Sync             | **init/sync included** as an explicit, opt-in action (the only thing that writes outside)        |
| Platforms        | **macOS + Windows + Linux** from day one                                                         |
| Signing          | **Unsigned** GitHub Release artifacts for v1; signing/auto-update are a later milestone          |
| Package layout   | **One package** `packages/aitrack-desktop` (main + preload + renderer)                           |
| Testing          | **Vitest** units (lib + renderer) + **Playwright** driving the built Electron app                |
| Visual direction | **Liquid glass**: translucent layered surfaces, refraction, depth — not flat cards               |

Verified on this machine while planning (Sep 2026): Node 26.9 has `node:sqlite`; Electron 44.4.5
is current and requires Node ≥ 22.12 (its embedded Node ships `node:sqlite` unflagged);
`electron-vite` 5.0 and `electron-builder` 26.15 are current.

---

## 1. What exists today and what is new

`aitrack-lib` reduces every transcript to **per-day, per-model token + cost totals** (`DayMap`).
That is exactly what sync needs and it stays as is. The desktop app needs a second, richer
model that the current readers throw away:

| Provider    | Source on disk                                                    | Session-level fields available (verified)                                                                                                     |
| ----------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `~/.claude/projects/<slug>/<sessionId>.jsonl`                     | per line: `sessionId`, `timestamp`, `cwd`, `gitBranch`, `version`, `type` (user/assistant/attachment…), `message.usage`, tool calls           |
| Codex       | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`            | `session_meta.payload.{session_id,cwd,runtime_workspace_roots,originator,source,cli_version}`, `event_msg` turns with `turn_id`, token counts |
| Cursor      | `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`     | full conversation with timestamps; slug encodes cwd                                                                                           |
| Cursor      | `state.vscdb` → `cursorDiskKV.composerData:<id>`                  | `composerId`, bubble headers with `createdAt`, mode; `bubbleId:*` rows hold per-message detail                                                |
| Cursor      | `state.vscdb` → `ItemTable.aiCodeTracking.dailyStats.v1.5.<date>` | `tabSuggestedLines`, `tabAcceptedLines`, `composerSuggestedLines`, `composerAcceptedLines` — per day                                          |
| Cursor      | `state.vscdb` → `ItemTable.aiCodeTracking.recentCommit`           | `commitHash`, `repoName`, `branchName`, `aiPercentage`, `composerLinesAdded/Deleted`, `tabLinesAdded/Deleted` — Cursor's own attribution      |
| Cursor      | Cursor CSV export (existing reader)                               | tokens/cost per day/model — already handled                                                                                                   |

So the new work splits cleanly:

1. **Library**: a `sessions/` layer (readers that keep session metadata, git inspection,
   linking, metrics) — provider-agnostic types, pure functions, fully unit-tested, published
   as part of `aitrack-lib` so the CLI can grow `aitrack sessions` later.
2. **Desktop package**: Electron shell, SQLite store, watcher/scheduler, IPC, React UI.

Nothing in the new layer mutates the tools' files, the user's repos, or the network, except
the pre-existing opt-in `sync` action and the pre-existing Cursor CSV fetch (already opt-in
via provider selection).

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Electron main process (Node, ESM)                                           │
│                                                                              │
│  ┌──────────────┐   ┌──────────────────┐   ┌──────────────────────────┐     │
│  │ Tray + menu  │   │ Window manager   │   │ IPC router (typed, zod)  │     │
│  └──────┬───────┘   └────────┬─────────┘   └────────────┬─────────────┘     │
│         │                    │                          │                   │
│  ┌──────▼────────────────────▼──────────────────────────▼──────────────┐    │
│  │ Services                                                            │    │
│  │  IngestScheduler ── Watcher(fs.watch + debounce + poll fallback)    │    │
│  │  SessionIngest   ── aitrack-lib/sessions/readers/*                  │    │
│  │  GitInspector    ── aitrack-lib/sessions/git (read-only, spawn git) │    │
│  │  Linker          ── aitrack-lib/sessions/link                       │    │
│  │  Metrics         ── aitrack-lib/sessions/metrics (pure)             │    │
│  │  UsageService    ── existing readers/pricing/DayMap (unchanged)     │    │
│  │  SyncService     ── existing git.ts (opt-in only)                   │    │
│  │  Store           ── node:sqlite, migrations, WAL                    │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────┬──────────────────────────────────────────────┘
                               │ contextBridge (preload, sandboxed)
┌──────────────────────────────▼──────────────────────────────────────────────┐
│ Renderer (React 19, Vite, Tailwind v4, Recharts, TanStack Query + Router)  │
│  Overview · Sessions · Commits · Repos · Cost · Leverage · Machines · Settings │
└─────────────────────────────────────────────────────────────────────────────┘
```

Principles:

- **Main process owns all I/O.** The renderer is sandboxed (`sandbox: true`,
  `contextIsolation: true`, `nodeIntegration: false`) and only sees a typed `window.aitrack`
  API from the preload.
- **Everything heavy runs off the UI thread.** Ingest and git inspection run in a
  `worker_threads` pool inside main so the tray stays responsive; results are written to SQLite
  and the renderer is notified via a single `store:changed` event with the affected tables.
- **Idempotent ingestion.** Every raw file is tracked by `(path, size, mtime, aitrackVersion)`;
  reprocessing is always safe. Deleting `desktop.sqlite` rebuilds everything from the sources.
- **Explainability is a data requirement, not a UI feature.** Every derived number stores the
  inputs and the rule that produced it, so the UI can always answer "why is this 0.7?".

---

## 3. Package layout

```
packages/aitrack-desktop/
  package.json                 name: aitrack-desktop, private: true (distributed as binaries, not npm)
  project.json                 nx targets: dev, build, package, test, test:e2e, lint, format:check, check:unused
  electron.vite.config.ts      three builds: main, preload, renderer
  electron-builder.yml         mac (dmg+zip, arm64+x64), win (nsis+portable), linux (AppImage+deb)
  tsconfig.json                references: tsconfig.main.json, tsconfig.preload.json, tsconfig.renderer.json
  playwright.config.ts
  resources/                   icons (template icon for macOS tray), entitlements.mac.plist
  src/
    main/
      index.ts                 app lifecycle, single-instance lock, tray-first startup
      tray.ts                  menu-bar icon, live tooltip ("Today: $4.12 · 3 sessions"), menu
      windows.ts               main window (frameless, vibrancy/mica), open/focus/hide
      ipc/                     one file per domain; handlers validated with zod schemas shared with renderer
        contracts.ts           the single source of truth for channel names + request/response types
        usage.ts sessions.ts commits.ts repos.ts metrics.ts settings.ts sync.ts diagnostics.ts
      services/
        store/                 sqlite.ts (open, pragmas), migrations/0001_init.ts …, repositories per table
        ingest/                scheduler.ts, watcher.ts, workerPool.ts, worker.ts (runs lib readers)
        git/                   inspector.ts (spawns git read-only, cached per repo+HEAD)
        link/                  runLinker.ts (batches lib linker against store)
        metrics/               recompute.ts (incremental, per repo/day)
        usage.ts               wraps existing buildUsageReport etc.
        sync.ts                wraps existing init/sync with explicit confirmation token
      security/
        csp.ts                 strict CSP for renderer; no remote content
        permissions.ts         deny all permission requests, block navigation/new windows
    preload/
      index.ts                 contextBridge.exposeInMainWorld('aitrack', api) — invoke + on() only
    renderer/
      index.html main.tsx
      app/                     router, providers (QueryClient, theme, reduced-motion)
      design/                  tokens.css, glass.css, motion.ts, typography.css  (§8)
      components/              Glass* primitives + shadcn-derived headless pieces restyled
      features/
        overview/ sessions/ commits/ repos/ cost/ leverage/ machines/ settings/ sync/ onboarding/
      charts/                  Heatmap (custom SVG), Sparkline, StackedCost, LeverageRadar, ChurnTimeline
      lib/                     api.ts (typed wrapper over window.aitrack), format.ts (reuse lib formatters)
  e2e/                         Playwright specs, fixture home dir with synthetic transcripts + a synthetic git repo
  __tests__/                   Vitest for main services (store, scheduler, linker glue) with fake fs/git

packages/aitrack-lib/src/sessions/           NEW, pure, published
  types.ts                     Session, Turn, ToolEvent, Repo, Commit, CommitLink, MetricRecord, Explanation
  readers/claude.ts codex.ts cursor.ts        session-preserving parsers, streaming, reuse readers/jsonl.ts
  readers/cursorState.ts                      read-only sqlite read of state.vscdb (copy-then-read, like today's auth reader)
  git/inspect.ts                              parse `git log`, `git show --numstat`, `git blame` output (pure functions over strings)
  git/commands.ts                             the exact read-only git argv used; nothing else is allowed
  link/linker.ts                              scoring + explanation
  metrics/speed.ts quality.ts cost.ts leverage.ts   pure metric functions with explanations
  paths.ts                                    cwd ↔ Claude slug / Cursor slug mapping
```

nx: `aitrack-desktop` is a fourth project; `build` depends on `^build` (so `aitrack-lib`
builds first); `package` depends on `build`; `test:e2e` depends on `package`. Its
`format:check`, `lint`, `check:unused` use the existing target defaults. Add its root to the
two `@nx/js/typescript` plugin `include` lists. `knip.json` gets an entry for the three
Electron entrypoints and Playwright config.

---

## 4. Data model (SQLite)

All timestamps are ISO-8601 UTC strings; day keys are local calendar days like the rest of
aitrack. WAL mode, `busy_timeout`, `foreign_keys=ON`. Migrations are forward-only, numbered,
and recorded in `schema_migrations`.

```sql
source_files   (path PK, provider, size, mtime_ms, aitrack_version, parsed_at, session_id NULL)
sessions       (id PK, provider, external_id, cwd, repo_id NULL, branch NULL, started_at, ended_at,
                turns, user_messages, assistant_messages, tool_calls, input_tokens, cached_tokens,
                output_tokens, cost_usd, models_json, title NULL, machine_id, rating NULL,
                rating_note NULL, rated_at NULL)
turns          (id PK, session_id FK, idx, started_at, ended_at, role, model, input_tokens,
                cached_tokens, output_tokens, cost_usd, tool_calls, files_touched_json)
file_touches   (session_id FK, turn_id FK, path, kind ENUM(read, edit, create, delete), at)
repos          (id PK, root_path UNIQUE, name, remote_url NULL, discovered_from ENUM(claude,codex,cursor),
                first_seen, last_seen, enabled DEFAULT 1, git_dir_ok)
commits        (id PK, repo_id FK, sha UNIQUE(repo_id,sha), parent_shas_json, author_time, commit_time,
                author_email, subject, files_changed, insertions, deletions, test_files_changed,
                test_insertions, is_merge, is_revert_of NULL, branch_hint NULL)
commit_files   (commit_id FK, path, insertions, deletions, is_test)
commit_links   (commit_id FK, session_id FK, score REAL, confidence ENUM(high,medium,low),
                explanation_json, decided_by ENUM(auto,user), PK(commit_id, session_id))
churn          (commit_id FK, window_days, lines_rewritten, lines_total, measured_at, measured_head_sha,
                explanation_json, PK(commit_id, window_days))
metric_daily   (day, repo_id NULL, provider NULL, metric, value REAL, inputs_json, PK(day, repo_id, provider, metric))
cursor_daily   (day PK, tab_suggested, tab_accepted, composer_suggested, composer_accepted)
cursor_commits (sha PK, repo_name, branch, ai_percentage, composer_added, composer_deleted, tab_added, tab_deleted, seen_at)
settings       (key PK, value_json)
ingest_log     (id PK, at, kind, detail_json)         -- powers the Diagnostics screen
```

Indexes: `sessions(started_at)`, `sessions(repo_id, started_at)`, `commits(repo_id, commit_time)`,
`file_touches(path)`, `commit_files(path)`, `metric_daily(day)`.

The existing `~/.config/aitrack/config.json`, `cache/`, `pending/`, `repo/` are used exactly as
the CLI uses them; the app never invents a second config.

---

## 5. Ingestion

### 5.1 Watcher and scheduler

- Roots: Claude projects dirs, Codex session dirs (from `getClaudePaths`/`getCodexPaths`, incl.
  config and env extras), `~/.cursor/projects/*/agent-transcripts`, Cursor `state.vscdb`.
- `fs.watch` recursive where supported (macOS, Windows); Linux falls back to per-directory
  watchers plus a 60 s poll. Events are debounced 1.5 s per path; a JSONL that is still being
  appended is re-read from its last parsed byte offset (readers are streaming, so partial
  trailing lines are tolerated and picked up next tick).
- Scheduler queue: `ingest(path)` → `link(sessionIds)` → `metrics(days, repoIds)` →
  `notify`. Full rescan on launch, on version change, and via Settings → "Rebuild index".
- Cursor CSV fetch reuses the existing cached reader (6 h TTL, `--refresh` equivalent button);
  it is only performed when the Cursor provider is enabled in Settings, which mirrors
  `--providers`.
- Sleep/wake and laptop-lid cases: `powerMonitor.on('resume')` triggers a catch-up scan.

### 5.2 Session readers (in `aitrack-lib/sessions/readers`)

Each reader yields `Session` objects with `Turn[]` and `FileTouch[]`:

- **Claude**: group by `sessionId`; `cwd`/`gitBranch` from the first line that carries them
  (later changes recorded as `branch_changes` in `models_json`-style meta); turns from
  `type: user|assistant`; tool calls from `message.content[].type === 'tool_use'`; file touches
  from `Edit`/`Write`/`MultiEdit`/`Read`/`NotebookEdit` tool inputs (`file_path`); token usage
  reuses the exact dedup rule the current reader uses (fullest usage per message id, cache-only
  turns kept). Sidechains (`isSidechain`) are counted as turns but flagged.
- **Codex**: `session_meta` gives id/cwd/roots/originator; turns from `event_msg`
  `task_started`/`task_complete` pairs keyed by `turn_id`; token counts from `token_count`
  events (reuse the current reset-detection logic); file touches from `apply_patch` /
  `shell` tool invocations whose argv touches a path under `cwd`.
- **Cursor transcripts**: one session per transcript id; cwd from the project slug
  (`Users-nicolas-Github-bircni-aitrack` → resolved by trying candidate splits against the
  filesystem; exact match required, ambiguous slugs are marked `cwd_uncertain`); timestamps from
  the embedded `<timestamp>` tag and, when present, `composerData.fullConversationHeadersOnly[].createdAt`
  via `state.vscdb`; file touches from tool-call blocks in the transcript. Tokens/cost for Cursor
  sessions are **not** attributed per session (the CSV is daily aggregate); the UI says so.
- **Cursor state**: `aiCodeTracking.dailyStats.*` → `cursor_daily`; `aiCodeTracking.recentCommit`
  → `cursor_commits` (it is a single "most recent" key, so the app snapshots it whenever it
  changes; it is treated as a corroborating signal, never as the only link).
- **state.vscdb access** copies the file (and `-wal`) to a temp dir before opening read-only,
  exactly as the current auth reader does, so Cursor is never blocked or mutated.

### 5.3 Repo discovery and git inspection (read-only)

- For each distinct session `cwd`, run `git rev-parse --show-toplevel` (once, cached). Toplevel
  becomes a `repos` row; `remote_url` from `git remote get-url origin` (display only).
- The **only** git commands the inspector is allowed to run (enforced by an allow-list and a
  unit test that fails on anything else):
  `rev-parse`, `log --format=… --numstat --no-color`, `show --numstat --format=…`,
  `diff --numstat <a> <b>`, `blame --line-porcelain -L …`, `remote get-url`, `branch --contains`.
  No `fetch`, `pull`, `checkout`, `stash`, or anything that touches the index or worktree.
- Commit import: `git log --all --since=<first session − 7 d>` incrementally from the last
  imported `commit_time − 1 d` (handles rebases by upserting on `(repo_id, sha)`; commits that
  disappear from `--all` are marked `unreachable=1`, not deleted, so history stays explainable).
- Test file detection: path matches `__tests__/`, `*.test.*`, `*.spec.*`, `/test/`, `/tests/`,
  `*_test.go`, `test_*.py`, `*Tests.swift`, `*Test.java|kt`, `e2e/`. Configurable per repo in
  Settings (glob list).
- Revert detection: subject `Revert "…"` or trailer `This reverts commit <sha>` → `is_revert_of`.

---

## 6. Linking sessions to commits

A commit is linked to a session when the evidence says the session produced (part of) it. The
linker is a pure function `link(session, candidateCommits, ctx) → CommitLink[]` with a scored,
explainable result. Candidates: commits in the same repo whose `author_time` is within
`[session.started_at − 5 min, session.ended_at + 6 h]` (window configurable).

Signals and weights (all inputs stored in `explanation_json`):

| Signal                                                                             | Weight | Explanation string shown in UI                                |
| ---------------------------------------------------------------------------------- | -----: | ------------------------------------------------------------- |
| File overlap: Jaccard of session edited paths vs commit paths                      |   0.45 | "7 of 9 files this commit touched were edited in the session" |
| Time proximity: commit within 30 min after last edit turn → 1, decays to 0 at +6 h |   0.25 | "Committed 12 min after the session's last edit"              |
| Branch match: session `gitBranch` ∈ `git branch --contains sha`                    |   0.15 | "Same branch (feature/x)"                                     |
| Cursor attribution: `cursor_commits.sha` matches, `aiPercentage` > 0               |   0.10 | "Cursor recorded 100% AI lines for this commit"               |
| Session mentions the commit subject / the commit body quotes the prompt            |   0.05 | "Commit subject appears in the assistant's final message"     |

Score ≥ 0.6 → `high`, ≥ 0.35 → `medium`, ≥ 0.2 → `low` (kept, shown greyed, excluded from
metrics unless the user confirms). Below 0.2 → not stored. A commit may link to several
sessions (pairing across tools is real: plan in Claude, patch in Cursor); shares are normalised
by score for attribution. Users can confirm, reject, or add a link manually; `decided_by=user`
links always win and are never overwritten by re-runs.

Commits with **no** linked session in a repo that has sessions are the "human baseline"; the
Leverage screen compares linked vs unlinked commits in the same repo and period, which is the
honest way to ask "how much leverage".

---

## 7. Metrics (all explainable)

Every metric has: definition, inputs, formula, caveats. The UI renders these from the metric
registry, so the copy lives once, next to the code. Windows: today, 7 d, 30 d, 90 d, custom;
scoped to all repos, one repo, or one provider.

### Speed

- **Session → commit lead time**: median minutes from first edit turn to linked commit.
- **Throughput**: linked commits per active day; lines (ins+del) per active hour of session time.
  Active session time = sum of turn durations, gaps > 15 min excluded (stored as inputs).
- **Turns per commit**: how much back-and-forth a shipped change took.
- **Cursor tab acceptance**: `tabAccepted / tabSuggested` per day (from `cursor_daily`).

### Quality

- **Short-term churn** (decided): for each linked commit, N days later (N ∈ {7, 30}, computed
  once each window has elapsed and re-measured when HEAD moves), the share of its added lines
  that no longer exist at `HEAD` as authored. Implementation: `git blame --line-porcelain` on
  the commit's files at `HEAD`, count lines still attributed to the sha vs lines it inserted.
  Compared against the same measure for unlinked commits in the same repo/window.
- **Test-touch ratio** (decided): share of linked commits that change ≥ 1 test file, and
  test lines / total lines; vs unlinked baseline.
- **Manual rating** (decided): per session, `kept / reworked / discarded` with optional note;
  surfaced as a distribution and as a filter. A weekly tray reminder ("3 sessions to rate")
  is optional and off by default.
- **Revert rate** is cheap once revert detection exists, so it is shown too, labelled as
  supplementary.

### Cost

- Reuses existing pricing exactly (`pricing/resolve.ts`), so desktop numbers equal CLI numbers.
- **Cost per linked commit**, **cost per 100 shipped lines**, **cost of discarded sessions**
  (rated `discarded` or no linked commit after 48 h — the latter labelled "unshipped", not
  "wasted").
- Budget line from `config.budget.monthlyUSD`, same 80 % / 100 % semantics as the CLI.

### Leverage (the headline)

One composite is a lie, so the Leverage screen is a **comparison panel**, not a score: for the
selected window and repo it shows side by side, AI-linked vs human-only commits: lead time,
size, churn@7d, churn@30d, test-touch, revert rate; plus cost per shipped line and the
share of commits that were AI-linked. Each row has an "Explain" affordance listing inputs.
A small, clearly-labelled "confidence" tag shows how many commits back each number
(< 10 → "too few to trust").

---

## 8. Design system — liquid glass

Brief from the maintainer: _stunning, no base-kit UI, liquid glass, very beautiful._ The look
is the memorable thing; data density and legibility stay disciplined underneath it.

### Material

- **Window**: frameless, `vibrancy: 'under-window'` (macOS), `backgroundMaterial: 'mica'`
  (Windows 11), a rendered gradient fallback on Linux. `titleBarStyle: 'hiddenInset'` with a
  custom drag region so the glass runs edge to edge.
- **Surfaces** are stacked translucent panes, not cards. Three depths, each a token:
  `--glass-0` (window backdrop: `backdrop-filter: blur(40px) saturate(160%)`),
  `--glass-1` (panels: blur 24 px, 1 px inner highlight `rgba(255,255,255,.28)` on top edge,
  `rgba(255,255,255,.06)` fill), `--glass-2` (floating: popovers, tray-like overlays; blur 32 px,
  soft 0 24 px 64 px shadow at 22 % and a specular gradient sweep). Edges use a 1 px border of
  `color-mix(in oklch, var(--tint) 30%, transparent)`, radius 22/16/10 by depth — radius encodes
  hierarchy, it is not one value everywhere.
- **Refraction**: an SVG `feDisplacementMap` filter behind hover/active states of the primary
  pane only (the Leverage comparison) so glass reads as glass without turning the whole app into
  a demo. Everything else is still.
- **Light source**: one consistent top-left highlight across all panes; ambient tint comes from
  a slow (90 s) drifting two-stop mesh gradient behind the glass in the provider colours.
  Respects `prefers-reduced-motion` (drift stops, becomes static).
- **Provider tints** (oklch, used for data, never for chrome): Claude `oklch(72% .16 55)`,
  Codex `oklch(70% .14 160)`, Cursor `oklch(68% .15 285)`. Neutral text `oklch(97% 0 0)` on dark
  glass, `oklch(18% .01 260)` on light glass; both themes ship, following the OS by default.
- **Type**: one family, variable — _Inter Display_ for headlines with tight tracking,
  _Inter_ text for body, tabular numerals for every number; a type scale of 12 / 13 / 15 / 18 /
  24 / 34 / 52. No mono for data labels, no all-caps eyebrows, no middle-dot metadata strings.
- **Charts**: Recharts styled to the token set — gradients fade into the pane, gridlines at 8 %,
  tooltips are `--glass-2` panes. The year heatmap is custom SVG with the existing p90
  intensity anchor so it matches the CLI's PNG.
- **Motion**: one orchestrated moment on window open (panes settle in with a 220 ms
  spring, staggered 40 ms); everything else only moves in response to a user action.
  `prefers-reduced-motion` disables both.
- **Copy**: sentence case, plain verbs, "Rate this session", "Rebuild index", "Push to your
  data repo". Empty states point to the next action ("No sessions yet — start Claude Code,
  Codex, or Cursor in a git repo and this fills in by itself").
- **Quality floor**: keyboard-navigable, visible focus rings on glass (2 px tinted outer glow),
  WCAG AA contrast measured against the darkest and lightest backdrop the mesh can produce,
  window resizable down to 960 × 640.

Before building screens, a `design/` Storybook-free "tokens" route renders every surface,
type size and chart style on both themes; it is screenshotted in Playwright as a visual
regression baseline.

### Screens

1. **Onboarding** (first launch): what the app reads, what it never does, provider toggles,
   optional "connect data repo" (init) — skippable; the app is fully useful without sync.
2. **Overview**: today's cost + sessions + linked commits in the tray-style header; year
   heatmap; 30 d stacked cost; "what happened today" session list.
3. **Sessions**: filterable table (provider, repo, branch, rating, linked/unlinked); detail pane:
   timeline of turns, files touched, tokens, cost, linked commits with explanations, rating.
4. **Commits**: per repo timeline; linked/unlinked colour; detail: numstat, tests touched,
   churn@7/30 with the blame-based explanation, linked sessions with scores, confirm/reject.
5. **Repos**: discovered repos, enable/disable, test-path globs, health (git ok, last import).
6. **Cost**: the CLI's `usage`/`top`/`export` as UI — windows, compare with previous period,
   budget, per-model breakdown, export PDF/CSV (reuses lib renderers, save-dialog).
7. **Leverage**: the comparison panel (§7), window/repo/provider scoping, confidence tags.
8. **Machines**: synced machines, timezone, last sync — mirrors `aitrack machines`.
9. **Settings**: providers, watch roots (from config), link window, churn windows, theme,
   launch at login, background mode, rebuild index, diagnostics (doctor output + ingest log).
10. **Sync** (inside Settings and on the Overview when configured): status of the local clone,
    unpushed changes, dry-run preview, and an explicit "Push to your data repo" button that
    requires a confirmation dialog listing exactly what will be written.

Tray menu: today's cost line, "Open aitrack", quick provider toggles, "Pause watching",
"Push to data repo…" (only if configured), "Quit".

---

## 9. IPC and security

- `ipc/contracts.ts` defines every channel as `{ request: ZodSchema, response: ZodSchema }`;
  a generic `handle()` validates both sides in main and the preload exposes only `invoke(channel,
req)` and `on(event, cb)` for the allow-listed names. The renderer wrapper is fully typed.
- Renderer: `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`,
  `webSecurity: true`, strict CSP (`default-src 'self'; img-src 'self' data:; style-src 'self'
'unsafe-inline'` — Tailwind v4 needs no inline JS), `setWindowOpenHandler` denies,
  `will-navigate` denies, all `permission` requests denied.
- Secrets: the Cursor token is read in main by the existing reader and never crosses IPC. The
  renderer receives only aggregates. Nothing is logged at debug level that contains a token.
- Filesystem writes by the app: `~/.config/aitrack/desktop.sqlite` (+ WAL), the existing
  `cache/`, exports the user explicitly saves, and — only on explicit sync — the existing
  `repo/` clone. A unit test asserts the list of write paths is exactly this.
- Network: Cursor CSV endpoint (existing rules: HTTPS, no credentials in URL) and git push on
  explicit sync. No update checks in v1, no telemetry, no crash reporting.

---

## 10. Build, packaging, release

- `electron-vite` builds `main` (Node ESM target), `preload`, `renderer`. `aitrack-lib` is
  consumed from `dist/` via workspace link and bundled by Vite for main (externalising
  `@napi-rs/canvas`, `pdfkit`, `node:*`); `electron-builder` copies the unpacked natives via
  `asarUnpack`.
- Targets: macOS `dmg` + `zip` for `arm64` and `x64` (universal later if size is acceptable),
  Windows `nsis` + portable `exe` for `x64` (`arm64` build produced but marked experimental),
  Linux `AppImage` + `deb` for `x64`.
- `.github/workflows/desktop.yml`: matrix on `macos-latest`, `windows-latest`, `ubuntu-latest`;
  runs `pnpm nx run aitrack-desktop:package` and uploads artifacts on every PR that affects the
  package; on `v*` tags attaches artifacts to the GitHub Release created by the existing
  `publish.yml` (that workflow gains a `needs`-free download step or the desktop workflow
  uploads via `gh release upload --clobber` after `github-release` finishes).
- Versioning: the desktop package follows the workspace version (`scripts/release.ts` already
  bumps all packages; `aitrack-desktop` is private so `pnpm publish -r` skips it).
- Unsigned for v1: README states Gatekeeper/SmartScreen steps. `entitlements.mac.plist` and
  the `CSC_*` env plumbing are wired but inert so enabling signing later is configuration only.
- The npm `aitrack` README gains a "Desktop app" section linking to Releases.

---

## 11. Testing

- **Lib (`sessions/`)**: fixtures for each provider's real line shapes (anonymised copies of the
  structures verified above) in `@aitrack/test-fixtures`; property-style tests for the linker
  (score monotonic in each signal; explanations always list every non-zero signal); git parsers
  tested on captured `git log`/`blame` output; the git allow-list test; timezone tests via
  `useTimeZone` + `EXTREME_TIME_ZONES` for every day-keyed metric.
- **Desktop main**: Vitest with an in-memory SQLite (`:memory:`) for repositories and
  migrations; scheduler tests with fake timers and a fake watcher; ingest worker tested against
  a temp `HOME` with fixture transcripts and a synthetic repo created by the test (`git init`,
  commits with controlled author dates) — this is the only test that runs real git, and it does
  so in `os.tmpdir()`.
- **Renderer**: Vitest + Testing Library for feature components against mocked
  `window.aitrack`; the metric registry's explanation copy is snapshot-tested so it can't drift
  from the formula.
- **E2E (Playwright, `_electron.launch`)**: boots the packaged app with `HOME` pointed at a
  fixture directory containing transcripts + synthetic repo; asserts onboarding → overview →
  sessions shows the fixture session linked to the fixture commit with the expected explanation;
  rating a session persists across relaunch; sync button absent when no repo configured;
  screenshot baselines for the tokens route on both themes. Runs on all three OSes in CI.
- Existing gates (`format:check`, `lint --type-aware`, `typecheck`, `check:unused`) apply to the
  new package; the workspace rules (no inline imports, exhaustive `switch` with `never`) hold.

---

## 12. Milestones

Each milestone ends green on `pnpm run validate` and is a mergeable PR. Order is chosen so the
app is usable early and the riskiest pieces (linking, churn) get real data soonest.

| #   | Milestone                                                                                                                                        | Exit criterion                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| M1  | `aitrack-lib/sessions`: types, Claude/Codex/Cursor session readers, slug↔cwd, fixtures                                                           | Sessions on this machine parse with correct cwd/branch/turns/tokens; totals equal the DayMap totals |
| M2  | `aitrack-lib/sessions/git`: allow-listed inspector, log/numstat/blame parsers, revert + test detection                                           | Import this repo's history in < 2 s; parsers covered by captured-output tests                       |
| M3  | Linker + explanations                                                                                                                            | Manual spot-check of 20 real sessions on this machine reads as correct; property tests pass         |
| M4  | Metrics: speed, test-touch, cost, leverage comparison; churn@7/30                                                                                | Registry complete, every metric has inputs + explanation; timezone tests pass                       |
| M5  | Desktop skeleton: Electron + vite + tray + window + IPC contracts + SQLite migrations + watcher/scheduler                                        | Tray shows today's cost from live data; index rebuild works; security tests pass                    |
| M6  | Design system: tokens, glass primitives, both themes, motion, tokens route + screenshot baseline                                                 | Reviewed against §8; contrast measured; reduced-motion verified                                     |
| M7  | Screens: Onboarding, Overview, Sessions, Commits                                                                                                 | E2E fixture flow passes on macOS                                                                    |
| M8  | Screens: Repos, Cost (incl. export), Leverage, Machines, Settings, Sync (opt-in)                                                                 | Feature-parity with CLI numbers verified by a test that compares against `aitrack usage --json`     |
| M9  | Packaging + CI matrix + release attachment + README                                                                                              | Artifacts for all three OSes produced from CI and launch on each                                    |
| M10 | Hardening: cold-start rescan performance (target < 5 s for 1 GB of transcripts), memory ceiling, Linux watcher fallback, Windows path edge cases | E2E green on all OSes; a fresh machine install works without a terminal                             |

Deferred (explicitly not v1, but wired to be configuration-only): code signing/notarization,
auto-update, CI-outcome quality signal via GitHub API, `aitrack sessions` CLI command over the
same lib layer.

---

## 13. Risks and how the plan handles them

- **Cursor internals are undocumented and change** (`composerData` `_v`, transcript layout,
  `aiCodeTracking` keys). Readers are versioned-tolerant (unknown shape → session with
  `partial=true`, logged in Diagnostics, never a crash), and the Cursor reader is isolated so a
  break there never affects Claude/Codex.
- **Linking is heuristic.** Confidence tiers, per-link explanations, human override, and a
  visible human baseline keep it honest; low-confidence links are excluded from metrics by
  default.
- **Churn via blame is expensive on large repos.** Computed lazily per commit once the window
  has elapsed, cached by `measured_head_sha`, capped per scheduler tick, and skipped for files
  > 1 MB or > 20 k lines (recorded in the explanation).
- **`node:sqlite` in Electron** — verified available in Electron 44's Node; if an Electron
  major ever drops it, the store module is the only place to swap for `better-sqlite3`.
- **Electron size and memory.** Tray-first with the window closed keeps the renderer
  unloaded; the ingest worker pool is capped at `min(4, cores − 1)`.
- **Unsigned builds** are friction on macOS/Windows; documented, and signing is configuration
  only when certificates exist.
- **Privacy expectations.** Sessions contain prompts. The app stores only metadata, file paths,
  token counts, and the derived metrics — never message text — and says so in Onboarding and
  Settings. Manual rating notes are the only free text stored, and they are the user's own.

---

## 14. Definition of done for v1

- A first-time user downloads the artifact, launches it, sees onboarding, and within a minute
  has a tray icon with today's cost and a window showing sessions linked to commits with
  explanations — without configuring anything or running a terminal command.
- Every number in the app can be traced by clicking it to the inputs and rule that produced it.
- The app never writes anywhere except `~/.config/aitrack/` and user-chosen export paths, unless
  the user explicitly presses "Push to your data repo" and confirms.
- `pnpm run validate` and the desktop E2E suite are green on macOS, Windows, and Linux.
- The UI matches §8: glass depths, one light source, one motion moment, both themes, reduced
  motion respected, AA contrast — reviewed with screenshots before each screen is merged.

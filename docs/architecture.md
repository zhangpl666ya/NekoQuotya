# NekoQuotya Architecture

> Status: revised draft (2026-10-27). Packs: Claude (client `claude`, quota Claude), GPT (client `codex`, quota Codex), Gemini (client `gemini`, no quota) and DeepSeek (client `dsh` = DeepSeek Harness, API billing, no quota), each with static image art.
> Changes from the initial plan: instead of four characters bundled in one program, the app is a shared core plus one self-contained pack folder per AI tool; the main window shrinks to a tray-style launcher panel; the appearance format (static image / animation / 2D / 3D) is undecided and declared by each pack.

## 0. Principles

1. **Core and packs are separate.** The core does the generic work: scheduling tokscale, managing windows, computing pet behavior, storing data. Everything specific to one AI tool (appearance, lines, rules, data) lives in that tool's own folder. Adding a tool means adding a folder; the core does not change.
2. **We never parse logs ourselves.** Token usage and subscription quotas come from tokscale (pinned to `4.20.1`).
3. **Behavior and appearance are separate.** The core decides *what* the pet does; a renderer decides *how it looks*. The appearance format is not decided, so renderers must be swappable.
4. **Packs contain data and assets, never code.** All renderers are built into the core and packs pick one in their manifest. No untrusted scripts run, and making a pack stays easy.
5. **Uncertain data never changes the mood.** A failed query keeps the last trusted value and marks it stale.
6. **No display text in data.** Data files and internal events carry identifiers and error codes only; every human-readable string comes from a translation table (§7). English is the default language.

## 1. Overview

```
┌──────────────────────────────── Core (Electron) ────────────────────────────────┐
│                                                                                 │
│  PackRegistry ── discovers and validates the packs in packs/                    │
│        │                                                                        │
│  Collector (child process) ── one shared tokscale queue ── tokscale.exe         │
│        │   results are split between packs by client / quota provider          │
│        ▼                                                                        │
│  PackRuntime × N ── one per enabled pack: state + PetBrain + data               │
│        │                                                                        │
│  WindowManager ── one pet window per pack; one launcher panel; tray icon         │
└─────────────────────────────────────────────────────────────────────────────────┘

packs/
  claude/        ← the only pack in phase 1
  codex/         ← later
  ...
```

| Part | Responsibility |
|---|---|
| PackRegistry | Scans `packs/` at startup, reads and validates every `pack.json`; invalid packs are skipped with an error code |
| Collector | Runs in an Electron `utilityProcess`; all packs share one tokscale queue |
| PackRuntime | One per enabled pack: holds its data, computes its pet's mood and actions, writes its files |
| Pet windows | One per enabled pack, independent, shown or hidden individually |
| Launcher panel | Small panel opened from the tray: lists all packs, toggles pets, shows today's usage and quota, opens settings |

## 2. Packs

### 2.1 Folder layout

```
packs/claude/
  pack.json            manifest: who the pack is, where its data comes from, which appearance it uses
  appearance/          appearance assets (format declared in pack.json, see §5)
  lines/               the pet's lines, one file per language
    en.json
    zh-CN.json
  data/                written by the app
    history.json       the ledger: date → session → model; survives log cleanup (§3.5). Cannot be rebuilt.
    backups/           daily copies of history.json, newest 7 kept (§3.6)
    today.json         today's usage, by session
    quota.json         subscription quota
    status.json        runtime status, hints and errors
    state.json         pet position, last mood, etc. (added in step 3)
    .lock              held by the process currently writing this folder (§3.7)
```

- `appearance/`, `lines/` and `pack.json` are authored; `data/` is generated.
- In `data/`, only `history.json` (and its backups) cannot be fully rebuilt: sessions the AI tool has cleaned up exist only in the ledger. Every other file is regenerated from tokscale if deleted.
- The pack folder must be writable because of `data/`:
  - In development the project's `packs/` is used directly.
  - In an installed app the install folder may be read-only and is replaced on update, so bundled packs are copied to `%APPDATA%\NekoQuotya\packs\` on first run and used from there. User-made packs can be dropped into that folder too.
- Updates replace pack assets only and never touch `data/`.

### 2.2 pack.json

```jsonc
{
  "id": "claude",
  "name": "Claude",  // or per locale: { "en": "…", "zh-CN": "…" }
  "version": 1,
  "packFormat": 1,                       // manifest format version, for compatibility checks

  "source": {
    "tokscaleClients": ["claude"],        // usage: tokscale client ids; several may be combined
    "quotaProvider": "Claude",            // quota: provider name in `tokscale usage` output
    "lateArrivalDays": 0,                 // only for tools whose usage arrives late: re-check the last N days daily
    "watch": [                            // log folders to watch live
      { "path": "${CLAUDE_CONFIG_DIR|~/.claude}/projects" },
      { "path": "${CLAUDE_CONFIG_DIR|~/.claude}/transcripts" }
    ]
  },

  "behavior": {                           // optional; core defaults apply
    "dailyBudget": 2000000,
    "moodBasis": "quota",                 // quota = use the quota when available; budget = always the daily budget
    "idleSleepMinutes": 30
  },

  "theme": {                              // the tool's brand colour: launcher card and quota bars
    "color": "#D97757"                    // Claude orange; e.g. GPT #000000, DeepSeek a deep blue
    // "gradient": ["#4285F4", "#9B72CB", "#D96570"]   // optional, e.g. Gemini; replaces the bar fill
  },

  "appearance": {
    "renderer": "image",                  // see §5
    "entry": "appearance/appearance.json",
    "card": "appearance/card.png"         // optional: faded illustration on the launcher card
  }
}
```

- `${CLAUDE_CONFIG_DIR|~/.claude}` means: the environment variable if set, otherwise the default.
- A pack may combine several clients (e.g. Claude usage from Claude Code and Cherry Studio) by listing them in `tokscaleClients`.
- **Each client belongs to at most one pack.** If two packs claim the same client they would both receive the same usage and any cross-pack total would count it twice, so the pack that loads later (by folder name) is rejected with `client_already_claimed`.

### 2.3 Lines

One file per language in `lines/`; keys are language-neutral:

```jsonc
// lines/en.json
{
  "mood.ENERGETIC": ["Full of energy today~"],
  "mood.SWEATING":  ["Over half the quota used, take it easy~"],
  "event.quota.80": ["Only 20% left!"],
  "event.quota.reset": ["Quota refreshed!"],
  "user.poke":      ["W-what is it?"]
}
```

Lookup order: the user's language → English → the core's generic lines.

## 3. Data layer

### 3.1 TokscaleRunner (one for the whole core)

- Development uses `node_modules/@tokscale/cli-win32-x64-msvc/bin/tokscale.exe`; the packaged app uses `resources/bin/tokscale.exe`. It is spawned directly, never through `npx` or a shell, with arguments as an array.
- **One global serial queue** shared by all packs: one tokscale process at a time; identical queued requests merge.
- Timeouts: 30 s for local scans, 20 s for `usage`; on timeout the process is killed and its exit awaited before continuing.
- On Windows the child runs at "below normal" priority.
- Output is validated with zod schemas; a mismatch is a failure (`tokscale_bad_output`).
- **Only these commands can be built**; commands that upload data (`login`, `submit`, `autosubmit`, ...) cannot be constructed at all:

| Purpose | Command |
|---|---|
| Today, by session | `--json --today --client <ids> --group-by client,session,model --no-spinner` |
| One day, by session | `--json --since <d> --until <d> --client <ids> --group-by client,session,model --no-spinner` |
| Subscription quota | `usage --json` |

Measured: about 0.4 s per day for Claude.

**How calls are shared between packs:** wherever possible one call serves every pack, and rows are split by their `client` field.

| Situation | Call |
|---|---|
| One pack's logs changed | today, that pack's clients only (~0.3 s) |
| Startup, fallback scan, manual refresh | today, all packs' clients in one call |
| History catch-up | one call per day, with every client that needs that day |
| Quota | one `usage` call for the whole app, split by `quotaProvider`; Claude also has local sources (below) |

### 3.2 Scheduling

While the app runs, **today's usage** and **quota** refresh automatically and the user can refresh at any time; only **finished days** (history) are not rescanned on a timer — they are scanned on events.

| Line | Trigger | Range |
|---|---|---|
| Today | a watched folder changed; 3 s debounce (at most every 10 s under continuous writes) | today |
| Today · fallback | today not scanned for 5 minutes (in case the watcher missed a change) | today |
| Manual refresh | user clicks "Refresh now" | today + history catch-up + quota (quota skips any backoff) |
| History · catch-up | midnight; app start; resume from sleep | every day after the ledger's `verifiedThrough` up to yesterday (last 35 days on first run) |
| History · re-verify | tokscale version change; manual "re-verify all" | every date in the ledger plus the last 35 days |
| History · late arrival | once a day, only for packs with `source.lateArrivalDays` | the last N days; for tools whose usage syncs from the cloud and arrives late. Claude does not need it (default 0) |
| Quota | every 5 minutes while any pack is active, otherwise every 15 | — |

Why history needs no timer: the logs of a finished day barely change. The only cases that need a second look are:
- the last records around midnight (catch-up scans yesterday after the day changes);
- days missed while the computer was off or asleep (catch-up on start and resume);
- tokscale upgrades that may correct how usage is counted (full re-verify on version change);
- data that arrives late from the cloud (declared by the pack).

Other rules:
- A failed day stops `verifiedThrough` just before it; the next catch-up retries from there.
- Quota failures back off 5→15→30→60 minutes; the last good values are kept and marked `stale`. A provider missing from `usage` output counts as a failure even when other providers answered: Claude's usage endpoint rate-limits with a ~1 hour `Retry-After`, and tokscale then silently drops Claude, so polling through it keeps the limit active.
- **Claude local sources** (`collector/claudeLocal.ts`, checked on every heartbeat, applied as soon as a file changes):
  - Claude desktop's own samples in `%LOCALAPPDATA%\Claude-Data\claude_*\plan-usage-history.json` (Store install; `version: 2`, `u.fh` = 5-hour used %, `u.sd` = 7-day used %). Undocumented, so any other version is ignored. It has no reset times: a known reset time is kept while it has not passed. Desktop samples irregularly (about every 15 minutes in some stretches, only at startup in others; it logs that polling needs its tray opened within 24 hours), so data older than 40 minutes is shown as stale with its time.
  - The command-line token expiry: tokscale's Claude query uses the access token in `~/.claude/.credentials.json`, which only the `claude` CLI refreshes (Claude desktop does not). Only `claudeAiOauth.expiresAt` is read. Expired → `claude_token_expired` with the fix (run `claude` once), no backoff; when the file changes and is valid again, the quota is queried at once.
  - Newest wins: a tokscale result when it has Claude, otherwise the desktop sample when it is newer than what is shown (`QuotaData.source`).
- Folders that cannot be watched fall back to scanning today every 60 s, noted in the status.

### 3.3 Data vocabulary

```ts
interface TokenBucket {
  input: number;       // input not served from cache
  output: number;      // output including reasoning (tokscale lists reasoning separately; added back)
  cacheRead: number;
  cacheWrite: number;
  messages: number;
  costUsd: number;     // estimate, reference only
}

interface QuotaWindow {
  kind: 'session' | 'weekly' | 'monthly' | 'other';   // the UI translates the kind
  rawLabel: string;          // tokscale's label, shown as-is for kind "other"
  usedPercent: number | null;
  resetsAt: number | null;
  applicable: boolean;       // false for allowances the plan does not include ("0/0")
  stale: boolean;            // previous value after a failed query, or past its reset time
}

interface ErrorInfo {
  code: ErrorCode;                          // e.g. "quota_provider_missing"
  params?: Record<string, string | number>; // e.g. { provider: "Claude" }
  detail?: string;                          // raw technical text (stderr), shown untranslated
}
```

Active tokens = input + output, excluding cache; used for the daily budget.

### 3.4 Writing

- Each pack writes only to its own `data/`, atomically (temp file + rename).
- On start the existing data is read first, so the pet has something to show immediately; refreshes follow in the background.
- `today.json` is written on every today scan; `history.json` only on catch-up or re-verify, so a growing file is not rewritten constantly.
- The core never reads or stores credentials; tokscale reads whatever it needs for quota queries itself. The one exception is the expiry time in `~/.claude/.credentials.json` (§3.2); the tokens in that file are never kept, logged or sent.

### 3.5 Session ledger: updated when found, retained when gone

AI tools clean up their own session logs (Claude Code keeps 30 days by default, adjustable with `cleanupPeriodDays`). Once a log is gone, tokscale can no longer count that session. So history is kept per session, not as daily totals:

```ts
interface SessionDay {
  client: string;
  sessionId: string;
  byModel: Record<string, TokenBucket>;
  firstSeenAt: number;
  lastSeenAt: number;   // last scan that still found it
  retained: boolean;    // true = the latest scan no longer finds it; values are retained
}
// history.json: days[date].sessions["client:sessionId"] = SessionDay
```

**One merge rule: sessions are never deleted from the ledger.** When a day is scanned:
- a session in the scan is replaced with the scanned values (so corrections come through), `retained = false`;
- a session missing from the scan keeps its values, `retained = true`.

A day's total is the sum of its sessions, so if some of a day's sessions are cleaned up and others remain, the day's total never shrinks.

There is deliberately no "detect a vanished session, then freeze it" step: one failed or empty scan would make every session look vanished. With "never delete", such a scan simply updates nothing.

`today.json` merges by the same rule. At midnight, yesterday's `today.json` is moved into the ledger *before* yesterday is rescanned, so sessions deleted in between are not lost.

The ledger grows indefinitely, not just 35 days. If it gets too large it can later be split by month.

**Renamed sessions after a tokscale upgrade.** A new tokscale version may derive session ids differently (e.g. Codex: rollout file name → thread id). Plain merging would retain the old ids *and* add the new ones, counting the same usage twice. So when the tokscale version has changed since the data was written (ledger: `verifiedWith`; today: `scannedWith`), each day is reconciled per client: if the sessions that just went missing and the sessions that just appeared add up to the same tokens within 2%, it is treated as a rename and the old ids are dropped. Sessions that were already retained before the upgrade are never touched. Outside an upgrade this check is not applied.

### 3.6 Ledger backups and recovery

- Before the first ledger write of each day, the current `history.json` is copied to `data/backups/history-YYYY-MM-DD.json`; the newest 7 are kept.
- If `history.json` cannot be read, the newest readable backup is restored, the damaged file is kept as `history.corrupt-<time>.json`, and the status reports `recoveredFrom`.
- If neither the ledger nor any backup is readable, the app reports `history_unreadable` and **never writes history** until it is fixed; today's usage and quota keep working. A read failure is never treated as an empty ledger, because writing would overwrite it.

### 3.7 One writer per data folder

Electron's single-instance lock only stops a second copy of the same app. It does not cover a development collector running next to the app, or an installed and a portable copy pointing at the same folder. So each pack's `data/.lock` names the owning process, which refreshes the file every 30 s. A pack whose folder is held by another live process is skipped entirely (`data_locked`) and nothing is written to it. A lock is taken over when its process is gone or its heartbeat is older than 2 minutes (which also covers a recycled PID).

## 4. Pet behavior (PetBrain)

Implemented in `src/main/brain/` (step 2). One instance per pack; pure logic with no timers, no I/O and no randomness except an injected `random`, so every rule is tested with a fake clock. Three inputs, each returning the current `PetIntent`:

- `observe(snapshot)`: new data from the collector
- `interact('poke' | 'dragStart' | 'dragEnd')`: the user touched the pet
- `tick()`: time passing (the host calls it about once a second)

All numbers below are defaults in `pack.json` → `behavior` and can be adjusted per pack without code changes.

### 4.1 Mood (continuous, five levels)

**Pressure:** with a usable quota, the highest used % among the 5-hour, weekly and monthly windows; otherwise today's active tokens / `dailyBudget`.

| Mood | Pressure (`moodThresholds`) |
|---|---|
| `ENERGETIC` | < 30% |
| `FOCUSED` | 30–60% |
| `SWEATING` | 60–80% |
| `PANICKED` | 80–95% |
| `EXHAUSTED` | ≥ 95% |

- Moving up applies immediately; moving down requires dropping `moodHysteresis` (5) points below the threshold.
- Stale quota freezes both the mood and the displayed pressure (`info.stale`). Once the quota has been seen, the mood never switches to the budget.
- On start the mood is set directly from the current pressure.

### 4.2 Activity (independent of mood)

| Activity | Condition |
|---|---|
| `working` | usage grew within `workingMinutes` (2) |
| `idle` | otherwise |
| `sleeping` | no usage and no interaction for `idleSleepMinutes` (30); new usage or a poke wakes her |

While asleep she says nothing and reacts to nothing except being woken.

### 4.3 Events → one-off actions

| Event | Action | Line key | Limit |
|---|---|---|---|
| poke | `poked` | `user.poke` / `user.pokeAnnoyed` | 5 pokes within 10 s → annoyed |
| poke while asleep | `wake` | `event.wake` | — |
| drag start / end | `dragged` (until released) / `landed` | `user.drag` / `user.land` | — |
| usage grew | `eat` | `event.eat` | `eatCooldownMinutes` (2) |
| quota crossed 50 / 80 / 95% | `alert` | `event.quota.<N>` | once per threshold per window cycle; a jump announces only the highest; never on first sighting (e.g. starting at 85%) |
| quota reset (used % dropped by more than 5 points) | `celebrate` | `event.quota.reset` | once per reset; re-arms the alerts |
| woken by new usage | `wake` | `event.wake` | — |
| date changed | `newDay` | `event.newDay` | once a day; skipped while asleep |

Stale quota windows trigger neither alerts nor resets.

**Priority:** user interaction (5) > alert (4) > celebrate / wake (3) > eat (2) > new day (1). Only one action plays at a time. An action of equal or higher priority interrupts the current one; a lower one is dropped. The exception is alerts: they wait for the current action to finish, and if several are waiting, the newest wins.

### 4.4 Lines

- Every action and every mood change shows a bubble for `bubbleSeconds` (6).
- Idle chatter: a `mood.<MOOD>` line every `chatterMinutes` (randomly 15–30) while she is awake and quiet; `null` turns it off.
- The brain emits line keys only (`LineKey` in `src/shared/pet.ts`). The text comes from the pack's `lines/<locale>.json` (§2.3).

### 4.5 Output

```ts
interface PetIntent {
  mood: MoodId;                         // ENERGETIC … EXHAUSTED
  activity: 'working' | 'idle' | 'sleeping';
  action: { id: ActionId; startedAt: number; until: number | null } | null;
  bubble: { id: number; lineKey: LineKey; params?: Record<string, string | number>; until: number } | null;
  info: { basis: 'quota' | 'budget'; pressure: number; todayTokens: number; stale: boolean };
}
```

`bubble.id` changes for every new bubble, so renderers pick a fresh random variant of the line.

### 4.6 What a pack author prepares

- **Images:** one per mood (five in total). Only `ENERGETIC` is required; the others fall back to it.
- **Actions (optional):** poked, dragged, landed, eat, alert, celebrate, wake, newDay. Sleeping is shown through `activity`, so it needs no action image.
- **Lines:** a few per line key above, for each language.

## 5. Appearance: swappable renderers

The appearance format is undecided, so the core only defines a renderer interface; each format gets a built-in renderer that packs select in `pack.json`.

```ts
interface PetRenderer {
  load(appearanceDir: string, config: unknown): Promise<{ width: number; height: number }>;
  applyIntent(intent: PetIntent): void;   // switch visuals for the mood and action
  hitTest(x: number, y: number): boolean; // is this point on the character (decides click-through)
  dispose(): void;
}
```

| Renderer | Format | Hit test | Plan |
|---|---|---|---|
| `placeholder` | development: shapes + text showing the current mood and action | rectangle | phase 1 |
| `image` | static images: one per mood and action | image alpha | phase 1 |
| `frames` | 2D frame animation loops: PNG/WebP sequences or sprite sheets | current frame alpha | once the appearance is decided |
| `live2d` | 2D skeletal animation | model hit areas | once the appearance is decided |
| `three` | 3D model (glTF / VRM) | ray casting | once the appearance is decided |

Key points:

- **Missing visuals fall back**: no `action.poked` image → keep showing the current mood; no `SWEATING` image → fall back to `ENERGETIC`. A single image is enough to run.
- Switching from `image` to `frames`, `live2d` or `three` means new assets and a new `renderer` value; behavior and window logic do not change.
- Example `appearance.json` for the `image` renderer:

```jsonc
{
  "size": [320, 320],
  "anchor": [160, 300],          // the character's "feet", used to sit it on the screen edge
  "images": {
    "mood.ENERGETIC": "energetic.webp",
    "mood.SWEATING":  "sweating.webp",
    "action.poked":   "poked.webp"
  }
}
```

## 6. Windows

### 6.1 Pet windows (one per enabled pack)

- Frameless, transparent, not in the taskbar, always on top, shown with `showInactive()` so it never steals focus.
- Window size comes from the appearance. A small quota widget sits to the right of the character: the 5-hour and weekly windows as mini bars in the pack's brand colour (today's tokens for tools without a quota). It is hidden until the pet is clicked, then shows for 8 seconds; it is display-only, clicks through, and may extend past the screen edge.
- Click-through by default; on mouse move the renderer's `hitTest` decides whether the window accepts the click.
- Dragging reuses the approach proven in the early prototype (the main process moves the window to follow the cursor). The character stays fully on screen, but the window's transparent parts (the bubble space above it, the placeholder's padding) may extend past the screen edge, so the pet can reach the very top. Near the top edge the bubble can therefore be cut off. Positions during a drag are computed only from the cursor and set with a fixed size; reading the position back and re-setting it makes windows creep on displays with fractional scaling. The pet window captures the pointer on press, so the release always ends the drag. The position is saved per pack in `data/state.json` as display + relative coordinates.
- When several pets are shown, a newly shown pet avoids the others' positions.
- Interaction: click to poke; drag to pick up; double-click or right-click for a menu (hide, open launcher, settings). Hover shows a small card with today's usage and quota.

### 6.2 Launcher panel (replaces the old main window)

- A small panel opened from the tray icon, anchored to the tray, closing when it loses focus.
- Look: always a white, light base. Each pack's card and quota bars use the tool's brand colour from `pack.json` → `theme`.
- One row per pack: name, pet toggle, today's tokens, quota bar, data status (OK / stale / not detected).
- Footer: refresh now, launch at startup, settings, quit.
- **Today's usage appears as soon as it is scanned; the quota shows "checking…" separately** — the quota query is a network call that can take 5–15 s and must not hold up the rest of the panel. The collector already reports each part as soon as it completes.
- Each card has period tabs, Today / This week (from Monday) / This month / Total, showing that period's tokens (computed from the ledger plus today; `src/shared/stats.ts`). Clicking the card opens the pack's **session window**: the same periods, one row per session with tokens, input, output, cache, messages, models and dates, plus a badge for sessions whose logs were cleaned up. Sessions have no titles, because that would mean reading conversation content.
- The header's **Settings** button opens the settings window: frameless like the panel, with its own title bar, and sized to its content. Its first section picks which pack's pet is on the desktop (only one pet at a time, or none); the panel's pet toggle follows the same rule. Below it is the selected pack's card: mood basis (only for tools with a subscription quota), daily budget (only when the mood follows the budget, i.e. API billing or the user chose it), idle-sleep minutes and idle chatter. Changes are saved as an override in that pack's `data/settings.json`, leaving `pack.json` untouched, and apply to the pet at once.
- The session window opens with an activity heatmap (last 26 weeks, one cell per day, shaded by quartile of active tokens) and a trend bar chart (last 60 days, peak day highlighted), both from the ledger plus today (`stats.ts → dailyTotals`).
- Settings → **Language**: follow the system, English or 简体中文, saved in `<userData>/preferences.json` and applied live (the panel and session windows re-render, each pet page reloads with its lines in the new language). `NEKO_LANG` still overrides it for development.
- Characters are named after their tool only: Claude, GPT, Gemini, DeepSeek (no "-chan" / "娘").
- The panel footer has **Check for updates**: main asks `api.github.com/repos/zhangpl666ya/NekoQuotya/releases/latest` (via `net.fetch`, so the system proxy applies), compares the tag with `app.getVersion()` (`shared/version.ts`), and offers to open the release page. Nothing is downloaded or installed automatically.
- Each pack has `lines/en.json` and `lines/zh-CN.json` with its character's voice (Claude: polite and careful; GPT: confident "Certainly!"; Gemini: sparkly cat; DeepSeek: frugal maid who thinks out loud). Missing keys fall back to the core lines in `shared/lines.ts`.
- The landing page lives in `site/` (static, no build) and is published to GitHub Pages by `.github/workflows/pages.yml`.
- Cards can be dragged to reorder them. The order is saved in `<userData>/layout.json` (`packOrder`) and is also used by the settings window's pet picker; packs not in the list follow in folder order.
- App icon: made from the user's artwork. `build/icon.png` (1024) and `build/icon.ico` are for packaging; `assets/icon.png` is the window icon, and `assets/tray.png` (+ @2x/@3x) is the tray icon. The code-drawn face is only a fallback if the tray file is missing.

## 7. Languages

- **English is the default and the fallback.** Code, comments, documentation, logs and the developer CLI are in English.
- All user-facing text goes through one translation table (`src/shared/i18n/`): `en.ts` must contain every key; other languages (`zh-CN.ts`, ...) may omit keys and fall back to English. Adding a language = adding one dictionary file and one line in `i18n/index.ts`.
- Data files and events contain no sentences: quota windows are identified by `kind`, errors by `code` + `params` (§3.3). The UI renders them in the current language; raw technical `detail` text is shown untranslated.
- Pack content is localized inside the pack: `name` may be a per-language map, and lines live in `lines/<locale>.json`.

## 8. Security and privacy

- No network ports are opened; there is no HTTP server.
- All windows use `contextIsolation` and `sandbox`, with `nodeIntegration` off; preload scripts expose an allow-listed API only.
- Packs cannot contain executable code; the core only reads asset files from `appearance/`, restricted to the pack folder (no `..` escapes).
- The core never reads credentials or collects cookies. The only network traffic is tokscale's `usage` query. The system proxy is passed to tokscale only while it is enabled.

## 9. Engineering and packaging

- Electron + TypeScript, built with electron-vite. The launcher uses React; pet windows use plain TS (a future 3D renderer adds three.js, loaded on demand).
- electron-builder produces an NSIS installer; `tokscale.exe` goes into `extraResources` (outside asar) and its sha256 is verified at build time. Bundled packs ship as `extraResources` and are copied to the user folder on first run.
- Tests:
  - Normalizer: recorded real tokscale output as fixtures.
  - Ledger: merge, retention, rename detection, catch-up ranges.
  - Store: backups, recovery, the data-folder lock.
  - Scheduler: fake runner and clock — debounce, midnight, backoff, upgrades, locked packs.
  - PackRegistry: valid and invalid manifests, path escapes, duplicate clients.
  - PetBrain: mood thresholds, hysteresis, activity, events, priorities, cooldowns, chatter, stale data.

## 10. Source layout

```
NekoQuotya/
  docs/architecture.md
  src/
    main/
      index.ts                 entry: single instance, lifecycle
      packs/                   packRuntime.ts
      brain/                   petBrain.ts, mood.ts (step 2 done)
      index.ts, petController.ts, launcher.ts (tray + panel), auxWindows.ts (session and settings windows),
      collectorClient.ts, packAssets.ts, geometry.ts
    collector/                 (utilityProcess; step 1 done, cli.ts is the developer harness)
      cli.ts, scheduler.ts, tokscaleRunner.ts, sourceWatcher.ts, packStore.ts,
      dataLock.ts, normalize.ts, schema.ts, proxy.ts
    shared/
      types.ts, usage.ts, ledger.ts, stats.ts, errors.ts, pet.ts, lines.ts, appearance.ts, ipc.ts (+ ipc/ per window)
      i18n/                    index.ts, en.ts, zh-CN.ts
      packs/                   manifest.ts (zod), registry.ts (shared by the core and the collector)
    preload/                   pet.ts, launcher.ts
    renderer/
      pet/                     host.ts (pet window shell)
        renderers/             placeholder.ts, image.ts (later: frames.ts, live2d.ts, three.ts)
      launcher/                React launcher panel
  packs/
    claude/                    pack.json, lines/, appearance/ (placeholder first)
  tests/
    fixtures/                  recorded tokscale output
```

## 11. Phase 1: Claude only

| Step | Scope | Done when |
|---|---|---|
| 1 Data layer | Runner, Scheduler, Watcher, Normalizer, PackRegistry, ledger, backups, lock, i18n; `packs/claude` has only `pack.json` | the data in `packs/claude/data/` matches tokscale run directly; chatting in Claude Code updates today within seconds; after session logs are deleted the ledger keeps their values marked retained; quota matches `/usage` in Claude Code |
| 2 Behavior (done) | PetBrain and its tests; `npm run pet` shows live reactions | mood and actions follow the rules; stale data causes no flicker |
| 3 Pet window (done) | window, click-through, dragging, `placeholder` and `image` renderers | every mood and action works with the placeholder; dropping an image into `appearance/` replaces it |
| 4 Launcher (done) | tray, panel with period totals, session window, settings window | the Claude pet can be toggled; usage and quota are visible. The panel's look is a placeholder until the UI design is settled (styling is isolated in `src/renderer/launcher/style.css`) |
| 5 Packaging | installer, launch at startup, packs copied to the user folder | installs and runs on a clean machine |

Once the appearance is decided, the matching `frames`, `live2d` or `three` renderer is added; the core and the Claude pack need no other changes.

## 12. Decided, open, and known limitations

Decided:
- One self-contained folder per AI tool, holding its data and assets.
- The main window is a tray-style launcher panel.
- Phase 1 covers Claude only.
- English is the default language; others are added as translation files.

Open (does not block steps 1–2):
- Appearance format: static images / 2D animation / 2D skeletal / 3D. Step 3 starts with the placeholder and image renderers.
- Whether platforms other than Windows are needed.

Known limitations (accepted for now, not tested):
- **Claude sign-in on quota queries.** tokscale uses Claude Code's own credentials; whether a token refresh during `usage` could affect Claude Code's sign-in is unverified.
- **Offline behavior.** Whether tokscale tries to download prices when offline, and slows local scans as a result, is unverified.
- **Time zones.** The ledger is keyed by local date; switching time zones can move usage to the neighbouring day. Totals stay correct.
- **Renamed tokscale clients.** If tokscale renames a client id, a pack using the old id silently reports zero instead of failing.
- **PAC proxies.** Only the system proxy's server address is used; automatic configuration scripts (PAC) are not supported, so quota queries fail for users relying on them.
- **Antivirus.** `tokscale.exe` is an unsigned third-party binary started frequently; code signing will be considered when packaging (step 5).

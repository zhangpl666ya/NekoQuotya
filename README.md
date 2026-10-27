# NekoQuotya

A desktop pet in the style of an AI-girl character that watches your AI coding tools' token usage and subscription quotas. Design: [docs/architecture.md](docs/architecture.md).

![NekoQuotya](build/icon.png)

## Install (Windows)

1. Download `NekoQuotya-Setup-1.0.0.exe` from [Releases](../../releases).
2. Run it. The installer is not code-signed yet, so Windows SmartScreen may warn: choose **More info → Run anyway**.
3. The pet appears on the desktop and an icon appears in the tray. Click the tray icon for the panel.

Characters (one pet on the desktop at a time, chosen in Settings):

| Pack | Tool it watches | Quota | Mood follows |
|---|---|---|---|
| Claude-chan | Claude Code (`~/.claude`) | Claude subscription | quota % |
| GPT-chan | Codex CLI (`~/.codex`) | ChatGPT subscription | quota % |
| Gemini-chan | Gemini CLI (`~/.gemini`) | — | daily token budget |
| DeepSeek-chan | DeepSeek Harness (`~/.dsh`) | — (API billing) | daily token budget |

Using the pet: click to poke (her quota bars show for a few seconds), drag to move (the position is remembered), double-click to open the panel, right-click for a menu. In the panel, click a card for its sessions and drag cards to reorder them. Settings has the pet picker, daily budget, mood basis, sleep time and idle chatter. Launch at startup is in the panel footer.

Your data stays on your computer: usage is read locally by tokscale and stored in `%APPDATA%\NekoQuotya\packs\<pack>\data`. Uninstalling leaves that folder in place.

## Development

```bash
npm install
npm run build && npm start   # run the app from source
npm run dev                  # the same, rebuilding on file changes
npm run dist                 # build the Windows installer into dist/
```

Headless tools for the data layer:

```bash
npm run pet              # keep running and print the pet's live reactions; type p + Enter to poke her
npm run collect          # keep running: auto refresh; type r + Enter to refresh now, s + Enter to re-verify history
npm run collect:once     # one pass of today, history catch-up and quota, then exit
npm run collect:resync   # re-verify all history, then exit
npm test                 # unit tests
npm run typecheck        # type check
```

Add `-- --lang zh-CN` for Chinese output (English by default).

## Packs

One folder per AI tool (`claude`, `gpt`, `gemini`, `deepseek`), for example `packs/claude/`:

```
packs/claude/
  pack.json        data sources, behavior settings, appearance
  appearance/      static images per mood, sleeping, and the panel card art
  data/            written by the app
    history.json   the ledger: date → session → model. Survives log cleanup; cannot be rebuilt — do not delete
    backups/       daily copies of history.json (newest 7)
    today.json     today's usage, by session
    quota.json     subscription quota: 5-hour / weekly windows and reset times
    status.json    tokscale version, watch state, ledger stats, hints and errors
```

## How the data works

- Usage and quotas come from [tokscale](https://github.com/junhoyeo/tokscale) `4.20.1` (pinned); this project never parses logs itself.
- **Ledger rule:** sessions are never deleted. A rescan updates sessions it finds and retains (`retained`) those whose logs the AI tool has cleaned up.
- **Automatic refresh:** today's usage updates within seconds of a log change, with a fallback scan every 5 minutes; quota refreshes every 2 minutes while active, otherwise every 10.
- **Manual refresh:** available at any time (`r` in the CLI, a button in the app); refreshes today, catches up history and queries quota immediately.
- **Finished days are not rescanned on a timer:** missing days are caught up at midnight, on start and on resume; everything is re-verified when the tokscale version changes, with sessions renamed by the upgrade replaced rather than counted twice.
- `output` includes reasoning tokens (tokscale lists them separately; they are added back).
- Active tokens = input + output, excluding cache.
- Costs are estimates from public prices; for subscribers they are only a reference.
- A failed quota query keeps the previous values marked `stale`; nothing drops to zero.
- Data files contain no display text: windows are identified by kind and errors by code; all text comes from `src/shared/i18n/` (English default, Chinese included).

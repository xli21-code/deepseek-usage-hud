# pi extension: deepseek-hud

The Claude Code status line in this repo feeds one slot of [claude-hud], through
`display.externalUsagePath`. **pi has no equivalent protocol** — its footer is
built in and an extension's only write seams are `ctx.ui.setStatus(key, text)`,
`setWidget`, and `ctx.ui.custom`. So the pi side is a small extension rather than
another status-line command.

The division of labour is deliberate:

| Piece | Owner | Why |
|---|---|---|
| Balance fetch, ledger, learned top-up baseline, lock, throttle, snapshot write | `src/generate.js` (unchanged) | One writer. A second implementation once rebuilt the snapshot without the learned baseline and silently turned a 40% bar into 20%. |
| Rendering in pi | `extensions/deepseek-hud.ts` | pi's seam is a status string, not a subprocess. |
| Per-host token usage | `extensions/deepseek-hud.ts` → `pi-usage.json` → merged into `_meta.pi_usage` by `generate.js` | Lets Claude Code's HUD see what pi spent, without pi becoming a snapshot writer. |

## Files

```
pi/extensions/deepseek-hud.ts             # extension entry: status line, events, /ds
pi/extensions/deepseek-hud-lib/panel.ts   # scrollable /ds panel (ScrollView)
pi/extensions/deepseek-hud-lib/format.ts  # pure helpers: localDate, displayWidth, fmt
```

`pi/extensions/deepseek-hud-lib/` is **not** discovered as an extension: pi loads
only the `.ts` files directly inside `<agent-dir>/extensions/`, not subdirectories.

## Deploy

```bash
sh pi/link.sh          # links the sources into ~/.pi/agent/extensions/
```

Then start a new pi session. `/ds` opens the report; `↑↓` scrolls, `r` forces a
balance refresh, `q` closes. The status line shows the balance, its remaining
percentage, this session's tokens and the cache hit rate (`缓存命中 96.7%`).

The bar follows the **live model**, not the snapshot: an `ollama-cloud/*` model
shows that account in dollars, anything else keeps the DeepSeek yuan bar. The
`/ds` report always prints both accounts, so the one that is not on the status
line is still one command away.

`link.sh` symlinks two paths, and it needs both: pi resolves relative imports
from the **symlink path**, so `import "./deepseek-hud-lib/…"` only works when that
directory is linked into the extensions dir as well. The `deepseek-hud-` prefix
keeps it from colliding with another extension's `lib/`.

## Configuration

| What | Where |
|---|---|
| balance scale, `low_balance`, `throttle_seconds` | `~/.config/claude-deepseek/deepseek-hud.json` (shared with the Claude Code install) |
| API key | `DEEPSEEK_API_KEY` or `ANTHROPIC_AUTH_TOKEN`, else `DEEPSEEK_API_KEY=` in `~/.config/litellm/litellm.env` |
| Ollama Cloud key | `OLLAMA_API_KEY`, else the `ollama-cloud` provider in `~/.config/magpie/providers.json` |
| Ollama usage refresh | `ollama_usage_seconds` (default `300`) — the endpoint is a lazily-updated 24h aggregate |
| checkout location, if not the default | `DEEPSEEK_HUD_REPO`, or `{"repoDir": "…"}` in `~/.pi/agent/deepseek-hud.json` |
| data directory | `DEEPSEEK_HUD_DATA_DIR` (default `~/.local/share/deepseek-hud`) |

## Debug

```bash
touch ~/.pi/agent/deepseek-hud.debug     # or DEEPSEEK_HUD_DEBUG=1
tail -f "$(node -p 'require("os").tmpdir()')/deepseek-hud-pi.log"
```

The log is in the OS temp directory (on macOS `/var/folders/…`, not `/tmp`).

## Behaviour worth knowing

- The balance bar means **remaining**, like the rest of this project. Keep that in
  mind when reading a low percentage.
- Balance is account-level: the same key funds the LiteLLM gateway, so other
  tools drain this number too.
- The sidecar holds one entry per pi process per day, keyed `<pid>-<startedAt>`.
  Entries that never ran a turn are pruned after two minutes, and an entry is only
  counted as a session once it has a turn. Nothing from another calendar day is
  ever attached to today's snapshot.
- Anything that runs on a timer must treat a captured `ctx` as invalid after the
  session ends: reading `ctx.mode` then throws, and an unhandled throw there takes
  the whole pi process down. The extension guards every render with a `stopped`
  flag for that reason.

[claude-hud]: https://github.com/jarrodwatts/claude-hud

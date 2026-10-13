# deepseek-usage-hud

[![CI](https://github.com/xli21-code/deepseek-usage-hud/actions/workflows/ci.yml/badge.svg)](https://github.com/xli21-code/deepseek-usage-hud/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A Claude Code status line for **prepaid** API providers — built for DeepSeek.

```
[deepseek-flash ◑ high] │ my-project │ refactor the parser │ ⏱️  2h 14m
Context ████░░░░░░ 38% │ Usage Balance ████████░░ 38% | ¥42.10 CNY
Cache ⏱ until 01:41 AM
Cache hit 99.8%
1 CLAUDE.md | 2 MCPs
✓ Bash ×13 | ✓ Edit ×5 | ✓ Read ×1
Tokens 63.0M (in: 150k, out: 330k, cache: 62.5M)
```

Everything except the `Usage` slot is [claude-hud](https://github.com/jarrodwatts/claude-hud).
This project fills in that one slot, because claude-hud cannot: it renders the
Anthropic subscription's 5-hour and 7-day quota windows, and a prepaid balance
has no such window to divide by.

## Why this is small

It would be reasonable to expect a fork. It is not one.

claude-hud already exposes `display.externalUsagePath` — a JSON snapshot another
program can write — and that schema contains a field called **`balance_label`**,
documented in its own source as `optional raw balance text (e.g. "¥6.35")`. The
author put it there for exactly this case. So this repo is the other side of that
seam: one HTTP call and a few lines of arithmetic, no fork to maintain.

The whole project is about 4,200 lines of dependency-free Node — source,
installer, calibration tools and tests together — and there is no build step.

There is no build step.

## Requirements

- macOS or Linux, Node 18+
- Claude Code, pointed at DeepSeek's Anthropic-compatible endpoint
  (`https://api.deepseek.com/anthropic`)
- `git` (used once, to fetch claude-hud at a pinned tag)

## Install

```bash
git clone https://github.com/xli21-code/deepseek-usage-hud.git
cd deepseek-usage-hud
node bin/install.js --dry-run     # see what it would change
node bin/install.js
```

Then:

```bash
claude-ds                         # start a session with the HUD
```

`bin/install.js` clones claude-hud `v0.11.2` into `~/.local/share/deepseek-hud/vendor/`
rather than vendoring it into this repo — it is MIT, and cloning respects upstream
better than a copy would.

### Where it installs, and why that matters

The installer resolves the settings directory by one rule, shared with the
launcher and the config tool (`src/paths.js`, mirrored in `bin/claude-ds`):
`$CLAUDE_CONFIG_DIR` if set; otherwise a dedicated directory *if it already
holds a `settings.json`*; otherwise `~/.claude`. Both setups work:

| your setup | where settings go | notes |
|---|---|---|
| `CLAUDE_CONFIG_DIR` is set (what `bin/claude-ds` arranges) | that directory | DeepSeek sessions are fully separate from your Anthropic ones |
| it is unset, but a dedicated install already exists | that dedicated directory | a previous install is found rather than duplicated |
| neither | `~/.claude` | if that config already has a status line it is **branched**, not replaced |

Note the middle row: "unset" does not mean "main config" — an existing dedicated
install is preferred, because that is where the settings it reads would be.

Getting this wrong is the failure this project is most careful about, so the
installer prints which directory it chose and why.

claude-hud's own display config is *not* written into your session's config
directory. It goes to a private `~/.local/share/deepseek-hud/claude-hud-config/`,
which the status line hands to claude-hud via `CLAUDE_CONFIG_DIR`. That way the
balance never leaks into an Anthropic HUD that shares the same config, and the
install works regardless of where your config lives.

The installer may patch `~/.claude/settings.json`. That is not vandalism; see
[the precedence trap](#the-precedence-trap). It backs the file up and keeps the
original command verbatim as the fallback.

## The bar means REMAINING

This is the one thing to know before reading the numbers.

```
Usage Balance ████████░░ 38%   ← 38% of the bar's scale is still there
```

Longer bar = more money left. This is the **opposite** of upstream's convention,
where a longer bar means more quota consumed.

That inversion has a consequence worth stating plainly: upstream colours usage by
*used* percentage (≥90% red, ≥75% magenta), so under inverted semantics a healthy
balance would render **red** and a nearly-empty one would render calm. The
installer therefore sets the usage-window colours to a single neutral value and
the warning is carried by text instead — `⚠ ¥8.20 CNY` once the balance falls
below `low_balance`. A shortened bar is the visual signal; the colour is not
trustworthy here.

## Where the scale comes from

A balance is a *stock*. `¥42.10` is not "42% of" anything — there is no
denominator in the API to divide by. So the scale is learned by watching the
balance move. The only large positive step a prepaid balance *normally* makes is a top-up —
a refund or a promotional credit would look the same, which is why this is a
heuristic and not a fact (see [Known limits](#known-limits)). So:

- **on a top-up**, the scale is set to the balance just after it — which is
  `top-up amount + whatever was left`, the money actually available for the cycle
- **otherwise** the scale is held, and the bar drains

Two modes in `deepseek-hud.json`:

```jsonc
{
  "baseline_mode": "auto",        // learn it from top-ups (default)
  "topup_min_jump": 1,        // smallest rise counted as a top-up
  "usage_max": 200            // used when baseline_mode is "fixed"
}
```

A fresh install that has not yet seen a top-up seeds from the highest balance
ever recorded. That is a *proxy*, not the real scale, and the bar will read high
until a top-up is observed. If you know what you paid in, just say so:

```bash
node src/baseline.js set 200
node src/baseline.js show
node src/baseline.js clear
```

## Caveats

These are measured, not guessed. They are the reason the display looks the way
it does.

**The balance is account-level, not Claude-Code-level.** If the same API key is
used by anything else — a gateway, a batch job, another machine — that spend
drains this number too. The bar will fall for reasons this HUD cannot see.

**The balance settles in batches.** Two adjacent samples once implied
contradictory price factors (12.08 vs 3.46) purely from settlement timing, and a
lag scan over ±20 minutes found no alignment — consistent with batching, though
two windows cannot rule out every other explanation. So a balance delta is only
meaningful over hours. **The bar's two inputs are not equally solid.** The balance is read from the
API. The scale is *inferred* — from a rise between two consecutive readings —
so it is a heuristic result, not a fact, and the README's Known limits section
says where it can be wrong. The `/ds-usage` report additionally computes a burn
rate from the ledger, under three restrictions: it needs four
hours of history, it restarts its window after the last **detected** top-up (a
top-up the detector missed is still counted as spend), and the README's own
advice is to check it against the provider console rather than trust it.

**Claude Code's own cost number is wrong for this provider.** Its stdin payload
carries `cost.total_cost_usd`, but Claude Code does not know DeepSeek's models
and applies some other model's price table.

Measured on a single call with no cache reads — 12,930 input tokens, 59 output —
Claude Code reported `costUSD = 0.0661`, while the published DeepSeek table
prices those same tokens at 0.0020 to 0.0040. So the factor is **between about
17x and 240x**, depending on whether that table is USD or CNY and whether the
call fell in peak hours. It is not a constant you could divide out, which is why
the field is simply not trusted.

**Context size is correct, and needed no workaround.** Claude Code reports
`context_window_size: 1000000` for these models, so the context bar is right out
of the box.

## Network and credentials

Upstream claude-hud advertises that it *"makes no network requests, never reads
credentials, and calls no undocumented APIs."* This project breaks the first of
those, deliberately and visibly:

- **one endpoint** is called: `GET https://api.deepseek.com/user/balance`
- **at most once per `throttle_seconds`** (default 60) while the endpoint is
  healthy, from a background process the status line spawns and never waits on.
  The throttle is keyed on the last *attempt*, so a failing endpoint backs off
  exponentially instead of being retried on every render
- **the API key is read from the environment** (`ANTHROPIC_AUTH_TOKEN` or
  `DEEPSEEK_API_KEY`) and sent as a bearer token. It is never written to the
  ledger, the snapshot or the log — verified, and worth re-verifying if you
  change the code
- **nothing else leaves the machine.** No telemetry, no identifiers, no
  transcript content. The generator reads nothing but the balance endpoint; the
  token accounting in `probe/` reads local transcripts and sends them nowhere

If you would rather it made no requests at all, the bar still works from the
last snapshot until claude-hud's freshness window lapses, after which the Usage
slot hides itself.

## The precedence trap

Worth reading if you install this on a machine that also uses Claude Code for
Anthropic models.

Claude Code reads *project* settings from `<cwd>/.claude/settings.json`, and
project settings **beat** user settings. When you launch from your home
directory, that path is `~/.claude/settings.json` — which is therefore both your
main config's user settings *and* the project settings for that directory.

The consequence: a `statusLine` written into `$CLAUDE_CONFIG_DIR/settings.json`
is **silently overridden** whenever the session's working directory is `$HOME`.
Nothing errors. The command simply never runs. The symptom is a blank status
line and no log entries anywhere to explain it.

`bin/install.js` handles this by patching the main config's command to branch on
`CLAUDE_CONFIG_DIR`, keeping the original command verbatim as the fallback:

```sh
case "${ANTHROPIC_BASE_URL:-}" in *deepseek*) exec '<node>' '<wrapper>';; esac; [ "${CLAUDE_CONFIG_DIR:-}" = '<config dir>' ] && exec '<node>' '<wrapper>'; : deepseek-usage-hud ; <the original command, unchanged>
```

POSIX shell only — `case` and `[ ]`, not `[[ ]]` — because the generated command
runs under whatever shell Claude Code uses, which is not necessarily bash or zsh.
The marker is the shell no-op `:` and **not** a `#` comment. That distinction is
the whole difference between a fallback that survives in the string and one that
runs: a `#` makes everything after it on the line a comment, so the original
command — preserved, present, and never executed — produced a blank bar for
every non-DeepSeek session. The tests execute the command now.

On a **shared** config the branch is the only thing between an Anthropic session
and a DeepSeek HUD, so it is strict: the base URL must contain `deepseek`. A
session that merely exports `CLAUDE_CONFIG_DIR=$HOME/.claude` — which some setups
do — is *not* evidence of anything, because both providers share that directory.

The predicate tests the **base URL**, not just the config directory, so a
session that was pointed at DeepSeek by hand in the main config is recognised
too. It is a substring match, which means a proxy URL that happens to contain
"deepseek" would also match — the alternative, an explicit opt-in flag, is
noted under [Known limits](#known-limits). The trailing `:` no-op marks the branch
as ours so a re-run replaces it instead of stacking another one.

## Which model a session actually uses

Worth knowing, because the failure mode is silent. `bin/claude-ds` exports six
model variables, and `$CLAUDE_CONFIG_DIR/deepseek-launcher.env` (written by the
installer) overrides any of them:

| what asks | which variable answers it |
|---|---|
| the main loop | `ANTHROPIC_MODEL` |
| `/model opus`, and plan mode under `opusplan` | `ANTHROPIC_DEFAULT_OPUS_MODEL` |
| `/model sonnet` | `ANTHROPIC_DEFAULT_SONNET_MODEL` |
| small/fast calls | `ANTHROPIC_SMALL_FAST_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL` |
| subagents | `CLAUDE_CODE_SUBAGENT_MODEL` |

Leave one unset and Claude Code sends the **Anthropic** model name for that slot
— and DeepSeek accepts it, so the session runs on whatever its endpoint maps
that name to, while Claude Code prices it against Anthropic's table. There is no
error. This is not hypothetical: it happened on a hand-launched session before
the variables were in place.

The status line is the only place this is visible, because it prints the model
the API actually served.

## Configuring

Two layers, two files:

| File | What lives there |
|---|---|
| `$CLAUDE_CONFIG_DIR/deepseek-hud.json` | this project: the bar's scale, the warning line, refresh cadence |
| `~/.local/share/deepseek-hud/claude-hud-config/plugins/claude-hud/config.json` | upstream: layout, which elements render. Private on purpose — see above |

Do not hand-edit them. A bad value is silent — upstream reverts invalid values to
defaults without a word, and a malformed file disables every setting in it. Use:

```bash
node src/hud-config.js list                    # current values + all options
node src/hud-config.js set display.showTools=false usage_max=150
```

or, inside a session, `/ds-usage configure`, which asks with pickers.

## How it works

```
Claude Code ──stdin JSON──▶ src/hud-wrapper.js          (statusLine command)
                              │ buffer stdin
                              │ if the snapshot is stale: spawn the generator
                              │       detached, never waiting on it
                              ▼
                        claude-hud v0.11.2  ──reads──▶  usage-snapshot.json
                              │                              ▲
                              ▼                              │ atomic write
                        stdout (the status line)             │
                                                      src/generate.js
                                                             │
                                              GET /user/balance  +  baseline
```

The generator throttles itself, holds a lock so concurrent sessions do not pile
up requests, and writes atomically. The wrapper never waits on the network — a
stale snapshot is fine, because the balance itself only moves every few minutes.

The lock is a listening UNIX socket, released by the process exiting rather than
by a delete. That is not a stylistic choice: two earlier versions released by
removing something, and both had a window between the check and the removal where
a takeover could land — `unlink` cannot be made conditional on a file's contents,
and POSIX has no compare-and-swap on a path. Binding is serialised by the kernel
and a live holder answers a connection, so acquisition has no such window, and
release has nothing to delete with.

The state it guards is also order-independent, which is what makes a weaker lock
sufficient: every reading is stamped with the time it was *taken*, and readers
sort by that rather than by write order. Two refreshes finishing out of order
therefore cannot show a decrease as a rise — which is exactly what used to
happen, silently rewriting the bar's scale.

| File | Role |
|---|---|
| `src/hud-wrapper.js` | status line entry: buffers stdin, triggers refreshes, forwards to claude-hud |
| `src/generate.js` | throttle → lock → fetch → write |
| `src/balance.js` | `/user/balance` with a hard timeout; the ledger |
| `src/baseline.js` | learns the bar's scale from top-ups |
| `src/snapshot.js` | builds the snapshot claude-hud reads |
| `src/report.js` | the `/ds-usage` report |
| `src/hud-config.js` | validated config read/write |
| `src/config.js`, `src/util.js` | config loading, atomic writes, logging |

## Measuring what it costs

`probe/` holds the tools used to work out what DeepSeek actually charges, and
`docs/CALIBRATION.md` explains what they found and what did not work. The short
version: the console reports a blended **¥0.168 per 1M tokens** for a window you
can also account for locally, and deriving a price *table* from a balance proved
underdetermined — one equation, two unknowns. See the doc.

## Known limits

Stated here rather than discovered later. Each of these is a deliberate trade,
not an oversight.

**The top-up detector is a heuristic.** It fires on any rise larger than
`topup_min_jump` between two readings, so a refund or a promotional credit looks
exactly like a top-up and will reset the bar's scale. A top-up that settles
against concurrent spend, several small top-ups, or a long gap between readings
can all be missed. The status line cannot distinguish these; if you know what you
paid in, `node src/baseline.js set <amount>` is the reliable answer.

**One data directory per machine.** Balance, ledger and scale all live in
`~/.local/share/deepseek-hud/`, keyed on nothing. Two DeepSeek configs on one
machine — two accounts, say — would share them and mix currencies and balances in
one bar. If that is your setup, point each at its own directory with
`DEEPSEEK_HUD_DATA_DIR`. It is also what the tests use.

**The provider is detected by URL substring, and sometimes not at all.**

| install target | how a session is recognised |
|---|---|
| main config (shared with other providers) | `ANTHROPIC_BASE_URL` must contain `deepseek`. Nothing else counts. |
| a dedicated directory | no test at all — every session there is DeepSeek by construction, which is what makes the plain, unconditional command safe |

So a custom domain that proxies DeepSeek without that word in the URL is not
detected on a shared config, and a non-DeepSeek proxy whose URL happens to
contain it is. An explicit opt-in flag would be sturdier and is the obvious next
change.

**Nothing here verifies a top-up actually happened.** There is no provider API
for top-up records, so the balance is the only evidence available, and it is
aggregate.

**A local token sum is a lower bound, by 7.3%.** Claude Code makes billed
requests through the provider that never appear in a transcript — its own
auto-mode classifier among them, which the harness says outright when you run
headless against a non-Anthropic endpoint. Nothing in the transcripts reveals how
much, which is why `capture_correction` is a fitted constant kept visible in the
config rather than a computed one. This only affects `show_today_estimate`, which
is off by default; the bar itself reads the balance, not a sum of tokens.

**It makes one network request** where upstream claude-hud makes none. See
[Network and credentials](#network-and-credentials).

## Credits

- [claude-hud](https://github.com/jarrodwatts/claude-hud) by Jarrod Watts (MIT) —
  the entire status line, and the `externalUsagePath` seam this plugs into.
- The `degraded` behaviour, the atomic writes and the freshness semantics are
  upstream's; this project only supplies data.

## License

MIT — see [LICENSE](LICENSE).

claude-hud is not vendored into this repository. `bin/install.js` clones it at a
pinned tag into a data directory, so upstream's own LICENSE travels with it. The
attribution above is the whole of the relationship: this project supplies data to
that seam and nothing else.

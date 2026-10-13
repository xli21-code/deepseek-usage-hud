---
name: ds-usage
description: DeepSeek prepaid balance report and HUD configuration. With no argument, reports the balance, the remaining-proportion bar, the ledger and the burn rate. With "configure", opens choosers for what the status line shows. Use when the user asks how much DeepSeek credit is left, what the usage looks like, or wants to change the bottom HUD. NOT the same thing as claude-hud's Claude subscription quota — that is the plugin's own display; this project only feeds the Usage slot.
---

# /ds-usage

> `<REPO>` is the checkout location, and `<REPO_SH>` is the same path already
> shell-quoted for use as a command argument. `bin/install.js` substitutes both
> when it installs this file, so what runs and what you read here are the same
> text with those two strings filled in. If you are reading the file in the
> repo rather than an installed copy, quote the path yourself — a checkout under
> a directory with a space in it will otherwise be split into two arguments.

Two jobs: **report usage** (default) and **configure the status line** (`configure`).

## Do not confuse this with claude-hud

| | Owns | Data source |
|---|---|---|
| **claude-hud** (upstream v0.11.2, vendored) | model, project, session name, duration, **context bar**, cache lines, CLAUDE.md/MCP counts, tool activity | Claude Code's stdin + transcript |
| **this project** | only the **Usage slot**: the balance and its remaining bar | DeepSeek `GET /user/balance` |

Upstream's 5h / 7d quota bars **do not exist** for a prepaid account — there is no
quota window to divide by — so those two slots stay empty and the balance bar
takes their place. That is the whole point of this project; see README.md.

## Report

```bash
node <REPO_SH>/src/report.js
```

Add `--refresh` to fetch a fresh balance first:

```bash
node <REPO_SH>/src/report.js --refresh
```

When presenting the output:

- **The bar means REMAINING.** `balance / scale × 100`, so a longer bar means more
  money left — the opposite of upstream's convention. Do not read it the other way.
- **The balance is account-level.** If the same API key is used by anything else,
  that spend drains this number too.
- **The balance settles in batches**, with ¥0.01 resolution. A short-window delta
  describes settlement timing, not spend, which is why the script **withholds the
  burn rate** under 4 hours of history. Do not invent a number to fill the gap.
- The last line reports whether the status line is actually running. Its check
  requires a UUID-shaped `session_id`, so a hand-written test payload cannot
  fool it.

## Configure

When the user says `/ds-usage configure`, or wants to change what the bottom HUD
shows.

**Do not hand-edit the JSON.** There are 40+ options across two files, and a bad
value is *silent*: upstream reverts invalid values to defaults without saying so,
and a malformed settings.json disables every setting in that file. Use the tool,
which validates and backs up:

```bash
# 1. current values + every option, with descriptions
node <REPO_SH>/src/hud-config.js list

# 2. ask the user with AskUserQuestion (multiSelect), grouped by the sections
#    the listing prints: layout / first line / context+usage / cache / other
#    lines / thresholds

# 3. apply
node <REPO_SH>/src/hud-config.js set display.showTools=true display.showMemoryUsage=false

# 4. render once so the user sees the result
echo '<real payload>' | node <REPO_SH>/src/hud-wrapper.js
```

Other subcommands: `options` (catalogue only), `cat` (print both files).

### Two hard rules

1. **Never enable the cost switches** — `display.showCost`, `showRoutedCost`,
   `showDailyCost`, `showWeeklyCost`.
   Claude Code does not know DeepSeek's models and applies another model's price
   table. On a single call with no cache reads it reported `costUSD = 0.0661`
   where the published table gives 0.0020-0.0040 — **17x to 240x** too high,
   depending on currency and peak hours, and not a constant you could divide
   out. These keys are pinned to `false`.

2. **Protected keys** (the tool refuses them): `display.externalUsagePath`,
   `externalUsageFreshnessMs`, `usagePace`, `autoCompactWindow`. They are wired to
   the data feed, or they carry the inverted "bar means remaining" semantics.

## Files

- status line entry: `<REPO>/src/hud-wrapper.js` — referenced from **two**
  settings files when launched from `$HOME`; see README.md's precedence section
- data: `~/.local/share/deepseek-hud/` (`usage-snapshot.json`,
  `balance-ledger.jsonl`, `baseline.json`, `last-render.json`, `generator.log`)
- config: `$CLAUDE_CONFIG_DIR/deepseek-hud.json` (this project),
  `$CLAUDE_CONFIG_DIR/plugins/claude-hud/config.json` (upstream)
- upstream copy: `~/.local/share/deepseek-hud/vendor/claude-hud/`

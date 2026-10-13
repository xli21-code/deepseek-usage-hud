# What does DeepSeek actually charge?

Notes from measuring it. Everything here was arrived at by running the tools in
`probe/` against a real account; nothing is inferred from a price list alone.
The dead ends are included on purpose — they are the reason the final answer is
stated as narrowly as it is.

## The short answer

The DeepSeek console reports, for a window we could also account for locally, a
blended **¥0.168 per 1M tokens** across cache reads, cache misses and output.

Be careful with that number. It is **one measurement over one window**, and a
blended rate depends on the mix of models, cache hits, and output-versus-input
tokens in it — a coding session with long cached contexts and a batch job with
short fresh prompts will not share it. Treat it as a plausibility check for a
window of similar shape, not as a constant to multiply days by.

What the measurement *does* establish is a method: the console is ground truth,
and anything computed locally can be checked against it for the same window. Do
**not** try to turn the rate into a price table; see
[Why a price table is not recoverable](#why-a-price-table-is-not-recoverable).

## Ground truth

The console at `platform.deepseek.com/usage` shows a cost per date range. That
is the only number here that is measured rather than modelled.

**Amounts below are relative, on purpose.** Let **C** be the console's cost for
a reference window of three days whose transcripts could be accounted for
completely. Absolute figures are account-specific and add nothing to the
argument.

Ratios here are still sample-dependent. What is structural is the *rule* — one
assistant record per content block, all sharing a `message.id` — not the ratio;
2.4 is simply how many blocks those particular responses happened to have, and a
session dominated by tool calls will differ. The request gap and the γ values
depend on the model mix, cache-hit ratio and output ratio of the window they
came from. Reproduce them for your own window rather than assuming they carry
over.

Comparing that window against a local scan of the same transcripts:

| | console | local accounting |
|---|---|---|
| API requests | 1.00 | 0.93 |
| tokens | 1.00 | 0.93 |
| cost | **C** | — |

Two things fall out:

- **A 7.3% gap, in requests and tokens alike**, and it has two distinct causes.
  (Recounted against the console window: 4,767 requests and 573,655,866 tokens
  locally, against 5,113 and 615,615,807.)

  *Subagents were being missed entirely.* They live at
  `projects/<project>/<session>/subagents/agent-*.jsonl` — depth 3. The ad-hoc
  scan used for the first pass globbed `projects/*/*.jsonl` and missed every one
  of them (22 files in the sample), undercounting by ~14%. The tools in `probe/`
  walk recursively and never had this bug; the one-off command did. Fixing it
  closed most of the gap.

  *The remainder is traffic that never reaches a transcript.* Claude Code makes
  billed requests through the provider that it does not record: told plainly by
  the harness itself when running headless against a non-Anthropic endpoint —

  > your requests go through api.deepseek.com, which isn't compatible with this
  > update. Nothing breaks: auto mode keeps working, and its classifier requests
  > are billed as before.

  So the auto-mode classifier's calls are charged but leave no JSONL behind. Any
  local token sum is a lower bound for this reason, and nothing in the
  transcripts reveals how much it is — which is why `capture_correction` in the
  config is a fitted constant rather than a computed one, and why it is kept
  visible instead of inlined.

  The running HUD does not depend on either, because it displays the balance
  rather than a computed cost. It matters only if `show_today_estimate` is turned
  on, which is off by default.
- **The implied daily spend is C/3.** That is the figure to sanity-check any
  estimate against; if a computed "today" lands far from it, the estimate is
  wrong, not the console.

## The deduplication trap

Before any of the above means anything, the token counts have to be right.

Claude Code writes **one assistant record per content block** — thinking, text,
and tool_use each get their own JSONL row — and every one of those rows carries
a byte-identical `usage` block for the same API response. Across a four-day
sample the two counts differed by a factor of **2.4** — that many rows per
distinct `message.id`.

- summing rows overcounts by **~2.4x**
- deduplicating by `uuid` does *nothing*: every row has a unique one, so it is
  not a dedup key at all

The correct key is `message.id`, held in a set that spans files (a fork or
resume can copy a transcript).

## The settlement trap

The obvious calibration is: measure the balance, do some work, measure it again,
and divide. This does not work, and it is worth knowing why before trusting any
short-window number.

Two adjacent windows, 11.5 minutes and 1.0 minute:

| window | length | messages | balance fell | implied factor (cache-hit / all-miss) |
|---|---|---|---|---|
| A | 11.5 min | 22 | 0.75% of C | 12.08 / 1.60 |
| B | 1.0 min | 6 | 0.058% of C | 3.46 / 0.31 |

They are adjacent, and **no single pricing model reconciles them**. A lag scan
that shifts the window one minute at a time from −15 to +20 minutes finds no
alignment either: the implied factor moves monotonically, crossing 1.0 and 7.1
on the way but never settling. A fixed delay is therefore also ruled out.

The conclusion is that `/user/balance` **settles in batches**. Say it no more
strongly than this: two adjacent windows disagreed, and a lag scan over ±20
minutes found no alignment. That is consistent with batch settlement and makes a
*fixed* delay of up to 20 minutes unlikely. It does not prove batching — a
longer, or more erratic, settlement cycle would produce the same picture — and
two windows plus a bounded scan are thin evidence for any claim about the
endpoint's internals. A short-window
delta describes when a batch landed, not when the money was spent. Every design
decision downstream follows from this: the status line displays the balance
as-is, and its bar divides by a scale that is itself inferred from a delta — a
rise between two readings. That inference is a heuristic; the README's Known
limits section says where it breaks. The `/ds-usage` report does compute a
burn rate from the ledger — read the restrictions on it in the README, because
a net change spanning a missed top-up is not spend. `probe/lag-scan.js` exists to
re-test the settlement claim rather than assert it.

## Why a price table is not recoverable

The published table has an obvious shape — cache-hit input, cache-miss input,
output, each with a peak and an off-peak rate. Fitting it to a measured cost
gives:

```
cost = γ · A   +   k · (B + C)
```

where `A`, `B`, `C` are the local cache-read, cache-miss and output costs at
table prices, `k` is the currency factor, and `γ` is the effective multiple
applied to cache reads.

**Two unknowns, one equation.** The console provides one cost per window. So the
system is underdetermined by construction, and no amount of care in the
measurement changes that.

Solving for each assumption in turn, against the reference window:

| assumption | implied `γ` | reading |
|---|---|---|
| table is already CNY | 24.1 | cache reads billed at roughly the **miss** rate |
| table is USD (≈7.1) | 1.78 | neither clean nor obviously wrong |

Cache reads dominate the token count by about 50x (562M cache-read against 11M miss-plus-output, measured over the reference window), so `γ` is doing almost all the
work — which is exactly why the two answers look so different while fitting the
same single data point.

**A second equation would come from a window with a materially different
cache-read ratio.** Read the console for single days, pair each with the local
`A`/`B`/`C`, and solve. That is a real method, and it is left undone rather than
half-done.

## What this means for the HUD

Nothing in the running status line depends on any of it. The bar is
`balance / scale`, where both sides are facts: one from the API, one learned from
observed top-ups. No price table is consulted.

The measured constant would only matter if a "today's spend" estimate were shown.
It is not — `show_today_estimate` defaults to `false` — because a number carrying
a 15x uncertainty band does not belong on a status line next to a number that
carries none.

## Reproducing

```bash
export CLAUDE_CONFIG_DIR=~/.config/claude-deepseek   # wherever the transcripts are
node probe/spend-report.js                            # token accounting, deduped
node probe/balance-sample.js                          # append a balance reading
node probe/calibrate.js <sinceISO> <untilISO> <deltaCNY>
node probe/lag-scan.js <sinceISO> <untilISO> <deltaCNY>
```

And read the console yourself:

```
https://platform.deepseek.com/usage
```

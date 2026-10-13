# probe/

The tools used to work out what DeepSeek actually charges, and to interrogate
Claude Code's status-line payload. They are kept because the conclusions in the
main code are only as good as the measurements behind them, and because anyone
who wants to re-derive the numbers should be able to.

They are **not** part of the running HUD — nothing in `src/` imports them.

| Tool | Question it answers |
|---|---|
| `spend-report.js` | What did the transcripts say we spent, per day, per model, at published prices? |
| `balance-sample.js` | What is the balance right now? (append-only ledger) |
| `calibrate.js` | Given a balance delta and a token cost over the same window, what is the price-unit-to-CNY factor? |
| `lag-scan.js` | Is the balance endpoint delayed? Scan candidate lags and look for alignment. |
| `stdin-probe.js` | What exactly does Claude Code put in the status-line payload for a non-Anthropic model? |

Results and dead ends are written up in `../docs/CALIBRATION.md`.

## The trap these exist to document

`spend-report.js` dedupes by `message.id`, not by row and not by `uuid`. Claude
Code writes one assistant record **per content block** (thinking / text /
tool_use), all sharing a `message.id` and all carrying a byte-identical `usage`
block. Summing rows overcounts by about **2.4x**; deduping by `uuid` does
nothing, because every row has a unique one.

Run them against a real transcript tree:

```bash
CLAUDE_CONFIG_DIR=~/.config/claude-deepseek node probe/spend-report.js
```

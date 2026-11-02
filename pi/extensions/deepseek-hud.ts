/**
 * deepseek-hud for pi
 *
 * Port of https://github.com/xli21-code/deepseek-usage-hud (a Claude Code
 * status line) to a pi extension.
 *
 * Division of labour, deliberately the same as upstream:
 *   - the repo's own `src/generate.js` stays the ONLY writer of the snapshot
 *     (balance fetch, batch-tolerant ledger, learned top-up baseline, lock,
 *     throttle). It is battle-tested; this file does not reimplement it.
 *   - this extension is the renderer pi never had. pi has no external
 *     status-line protocol, so the seam is `ctx.ui.setStatus()` instead of
 *     claude-hud's `display.externalUsagePath`.
 *
 * Consequences worth knowing:
 *   - balance is account-level ground truth; pi's per-turn cost for the
 *     `magpie` gateway is 0 in models.json, so cost is NOT derived from pi.
 *   - the same ledger/baseline is shared with Claude Code: one account, one
 *     scale. Running both hosts must not produce two different bars.
 *
 * Phase 2 does not move any of that boundary: `pi-usage.json` is the only file
 * this extension writes, generate.js reads it and attaches it to the snapshot as
 * `_meta.pi_usage`; the status line shows the cache-hit rate instead of a cache
 * token count; the scrollable `/ds` panel lives in lib/deepseek-hud-panel.ts.
 *
 * Phase 3 adds a second account. The snapshot now also carries
 * `_meta.ollama`, and the status line picks the bar from the LIVE MODEL
 * (`ctx.model`, falling back to `PI_MODEL`): an `ollama-cloud/*` model shows
 * that account's dollar balance, anything else keeps the DeepSeek yuan bar.
 * Two currencies must never share one percentage, so the switch is by account,
 * not by summing them.
 *
 * Contract: never block a render, never throw into pi, never leave it blank.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPanel } from "./deepseek-hud-lib/deepseek-hud-panel.ts";
import { displayWidth, fmt, localDate } from "./deepseek-hud-lib/format.ts";

const HOME = os.homedir();
const STATUS_KEY = "deepseek-hud";
const WIDGET_KEY = "ds-report";
const DEBUG = process.env.DEEPSEEK_HUD_DEBUG === "1" || fs.existsSync(path.join(HOME, ".pi", "agent", "deepseek-hud.debug"));
const LOG = path.join(os.tmpdir(), "deepseek-hud-pi.log");

const DEFAULT_REPO = path.join(HOME, "Documents", "Codex", "2026-10-12-deepseek-usage-hud");
/** pi's launcher resolves to node, but a custom launcher may not: spawning the
 *  HUD through a `pi` binary would just start a second agent. */
const NODE_BIN = /(^|[\\/])node(\.exe)?$/.test(process.execPath) ? process.execPath : "node";
const DATA_DIR = process.env.DEEPSEEK_HUD_DATA_DIR?.trim() || path.join(HOME, ".local", "share", "deepseek-hud");
const SNAPSHOT = path.join(DATA_DIR, "usage-snapshot.json");
/** The one file this extension is allowed to write. The snapshot itself stays
 *  generate.js's; this is where pi's own tokens become visible to Claude Code. */
const PI_USAGE = path.join(DATA_DIR, "pi-usage.json");
/** Dedicated config dir from the upstream install; it is what decides usage_max etc. */
const DEDICATED_CONFIG_DIR = path.join(HOME, ".config", "claude-deepseek");

const SIDECAR_SCHEMA = 1;
/** message_end fires per message; the sidecar is not worth a write for each. */
const SIDECAR_MIN_MS = 2000;
const MAX_LINE_WIDTH = 90;
/** Below this, an Ollama pay-as-you-go balance gets the same ⚠ the yuan bar has. */
const OLLAMA_LOW_USD = 5;

function log(msg: string) {
	if (!DEBUG) return;
	try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`); } catch { /* logging must never break a render */ }
}

function readJson<T>(file: string, fallback: T): T {
	try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return fallback; }
}

function mtimeMs(file: string): number {
	try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

/** Repo location: env override, then the local checkout, then nothing. */
function resolveRepoDir(): string | null {
	const candidates = [
		process.env.DEEPSEEK_HUD_REPO?.trim(),
		readJson<{ repoDir?: string }>(path.join(HOME, ".pi", "agent", "deepseek-hud.json"), {}).repoDir,
		DEFAULT_REPO,
	].filter((p): p is string => Boolean(p));
	for (const dir of candidates) {
		try { if (fs.statSync(path.join(dir, "src", "generate.js")).isFile()) return dir; } catch { /* try next */ }
	}
	return null;
}

/**
 * API key, in the order the upstream README documents, plus the LiteLLM env
 * file — the same key funds the gateway this HUD's account is shared with.
 */
function resolveKey(): string | null {
	const fromEnv = process.env.DEEPSEEK_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
	if (fromEnv?.trim()) return fromEnv.trim();
	for (const file of [path.join(HOME, ".config", "litellm", "litellm.env")]) {
		try {
			const text = fs.readFileSync(file, "utf8");
			const m = text.match(/^\s*(?:export\s+)?DEEPSEEK_API_KEY\s*=\s*(.+)$/m);
			if (m) {
				const value = m[1].trim().replace(/^["']|["']$/g, "");
				if (value) return value;
			}
		} catch { /* no file */ }
	}
	return null;
}

/** Upstream config: throttle_seconds lives next to the Claude Code settings. */
function upstreamConfig(): { throttle_seconds?: number; low_balance?: number } {
	const dedicated = path.join(DEDICATED_CONFIG_DIR, "deepseek-hud.json");
	const main = path.join(HOME, ".claude", "deepseek-hud.json");
	return readJson(dedicated, readJson(main, {}));
}

function spawnEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	const key = resolveKey();
	if (key) {
		env.DEEPSEEK_API_KEY = key;
		env.ANTHROPIC_AUTH_TOKEN = env.ANTHROPIC_AUTH_TOKEN || key;
	}
	// Make the child read the same config the upstream install wrote, otherwise
	// it falls back to defaults and the scale silently changes.
	try {
		if (fs.statSync(path.join(DEDICATED_CONFIG_DIR, "settings.json")).isFile()) env.CLAUDE_CONFIG_DIR = DEDICATED_CONFIG_DIR;
	} catch { /* keep inherited value */ }
	return env;
}

interface HudState {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	turns: number;
	startedAt: number;
}

interface SidecarEntry {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	turns: number;
	updated_at: string;
}

interface Sidecar {
	schema: number;
	updated_at: string;
	date: string;
	sessions: Record<string, SidecarEntry>;
}

export default function deepseekHud(pi: any) {
	const repoDir = resolveRepoDir();
	const genPath = repoDir ? path.join(repoDir, "src", "generate.js") : null;
	const reportPath = repoDir ? path.join(repoDir, "src", "report.js") : null;

	let timer: ReturnType<typeof setInterval> | null = null;
	let refreshing = false;
	let lastRender = 0;
	let renderQueued = false;
	let lastText = "";
	/** Set once the session is gone. pi invalidates a captured ctx on shutdown and
	 *  touching it then throws — a HUD must never take pi down with it. */
	let stopped = false;
	/** The model the bar should follow. Set from ctx.model on every render, so a
	 *  `/model` switch is picked up before the next balance refresh lands. */
	let liveModel = "";
	const state: HudState = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, startedAt: Date.now() };

	// ------------------------------------------------------------------ sidecar

	let sidecarKey = "";
	let sidecarBusy = false;
	let sidecarQueued = false;
	let sidecarLast = 0;

	/**
	 * Read, drop entries from another day, overwrite only this process's key,
	 * rename into place. Everything here is async: the message_end path and the
	 * timer must never block on the filesystem, and a failure is logged rather
	 * than thrown, so it cannot reach pi or the render.
	 */
	async function writeSidecar(): Promise<void> {
		if (sidecarBusy) return;
		sidecarBusy = true;
		try {
			const today = localDate();
			let doc: Sidecar | null = null;
			try {
				const raw = JSON.parse(await fsp.readFile(PI_USAGE, "utf8"));
				if (raw && typeof raw === "object" && raw.date === today && raw.sessions && typeof raw.sessions === "object") doc = raw as Sidecar;
			} catch { /* missing or corrupt counts as empty */ }
			if (!doc) doc = { schema: SIDECAR_SCHEMA, updated_at: "", date: today, sessions: {} };
			// Prune before writing, and only other processes' entries: an empty
			// entry (never ran a turn) would otherwise sit in the file forever and
			// show up as a zero block. Ours is skipped so a long-running session
			// keeps its row while it is still live.
			const cutoff = Date.now() - 2 * 60_000;
			for (const [k, v] of Object.entries(doc.sessions)) {
				if (k === sidecarKey) continue;
				if ((v.turns ?? 0) === 0 && Date.parse(v.updated_at) < cutoff) delete doc.sessions[k];
			}
			const at = new Date().toISOString();
			doc.sessions[sidecarKey] = {
				input: state.input,
				output: state.output,
				cacheRead: state.cacheRead,
				cacheWrite: state.cacheWrite,
				turns: state.turns,
				updated_at: at,
			};
			doc.updated_at = at;
			await fsp.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
			const tmp = path.join(DATA_DIR, `.pi-usage.json.${process.pid}.tmp`);
			await fsp.writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
			await fsp.rename(tmp, PI_USAGE);
			sidecarLast = Date.now();
			if (DEBUG) log(`sidecar: ${sidecarKey} ${doc.sessions[sidecarKey].turns} turns`);
		} catch (err) {
			log(`sidecar write failed: ${(err as Error).message}`);
		} finally {
			sidecarBusy = false;
		}
	}

	/** Coalesced, at most one write per SIDECAR_MIN_MS. */
	function sidecarSoon(): void {
		if (sidecarQueued) return;
		sidecarQueued = true;
		const wait = Math.max(0, sidecarLast + SIDECAR_MIN_MS - Date.now());
		setTimeout(() => {
			sidecarQueued = false;
			void writeSidecar();
		}, wait);
	}

	/**
	 * Write the final numbers on shutdown. writeSidecar() returns immediately while
	 * another write is in flight, so an awaited call there could drop the last
	 * turn; this waits for the in-flight write (bounded) and then writes again.
	 */
	async function flushSidecar(timeoutMs = 800): Promise<void> {
		const until = Date.now() + timeoutMs;
		while (sidecarBusy && Date.now() < until) {
			await new Promise((r) => setTimeout(r, 10));
		}
		await writeSidecar();
	}

	// ------------------------------------------------------------------ status

	function snapshot() {
		const snap = readJson<any>(SNAPSHOT, null);
		const cfg = upstreamConfig();
		const throttle = Number(cfg.throttle_seconds) > 0 ? Number(cfg.throttle_seconds) : 60;
		return { snap, throttle };
	}

	/** Refresh through the upstream generator. Never blocks, never throws. */
	function refresh(force: boolean) {
		if (!genPath || refreshing) return;
		const { throttle } = snapshot();
		const age = Date.now() - mtimeMs(SNAPSHOT);
		if (!force && age < throttle * 1000) return;
		refreshing = true;
		try {
			const child = spawn(NODE_BIN, [genPath, ...(force ? ["--force"] : [])], {
				env: spawnEnv(),
				stdio: "ignore",
				detached: true,
				cwd: repoDir ?? undefined,
			});
			child.on("error", (err: Error) => {
				log(`generate spawn error: ${err.message}`);
				refreshing = false;
			});
			child.on("exit", (code: number | null) => {
				refreshing = false;
				log(`generate exit ${code}`);
			});
			child.unref();
		} catch (err) {
			log(`generate failed: ${(err as Error).message}`);
			refreshing = false;
		}
	}

	/** cacheRead over the prompt tokens actually sent. Null means "no denominator". */
	function cacheRate(): number | null {
		const denom = state.input + state.cacheRead;
		if (denom <= 0) return null;
		return state.cacheRead / denom;
	}

	function modelId(): string {
		return liveModel || (process.env.PI_MODEL ?? "").trim();
	}

	/**
	 * Which account the current model bills to.
	 *
	 * Unrecognised ids fall back to DeepSeek: that is the account this HUD was
	 * installed for, and its snapshot is the one that is always present.
	 */
	function accountNow(): "ollama" | "deepseek" {
		return /(^|\/)ollama-cloud\//i.test(modelId()) ? "ollama" : "deepseek";
	}

	/** The one line the status bar shows. Mirrors the HUD's "bar means remaining". */
	function buildLine(): string {
		const { snap } = snapshot();
		if (!snap) return "🔋 无余额快照";
		const meta = snap._meta ?? {};
		const account = accountNow();

		let core: string[];
		let warn = false;
		let stamp = snap.updated_at;
		if (account === "ollama") {
			const ollama = meta.ollama;
			if (!ollama) {
				// Never silently fall back to the yuan balance here: that would label
				// dollars as the account the user is not spending.
				core = ["🔋 Ollama: 无快照"];
			} else {
				const allowance = Number(ollama.allowance_usd) > 0 ? Number(ollama.allowance_usd) : null;
				const balance = Number(ollama.balance_usd) || 0;
				core = [`🔋 $${balance.toFixed(2)}`];
				if (allowance) {
					const raw = Math.max(0, Math.min(100, (balance / allowance) * 100));
					// One decimal just under full: at $59.75 of $60, integer rounding
					// announces "100%" and hides the spend the account actually made.
					core.push(`${raw >= 99 && raw < 100 ? raw.toFixed(1) : Math.round(raw)}%`);
					warn = raw < 15;
				} else {
					warn = balance < OLLAMA_LOW_USD;
				}
				stamp = ollama.updated_at ?? stamp;
			}
		} else {
			const pct = snap.model_scoped?.[0]?.utilization;
			core = [`🔋 ${snap.balance_label ?? "?"}`];
			if (typeof pct === "number") core.push(`${pct}%`);
			warn = Boolean(meta.low_warning);
		}

		const ageSec = (Date.now() - Date.parse(stamp)) / 1000;
		const stale = Number.isFinite(ageSec) && ageSec > 20 * 60 ? " ⏳" : "";

		// Dropped first: session token counts, then the cache hit rate.
		const droppable: string[] = [];
		if (state.input || state.output || state.cacheRead) droppable.push(`会话 ↓${fmt(state.input)} ↑${fmt(state.output)}`);
		const rate = cacheRate();
		if (rate !== null) droppable.push(`缓存命中 ${(rate * 100).toFixed(1)}%`);
		const tail = warn ? "⚠ 余额不足" : "";
		const assemble = () => [...core, ...droppable, tail].filter(Boolean).join(" · ") + stale;
		while (droppable.length && displayWidth(assemble()) > MAX_LINE_WIDTH) droppable.shift();
		return assemble();
	}

	function stop() {
		stopped = true;
		if (timer) clearInterval(timer);
		timer = null;
	}

	/** Everything that touches ctx lives inside the try: reading `ctx.mode` on a
	 *  stale context throws before any of our own code runs. */
	function render(ctx: any) {
		if (stopped || !ctx) return;
		try {
			if (ctx.mode !== "tui") return;
			// The live model, not the one at launch: /model can switch accounts
			// mid-session, and the bar must follow it without waiting for a refresh.
			const m = ctx.model;
			const id = typeof m?.id === "string" ? m.id : typeof m?.modelId === "string" ? m.modelId : "";
			if (id) liveModel = id;
			const text = buildLine();
			if (text === lastText) return;
			lastText = text;
			ctx.ui.setStatus(STATUS_KEY, text);
			log(`render: ${text}`);
		} catch (err) {
			const msg = (err as Error).message ?? String(err);
			log(`render error: ${msg}`);
			if (msg.includes("stale")) stop();
		}
	}

	/** Coalesce renders: message_end fires per message, not per token. */
	function renderSoon(ctx: any, ms = 250) {
		if (renderQueued || stopped) return;
		renderQueued = true;
		setTimeout(() => {
			renderQueued = false;
			render(ctx);
		}, ms);
	}

	function report(force: boolean): string {
		if (!reportPath) return "deepseek-hud: 找不到仓库（设置 DEEPSEEK_HUD_REPO）";
		try {
			const res = spawnSync(NODE_BIN, [reportPath, ...(force ? ["--refresh"] : [])], {
				env: spawnEnv(),
				cwd: repoDir ?? undefined,
				encoding: "utf8",
				timeout: 12_000,
			});
			const out = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
			return out || "deepseek-hud: report 无输出";
		} catch (err) {
			return `deepseek-hud: report 失败 ${(err as Error).message}`;
		}
	}

	// -------------------------------------------------------------------- panel

	let tuiMod: any | null = null;
	let tuiFailReason = "";

	/** Host-provided, so imported lazily: a missing module map degrades the panel
	 *  instead of breaking the extension at load time. The reason is logged once. */
	async function loadTui(): Promise<any | null> {
		if (tuiMod) return tuiMod;
		if (tuiFailReason) return null;
		try {
			tuiMod = await import("@earendil-works/pi-tui");
			return tuiMod;
		} catch (err) {
			tuiFailReason = (err as Error).message;
			log(`pi-tui import failed once: ${tuiFailReason} — /ds uses the widget instead`);
			return null;
		}
	}

	// ------------------------------------------------------------------ handlers

	pi.on("session_start", async (_event: any, ctx: any) => {
		stopped = false;
		state.input = 0;
		state.output = 0;
		state.cacheRead = 0;
		state.cacheWrite = 0;
		state.turns = 0;
		state.startedAt = Date.now();
		lastText = "";
		liveModel = (process.env.PI_MODEL ?? "").trim();
		sidecarKey = `${process.pid}-${new Date(state.startedAt).toISOString()}`;
		log(`session_start repo=${repoDir} key=${resolveKey() ? "yes" : "no"}`);
		if (DEBUG) log(`line: ${buildLine()}`);

		// Show whatever we have immediately, then refresh behind it.
		render(ctx);
		refresh(false);
		await writeSidecar();

		if (timer) clearInterval(timer);
		timer = setInterval(() => {
			// An unawaited throw here used to take the whole pi process down.
			try {
				if (stopped) return stop();
				refresh(false);
				render(ctx);
			} catch (err) {
				log(`tick error: ${(err as Error).message}`);
			}
		}, 30_000);
	});

	pi.on("message_end", async (event: any, ctx: any) => {
		const msg = event?.message;
		if (!msg || msg.role !== "assistant" || !msg.usage) return;
		state.input += msg.usage.input ?? 0;
		state.output += msg.usage.output ?? 0;
		state.cacheRead += msg.usage.cacheRead ?? 0;
		state.cacheWrite += msg.usage.cacheWrite ?? 0;
		state.turns += 1;
		sidecarSoon();
		const now = Date.now();
		if (now - lastRender > 400) {
			lastRender = now;
			renderSoon(ctx, 100);
		}
	});

	pi.on("agent_settled", async (_event: any, ctx: any) => {
		if (stopped) return;
		render(ctx);
		if (DEBUG) log(`line: ${buildLine()} turns=${state.turns}`);
		// A settled turn is the natural moment to pick up a new balance reading.
		refresh(false);
	});

	pi.on("session_shutdown", async () => {
		stop();
		await flushSidecar();
	});

	pi.registerCommand("ds", {
		description: "DeepSeek 余额与用量报告（/ds refresh 强制刷新，/ds hide 关闭）",
		getArgumentCompletions: (prefix: string) => {
			const p = String(prefix || "").toLowerCase();
			return ["refresh", "hide"].filter((w) => w.startsWith(p)).map((w) => ({ value: w, label: w }));
		},
		handler: async (args: string, ctx: any) => {
			const arg = String(args || "").trim().toLowerCase();
			try {
				if (arg === "hide" || arg === "off") {
					ctx.ui.setWidget(WIDGET_KEY, undefined);
					return;
				}
				const force = arg === "refresh" || arg === "r";
				const text = report(force);
				// Fallback 1: print and json have no UI channel, so the report goes to
				// stdout; RPC can still notify.
				if (ctx.mode !== "tui") {
					console.log(text);
					if (ctx.hasUI) ctx.ui.notify("DeepSeek 用量已输出到标准输出", "info");
					return;
				}
				// Fallback 2: no host module map -> the widget, as before.
				const mod = await loadTui();
				if (!mod) {
					ctx.ui.setWidget(WIDGET_KEY, text.split("\n"), { placement: "aboveEditor" });
					render(ctx);
					return;
				}
				// Fallback 3 lives inside the panel: an error line plus the hint,
				// and the panel stays open.
				await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => createPanel(mod, text, tui, theme, keybindings, done, report));
			} catch (err) {
				const msg = (err as Error).message ?? String(err);
				log(`command error: ${msg}`);
				if (msg.includes("stale")) stop();
			}
		},
	});
}

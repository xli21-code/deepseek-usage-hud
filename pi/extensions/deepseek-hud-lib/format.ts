/**
 * Pure text helpers shared by the extension and the panel.
 *
 * They live here rather than in deepseek-hud.ts so they can be asserted without
 * loading pi, and so the extension file stays inside its size budget.
 */

/** "Today" in the local calendar, which is what the sidecar's date means. */
export function localDate(d: Date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Display width in terminal columns: ANSI ignored, East Asian wide and emoji
 * counted as two. Counting code points under-reports every Chinese label in the
 * status line by one column each, which made MAX_LINE_WIDTH a no-op.
 */
const WIDE =
	/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]|[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

export function displayWidth(s: string): number {
	let width = 0;
	for (const ch of s.replace(/\u001b\[[0-9;]*m/g, "")) width += WIDE.test(ch) ? 2 : 1;
	return width;
}

/** Pure formatter: 1234 -> "1.2k", 63_000_000 -> "63.0M". */
export function fmt(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n >= 1e9) return `${(n / 1e9).toFixed(1)}G`;
	if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
	if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
	return String(Math.round(n));
}

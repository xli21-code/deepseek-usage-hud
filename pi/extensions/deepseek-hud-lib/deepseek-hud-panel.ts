/**
 * Scrollable /ds panel for the deepseek-hud pi extension.
 *
 * It sits in a subdirectory on purpose: pi's extension discovery loads every
 * direct .ts file in the extensions dir, and this module is a helper, not an
 * extension. It imports nothing — the caller hands it the host pi-tui module, so
 * a missing module map degrades instead of breaking the extension.
 *
 * Component contract: render(width) / handleInput(data) / invalidate().
 * render() caches by width, and every theme-coloured string is rebuilt on
 * invalidate() so a theme change cannot leave stale colours behind.
 */

const PANEL_TITLE = "DeepSeek usage";
const PANEL_HINT = "↑↓ 滚动 · r 刷新 · q 关闭";

/** The body is report.js output verbatim; only the title and the hint are ours. */
export function createPanel(mod: any, text: string, tui: any, theme: any, keybindings: any, done: (result?: string) => void, report: (force: boolean) => string): any {

	let content: string[] = [];
	let viewHeight = 1;
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;
	/** Set while a synchronous refresh runs, so the hint says so and `r` cannot queue. */
	let busy = false;
	let hint = PANEL_HINT;

	const invalidate = () => {
		cachedWidth = undefined;
		cachedLines = undefined;
	};

	// report.js prints its own title line; restyling that line beats printing it twice.
	const setContent = (raw: string) => {
		content = raw.split("\n");
		if (content[0] === PANEL_TITLE) content.shift();
		invalidate();
	};
	setContent(text);

	const body = {
		render(width: number): string[] {
			return content.map((line) => mod.truncateToWidth(line, width));
		},
		invalidate(): void {},
	};
	const scroll = new mod.ScrollView(body, { axis: "vertical", overscroll: "contain", scrollbar: "auto" });

	return {
		render(width: number): string[] {
			if (cachedLines && cachedWidth === width) return cachedLines;
			const rows = Number(tui?.terminal?.rows) > 0 ? Number(tui.terminal.rows) : 24;
			viewHeight = Math.max(1, Math.min(content.length, rows - 6));
			scroll.updateLayout(content.length, viewHeight, () => {
				try {
					tui.requestRender();
				} catch {
					/* the tui may already be stopped */
				}
			});
			// ScrollView.render returns the whole child; clipping belongs to the
			// layout system, so the panel clips its own window here.
			const lines = scroll.render(width);
			const top = Math.max(0, Math.min(scroll.scrollTop, content.length - viewHeight));
			cachedWidth = width;
			cachedLines = [
				theme.fg("accent", PANEL_TITLE),
				...lines.slice(top, top + viewHeight),
				theme.fg("dim", mod.truncateToWidth(hint, width)),
			];
			return cachedLines;
		},
		handleInput(data: string): void {
			if (keybindings.matches(data, "tui.select.up")) scroll.scrollBy(-1);
			else if (keybindings.matches(data, "tui.select.down")) scroll.scrollBy(1);
			else if (keybindings.matches(data, "tui.select.pageUp")) scroll.scrollBy(-viewHeight);
			else if (keybindings.matches(data, "tui.select.pageDown")) scroll.scrollBy(viewHeight);
			else if (data === "g") scroll.scrollToStart();
			else if (data === "G") scroll.scrollToEnd();
			// spawnSync is only acceptable here: an explicit keypress inside /ds.
			// The hint is painted before the blocking call so the panel does not look
			// frozen for up to the balance timeout.
			else if (data === "r" && !busy) {
				busy = true;
				hint = "刷新中…（余额接口最长 2.5s）";
				invalidate();
				try {
					tui.requestRender();
				} catch {
					/* the tui may already be stopped */
				}
				const next = report(true);
				busy = false;
				hint = PANEL_HINT;
				setContent(next);
			}
			else if (data === "q" || keybindings.matches(data, "tui.select.cancel")) {
				done(undefined);
				return;
			} else return;
			invalidate();
			try {
				tui.requestRender();
			} catch {
				/* the tui may already be stopped */
			}
		},
		invalidate,
	};
}

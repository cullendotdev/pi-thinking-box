/**
 * Thinking Box Extension
 *
 * Wraps agent thinking blocks in a styled container, similar to how user
 * messages have a background box. Two display modes are supported:
 *
 * - `background`  — fills the box with a configurable hex color (the original
 *                   behaviour, ChatGPT-style).
 * - `bordered`    — draws a border around the thinking text. Border character
 *                   set, border color, and corner style are all configurable.
 *
 * Both modes share the same padding / header / line-count settings and the
 * same `bgColor` (which acts as an optional interior fill in bordered mode).
 *
 * Commands:
 *   /thinking-box  Opens an interactive settings menu to configure all options.
 *
 * User config persists to ~/.pi/agent/config/thinking-box.json — survives package updates.
 *
 * Implementation: monkey-patches AssistantMessageComponent.prototype.updateContent
 * to wrap thinking Markdown in either a `Box` (background mode) or a custom
 * `BorderedBox` (bordered mode), with configurable background, padding,
 * header, and line count. Accesses the active theme via globalThis (same
 * symbol-based mechanism the original component uses) so thinking text,
 * labels, and errors follow the theme.
 */

import { mkdir, readFile, writeFile, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	DynamicBorder,
	getAgentDir,
	Theme,
	type ExtensionAPI,
	getSettingsListTheme,
	getSelectListTheme,
} from "@earendil-works/pi-coding-agent";
import {
	Box,
	Container,
	getKeybindings,
	Input,
	Markdown,
	SelectList,
	type Component,
	type MarkdownTheme,
	type SelectItem,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import defaults from "./config.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Theme access
// ---------------------------------------------------------------------------

/**
 * Pi stores the active theme on globalThis with a well-known Symbol.
 * This is the same mechanism the assistant-message component uses internally;
 * we re-use the public Theme class (exported) to access it without deep imports.
 */
const THEME_KEY: unique symbol = Symbol.for("@earendil-works/pi-coding-agent:theme");

function getTheme(): Theme {
	const t = (globalThis as Record<symbol, Theme | undefined>)[THEME_KEY];
	if (!t) throw new Error("Theme not initialised — is pi running?");
	return t;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The old location of the user config (pre-migration to config/ subdirectory). */
const OLD_USER_CONFIG_FILE = join(getAgentDir(), "thinking-box.json");

/** User config lives in ~/.pi/agent/config/ so it survives package updates. */
const USER_CONFIG_FILE = join(getAgentDir(), "config", "thinking-box.json");

// ---------------------------------------------------------------------------
// Runtime state (module-level)
// ---------------------------------------------------------------------------

interface ThinkingBoxConfig {
	enabled: boolean;
	displayMode: "background" | "bordered";
	bgColor: string | null;
	borderColor: string | null;
	borderThickness: "thin" | "thick";
	roundedCorners: boolean;
	paddingX: number;
	paddingY: number;
	showHeader: boolean;
	headerLabel: string;
	showThinkingLevel: boolean;
	showArrow: boolean;
	showLineCount: boolean;
}

// JSON imports widen string values to `string`; narrow back to the union so
// the rest of the file is exhaustively type-checked.
let config: ThinkingBoxConfig = {
	...(defaults as unknown as ThinkingBoxConfig),
};

/** Reference to ExtensionAPI, set once during extension init. Used to query the current thinking level. */
let piApi: ExtensionAPI | null = null;

let originalUpdateContent: typeof AssistantMessageComponent.prototype.updateContent | null = null;

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

/** Convert hex (with or without #) to ANSI truecolor background escape. */
function hexToAnsiBg(hex: string): string {
	const clean = hex.startsWith("#") ? hex.slice(1) : hex;
	const r = parseInt(clean.slice(0, 2), 16);
	const g = parseInt(clean.slice(2, 4), 16);
	const b = parseInt(clean.slice(4, 6), 16);
	if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
		throw new Error(`Invalid hex color: ${hex}`);
	}
	return `\x1b[48;2;${r};${g};${b}m`;
}

/** Create a bgFn for the Box component from a hex color string. */
function createBgFn(hexColor: string): (text: string) => string {
	const ansiBg = hexToAnsiBg(hexColor);
	return (text: string) => `${ansiBg}${text}\x1b[49m`;
}

/** Style thinking text using the active theme. */
function thinkingStyle(text: string): string {
	return getTheme().fg("thinkingText", text);
}

/** Style error text using the active theme. */
function errorStyle(text: string): string {
	return getTheme().fg("error", text);
}

// ---------------------------------------------------------------------------
// Border styles & BorderedBox
// ---------------------------------------------------------------------------

/** Characters that make up a border: corners + edges. */
interface BorderChars {
	topLeft: string;
	topRight: string;
	bottomLeft: string;
	bottomRight: string;
	horizontal: string;
	vertical: string;
}

/**
 * Border glyph tables keyed by thickness. The corner glyphs are square by
 * default; `resolveBorderChars` swaps in the rounded pair for thin borders
 * when the user opts in. Unicode has no standard heavy "rounded" corner, so
 * the rounded flag is ignored when `borderThickness === "thick"`.
 */
const BORDER_STYLES: Record<ThinkingBoxConfig["borderThickness"], { square: BorderChars; rounded: BorderChars }> = {
	// Thin lines: ─ │ with square (┌┐└┘) or rounded (╭╮╰╯) corners
	thin: {
		square: { topLeft: "┌", topRight: "┐", bottomLeft: "└", bottomRight: "┘", horizontal: "─", vertical: "│" },
		rounded: { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│" },
	},
	// Heavy lines: ━ ┃ with square corners (┏┓┗┛)
	thick: {
		square: { topLeft: "┏", topRight: "┓", bottomLeft: "┗", bottomRight: "┛", horizontal: "━", vertical: "┃" },
		rounded: { topLeft: "┏", topRight: "┓", bottomLeft: "┗", bottomRight: "┛", horizontal: "━", vertical: "┃" },
	},
};

/**
 * Resolve the effective border glyphs for the current config. Rounded corners
 * only apply to thin borders.
 */
function resolveBorderChars(thickness: ThinkingBoxConfig["borderThickness"], rounded: boolean): BorderChars {
	const table = BORDER_STYLES[thickness];
	return rounded && thickness === "thin" ? table.rounded : table.square;
}

/** Convert hex (with or without #) to ANSI truecolor foreground escape. */
function hexToAnsiFg(hex: string): string {
	const clean = hex.startsWith("#") ? hex.slice(1) : hex;
	const r = parseInt(clean.slice(0, 2), 16);
	const g = parseInt(clean.slice(2, 4), 16);
	const b = parseInt(clean.slice(4, 6), 16);
	if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
		throw new Error(`Invalid hex color: ${hex}`);
	}
	return `\x1b[38;2;${r};${g};${b}m`;
}

/** Create a foreground-fn for border glyphs from a hex color string. */
function createBorderFgFn(hexColor: string): (text: string) => string {
	const ansiFg = hexToAnsiFg(hexColor);
	return (text: string) => `${ansiFg}${text}\x1b[39m`;
}

/**
 * BorderedBox — a Box that also draws a border on all four sides.
 *
 * The interior is delegated to a standard `Box` (with padding + optional bg).
 * Border glyphs are placed at column 0 / (width-1) of every line, and a full
 * top/bottom border line is prepended/appended. The bg color (if any) only
 * covers the interior — the border glyphs sit on the parent's background.
 *
 * Why not extend Box directly? `Box` has no concept of borders, and the
 * `paddingX/Y` semantics differ (Box pads each line; BorderedBox needs a
 * different layout so the interior's padded lines align under the border).
 * Wrapping an inner Box keeps the bg + padding logic identical to the
 * background mode.
 */
class BorderedBox implements Container {
	children: Component[] = [];
	private inner: Box;
	private chars: BorderChars;
	private borderColor: (text: string) => string;
	private cache?: { width: number; bgSample: string | undefined; childLines: string[]; lines: string[] };

	constructor(
		paddingX: number,
		paddingY: number,
		bgFn: ((text: string) => string) | undefined,
		chars: BorderChars,
		borderColor: (text: string) => string,
	) {
		this.inner = new Box(paddingX, paddingY, bgFn);
		this.chars = chars;
		this.borderColor = borderColor;
	}

	addChild(component: Component): void {
		this.children.push(component);
		this.inner.addChild(component);
		this.invalidate();
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
		}
		// Inner Box manages its own child list; rebuild by clearing + re-adding.
		this.inner.clear();
		for (const c of this.children) this.inner.addChild(c);
		this.invalidate();
	}

	clear(): void {
		this.children = [];
		this.inner.clear();
		this.invalidate();
	}

	invalidate(): void {
		this.cache = undefined;
		this.inner.invalidate();
		for (const c of this.children) c.invalidate?.();
	}

	private matchCache(width: number, childLines: string[], bgSample: string | undefined): boolean {
		const cache = this.cache;
		return (
			!!cache &&
			cache.width === width &&
			cache.bgSample === bgSample &&
			cache.childLines.length === childLines.length &&
			cache.childLines.every((line, i) => line === childLines[i])
		);
	}

	render(width: number): string[] {
		if (this.children.length === 0) return [];

		// The border takes 2 columns total (1 left, 1 right) and 2 rows total
		// (1 top, 1 bottom). Need at least 3 columns / 3 rows to draw anything.
		if (width < 3) return [];

		const innerWidth = width - 2;
		const innerLines = this.inner.render(innerWidth);
		if (innerLines.length === 0) return [];

		// Sample bg so we can detect changes (mirrors Box's invalidation strategy).
		// We can detect the inner Box's bgFn by looking at the first inner line —
		// it has been bg'd by the Box already, so we use the line itself as the
		// "what did the bg produce" signal.
		const bgSample = innerLines[0];

		if (this.matchCache(width, innerLines, bgSample)) {
			return this.cache!.lines;
		}

		const { topLeft, topRight, bottomLeft, bottomRight, horizontal, vertical } = this.chars;
		const topBorder = this.borderColor(topLeft + horizontal.repeat(innerWidth) + topRight);
		const bottomBorder = this.borderColor(bottomLeft + horizontal.repeat(innerWidth) + bottomRight);
		const leftBorder = this.borderColor(vertical);
		const rightBorder = this.borderColor(vertical);

		const lines: string[] = [topBorder];
		for (const innerLine of innerLines) {
			lines.push(leftBorder + innerLine + rightBorder);
		}
		lines.push(bottomBorder);

		this.cache = { width, bgSample, childLines: innerLines, lines };
		return lines;
	}
}


// ---------------------------------------------------------------------------
// Header rendering
// ---------------------------------------------------------------------------

/**
 * Build the thinking block header line.
 * Format:
 * - collapsed: "▶ {label} · {level} · {N lines} (hidden)"
 * - expanded: "▼ {label} · {level}".
 * Returns a Text component styled with the active theme.
 */
function createThinkingHeader(hideThinking: boolean, thinkingText: string): Text {
	const t = getTheme();
	const label = config.headerLabel || "Thinking";
	const levelSuffix = buildLevelSuffix();

	if (hideThinking) {
		// Collapsed state: "▶ {label}[ · {level}][ · {N lines}] (hidden)"
		const lineCountSuffix = buildLineCountSuffix(thinkingText);
		const arrow = config.showArrow ? "▶ " : "";
		const text = t.italic(t.fg("thinkingText", `${arrow}${label}${levelSuffix}${lineCountSuffix} (hidden)`));
		return new Text(text, 1, 0);
	}

	// Expanded state: "▼ {label}[ · {level}]"
	const arrow = config.showArrow ? t.fg("accent", t.bold("▼")) + " " : "";
	const headerText = arrow + t.fg("thinkingText", label + levelSuffix);
	return new Text(headerText, 1, 0);
}

/** Build the thinking level suffix string (e.g., " · medium"), or empty if disabled/off. */
function buildLevelSuffix(): string {
	if (!config.showThinkingLevel || !piApi) return "";
  try {
     const level = piApi.getThinkingLevel();
     if (!level || level === "off") return "";
     const t = getTheme();
     return " " + t.fg("dim", "·") + " " + t.fg("dim", level);
  } catch {
     return ""; // piApi is stale after session reload — degrade gracefully
  }
}

/**
 * Passthrough `MarkdownTheme` used to count rendered lines without
 * actually styling the output. All formatter functions return their
 * input unchanged, so a one-off `new Markdown(...).render(width)` call
 * returns the *plain* lines the real renderer would produce (paragraph
 * breaks, code blocks, list nesting, and soft-wrap are all preserved)
 * — the only thing missing is ANSI color codes, which don't affect
 * the line count.
 */
const PASSTHROUGH_THEME: MarkdownTheme = {
	heading: (t) => t,
	link: (t) => t,
	linkUrl: (t) => t,
	code: (t) => t,
	codeBlock: (t) => t,
	codeBlockBorder: (t) => t,
	quote: (t) => t,
	quoteBorder: (t) => t,
	hr: (t) => t,
	listBullet: (t) => t,
	bold: (t) => t,
	italic: (t) => t,
	strikethrough: (t) => t,
	underline: (t) => t,
};

/**
 * Estimated render width used when counting thinking-block lines for
 * the header. The real render width depends on the terminal width and
 * the box config (`Box` reserves `2 * paddingX` columns; `BorderedBox`
 * reserves 2), neither of which is known at header-construction time.
 * 80 columns is a reasonable middle ground for a typical terminal and
 * is kept *constant* so the count doesn't flicker as the user resizes
 * the terminal. If the user is on a much narrower or wider terminal
 * the count will be approximate — that's documented behaviour.
 */
const ESTIMATED_RENDER_WIDTH = 80;

/** Count the number of lines a thinking block would render to at `width`. */
function countRenderedLines(thinkingText: string, width: number): number {
	// Use a fresh, throwaway Markdown instance so we don't interfere with
	// the cached output of the real thinking block.
	const probe = new Markdown(thinkingText, 0, 0, PASSTHROUGH_THEME);
	return probe.render(width).length;
}

/** Build the line count suffix string (e.g., " · 47 lines"), or empty if disabled. */
function buildLineCountSuffix(thinkingText: string): string {
	if (!config.showLineCount) return "";
	const lineCount = countRenderedLines(thinkingText, ESTIMATED_RENDER_WIDTH);
	if (lineCount === 0) return "";
	const t = getTheme();
	const noun = lineCount === 1 ? "line" : "lines";
	return " " + t.fg("dim", "·") + " " + t.fg("dim", `${lineCount} ${noun}`);
}

// ---------------------------------------------------------------------------
// Config persistence (writes to config.json on disk)
// ---------------------------------------------------------------------------

async function persistConfig(): Promise<void> {
	// Only persist keys that differ from defaults (overrides-only delta).
	// Missing keys in the user file fall through to config.json defaults,
	// so new settings added in future versions default correctly.
	const overrides: Partial<ThinkingBoxConfig> = {};
	for (const key of Object.keys(config) as (keyof ThinkingBoxConfig)[]) {
		if (config[key] !== (defaults as Record<string, unknown>)[key]) {
			(overrides as Record<string, unknown>)[key] = config[key];
		}
	}
	await mkdir(dirname(USER_CONFIG_FILE), { recursive: true });
	await writeFile(USER_CONFIG_FILE, JSON.stringify(overrides, null, 2) + "\n", "utf-8");
}

async function loadConfig(): Promise<void> {
	// Migrate old config file to new location if it exists
	try {
		const s = await stat(OLD_USER_CONFIG_FILE);
		if (s.isFile()) {
			await mkdir(dirname(USER_CONFIG_FILE), { recursive: true });
			await rename(OLD_USER_CONFIG_FILE, USER_CONFIG_FILE);
		}
	} catch {
		// Old file doesn't exist — nothing to migrate
	}

	try {
		const raw = await readFile(USER_CONFIG_FILE, "utf-8");
		const parsed = JSON.parse(raw) as Partial<ThinkingBoxConfig> & {
			// Legacy fields from earlier iterations that need migration to
			// the current schema. `borderStyle` was a finer-grained enum
			// that has since been replaced by the simpler `borderThickness`
			// + `roundedCorners` pair.
			borderStyle?: "single" | "double" | "rounded" | "thick" | "ascii";
		};
		// Migrate the legacy `borderStyle` enum to the current
		// `borderThickness` flag. Only "thick" maps to "thick"; every
		// other value (single/double/rounded/ascii) collapses to "thin".
		// The `borderStyle` field is then dropped from the persisted
		// file on the next `persistConfig()` call.
		if (parsed.borderStyle && !parsed.borderThickness) {
			parsed.borderThickness = parsed.borderStyle === "thick" ? "thick" : "thin";
		}
		delete parsed.borderStyle;
		config = { ...config, ...parsed };
	} catch {
		// File missing or parse error — keep defaults from config.json
	}
}

// ---------------------------------------------------------------------------
// Monkey-patch
// ---------------------------------------------------------------------------

/** Private property accessor type for AssistantMessageComponent internals. */
type AssistantPrivate = {
	lastMessage?: AssistantMessage;
	contentContainer: Container;
	hideThinkingBlock: boolean;
	markdownTheme: InstanceType<typeof Markdown> extends { theme: infer T } ? T : unknown;
	hiddenThinkingLabel: string;
	hasToolCalls: boolean;
};

function applyMonkeyPatch(): void {
	if (originalUpdateContent) return; // already patched

	originalUpdateContent = AssistantMessageComponent.prototype.updateContent;

	AssistantMessageComponent.prototype.updateContent = function (
		this: AssistantMessageComponent,
		message: AssistantMessage,
	): void {
		// Bail-out conditions: disabled, or the active mode is missing its
		// required color (bgColor for background, borderColor for bordered).
		const missingColor =
			(config.displayMode === "background" && !config.bgColor) ||
			(config.displayMode === "bordered" && !config.borderColor);
		if (!config.enabled || missingColor) {
			originalUpdateContent!.call(this, message);
			return;
		}

		const self = this as unknown as AssistantPrivate;

		self.lastMessage = message;
		self.contentContainer.clear();

		const hasVisibleContent = message.content.some(
			(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);

		if (hasVisibleContent) {
			self.contentContainer.addChild(new Spacer(1));
		}

		const mdTheme = (self as any).markdownTheme;

		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				self.contentContainer.addChild(new Markdown(content.text.trim(), 1, 0, mdTheme));
			} else if (content.type === "thinking" && content.thinking.trim()) {
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				if (self.hideThinkingBlock) {
					// Hidden thinking block.
					if (config.showHeader) {
						// Show a styled collapse indicator header
						self.contentContainer.addChild(
							createThinkingHeader(true, content.thinking.trim()),
						);
					} else {
						// Fall back to original hidden label
						const t = getTheme();
						self.contentContainer.addChild(
							new Text(t.italic(t.fg("thinkingText", self.hiddenThinkingLabel)), 1, 0),
						);
					}
					if (hasVisibleContentAfter) {
						self.contentContainer.addChild(new Spacer(1));
					}
				} else {
					// Visible thinking block — wrap in a thinking section container.
					const thinkingSection = new Container();

					// Header bar (optional)
					if (config.showHeader) {
						thinkingSection.addChild(createThinkingHeader(false, content.thinking.trim()));
					}

					// Thinking content wrapped in a styled container.
					// Mode = "background" → Box with bg color.
					// Mode = "bordered"  → BorderedBox with border (bg optional).
					const thinkingMd = new Markdown(content.thinking.trim(), 1, 0, mdTheme, {
						color: (text: string) => thinkingStyle(text),
						italic: true,
					});

					let thinkingBox: Component;
					if (config.displayMode === "bordered") {
						const borderFgFn = createBorderFgFn(config.borderColor!);
						const chars = resolveBorderChars(config.borderThickness, config.roundedCorners);
						// Bordered mode is border-only: no interior background fill,
						// and padding is forced to 0 so the border sits flush with
						// the text. The configured padding values are preserved
						// for when the user switches back to background mode.
						const bordered = new BorderedBox(0, 0, undefined, chars, borderFgFn);
						bordered.addChild(thinkingMd);
						thinkingBox = bordered;
					} else {
						const bgFn = createBgFn(config.bgColor!);
						const box = new Box(config.paddingX, config.paddingY, bgFn);
						box.addChild(thinkingMd);
						thinkingBox = box;
					}
					thinkingSection.addChild(thinkingBox);

					self.contentContainer.addChild(thinkingSection);

					if (hasVisibleContentAfter) {
						self.contentContainer.addChild(new Spacer(1));
					}
				}
			}
		}

		// --- Error / abort handling (same as original) ---
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		self.hasToolCalls = hasToolCalls;
		if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMsg =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				if (hasVisibleContent) {
					self.contentContainer.addChild(new Spacer(1));
				} else {
					self.contentContainer.addChild(new Spacer(1));
				}
				self.contentContainer.addChild(new Text(errorStyle(abortMsg), 1, 0));
			} else if (message.stopReason === "error") {
				const errMsg = message.errorMessage || "Unknown error";
				self.contentContainer.addChild(new Spacer(1));
				self.contentContainer.addChild(new Text(errorStyle(`Error: ${errMsg}`), 1, 0));
			}
		}
	};
}

// ---------------------------------------------------------------------------
// Color presets for the background color submenu
// ---------------------------------------------------------------------------

const COLOR_PRESETS: SelectItem[] = [
	{ value: "#343541", label: "Default", description: "Dark gray (ChatGPT-style)" },
	{ value: "#2d2d30", label: "VS Code Dark", description: "Editor dark" },
	{ value: "#1e1e2e", label: "Dark Blue-Gray" },
	{ value: "#282a36", label: "Dracula" },
	{ value: "#1a1b26", label: "Tokyo Night" },
	{ value: "#2b213a", label: "Purple Twilight" },
	{ value: "#3c3836", label: "Gruvbox Dark" },
	{ value: "#1e1e24", label: "Deep Black" },
	{ value: "#000000", label: "Pure Black" },
	{ value: "__custom__", label: "Custom…", description: "Enter a custom hex color via input dialog" },
];

/** Sentinel value used to signal that the custom-color input dialog should open. */
const CUSTOM_COLOR_SENTINEL = "__custom__";

/** Sentinel value used to signal that the label input dialog should open. */
const EDIT_LABEL_SENTINEL = "__edit__";

// ---------------------------------------------------------------------------
// Submenu factory helpers
// ---------------------------------------------------------------------------

/**
 * Color picker submenu with live preview and inline custom color entry.
 * `onPreview` fires on:
 *   - arrow-key navigation through the preset list (so the main settings
 *     UI can update its preview box in real time), and
 *   - every keystroke in the custom hex input, when the current value
 *     parses as a valid 6-digit hex (with or without leading `#`).
 * Partial / invalid input is silently ignored; the preview stays on the
 * last good value until the user completes the hex code.
 *
 * Esc on the preset list closes the submenu and reverts to the value
 * before it was opened. Esc on the custom input goes back to the
 * preset list (without closing the submenu) and also reverts to the
 * value before it was opened — so cancelling an in-progress custom
 * edit drops everything that happened in the submenu, including any
 * preset the user arrowed through on the way to Custom….
 */
function createColorSubmenu(
	currentValue: string,
	selectListTheme: ReturnType<typeof getSelectListTheme>,
	onPreview: (color: string) => void,
	done: (value?: string) => void,
): Container {
	// The value before the submenu was opened. Both Esc paths revert
	// to this: Esc on the preset list closes the submenu, Esc on the
	// custom input goes back to the preset list. In both cases the
	// user's intent is "cancel and go back to where I was" — which
	// means the value before they started touching this submenu.
	const originalColor = currentValue;
	const container = new Container();
	const kb = getKeybindings();

	// Mutable state (reassigned on rebuild)
	let selectList: SelectList;
	let customInput: Input | null = null;
	let showingInput = false;

	/** Full rebuild of the container's child tree for the current mode. */
	const rebuild = (): void => {
		container.clear();

		if (showingInput && customInput) {
			// --- Custom hex input mode ---
			container.addChild(
				new Text("Enter a 6-digit hex color (e.g. #2d2d30 or 2d2d30):", 0, 1),
			);
			container.addChild(new Spacer(1));
			container.addChild(customInput);
			container.addChild(new Spacer(1));
			container.addChild(
				new Text("Live preview as you type · Enter to confirm · Esc to go back", 0, 0),
			);
		} else {
			// --- SelectList mode ---
			// Title
			container.addChild(new Text(selectListTheme.selectedPrefix("Background Color"), 0, 1));
			container.addChild(new Spacer(1));

			selectList = new SelectList(
				COLOR_PRESETS,
				Math.min(COLOR_PRESETS.length, 10),
				selectListTheme,
			);

			// Pre-select current value
			const currentIndex = COLOR_PRESETS.findIndex((o) => o.value === currentValue);
			if (currentIndex !== -1) selectList.setSelectedIndex(currentIndex);

			selectList.onSelectionChange = (item) => {
				if (item.value !== CUSTOM_COLOR_SENTINEL) {
					onPreview(item.value);
				}
			};

			selectList.onSelect = (item) => {
				if (item.value === CUSTOM_COLOR_SENTINEL) {
					// Transition to custom hex input. Reset the live
					// preview to the saved color so the user sees what
					// they're editing away from, not the last preset
					// they arrowed through on the way to Custom….
					onPreview(originalColor);
					customInput = new Input();
					customInput.setValue("#");
				(customInput as any).cursor = 1;
					showingInput = true;
					rebuild();
				} else {
					done(item.value);
				}
			};

			selectList.onCancel = () => {
				onPreview(originalColor); // Restore original on cancel
				done();
			};

			container.addChild(selectList);

			container.addChild(new Spacer(1));
			container.addChild(
				new Text("↑↓ navigate (live preview) · Enter select · Esc cancel", 0, 0),
			);
		}
	};

	container.handleInput = (data: string) => {
		if (showingInput && customInput) {
			if (kb.matches(data, "tui.input.submit")) {
				const raw = customInput.getValue().trim();
				if (raw && /^#?[0-9a-fA-F]{6}$/.test(raw)) {
					const normalized = raw.startsWith("#") ? raw : `#${raw}`;
					onPreview(normalized);
					done(normalized);
				}
				return;
			}
			if (kb.matches(data, "tui.select.cancel")) {
				// Escape (or ctrl+c) → cancel the custom edit and go
				// back to the preset list. Revert the live preview to
				// the value the user had *before opening this submenu*
				// (`originalColor`). This is what "cancel" means: drop
				// everything that happened in the submenu — including
				// any preset the user may have arrowed through on the
				// way to Custom… — and go back to where they started.
				// The preset list's own Esc handler does the same thing
				// when cancelling the submenu entirely.
				//
				// We use the keybinding matcher instead of checking
				// `data === "\x1b"` so terminals that send escape via
				// the Kitty keyboard protocol (e.g. \x1b[27u on Kitty,
				// WezTerm, Ghostty, foot) are handled too.
				showingInput = false;
				customInput = null;
				onPreview(originalColor);
				rebuild();
				return;
			}
			customInput.handleInput(data);
			// Live preview: if the current value parses as a valid 6-digit
			// hex (with or without leading `#`), fire onPreview so the
			// main settings UI updates in real time — same UX as the
			// preset list's arrow-key navigation. Partial / invalid input
			// is silently ignored; the preview stays on the last good
			// value until the user completes the hex code.
			const current = customInput.getValue().trim();
			if (/^#?[0-9a-fA-F]{6}$/.test(current)) {
				const normalized = current.startsWith("#") ? current : `#${current}`;
				onPreview(normalized);
			}
		} else {
			selectList!.handleInput(data);
		}
	};

	rebuild();
	return container;
}

/**
 * Label-editing submenu that opens an inline Input field instead of closing
 * the settings dialog to prompt externally.
 */
function createLabelSubmenu(
	currentValue: string,
	selectListTheme: ReturnType<typeof getSelectListTheme>,
	done: (value?: string) => void,
): Container {
	const originalLabel = currentValue;
	const container = new Container();
	const kb = getKeybindings();

	// Mutable state
	let selectList: SelectList;
	let editInput: Input | null = null;
	let showingInput = false;

	const rebuild = (): void => {
		container.clear();

		if (showingInput && editInput) {
			// --- Inline input mode ---
			container.addChild(new Text("Header Label", 0, 1));
			container.addChild(new Spacer(1));
			container.addChild(editInput);
			container.addChild(new Spacer(1));
			container.addChild(new Text("Enter to confirm · Esc to go back", 0, 0));
		} else {
			// --- SelectList mode ---
			container.addChild(
				new Text(selectListTheme.selectedPrefix("Header Label"), 0, 1),
			);
			container.addChild(new Spacer(1));
			container.addChild(
				new Text(`Current: "${currentValue}"`, 0, 0),
			);
			container.addChild(new Spacer(1));

			selectList = new SelectList(
				[
					{
						value: EDIT_LABEL_SENTINEL,
						label: "Edit label…",
						description: "Type a new header label",
					},
				],
				3,
				selectListTheme,
			);

			selectList.onSelect = (_item) => {
				editInput = new Input();
				editInput.setValue(currentValue);
				showingInput = true;
				rebuild();
			};

			selectList.onCancel = () => {
				done();
			};

			container.addChild(selectList);
		}
	};

	container.handleInput = (data: string) => {
		if (showingInput && editInput) {
			if (kb.matches(data, "tui.input.submit")) {
				const val = editInput.getValue().trim();
				if (val) {
					// Update local snapshot so the SelectList-mode view
					// shows the new value if the user re-enters the submenu.
					currentValue = val;
					done(val);
				}
				return;
			}
			if (kb.matches(data, "tui.select.cancel")) {
				// Escape (or ctrl+c) → back to SelectList (keep original).
				// Use the keybinding matcher so terminals that send escape
				// via the Kitty keyboard protocol (e.g. \x1b[27u on Kitty,
				// WezTerm, Ghostty, foot) are handled too.
				showingInput = false;
				editInput = null;
				rebuild();
				return;
			}
			editInput.handleInput(data);
		} else {
			selectList!.handleInput(data);
		}
	};

	rebuild();
	return container;
}

/**
 * Build a short human-readable summary of the current border config.
 * Used as the `currentValue` of the "Customize Border" item in the main
 * settings list so the user can see their border settings at a glance
 * without opening the submenu.
 */
function summarizeBorderConfig(): string {
	if (config.borderThickness === "thick") return "thick";
	return config.roundedCorners ? "thin / rounded" : "thin / square";
}

/**
 * Wrap a `SettingsListTheme` to apply muted + strikethrough styling to one
 * specific row (both label and value). Used to visually disable the
 * "Rounded Corners" row when `borderThickness === "thick"` (heavy borders
 * always have square corners — Unicode has no heavy rounded corner glyphs).
 *
 * The disabled state is read via the `isDisabled` callback on every render,
 * so toggling `borderThickness` inside the submenu updates the row styling
 * immediately without rebuilding the submenu.
 *
 * Implementation note: `SettingsListTheme.value(text, selected)` doesn't
 * receive the row label, so we can't match the value to its row directly.
 * Instead, the wrapped `label` function stashes a flag in a closure
 * variable that the next `value` call reads. The SettingsList always calls
 * `label` immediately before `value` for each row, so the flag is always
 * fresh.
 */
function wrapSettingsListThemeWithDisabledRow(
	baseTheme: ReturnType<typeof getSettingsListTheme>,
	disabledLabel: string,
	isDisabled: () => boolean,
): ReturnType<typeof getSettingsListTheme> {
	let nextValueIsDisabled = false;
	const matches = (labelText: string) => labelText.trimStart().startsWith(disabledLabel);
	const style = (text: string): string => {
		const t = getTheme();
		// Apply strikethrough first, then override the foreground with the
		// muted theme color. The row stays navigable so the current value
		// remains visible.
		return t.fg("muted", t.strikethrough(text));
	};
	return {
		...baseTheme,
		label: (text: string, selected: boolean) => {
			const disabled = isDisabled() && matches(text);
			nextValueIsDisabled = disabled;
			if (disabled) return style(text);
			return baseTheme.label(text, selected);
		},
		value: (text: string, selected: boolean) => {
			if (nextValueIsDisabled) return style(text);
			return baseTheme.value(text, selected);
		},
	};
}

/**
 * Build the "Customize Border" submenu — a SettingsList with three items:
 *   1. Border Color   — color picker submenu (reuses createColorSubmenu)
 *   2. Border Thickness — thin | thick
 *   3. Rounded Corners  — on | off
 *
 * `onChange(id, value)` fires when any item changes so the caller can
 *   - persist the new value
 *   - update the main "Customize Border" item's currentValue (summary)
 *   - re-render the live preview
 *   - request a TUI render
 */
function createCustomizeBorderSubmenu(
	settingsListTheme: ReturnType<typeof getSettingsListTheme>,
	selectListTheme: ReturnType<typeof getSelectListTheme>,
	onChange: (id: string, newValue: string) => void,
	done: () => void,
): Container {
	const container = new Container();

	const subItems: SettingItem[] = [
		{
			id: "borderColor",
			label: "Border Color",
			description: `Current: ${config.borderColor || "(none)"}`,
			currentValue: config.borderColor || "none",
			submenu: (_currentValue, subDone) =>
				createColorSubmenu(
					config.borderColor ?? "",
					selectListTheme,
					(color: string) => {
						config.borderColor = color;
						onChange("borderColor", color);
					},
					subDone,
				),
		},
		{
			id: "borderThickness",
			label: "Border Thickness",
			description: "'thin' uses single-line characters (─│); 'thick' uses heavy characters (━┃).",
			currentValue: config.borderThickness,
			values: ["thin", "thick"],
		},
		{
			id: "roundedCorners",
			label: "Rounded Corners",
			// Dynamic description: explain the no-op state when thick, the
			// behaviour when thin. Getters are read on every render, so
			// toggling borderThickness updates the description immediately.
			get description() {
				return config.borderThickness === "thick"
					? "Heavy borders always have square corners — this option has no effect in thick mode."
					: "Use rounded corners (╭╮╰╯) on thin borders.";
			},
			// Dynamic currentValue: always reflects the live config. The
			// setter is a no-op because SettingsList.activateItem assigns
			// `item.currentValue = newValue` after cycling; the real value
			// comes from `config.roundedCorners` via the getter on the next
			// render (and from the onChange callback that updates config).
			get currentValue() {
				return config.roundedCorners ? "on" : "off";
			},
			set currentValue(_v) {
				// no-op: derived from `config.roundedCorners`
			},
			// Dynamic values: empty when thick so SettingsList.activateItem
			// doesn't cycle the value (it only cycles when values.length > 0).
			// The getter is re-evaluated on every render / keypress, so
			// switching borderThickness to thin re-enables cycling instantly.
			get values() {
				return config.borderThickness === "thick" ? [] : ["on", "off"];
			},
		},
	];

	const subList = new SettingsList(
		subItems,
		Math.min(subItems.length + 2, 8),
		// When borderThickness is thick, the "Rounded Corners" row is a
		// visual no-op (Unicode has no heavy rounded corner glyphs). Wrap
		// the theme so the row renders muted + strikethrough — but stays
		// navigable, so the user can still see the current value.
		wrapSettingsListThemeWithDisabledRow(
			settingsListTheme,
			"Rounded Corners",
			() => config.borderThickness === "thick",
		),
		(id, newValue) => {
			switch (id) {
				case "borderColor":
					// Color submenu handles its own onPreview; the color
					// value is set there and onChange is called.
					break;
				case "borderThickness":
					if (newValue === "thin" || newValue === "thick") {
						config.borderThickness = newValue;
						onChange(id, newValue);
					}
					break;
				case "roundedCorners":
					// Defense in depth: the item's `values` getter returns
					// `[]` when borderThickness is thick, which prevents
					// `SettingsList.activateItem` from cycling in the first
					// place. If a future change ever bypasses that, we still
					// ignore the toggle here so the value can't drift.
					if (config.borderThickness === "thick") break;
					config.roundedCorners = newValue === "on";
					onChange(id, newValue);
					break;
			}
		},
		() => done(),
	);

	container.addChild(subList);

	// Container has no built-in `handleInput`, so we manually forward
	// input to the subList. The SettingsList itself delegates further
	// to its own submenus (the color picker for Border Color), so this
	// single forward is enough for the whole submenu tree.
	container.handleInput = (data: string) => {
		subList.handleInput?.(data);
	};
	container.invalidate = () => {
		subList.invalidate?.();
	};

	return container;
}

/**
 * Build a short human-readable summary of the current "thinking box"
 * (background-mode) styling config. Used as the `currentValue` of the
 * "Customize Thinking Box" item in the main settings list.
 */
function summarizeThinkingBoxConfig(): string {
	return `${config.bgColor || "none"} · ${config.paddingX}\u00d7${config.paddingY}`;
}

/**
 * Build the "Customize Thinking Box" submenu — a SettingsList with three items:
 *   1. Background Color — color picker submenu (reuses createColorSubmenu)
 *   2. Padding X        — 0 | 1 | 2 | 3 | 4 | 5
 *   3. Padding Y        — 0 | 1 | 2 | 3 | 4 | 5
 *
 * Shown in the main settings list only when `displayMode === "background"`.
 * In bordered mode the equivalent "Customize Border" submenu is shown instead
 * and padding is forced to 0 (borders are the styling).
 *
 * `onChange(id, value)` fires when any item changes so the caller can
 *   - persist the new value
 *   - update the main "Customize Thinking Box" item's currentValue (summary)
 *   - re-render the live preview
 *   - request a TUI render
 */
function createCustomizeThinkingBoxSubmenu(
	settingsListTheme: ReturnType<typeof getSettingsListTheme>,
	selectListTheme: ReturnType<typeof getSelectListTheme>,
	onChange: (id: string, newValue: string) => void,
	done: () => void,
): Container {
	const container = new Container();

	const subItems: SettingItem[] = [
		{
			id: "bg",
			label: "Background Color",
			description: `Current: ${config.bgColor || "(none)"}`,
			currentValue: config.bgColor || "none",
			submenu: (_currentValue, subDone) =>
				createColorSubmenu(
					config.bgColor ?? "",
					selectListTheme,
					(color: string) => {
						config.bgColor = color;
						onChange("bg", color);
					},
					subDone,
				),
		},
		{
			id: "paddingX",
			label: "Padding X",
			description: "Horizontal padding inside the thinking box (in characters)",
			currentValue: String(config.paddingX),
			values: ["0", "1", "2", "3", "4", "5"],
		},
		{
			id: "paddingY",
			label: "Padding Y",
			description: "Vertical padding inside the thinking box (in lines)",
			currentValue: String(config.paddingY),
			values: ["0", "1", "2", "3", "4", "5"],
		},
	];

	const subList = new SettingsList(
		subItems,
		Math.min(subItems.length + 2, 8),
		settingsListTheme,
		(id, newValue) => {
			switch (id) {
				case "bg":
					// Color submenu handles its own onPreview; the color value
					// is set there and onChange is called.
					break;
				case "paddingX":
					const n = parseInt(newValue, 10);
					if (!Number.isNaN(n)) {
						config.paddingX = n;
						onChange(id, newValue);
					}
					break;
				case "paddingY":
					const m = parseInt(newValue, 10);
					if (!Number.isNaN(m)) {
						config.paddingY = m;
						onChange(id, newValue);
					}
					break;
			}
		},
		() => done(),
	);

	container.addChild(subList);

	// Container has no built-in `handleInput`, so we manually forward
	// input to the subList. The SettingsList itself delegates further
	// to its own submenus (the color picker for Background Color), so
	// this single forward is enough for the whole submenu tree.
	container.handleInput = (data: string) => {
		subList.handleInput?.(data);
	};
	container.invalidate = () => {
		subList.invalidate?.();
	};

	return container;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function thinkingBoxExtension(pi: ExtensionAPI): void {
	piApi = pi;

	pi.on("session_start", async () => {
		await loadConfig();
		applyMonkeyPatch();
	});

	pi.registerCommand("thinking-box", {
		description: "Configure the thinking box (interactive menu)",
		handler: async (_args, ctx) => {
			await ctx.ui.custom((tui, theme, _kb, done) => {
				const slTheme = getSettingsListTheme();
				const selectTheme = getSelectListTheme();

				const container = new Container();

				// Top border
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

				// Title
				container.addChild(new Text(theme.fg("accent", theme.bold("Thinking Box Settings")), 1, 1));

				// Live preview of the thinking box
				container.addChild(new Text(theme.fg("dim", theme.bold("Preview:")), 1, 0));
				const previewContainer = new Container();
				container.addChild(previewContainer);

				const buildPreview = (): void => {
					previewContainer.clear();

					// Mode-aware bail-out messages.
					if (!config.enabled) {
						previewContainer.addChild(
							new Text(theme.fg("dim", "  (Disabled — enable to preview)"), 0, 0),
						);
						return;
					}
					const missingModeColor =
						(config.displayMode === "background" && !config.bgColor) ||
						(config.displayMode === "bordered" && !config.borderColor);
					if (missingModeColor) {
						previewContainer.addChild(
							new Text(
								theme.fg("dim", `  (Set a ${config.displayMode === "background" ? "background" : "border"} color to preview)`),
								0,
								0,
							),
						);
						return;
					}

					// Header (matches createThinkingHeader)
					if (config.showHeader) {
						const label = config.headerLabel || "Thinking";
						let suffix = "";
						if (config.showThinkingLevel && piApi) {
              try {
                const level = piApi.getThinkingLevel();
                if (level && level !== "off") {
                  suffix = " " + theme.fg("dim", "·") + " " + theme.fg("dim", level);
                }
              } catch {
                // piApi is stale after session reload — skip level in preview
              }
						}
							const arrow = config.showArrow ? theme.fg("accent", theme.bold("▼")) + " " : "";
							const headerLine = arrow + theme.fg("thinkingText", label + suffix);
							previewContainer.addChild(new Text(headerLine, 1, 0));
						}

						// Thinking body — same dispatch as the monkey-patch.
						const previewTextStr = "This preview shows how thinking blocks will appear.\n" +
							"Background, padding, header, and label match\n" +
							"your current configuration.";
						const previewBody = new Text(
							theme.fg("thinkingText", theme.italic(previewTextStr)),
							1,
							0,
						);

						let previewBox: Component;
						if (config.displayMode === "bordered") {
							// Bordered mode is border-only: no interior background
							// fill, and padding is forced to 0. Matches the
							// monkey-patch so the preview is a faithful preview.
							const borderFgFn = createBorderFgFn(config.borderColor!);
							const chars = resolveBorderChars(config.borderThickness, config.roundedCorners);
							const bordered = new BorderedBox(0, 0, undefined, chars, borderFgFn);
							bordered.addChild(previewBody);
							previewBox = bordered;
						} else {
							const bgFn = createBgFn(config.bgColor!);
							const box = new Box(config.paddingX, config.paddingY, bgFn);
							box.addChild(previewBody);
							previewBox = box;
						}
						previewContainer.addChild(previewBox);
					};

					// Initial preview render
					buildPreview();

					container.addChild(new Spacer(1));

					// The settings list lives in its own container so we can clear
					// and re-add it when the display mode changes (the Customize
					// Border item only exists in bordered mode, Background Color
					// only in background mode).
					const settingsContainer = new Container();
					container.addChild(settingsContainer);

					// Bottom border
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

					// Mutable reference to the current settings list. Updated by
					// rebuildSettingsList() so input handling always targets the
					// live list.
					let settingsList: SettingsList | null = null;

					/**
					 * Build the items rendered in the main settings list. Re-evaluated
					 * every rebuild so `currentValue` reflects the latest config.
					 * `displayMode` controls which color item is exposed — the
					 * background fill is mutually exclusive with the border.
					 */
					const buildItems = (): SettingItem[] => {
						const items: SettingItem[] = [
							{
								id: "enabled",
								label: "Enabled",
								description: "Wrap thinking blocks in a styled background box",
								currentValue: config.enabled ? "on" : "off",
								values: ["on", "off"],
							},
							{
								id: "displayMode",
								label: "Display Mode",
								description: "How the thinking block is styled: background fill or a drawn border",
								currentValue: config.displayMode,
								values: ["background", "bordered"],
							},
						];

						// Mode-specific styling submenu. Mutually exclusive:
						//   - background → "Customize Thinking Box" (color + padding)
						//   - bordered   → "Customize Border" (color + thickness + corners)
						// Padding is hidden in bordered mode because it's forced to 0
						// (the border is the styling; padding would just create a gap
						// between the border and the text).
						if (config.displayMode === "background") {
							items.push({
								id: "customizeThinkingBox",
								label: "Customize Thinking Box",
								description: `Color: ${config.bgColor || "(none)"} · Padding: ${config.paddingX}×${config.paddingY}`,
								currentValue: summarizeThinkingBoxConfig(),
								submenu: (_currentValue, subDone) =>
									createCustomizeThinkingBoxSubmenu(
										slTheme,
										selectTheme,
										(_id, _value) => {
											// The submenu already wrote to `config`.
											// Keep the main item's summary in sync and
											// refresh the live preview.
											settingsList?.updateValue("customizeThinkingBox", summarizeThinkingBoxConfig());
											persistConfig();
											buildPreview();
											tui.requestRender();
										},
										subDone,
									),
							});
						} else {
							items.push({
								id: "customizeBorder",
								label: "Customize Border",
								description: `Color: ${config.borderColor || "(none)"} · Thickness: ${config.borderThickness} · Corners: ${config.roundedCorners ? "rounded" : "square"}`,
								currentValue: summarizeBorderConfig(),
								submenu: (_currentValue, subDone) =>
									createCustomizeBorderSubmenu(
										slTheme,
										selectTheme,
										(_id, _value) => {
											// The submenu already wrote to `config`. Just
											// keep the main item's summary in sync and
											// refresh the live preview.
											settingsList?.updateValue("customizeBorder", summarizeBorderConfig());
											persistConfig();
											buildPreview();
											tui.requestRender();
										},
										subDone,
									),
							});
						}

						items.push(
							{
								id: "showHeader",
								label: "Show Header",
								description: "Display a header bar above each thinking block",
								currentValue: config.showHeader ? "on" : "off",
								values: ["on", "off"],
							},
							{
								id: "headerLabel",
								label: "Header Label",
								description: `Current: "${config.headerLabel}"`,
								currentValue: config.headerLabel,
								submenu: (_currentValue, subDone) =>
									createLabelSubmenu(config.headerLabel, selectTheme, subDone),
							},
							{
								id: "showThinkingLevel",
								label: "Show Thinking Level",
								description: "Append the current thinking level (e.g. 'medium') to the header",
								currentValue: config.showThinkingLevel ? "on" : "off",
								values: ["on", "off"],
							},
							{
								id: "showLineCount",
								label: "Show Line Count (Collapsed)",
								description: "Display the number of lines in thinking block (Only shows when thinking block is collapsed)",
								currentValue: config.showLineCount ? "on" : "off",
								values: ["on", "off"],
							},
							{
								id: "showArrow",
								label: "Show Arrow",
								description: "Show the ▼/▶ collapse indicator arrow in the header",
								currentValue: config.showArrow ? "on" : "off",
								values: ["on", "off"],
							},
						);

						return items;
					};

					/**
					 * Replace the current settings list with a fresh one built from
					 * the latest config. Called after any item change so currentValue
					 * labels and the visible item set (Customize Thinking Box ↔
					 * Customize Border) reflect the current display mode.
					 *
					 * `preserveIndex` keeps the cursor on the same row it was on
					 * before the rebuild (clamped to the new list length). Without
					 * this, the cursor would jump back to row 0 ("Enabled") after
					 * every mode toggle — very disorienting.
					 */
					const rebuildSettingsList = (preserveIndex?: number): void => {
						const items = buildItems();
						const newList = new SettingsList(
							items,
							Math.min(items.length + 2, 15),
							slTheme,
							(id, newValue) => {
								const oldMode = config.displayMode;
								switch (id) {
									case "enabled":
										config.enabled = newValue === "on";
										// Auto-fill the missing color for the active mode so the
										// preview + monkey-patch have something to draw with.
										if (config.enabled) {
											if (config.displayMode === "background" && !config.bgColor) {
												config.bgColor = defaults.bgColor;
											}
											if (config.displayMode === "bordered" && !config.borderColor) {
												config.borderColor = defaults.borderColor;
											}
										}
										break;
									case "displayMode":
										if (newValue === "background" || newValue === "bordered") {
											config.displayMode = newValue;
											// Pre-fill the color the new mode needs so the
											// preview is never empty after a mode switch.
											if (newValue === "background" && !config.bgColor) {
												config.bgColor = defaults.bgColor;
											}
											if (newValue === "bordered" && !config.borderColor) {
												config.borderColor = defaults.borderColor;
											}
										}
										break;
									case "bg":
									case "paddingX":
									case "paddingY":
										// Handled inside the Customize Thinking Box
										// submenu. Reaching this case means the
										// settings list is mis-wired.
										break;
									case "showHeader":
										config.showHeader = newValue === "on";
										break;
									case "headerLabel":
										config.headerLabel = newValue || defaults.headerLabel;
										break;
									case "showThinkingLevel":
										config.showThinkingLevel = newValue === "on";
										break;
									case "showArrow":
										config.showArrow = newValue === "on";
										break;
									case "showLineCount":
										config.showLineCount = newValue === "on";
										break;
								}
								persistConfig();

								// If the display mode changed, the visible item set has
								// changed shape (Customize Thinking Box ↔ Customize
								// Border), so the list itself needs to be rebuilt
								// from scratch.
								if (oldMode !== config.displayMode) {
									// Capture the cursor position so it stays on the
									// same row (Display Mode, usually) after the rebuild.
									// `selectedIndex` is private on SettingsList but
									// accessible at runtime.
									const oldIndex = (settingsList as unknown as { selectedIndex?: number })
										?.selectedIndex;
									rebuildSettingsList(oldIndex);
								} else {
									// Same shape — just refresh the currentValue of the
									// item that changed (buildItems reads the updated
									// config, so its snapshot is fresh).
									const freshItems = buildItems();
									const freshItem = freshItems.find((i) => i.id === id);
									if (freshItem) settingsList?.updateValue(id, freshItem.currentValue);
								}
								buildPreview();
								tui.requestRender();
							},
							() => done(undefined),
							{ enableSearch: true },
						);
						// Restore the cursor to where it was before the rebuild.
						// `selectedIndex` is private on SettingsList but accessible
						// at runtime; clamp to the new item count to be safe.
						if (typeof preserveIndex === "number") {
							const clamped = Math.max(0, Math.min(preserveIndex, items.length - 1));
							(newList as unknown as { selectedIndex: number }).selectedIndex = clamped;
						}
						settingsContainer.clear();
						settingsContainer.addChild(newList);
						settingsList = newList;
					};

					// Initial build.
					rebuildSettingsList();

					return {
						render: (w: number) => container.render(w),
						invalidate: () => container.invalidate(),
						handleInput: (data: string) => {
							settingsList?.handleInput?.(data);
							tui.requestRender();
						},
					};
				});


		},
	});
}

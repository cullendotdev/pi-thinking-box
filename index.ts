/**
 * Thinking Box Extension
 *
 * Wraps agent thinking blocks in a styled box container (background + padding),
 * similar to how user messages have a background box. Adds an optional header
 * bar above each thinking block showing the collapse state, "Thinking…" label,
 * and agent/model name.
 *
 * Commands:
 *   /thinking-box on|off             Toggle the feature
 *   /thinking-box bg <hex>           Set background color (e.g., "#2d2d30")
 *   /thinking-box padding <x> <y>    Set horizontal and vertical padding
 *   /thinking-box header on|off      Toggle header bar above thinking blocks
 *   /thinking-box label <text>       Set the header label (default: "Thinking")
 *   /thinking-box thinking-level on|off  Toggle thinking level display in header
 *
 * User config persists to ~/.pi/agent/thinking-box.json — survives package updates.
 *
 * Implementation: monkey-patches AssistantMessageComponent.prototype.updateContent
 * to wrap thinking Markdown in a Box with configurable background and padding.
 * Accesses the active theme via globalThis (same symbol-based mechanism the
 * original component uses) so thinking text, labels, and errors follow the theme.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent, getAgentDir, Theme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
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

/** User config lives in ~/.pi/agent/ so it survives package updates. */
const USER_CONFIG_FILE = join(getAgentDir(), "thinking-box.json");

// ---------------------------------------------------------------------------
// Runtime state (module-level)
// ---------------------------------------------------------------------------

interface ThinkingBoxConfig {
	enabled: boolean;
	bgColor: string | null;
	paddingX: number;
	paddingY: number;
	showHeader: boolean;
	headerLabel: string;
	showThinkingLevel: boolean;
}

let config: ThinkingBoxConfig = { ...defaults };

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
// Header rendering
// ---------------------------------------------------------------------------

/**
 * Build the thinking block header line.
 * Format: "▼ {label} · {level}" or "▶ {label} · {level} (hidden)".
 * Returns a Text component styled with the active theme.
 */
function createThinkingHeader(hideThinking: boolean): Text {
	const t = getTheme();
	const label = config.headerLabel || "Thinking";
	const levelSuffix = buildLevelSuffix();

	if (hideThinking) {
		// Collapsed state: "▶ {label}[ · {level}] (hidden)"
		const text = t.italic(t.fg("thinkingText", `▶ ${label}${levelSuffix} (hidden)`));
		return new Text(text, 1, 0);
	}

	// Expanded state: "▼ {label}[ · {level}]"
	const headerText = t.fg("accent", t.bold("▼")) + " " + t.fg("thinkingText", label + levelSuffix);
	return new Text(headerText, 1, 0);
}

/** Build the thinking level suffix string (e.g., " · medium"), or empty if disabled/off. */
function buildLevelSuffix(): string {
	if (!config.showThinkingLevel || !piApi) return "";
	const level = piApi.getThinkingLevel();
	if (!level || level === "off") return "";
	const t = getTheme();
	return " " + t.fg("dim", "·") + " " + t.fg("dim", level);
}

// ---------------------------------------------------------------------------
// Config persistence (writes to config.json on disk)
// ---------------------------------------------------------------------------

async function persistConfig(): Promise<void> {
	await mkdir(getAgentDir(), { recursive: true });
	const json = JSON.stringify(config, null, 2) + "\n";
	await writeFile(USER_CONFIG_FILE, json, "utf-8");
}

async function loadConfig(): Promise<void> {
	try {
		const raw = await readFile(USER_CONFIG_FILE, "utf-8");
		const parsed = JSON.parse(raw) as Partial<ThinkingBoxConfig>;
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
		// If disabled or no background color, delegate to the original.
		if (!config.enabled || !config.bgColor) {
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
							createThinkingHeader(true),
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
						thinkingSection.addChild(createThinkingHeader(false));
					}

					// Thinking content wrapped in Box with background + padding.
					const bgFn = createBgFn(config.bgColor);
					const thinkingMd = new Markdown(content.thinking.trim(), 1, 0, mdTheme, {
						color: (text: string) => thinkingStyle(text),
						italic: true,
					});

					const thinkingBox = new Box(config.paddingX, config.paddingY, bgFn);
					thinkingBox.addChild(thinkingMd);
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
// Extension entry point
// ---------------------------------------------------------------------------

export default function thinkingBoxExtension(pi: ExtensionAPI): void {
	piApi = pi;
	applyMonkeyPatch();

	pi.on("session_start", async () => {
		await loadConfig();
	});

	pi.registerCommand("thinking-box", {
		description: "Configure the thinking box (background, padding, header bar)",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);

			// No args → show current config
			if (parts.length === 0 || parts[0] === "") {
				const status = config.enabled && config.bgColor ? "on" : "off";
				const headerStatus = config.showHeader ? "on" : "off";
				const levelStatus = config.showThinkingLevel ? "on" : "off";
				ctx.ui.notify(
					`Thinking box: ${status}, bg=${config.bgColor || "(default)"}, padding=${config.paddingX}x${config.paddingY}, header=${headerStatus}, label="${config.headerLabel}", level=${levelStatus}`,
					"info",
				);
				return;
			}

			const sub = parts[0].toLowerCase();

			switch (sub) {
				case "on": {
					config.enabled = true;
					if (!config.bgColor) config.bgColor = defaults.bgColor;
					await persistConfig();
					ctx.ui.notify("Thinking box: on (applies to next response)", "success");
					break;
				}
				case "off": {
					config.enabled = false;
					await persistConfig();
					ctx.ui.notify("Thinking box: off", "success");
					break;
				}
				case "bg": {
					if (parts.length < 2) {
						ctx.ui.notify("Usage: /thinking-box bg <hex>, e.g. #2d2d30", "error");
						return;
					}
					const color = parts[1];
					if (!/^#?[0-9a-fA-F]{6}$/.test(color)) {
						ctx.ui.notify("Invalid color. Use 6-digit hex, e.g. #2d2d30", "error");
						return;
					}
					try {
						hexToAnsiBg(color);
					} catch {
						ctx.ui.notify("Invalid hex color", "error");
						return;
					}
					config.bgColor = color.startsWith("#") ? color : `#${color}`;
					config.enabled = true;
					await persistConfig();
					ctx.ui.notify(`Thinking box bg = ${config.bgColor}`, "success");
					break;
				}
				case "padding": {
					if (parts.length < 3) {
						ctx.ui.notify("Usage: /thinking-box padding <x> <y>, e.g. 1 1", "error");
						return;
					}
					const px = parseInt(parts[1], 10);
					const py = parseInt(parts[2], 10);
					if (Number.isNaN(px) || Number.isNaN(py) || px < 0 || py < 0 || px > 10 || py > 10) {
						ctx.ui.notify("Padding must be 0–10, e.g. /thinking-box padding 1 1", "error");
						return;
					}
					config.paddingX = px;
					config.paddingY = py;
					await persistConfig();
					ctx.ui.notify(`Thinking box padding = ${px}x${py}`, "success");
					break;
				}
				case "header": {
					if (parts.length < 2) {
						ctx.ui.notify("Usage: /thinking-box header on|off", "error");
						return;
					}
					const val = parts[1].toLowerCase();
					if (val === "on") {
						config.showHeader = true;
						await persistConfig();
						ctx.ui.notify("Thinking box header: on", "success");
					} else if (val === "off") {
						config.showHeader = false;
						await persistConfig();
						ctx.ui.notify("Thinking box header: off", "success");
					} else {
						ctx.ui.notify("Usage: /thinking-box header on|off", "error");
					}
					break;
				}
				case "label": {
					if (parts.length < 2) {
						ctx.ui.notify("Usage: /thinking-box label <text>, e.g. /thinking-box label Reasoning", "error");
						return;
					}
					const label = parts.slice(1).join(" ").trim();
					if (!label) {
						ctx.ui.notify("Label cannot be empty", "error");
						return;
					}
					config.headerLabel = label;
					await persistConfig();
					ctx.ui.notify(`Thinking box label = "${label}"`, "success");
					break;
				}
				case "thinking-level": {
					if (parts.length < 2) {
						ctx.ui.notify("Usage: /thinking-box thinking-level on|off", "error");
						return;
					}
					const val = parts[1].toLowerCase();
					if (val === "on") {
						config.showThinkingLevel = true;
						await persistConfig();
						ctx.ui.notify("Thinking box thinking-level: on", "success");
					} else if (val === "off") {
						config.showThinkingLevel = false;
						await persistConfig();
						ctx.ui.notify("Thinking box thinking-level: off", "success");
					} else {
						ctx.ui.notify("Usage: /thinking-box thinking-level on|off", "error");
					}
					break;
				}
				default: {
					ctx.ui.notify(
						"Usage: /thinking-box [on|off|bg <hex>|padding <x> <y>|header on|off|label <text>|thinking-level on|off]",
						"error",
					);
				}
			}
		},
	});
}

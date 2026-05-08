/**
 * Thinking Box Extension
 *
 * Wraps agent thinking blocks in a styled box container (background + padding),
 * similar to how user messages have a background box.
 *
 * Commands:
 *   /thinking-box on|off             Toggle the feature
 *   /thinking-box bg <hex>           Set background color (e.g., "#2d2d30")
 *   /thinking-box padding <x> <y>    Set horizontal and vertical padding
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

import type { AssistantMessage } from "@mariozechner/pi-ai";
import { AssistantMessageComponent, getAgentDir, Theme, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import defaults from "./config.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Theme access
// ---------------------------------------------------------------------------

/**
 * Pi stores the active theme on globalThis with a well-known Symbol.
 * This is the same mechanism the assistant-message component uses internally;
 * we re-use the public Theme class (exported) to access it without deep imports.
 */
const THEME_KEY: unique symbol = Symbol.for("@mariozechner/pi-coding-agent:theme");

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
}

let config: ThinkingBoxConfig = { ...defaults };

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
					// Hidden thinking label — matches original component behaviour.
					const t = getTheme();
					self.contentContainer.addChild(
						new Text(t.italic(t.fg("thinkingText", self.hiddenThinkingLabel)), 1, 0),
					);
					if (hasVisibleContentAfter) {
						self.contentContainer.addChild(new Spacer(1));
					}
				} else {
					// Create the thinking Markdown …
					// MarkdownTheme.italic() handles italics theme-aware.
					const thinkingMd = new Markdown(content.thinking.trim(), 1, 0, mdTheme, {
						color: (text: string) => thinkingStyle(text),
						italic: true,
					});

					// … and wrap it in a Box with background + padding.
					const thinkingBox = new Box(config.paddingX, config.paddingY, createBgFn(config.bgColor));
					thinkingBox.addChild(thinkingMd);
					self.contentContainer.addChild(thinkingBox);

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
	applyMonkeyPatch();

	pi.on("session_start", async () => {
		await loadConfig();
	});

	pi.registerCommand("thinking-box", {
		description: "Configure the thinking box (background + padding around thinking blocks)",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);

			// No args → show current config
			if (parts.length === 0 || parts[0] === "") {
				const status = config.enabled && config.bgColor ? "on" : "off";
				ctx.ui.notify(
					`Thinking box: ${status}, bg=${config.bgColor || "(default)"}, padding=${config.paddingX}x${config.paddingY}`,
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
				default: {
					ctx.ui.notify(
						"Usage: /thinking-box [on|off|bg <hex>|padding <x> <y>]",
						"error",
					);
				}
			}
		},
	});
}

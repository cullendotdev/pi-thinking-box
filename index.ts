/**
 * Thinking Box Extension
 *
 * Wraps agent thinking blocks in a styled box container (background + padding),
 * similar to how user messages have a background box. Adds an optional header
 * bar above each thinking block showing the collapse state, "Thinking…" label,
 * and agent/model name.
 *
 * Commands:
 *   /thinking-box  Opens an interactive settings menu to configure all options.
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
	Input,
	Markdown,
	SelectList,
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
 * Color picker submenu with live preview on hover and inline custom color
 * entry.  onPreview fires on every selection change (arrow-key navigation)
 * so the main settings UI can update its preview box in real time.
 */
function createColorSubmenu(
	currentValue: string,
	selectListTheme: ReturnType<typeof getSelectListTheme>,
	onPreview: (color: string) => void,
	done: (value?: string) => void,
): Container {
	const originalColor = currentValue;
	const container = new Container();

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
			container.addChild(new Text("Enter to confirm · Esc to go back", 0, 0));
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
					// Transition to custom hex input
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
			if (data === "\r" || data === "\n") {
				const raw = customInput.getValue().trim();
				if (raw && /^#?[0-9a-fA-F]{6}$/.test(raw)) {
					const normalized = raw.startsWith("#") ? raw : `#${raw}`;
					onPreview(normalized);
					done(normalized);
				}
				return;
			}
			if (data === "\x1b") {
				// Escape → back to SelectList
				showingInput = false;
				customInput = null;
				onPreview(originalColor);
				rebuild();
				return;
			}
			customInput.handleInput(data);
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
			if (data === "\r" || data === "\n") {
				const val = editInput.getValue().trim();
				if (val) {
					// Update local snapshot so the SelectList-mode view
					// shows the new value if the user re-enters the submenu.
					currentValue = val;
					done(val);
				}
				return;
			}
			if (data === "\x1b") {
				// Escape → back to SelectList (keep original)
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
		description: "Configure the thinking box (interactive menu)",
		handler: async (_args, ctx) => {
			await ctx.ui.custom((tui, theme, _kb, done) => {
				const slTheme = getSettingsListTheme();
				const selectTheme = getSelectListTheme();

				const items: SettingItem[] = [
					{
						id: "enabled",
						label: "Enabled",
						description: "Wrap thinking blocks in a styled background box",
						currentValue: config.enabled ? "on" : "off",
						values: ["on", "off"],
					},
					{
						id: "bg",
						label: "Background Color",
						description: `Current: ${config.bgColor || "(none)"}. Choose a preset or enter a custom hex color.`,
						currentValue: config.bgColor || "none",
						submenu: (_currentValue, subDone) =>
							createColorSubmenu(
								config.bgColor ?? "",
								selectTheme,
								(color: string) => {
									config.bgColor = color;
									config.enabled = true;
									buildPreview();
									tui.requestRender();
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
				];

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

					if (!config.enabled || !config.bgColor) {
						previewContainer.addChild(
							new Text(theme.fg("dim", "  (Disabled — enable and set a color to preview)"), 0, 0),
						);
						return;
					}

					// Header (matches createThinkingHeader)
					if (config.showHeader) {
						const label = config.headerLabel || "Thinking";
						let suffix = "";
						if (config.showThinkingLevel && piApi) {
							const level = piApi.getThinkingLevel();
							if (level && level !== "off") {
								suffix = " " + theme.fg("dim", "·") + " " + theme.fg("dim", level);
							}
						}
						const headerLine =
							theme.fg("accent", theme.bold("▼")) + " " + theme.fg("thinkingText", label + suffix);
						previewContainer.addChild(new Text(headerLine, 1, 0));
					}

					// Thinking box with background + padding
					const bgFn = createBgFn(config.bgColor);
					const box = new Box(config.paddingX, config.paddingY, bgFn);

					const previewBody = theme.fg(
						"thinkingText",
						theme.italic(
							"This preview shows how thinking blocks will appear. " +
								"Background, padding, header, and label match your current configuration.",
						),
					);
					box.addChild(new Text(previewBody, 0, 0));
					previewContainer.addChild(box);
				};

				// Initial preview render
				buildPreview();

				container.addChild(new Spacer(1));

				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 2, 15),
					slTheme,
					(id, newValue) => {
						switch (id) {
							case "enabled":
								config.enabled = newValue === "on";
								if (config.enabled && !config.bgColor) {
									config.bgColor = defaults.bgColor;
								}
								break;
							case "bg":
								config.bgColor = newValue || defaults.bgColor;
								config.enabled = true;
								break;
							case "paddingX":
								config.paddingX = parseInt(newValue, 10);
								break;
							case "paddingY":
								config.paddingY = parseInt(newValue, 10);
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
						}
						persistConfig();
						buildPreview();
						tui.requestRender();
					},
					() => done(undefined),
					{ enableSearch: true },
				);

				container.addChild(settingsList);

				// Bottom border
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

				return {
					render: (w: number) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						settingsList.handleInput?.(data);
						tui.requestRender();
					},
				};
			});


		},
	});
}

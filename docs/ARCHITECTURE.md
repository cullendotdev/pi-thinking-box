# Architecture: Thinking Box Extension

## How it works

The extension monkey-patches `AssistantMessageComponent.prototype.updateContent`. When a new assistant message arrives, our patched method wraps thinking blocks in either a `Box` (background mode) or a custom `BorderedBox` (bordered mode), with configurable padding, header, and line count.

The two modes share the same header bar, padding, and line-count settings. In bordered mode the `Background Color` setting becomes an optional interior fill — leave it unset for a transparent interior.

## Why monkey-patching

Pi has no extension hook for customizing built-in assistant message rendering. There's `registerMessageRenderer` but only for custom message types (`role: "custom"`), not for the built-in `role: "assistant"`. The `theme` singleton (which has `fg()`, `bg()`) is not publicly exported — only the `Theme` class is. So even if we added `thinkingBg` to a custom theme file, the patched code couldn't call `theme.bg("thinkingBg", text)`.

The extension accesses the active theme through `globalThis` using the same `Symbol.for()` key that Pi's own code uses internally. This gives us `Theme.fg()` and `Theme.italic()` for theme-aware text styling, while the background stays user-configured hex.

## Implementation overview

**`index.ts`** — single file. Five sections:

### 1. Config state (module-level)

```typescript
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

let config: ThinkingBoxConfig = { ...defaults };
```

Defaults are imported from `config.json` (bundled with the extension, read-only). On `session_start`, `loadConfig()` reads user overrides from `~/.pi/agent/config/thinking-box.json` and merges them into the in-memory `config`. The user config file is created lazily — only written the first time a `/thinking-box` command changes a setting. Every `/thinking-box` subcommand persists changes immediately via `persistConfig()`. This means settings survive pi restarts, `/reload`, and package updates — no reliance on session history.

### 2. Theme access

```typescript
const THEME_KEY = Symbol.for("@mariozechner/pi-coding-agent:theme");

function getTheme(): Theme {
  const t = (globalThis as Record<symbol, Theme | undefined>)[THEME_KEY];
  if (!t) throw new Error("Theme not initialised");
  return t;
}
```

Pi stores the active theme on `globalThis` with the above symbol key. This is the same mechanism the original `AssistantMessageComponent` uses — both share the same `globalThis`, so `getTheme()` always returns the current theme regardless of how extensions are loaded (Jiti, tsx, etc.).

The `Theme` class is publicly exported from `@mariozechner/pi-coding-agent`, so no deep imports needed.

### 3. Monkey-patch

Saves `AssistantMessageComponent.prototype.updateContent` → replaces with custom version.

The patched method replicates the original logic exactly, except for thinking blocks. The wrapping container is chosen by `config.displayMode`:

```typescript
// Bail-out: disabled, or active mode missing its required color.
const missingColor =
  (config.displayMode === "background" && !config.bgColor) ||
  (config.displayMode === "bordered" && !config.borderColor);
if (!config.enabled || missingColor) {
  originalUpdateContent!.call(this, message);
  return;
}

// ... same header + Markdown construction as before ...

if (config.displayMode === "bordered") {
  const chars = resolveBorderChars(config.borderThickness, config.roundedCorners);
  // Bordered mode is border-only: no interior background fill, and
  // padding is forced to 0 so the border sits flush against the text.
  // Configured padding values are preserved and re-apply when the
  // user switches back to background mode.
  const bordered = new BorderedBox(
    0, 0, undefined, chars,
    createBorderFgFn(config.borderColor!),
  );
  bordered.addChild(thinkingMd);
  thinkingSection.addChild(bordered);
} else {
  const box = new Box(config.paddingX, config.paddingY, createBgFn(config.bgColor!));
  box.addChild(thinkingMd);
  thinkingSection.addChild(box);
}
```

When disabled (or its mode has no color set), the original method is called unchanged.

### 4. Interactive Settings Menu

The `/thinking-box` command opens an interactive settings UI built with `SettingsList`, `SelectList`, `Input`, and `DynamicBorder`. It replaces the old subcommand-based CLI with a unified menu.

**Settings controls:**
| Setting | Control | Values | Visibility |
|---------|---------|--------|------------|
| Enabled | Toggle (on/off) | SelectList | always |
| Display Mode | SelectList | `background`, `bordered` | always |
| Customize Thinking Box | Submenu (own SettingsList) | — | **background** mode only |
| &nbsp;&nbsp;&nbsp;Background Color | Color picker submenu | 9 presets + custom hex | (inside submenu) |
| &nbsp;&nbsp;&nbsp;Padding X | SelectList | 0–5 | (inside submenu) |
| &nbsp;&nbsp;&nbsp;Padding Y | SelectList | 0–5 | (inside submenu) |
| Customize Border | Submenu (own SettingsList) | — | **bordered** mode only |
| &nbsp;&nbsp;&nbsp;Border Color | Color picker submenu | 9 presets + custom hex | (inside submenu) |
| &nbsp;&nbsp;&nbsp;Border Thickness | SelectList | `thin`, `thick` | (inside submenu) |
| &nbsp;&nbsp;&nbsp;Rounded Corners | Toggle (on/off) | SelectList | (inside submenu) |
| Show Header | Toggle (on/off) | SelectList | always |
| Header Label | Inline Input submenu | Any text | always |
| Show Thinking Level | Toggle (on/off) | SelectList | always |
| Show Line Count (Collapsed) | Toggle (on/off) | SelectList | always |
| Show Arrow | Toggle (on/off) | SelectList | always |

**Mutually exclusive styling:** The `Customize Thinking Box` and `Customize Border` submenus are swapped in and out of the main list based on `displayMode` — they never both appear. Switching `Display Mode` rebuilds the main `SettingsList` with a fresh item set so the visible submenu is the right one for the new mode.

**Padding in bordered mode is always `0 × 0`.** The configured `paddingX` / `paddingY` values are preserved (used again when switching back to background mode) but ignored by both the monkey-patch and the live preview when `displayMode === "bordered"`. The `BorderedBox` is constructed with `new BorderedBox(0, 0, undefined, ...)` so the border sits flush against the text — any padding would just create a visual gap between the border and the content.

**Live preview:** A real-time `Box` (or `BorderedBox`) preview shows how thinking blocks will render with the current settings. The preview dispatches on `displayMode` exactly the way the monkey-patch does. It updates on every selection change (including arrow-key navigation in the color picker).

**Mode-aware defaults:** Switching `Display Mode` pre-fills the new mode's required color from `config.json` defaults, so the preview is never empty after a mode switch.

### 5. Submenu helpers

Four factory functions create submenus that open inline rather than closing the settings dialog:

**`createColorSubmenu(currentValue, selectListTheme, onPreview, done)`**
- Renders a `SelectList` of `COLOR_PRESETS` (Default, VS Code Dark, Dracula, Tokyo Night, etc.)
- `onPreview` fires on every arrow-key selection change — the main UI updates its preview box in real time
- Selecting "Custom…" transitions to an `Input` field for hex entry (validates 6-digit hex)
- Escape returns to the preset list
- Used for `Background Color` (inside `Customize Thinking Box`) and `Border Color` (inside `Customize Border`)

**`createLabelSubmenu(currentValue, selectListTheme, done)`**
- Shows current label with an "Edit label…" option
- Selecting it transitions to an inline `Input` field
- Enter confirms the new label; Escape returns to the SelectList
- `currentValue` is reassigned on confirm so re-entering the submenu shows the updated label

**`createCustomizeThinkingBoxSubmenu(settingsListTheme, selectListTheme, onChange, done)`**
- Opens in place of the `Customize Thinking Box` row in the main settings list (background mode only)
- Renders a small `SettingsList` with three items: Background Color, Padding X, Padding Y
- `onChange(id, value)` fires on every value change so the caller can keep the main row's summary (`summarizeThinkingBoxConfig()`) in sync, persist, and refresh the live preview
- The Background Color item reuses `createColorSubmenu` for its picker
- Escape closes back to the main list

**`createCustomizeBorderSubmenu(settingsListTheme, selectListTheme, onChange, done)`**
- Opens in place of the `Customize Border` row in the main settings list (bordered mode only)
- Renders a small `SettingsList` with three items: Border Color, Border Thickness, Rounded Corners
- `onChange(id, value)` fires on every value change so the caller can keep the main `Customize Border` row's summary (`summarizeBorderConfig()`) in sync, persist, and refresh the live preview
- The Border Color item reuses `createColorSubmenu` for its picker
- When `borderThickness === "thick"`, the `Rounded Corners` row is fully disabled:
  - **Visually** — both the label and the value are rendered muted + strikethrough, via `wrapSettingsListThemeWithDisabledRow` (which intercepts both `theme.label` and `theme.value` and uses a shared closure flag to pair them per-row)
  - **Behaviorally** — the item's `values` getter returns `[]` when thick, so `SettingsList.activateItem` skips cycling entirely (`if (item.values && item.values.length > 0)`). The `onChange` callback also has a guard `if (config.borderThickness === "thick") break;` as defense in depth.
  - The `description` and `currentValue` are also getters that re-read `config` on every render, so the row updates immediately when the user toggles Border Thickness within the submenu.
  - The row stays navigable so the current value (`on` / `off`) remains visible.
- Escape closes back to the main list

### 6. Display modes & BorderedBox

`BorderedBox` is a small `Container` implementation that draws a border on all four sides of its child content. It is used in `bordered` mode in place of the standard `Box`.

**Layout**

```
   topLeft + horizontal.repeat(innerWidth) + topRight        ← one full-width border line
   vertical   + innerLine (padded to innerWidth) + vertical   ← one per child line + padding
   ...
   bottomLeft + horizontal.repeat(innerWidth) + bottomRight  ← one full-width border line
```

The interior is delegated to an inner `Box(paddingX, paddingY, bgFn)`. That gives us padding + optional background fill for free, and keeps the bordered mode's "interior" behaviour identical to the background mode's. The inner Box renders at `width - 2` columns; border glyphs (1 char wide each) are prepended / appended to every line.

**Border style catalogue**

`BORDER_STYLES` is a `Record<borderThickness, { square, rounded }>`:

| `borderThickness` | `roundedCorners` | Corners | Edges | Visual |
|---|---|---|---|---|
| `thin`  | off | `┌ ┐ └ ┘` | `─ │` | thin, square |
| `thin`  | on  | `╭ ╮ ╰ ╯` | `─ │` | thin, soft corners |
| `thick` | off | `┏ ┓ ┗ ┛` | `━ ┃` | heavy, square |
| `thick` | on  | `┏ ┓ ┗ ┛` | `━ ┃` | heavy, square (rounded ignored) |

`roundedCorners` (a separate boolean) only takes effect when `borderThickness === "thin"`: it swaps the square corners for the rounded pair. Unicode has no standard heavy "rounded" corner, so heavy borders always have square corners regardless of the flag.

**Cache**

BorderedBox mirrors `Box`'s cache: it samples the first interior line as a "did the bg change" signal, and only re-renders when width / child output / bg sample all change. Invalidation is exposed via the `Component.invalidate()` hook, which the parent Container calls when its own state changes.

## Fragility

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| pi changes `updateContent` internals | Low (stable) | High (patch breaks) | Patch mirrors original closely; diff audit on pi upgrade |
| pi switches to `#private` fields | Very low | Critical | Would need upstream extension hook |
| Theme change (dark→light) | Common | Visual match | Text colors follow theme; background / border are user-configured hex (static by design) |
| Pi changes the globalThis symbol key | Very low | Critical | Would break Pi's own internal code too — unlikely without major refactor |
| `/reload` loses in-memory config | Low | Medium | Config restored from `~/.pi/agent/config/thinking-box.json` on next `session_start` |

## Config persistence

On `session_start`: read user config → shallow-merge over defaults → in-memory `config`.
On `/thinking-box` command: write only overrides (deltas from defaults) → user config file (creates if missing). Missing keys fall through to config.json defaults — new settings added in future versions default correctly without migration.
User config is optional — defaults work without any file on disk.

## Files

```
thinking-box/
├── index.ts              # Extension code
├── config.json           # Bundled defaults (read-only)
├── README.md             # Install + usage
└── docs/
    └── ARCHITECTURE.md   # This file
```

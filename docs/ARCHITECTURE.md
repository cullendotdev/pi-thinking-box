# Architecture: Thinking Box Extension

## How it works

The extension monkey-patches `AssistantMessageComponent.prototype.updateContent`. When a new assistant message arrives, our patched method wraps thinking blocks in a `Box` component with a configurable background color and padding.

```
Normal rendering:                    Patched rendering:
                                    
  Text block                          Text block
  (rendered inline)                   (rendered inline)
                                    
  Thinking block                     ┌─────────────────┐
  (theme-colored italic,             │  Thinking block  │
   no background)                    │  (theme-colored  │
                                     │   italic, on a   │
  More text                          │   bg color)      │
                                     └─────────────────┘
                                     
                                     More text
```

## Why monkey-patching

Pi has no extension hook for customizing built-in assistant message rendering. There's `registerMessageRenderer` but only for custom message types (`role: "custom"`), not for the built-in `role: "assistant"`. The `theme` singleton (which has `fg()`, `bg()`) is not publicly exported — only the `Theme` class is. So even if we added `thinkingBg` to a custom theme file, the patched code couldn't call `theme.bg("thinkingBg", text)`.

The extension accesses the active theme through `globalThis` using the same `Symbol.for()` key that Pi's own code uses internally. This gives us `Theme.fg()` and `Theme.italic()` for theme-aware text styling, while the background stays user-configured hex.

## Implementation overview

**`index.ts`** — single file, ~280 lines. Three sections:

### 1. Config state (module-level)

```typescript
interface ThinkingBoxConfig {
  enabled: boolean;
  bgColor: string | null;
  paddingX: number;
  paddingY: number;
}

let config: ThinkingBoxConfig = { ...defaults };
```

Defaults are imported from `config.json` (bundled with the extension, read-only). On `session_start`, `loadConfig()` reads user overrides from `~/.pi/agent/thinking-box.json` and merges them into the in-memory `config`. The user config file is created lazily — only written the first time a `/thinking-box` command changes a setting. Every `/thinking-box` subcommand persists changes immediately via `persistConfig()`. This means settings survive pi restarts, `/reload`, and package updates — no reliance on session history.

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

The patched method replicates the original logic exactly, except for thinking blocks:

```typescript
// Original (theme singleton imported internally by Pi):
new Markdown(content.thinking.trim(), 1, 0, this.markdownTheme, {
  color: (text) => theme.fg("thinkingText", text),
  italic: true,  // MarkdownTheme.italic() — theme-aware
});
// Hidden label:
new Text(theme.italic(theme.fg("thinkingText", label)), 1, 0);

// Patched (same calls, theme accessed via globalThis):
const t = getTheme();
new Markdown(content.thinking.trim(), 1, 0, mdTheme, {
  color: (text) => t.fg("thinkingText", text),  // identical
  italic: true,                                    // identical
});
// Wrapped in Box with user-configured background:
const thinkingBox = new Box(paddingX, paddingY, createBgFn(config.bgColor));
thinkingBox.addChild(thinkingMd);
// Hidden label — identical:
new Text(t.italic(t.fg("thinkingText", label)), 1, 0);
```

When disabled, delegates to the original method.

### 4. Commands

| Command | Behavior |
|---------|----------|
| `/thinking-box` | Show current settings |
| `/thinking-box on\|off` | Toggle; persists to `~/.pi/agent/thinking-box.json` |
| `/thinking-box bg #rrggbb` | Set background color; auto-enables, persists |
| `/thinking-box padding X Y` | Set padding (0–10); persists to disk |

## Color pipeline

```
                  ┌── Box.background ──────────────────────────┐
                  │  User sets hex color via /thinking-box bg   │
                  │       │                                     │
                  │  hexToAnsiBg("#2d2d30")                     │
                  │  = \x1b[48;2;45;45;48m                     │
                  │       │                                     │
                  │  Box.bgFn(text)                             │
                  │  = \x1b[48;2;...{text}\x1b[49m            │
                  └────────────────────────────────────────────┘

                  ┌── Thinking text color ─────────────────────┐
                  │  Theme.fg("thinkingText", text)            │
                  │  → accessed via globalThis symbol          │
                  │  → theme-aware (respects custom themes)    │
                  └────────────────────────────────────────────┘

                  ┌── Thinking text italic ────────────────────┐
                  │  Markdown DefaultTextStyle { italic: true }│
                  │  → MarkdownTheme.italic() applies          │
                  │  → theme-aware (respects custom themes)    │
                  └────────────────────────────────────────────┘

                  ┌── Errors / abort messages ─────────────────┐
                  │  Theme.fg("error", text)                   │
                  │  → accessed via globalThis symbol          │
                  │  → theme-aware                             │
                  └────────────────────────────────────────────┘
```

## Fragility

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| pi changes `updateContent` internals | Low (stable) | High (patch breaks) | Patch mirrors original closely; diff audit on pi upgrade |
| pi switches to `#private` fields | Very low | Critical | Would need upstream extension hook |
| Theme change (dark→light) | Common | Visual match | Text colors follow theme; background is user-configured hex (static by design) |
| Pi changes the globalThis symbol key | Very low | Critical | Would break Pi's own internal code too — unlikely without major refactor |
| `/reload` loses in-memory config | Low | Medium | Config restored from `~/.pi/agent/thinking-box.json` on next `session_start` |

## Config persistence

```
Extension dir (bundled, read-only)       User dir (writable, survives updates)
┌──────────────────────────────┐         ┌───────────────────────────────────┐
│ config.json                  │         │ ~/.pi/agent/thinking-box.json     │
│   enabled: true              │  merge  │   bgColor: "#1e1e2e"              │
│   bgColor: "#2d2d30"         │ ──────► │   paddingX: 2                     │
│   paddingX: 1                │         │                                   │
│   paddingY: 1                │         │ (created lazily on first change)  │
└──────────────────────────────┘         └───────────────────────────────────┘
```

On `session_start`: read user config → shallow-merge over defaults → in-memory `config`.
On `/thinking-box` command: write `config` → user config file (creates if missing).
User config is optional — defaults work without any file on disk.

## Files

```
thinking-box/
├── index.ts              # Extension code (~280 lines)
├── config.json           # Bundled defaults (read-only)
├── README.md             # Install + usage
└── docs/
    └── ARCHITECTURE.md   # This file
```

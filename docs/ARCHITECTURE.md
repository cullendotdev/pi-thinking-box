# Architecture: Thinking Box Extension

## How it works

The extension monkey-patches `AssistantMessageComponent.prototype.updateContent`. When a new assistant message arrives, our patched method wraps thinking blocks in a `Box` component with a configurable background color and padding.

```
Normal rendering:                    Patched rendering:
                                    
  Text block                          Text block
  (rendered inline)                   (rendered inline)
                                    
  Thinking block                     ┌─────────────────┐
  (gray italic text,                 │  Thinking block  │
   no background)                    │  (gray italic,   │
                                     │   on bg color)   │
  More text                          └─────────────────┘
                                     
                                     More text
```

## Why monkey-patching

Pi has no extension hook for customizing built-in assistant message rendering. There's `registerMessageRenderer` but only for custom message types (`role: "custom"`), not for the built-in `role: "assistant"`. The `theme` singleton (which has `fg()`, `bg()`) is not publicly exported — only the `Theme` class is. So even if we added `thinkingBg` to a custom theme file, the patched code couldn't call `theme.bg("thinkingBg", text)`.

The monkey-patch uses `chalk` for text styling and raw ANSI escapes for the box background, avoiding both the extension API gap and the theme export gap.

## Implementation overview

**`index.ts`** — single file, ~300 lines. Three sections:

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

### 2. Monkey-patch

Saves `AssistantMessageComponent.prototype.updateContent` → replaces with custom version.

The patched method replicates the original logic exactly, except for thinking blocks:

```typescript
// Original:
this.contentContainer.addChild(
  new Markdown(content.thinking.trim(), 1, 0, this.markdownTheme, {
    color: (text) => theme.fg("thinkingText", text),
    italic: true,
  })
);

// Patched:
const thinkingMd = new Markdown(content.thinking.trim(), 1, 0, mdTheme, {
  color: (text) => chalk.gray.italic(text),
  italic: false,  // chalk already italicizes
});
const thinkingBox = new Box(paddingX, paddingY, hexToBgFn(bgColor));
thinkingBox.addChild(thinkingMd);
this.contentContainer.addChild(thinkingBox);
```

When disabled, delegates to the original method.

### 3. Commands

| Command | Behavior |
|---------|----------|
| `/thinking-box` | Show current settings |
| `/thinking-box on\|off` | Toggle; persists to `~/.pi/agent/thinking-box.json` |
| `/thinking-box bg #rrggbb` | Set background color; auto-enables, persists |
| `/thinking-box padding X Y` | Set padding (0–10); persists to disk |

## Color pipeline

```
User input                  ANSI escape
"/thinking-box bg #2d2d30"  ──►  \x1b[48;2;45;45;48m
                                             │
                                      Box.bgFn(text)
                                      = \x1b[48;2;45;45;48m{text}\x1b[49m
```

`\x1b[49m` resets the background after each line so the color doesn't bleed.

## Fragility

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| pi changes `updateContent` internals | Low (stable) | High (patch breaks) | Patch mirrors original closely; diff audit on pi upgrade |
| pi switches to `#private` fields | Very low | Critical | Would need upstream extension hook |
| Theme change (dark→light) | Common | Visual mismatch | User sets bg manually for light themes |
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
├── index.ts              # Extension code (~300 lines)
├── config.json           # Bundled defaults (read-only)
├── README.md             # Install + usage
└── docs/
    └── ARCHITECTURE.md   # This file
```

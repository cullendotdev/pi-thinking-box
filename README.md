# Thinking Box

Wrap agent thinking blocks in a background box — just like user messages have.

**Default appearance** (dark theme, `#2d2d30` background, 1 cell padding):

```
┌¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬┐
  Let me think about this carefully…
  The user wants to refactor the auth module.
  I should check the existing middleware first.
└¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬¬┘
```

## Install

```bash
pi install npm:thinking-box
# or for local dev:
# cp -r thinking-box ~/.pi/agent/extensions/
```

Restart pi or run `/reload` after install.

## Usage

| Command | Effect |
|---------|--------|
| `/thinking-box` | Show current settings |
| `/thinking-box on` | Enable the box |
| `/thinking-box off` | Disable (stock rendering) |
| `/thinking-box bg #2d2d30` | Set background color |
| `/thinking-box padding 1 1` | Set padding in character cells (cols × rows) |

### Examples

```bash
# Match your terminal background
/thinking-box bg #1e1e2e

# Wider box
/thinking-box padding 2 1

# No padding — tight background
/thinking-box padding 0 0

# Disable temporarily
/thinking-box off

# Re-enable
/thinking-box on
```

## Configuration

Config persists across sessions to `~/.pi/agent/thinking-box.json`. Changes survive pi restarts, reloads, and package updates. Defaults ship in `config.json` inside the extension directory.

**Defaults:**
- Background: `#2d2d30` (matches dark theme's user message background)
- Padding: `1 × 1` (character cells)
- Enabled: `true`

## Limitations

- **Theme changes**: The box background is set explicitly — it won't auto-adapt when you switch themes. Set it manually for light themes (e.g., `/thinking-box bg #e8e8e8`).
- **Text color**: Thinking text is styled independently of the theme (gray italic). Looks good on dark themes, acceptable on light.
- **No uninstall**: Removing the extension requires a pi restart (the monkey-patch persists in-process until restart).

## How It Works

The extension monkey-patches `AssistantMessageComponent.prototype.updateContent` to intercept thinking block rendering. When enabled, thinking content is wrapped in a `Box` component (from `@mariozechner/pi-tui`) with configurable padding and a hex background color. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for full details.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Extension code (~300 lines) |
| `config.json` | Bundled defaults (read-only) |
| `README.md` | This file |
| `docs/ARCHITECTURE.md` | Architecture, design decisions, gotchas |

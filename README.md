# pi-thinking-box

Wrap agent thinking blocks in a styled background box — just like user messages have. A [pi](https://github.com/earendil-works/pi) extension.

**Default appearance** (dark theme, `#343541` background, 1 cell padding):

```
┌──────────────────────────────────────┐
│  Let me think about this carefully…  │
│  The user wants to refactor...       │
│  I should check middleware first.    │
└──────────────────────────────────────┘
```

## Install

```bash
pi install npm:pi-thinking-box
# or for local dev:
# cp -r pi-thinking-box ~/.pi/agent/extensions/
```

Restart pi or run `/reload` after install.

## Usage

| Command | Effect |
|---------|--------|
| `/thinking-box` | Show current settings |
| `/thinking-box on` | Enable the box |
| `/thinking-box off` | Disable (stock rendering) |
| `/thinking-box bg #2d2d30` | Set background color (6-digit hex) |
| `/thinking-box padding 1 1` | Set padding in character cells (cols × rows, 0–10) |

### Examples

```bash
# Match your terminal background
/thinking-box bg #1e1e2e

# Wider box
/thinking-box padding 2 1

# No padding — tight background
/thinking-box padding 0 0

# Disable
/thinking-box off

# Re-enable
/thinking-box on
```

## Configuration

Config persists across sessions to `~/.pi/agent/thinking-box.json`. Changes survive pi restarts, reloads, and package updates. Defaults ship in `config.json` inside the extension directory.

**Defaults:**
- Background: `#343541`
- Padding: `0 × 1` (character cells)
- Enabled: `true`

## How It Works

The extension monkey-patches `AssistantMessageComponent.prototype.updateContent` to wrap thinking blocks in a `Box` component with configurable background and padding. Thinking text follows the active theme; the background is user-configured hex.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for full implementation details.

## Limitations

- **Theme changes**: Box background is explicit hex — won't auto-adapt on theme switch. Configure manually for your theme.

## License

MIT

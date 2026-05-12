# pi-thinking-box

Wrap agent thinking blocks in a styled background box — just like user messages have. A [pi](https://github.com/earendil-works/pi) extension.

![Settings menu with live preview of styled thinking box](https://raw.githubusercontent.com/cullendotdev/pi-thinking-box/refs/heads/main/images/settings.png)

## Install

```bash
pi install npm:pi-thinking-box
# or for local dev:
# cp -r pi-thinking-box ~/.pi/agent/extensions/
```

Restart pi or run `/reload` after install.

## Usage

Run `/thinking-box` to open an interactive settings menu with a live preview. Configure everything in one place:

- **Enabled** — toggle the thinking box on/off
- **Background Color** — choose from 9 presets (VS Code Dark, Dracula, Tokyo Night, etc.) or enter a custom hex color
- **Padding X / Y** — horizontal and vertical padding inside the box (0–5)
- **Show Header** — toggle a header bar above each thinking block
- **Header Label** — customise the header text (default: "Thinking")
- **Show Thinking Level** — append the current thinking level (e.g. "medium") to the header

All changes apply immediately and preview in real time. Settings persist across sessions to `~/.pi/agent/thinking-box.json`.

### Color Presets

Navigate the color picker with arrow keys — the preview updates live as you browse. Choose "Custom…" to enter any 6-digit hex color.

- Default (ChatGPT-style), VS Code Dark, Dark Blue-Gray, Dracula, Tokyo Night, Purple Twilight, Gruvbox Dark, Deep Black, Pure Black, Custom…

## Configuration

Config persists across sessions to `~/.pi/agent/thinking-box.json`. Changes survive pi restarts, reloads, and package updates. Defaults ship in `config.json` inside the extension directory.

**Defaults:**

- Enabled: `true`
- Background: `#343541`
- Padding: `0 × 1` (character cells)
- Show Header: `true`
- Header Label: `"Thinking"`
- Show Thinking Level: `true`

## How It Works

The extension monkey-patches `AssistantMessageComponent.prototype.updateContent` to wrap thinking blocks in a `Box` component with configurable background and padding. Thinking text follows the active theme; the background is user-configured hex.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for full implementation details.

## Limitations

- **Theme changes**: Box background is explicit hex — won't auto-adapt on theme switch. Configure manually for your theme.

## License

MIT

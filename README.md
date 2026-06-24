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
- **Display Mode** — `background` (filled box) or `bordered` (drawn border around the text)
- **Customize Thinking Box** — submenu in `background` mode that groups box styling:
  - **Background Color** — choose from 9 presets (VS Code Dark, Dracula, Tokyo Night, etc.) or enter a custom hex color
  - **Padding X** — horizontal padding inside the box (0–5 characters)
  - **Padding Y** — vertical padding inside the box (0–5 lines)
- **Customize Border** — submenu in `bordered` mode that groups all border settings:
  - **Border Color** — color of the border glyphs
  - **Border Thickness** — `thin` (─│) or `thick` (━┃)
  - **Rounded Corners** — `on` (╭╮╰╯) or `off` (┌┐└┘); only applies to thin borders — when Border Thickness is `thick` this row is rendered muted + strikethrough (both label and value) and the toggle is disabled (Unicode has no heavy rounded corner glyphs)
- **Show Header** — toggle a header bar above each thinking block
- **Header Label** — customise the header text (default: "Thinking")
- **Show Thinking Level** — append the current thinking level (e.g. "medium") to the header
- **Show Line Count (Collapsed)** — display the rendered line count of collapsed thinking blocks (counted with the Markdown renderer so soft-wrap, code blocks, and lists are measured accurately, not just raw newlines)

All changes apply immediately and preview in real time. Settings persist across sessions to `~/.pi/agent/config/thinking-box.json`.

### Color Presets

Navigate the color picker with arrow keys — the preview updates live as you browse. Choose "Custom…" to enter any 6-digit hex color; the preview also updates live as you type a valid hex code.

- Default (ChatGPT-style), VS Code Dark, Dark Blue-Gray, Dracula, Tokyo Night, Purple Twilight, Gruvbox Dark, Deep Black, Pure Black, Custom…

## Configuration

Config persists across sessions to `~/.pi/agent/config/thinking-box.json`. Changes survive pi restarts, reloads, and package updates. Defaults ship in `config.json` inside the extension directory.

**Defaults:**

- Enabled: `true`
- Display Mode: `background`
- Background: `#343541`
- Border Color: `#5f87ff`
- Border Thickness: `thin`
- Rounded Corners: `true`
- Padding: `0 × 1` (character cells)
- Show Header: `true`
- Header Label: `"Thinking"`
- Show Thinking Level: `true`
- Show Line Count: `true`
- Show Arrow: `true`

## How It Works

The extension monkey-patches `AssistantMessageComponent.prototype.updateContent` to wrap thinking blocks in either a `Box` component (background mode, configurable fill color) or a custom `BorderedBox` component (bordered mode, configurable border style, color, and corner shape). Thinking text follows the active theme; the box border / fill colors are user-configured hex.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for full implementation details.

## Limitations

- **Theme changes**: Box background is explicit hex — won't auto-adapt on theme switch. Configure manually for your theme.

## License

MIT

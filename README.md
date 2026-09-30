# Pi customizations

Portable [Pi](https://github.com/earendil-works/pi) extensions for context usage, ephemeral side chats, and terminal notifications. Works with `@earendil-works/pi-coding-agent` 0.87.1; no Pi fork required.

## Install

```bash
pi install git:github.com/bluearpit/pi-customizations
pi list
```

In an existing Pi terminal, run `/reload`. Avoid keeping separate copies of these extensions under `~/.pi/agent/extensions/` or they will load twice. For testing without installing: `pi -e ./extensions/side.ts` or `pi -e ./extensions/context.ts`.

To upgrade an unpinned git installation, run `pi update --extensions` and `/reload`. For repeatable installs on several machines, pin the Git source to a release tag (for example `git:github.com/bluearpit/pi-customizations@v0.2.0`). Install Pi and configure model authentication separately on each machine.

## `/context`

Displays an estimated category breakdown of the active context in a collapsible TUI view, plus a compact footer meter. Token categories are *heuristic estimates*, not provider billing accounting. Compaction summaries are counted separately from other conversation messages.

## Terminal notifications

Sends an OSC terminal notification after a Pi turn has fully settled, only in interactive mode. No notifications are written to headless SDK/Telegram logs.

## `/side [question]`

Opens a temporary, read-only pane on the right of the current terminal tab. It reads the main session's latest active branch and system prompt **before every side question**. Ask follow-up questions with **Enter**; use **Shift+Enter** for a new line and **Page Up/Down** (Fn + ↑/↓ on Mac) to scroll the side conversation. Press **Tab** to focus the main editor without closing the pane; run **`/side`** or press **Ctrl+Alt+S** to focus it again. **Esc** while focused in the side pane discards it; reopening `/side` starts fresh. The pane overlays part of the main transcript rather than reflowing it, and side questions wait until an in-progress main turn finishes.

Side questions and replies are held only in memory; they are not appended to Pi's session, persisted as a second session, or sent to enabled tools. The side chat **cannot read new files, browse, or change your project**. Existing tool results in the main branch may still be in its inherited context. Provider requests still happen and can incur charges, even though those charges will not appear in Pi's saved session totals. Closing during a request aborts it best-effort; provider-side processing already started may still be billed. This is not a privacy boundary against the model provider.

The main conversation remains unchanged. Avoid using `/side` to ask questions that require fresh file access or tool execution.

## Development

```bash
npm ci
npm run check
npm test
```

Extensions run with the user's Pi process permissions. Review third-party changes before installing or updating.

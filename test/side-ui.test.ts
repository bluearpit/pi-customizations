import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type Component, type Focusable, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";
import sideExtension from "../extensions/side.js";

function harness() {
  let handler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  let shortcut!: (ctx: ExtensionCommandContext) => void;
  let shutdown!: () => void;
  let panel: (Component & Focusable) | undefined;
  let widget: { dispose?: () => void } | undefined;
  let inputListener: ((data: string) => { consume?: boolean } | undefined) | undefined;
  let editorText = "";
  const mainEditor = {} as Component;
  let focusTarget: Component | null = mainEditor;
  let focused = false;
  let hideCount = 0;
  const requests: { systemPrompt: string; messages: Array<{ role: string; content?: unknown }> }[] = [];
  const source: any[] = [{ role: "user", content: [{ type: "text", text: "Main question" }], timestamp: 1 }];
  const tui = {
    terminal: { rows: 35 },
    requestRender: () => {},
    getFocusedComponent: () => focusTarget,
    showOverlay: (component: Component & Focusable, options: Record<string, unknown>) => {
      panel = component;
      assert.equal(options.nonCapturing, true);
      assert.equal(options.anchor, "right-center");
      const handle = {
        focus: () => { focused = true; component.focused = true; focusTarget = component; },
        unfocus: () => { focused = false; component.focused = false; focusTarget = mainEditor; },
        isFocused: () => focused,
        hide: () => { hideCount++; focused = false; component.focused = false; focusTarget = mainEditor; },
      } as OverlayHandle;
      return handle;
    },
  } as unknown as TUI;
  const theme = { fg: (_name: string, text: string) => text } as Theme;
  let busy = false;
  let calls = 0;
  const ctx = {
    mode: "tui", model: { id: "fake" },
    isIdle: () => !busy,
    sessionManager: { buildSessionProjection: () => ({ messages: source }) },
    getSystemPrompt: () => "Main instructions",
    modelRegistry: { complete: async (_model: unknown, request: typeof requests[number]) => {
      calls++;
      requests.push(request);
      return { role: "assistant", content: [{ type: "text", text: `Side answer ${calls}` }], stopReason: "stop" };
    } },
    ui: { setWidget: (_name: string, factory?: (tui: TUI, theme: Theme) => Component & { dispose?: () => void }) => {
      widget?.dispose?.();
      widget = factory?.(tui, theme);
    },
    onTerminalInput: (handler: typeof inputListener) => {
      inputListener = handler;
      return () => { inputListener = undefined; };
    },
    getEditorText: () => editorText,
    notify: () => {} },
  } as unknown as ExtensionCommandContext;
  sideExtension({
    registerCommand: (_name: string, command: { handler: typeof handler }) => { handler = command.handler; },
    registerShortcut: (_key: unknown, option: { handler: typeof shortcut }) => { shortcut = option.handler; },
    on: (_name: string, fn: typeof shutdown) => { shutdown = fn; },
    getThinkingLevel: () => "off",
  } as unknown as ExtensionAPI);
  const ask = async (text: string) => {
    assert.ok(panel);
    for (const char of text) panel.handleInput?.(char);
    panel.handleInput?.("\r");
    await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    ctx, source, requests, ask, open: (args = "") => handler(args, ctx),
    shortcut: () => shortcut(ctx), shutdown: () => shutdown(),
    render: () => panel!.render(70).map(stripTerminalSequences).join("\n"),
    input: (key: string) => panel!.handleInput?.(key),
    mainTab: () => inputListener?.("\t")?.consume ?? false,
    setEditorText: (value: string) => { editorText = value; },
    setBusy: (value: boolean) => { busy = value; },
    isFocused: () => focused, getHideCount: () => hideCount,
    hasWidget: () => !!widget,
    paneLines: () => panel!.render(70),
  };
}

test("/side stays open while the main editor is active, refreshes context per question, and discards on Esc", async () => {
  const side = harness();
  await side.open(); // Command returns immediately: Pi's parent input loop can continue.
  assert.equal(side.isFocused(), true);
  assert.ok(side.paneLines().every((line) => visibleWidth(line) <= 70));
  await side.ask("Side question");
  assert.match(side.render(), /Side answer 1/);
  side.input("\t");
  assert.equal(side.isFocused(), false);
  side.setEditorText("draft");
  assert.equal(side.mainTab(), false); // Preserve main editor completion when typing.
  side.setEditorText("");
  assert.equal(side.mainTab(), true);
  assert.equal(side.isFocused(), true);
  side.input("\t");
  side.source.push({ role: "user", content: [{ type: "text", text: "New main turn" }], timestamp: 2 });
  side.shortcut(); // Also supports the existing main-editor shortcut.
  assert.equal(side.isFocused(), true);
  await side.ask("Follow-up");
  assert.equal(side.requests.length, 2);
  assert.match(JSON.stringify(side.requests[1].messages), /New main turn/);
  assert.match(JSON.stringify(side.requests[1].messages), /Side question/);
  assert.equal(side.source.length, 2); // Side questions never reach the main session.
  side.input("\x1b");
  assert.equal(side.hasWidget(), false);
  assert.equal(side.getHideCount(), 1);
  assert.equal(side.mainTab(), false); // Listener removed on close.
});

test("/side does not snapshot a partially streaming main turn and closes on session shutdown", async () => {
  const side = harness();
  await side.open();
  side.setBusy(true);
  await side.ask("Wait for main");
  assert.equal(side.requests.length, 0);
  assert.match(side.render(), /Wait for the main Pi turn/);
  side.shutdown();
  assert.equal(side.hasWidget(), false);
  assert.equal(side.getHideCount(), 1);
});

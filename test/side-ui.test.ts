import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import sideExtension from "../extensions/side.js";

test("/side answers in memory, returns on Esc, and leaves the source untouched", async () => {
  let handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> = async () => {};
  sideExtension({
    registerCommand: (_name: string, command: { handler: typeof handler }) => { handler = command.handler; },
    getThinkingLevel: () => "off",
  } as unknown as ExtensionAPI);
  const source = [{ role: "user", content: [{ type: "text", text: "Main question" }], timestamp: 1 }];
  let calls = 0;
  const tui = { terminal: { rows: 35 }, requestRender: () => {} } as unknown as TUI;
  const theme = { fg: (_name: string, text: string) => text } as Theme;
  let render = () => "";
  let ask = (_text: string) => {};
  let close = () => {};
  const ctx = {
    mode: "tui", model: { id: "fake" },
    sessionManager: { buildSessionProjection: () => ({ messages: source }) },
    getSystemPrompt: () => "Main instructions",
    modelRegistry: { complete: async (_model: unknown, request: { messages: Array<{ role: string }> }) => {
      calls++;
      assert.equal(request.messages.at(-1)?.role, "user");
      return { role: "assistant", content: [{ type: "text", text: "Side answer" }], stopReason: "stop" };
    } },
    ui: { custom: async (factory: (tui: TUI, theme: Theme, kb: unknown, done: () => void) => any) => {
      let resolve!: () => void;
      const completed = new Promise<void>((done) => { resolve = done; });
      const component = await factory(tui, theme, {}, resolve);
      component.focused = true;
      render = () => component.render(70).map(stripTerminalSequences).join("\n");
      ask = (text) => { for (const char of text) component.handleInput(char); component.handleInput("\r"); };
      close = () => component.handleInput("\x1b");
      assert.ok(component.render(70).every((line: string) => visibleWidth(line) <= 70));
      await completed;
    } },
  } as unknown as ExtensionCommandContext;
  const interaction = handler("", ctx);
  await new Promise((resolve) => setImmediate(resolve));
  ask("Side question");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(render(), /Side answer/);
  close();
  await interaction;
  assert.equal(calls, 1);
  assert.equal(source.length, 1);
  assert.equal(source[0].content[0].text, "Main question");
});

import { uuidv7, type Message, type UserMessage } from "@earendil-works/pi-ai";
import { convertToLlm, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Editor, Key, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";

/** Take Pi's active, compaction-aware branch; the effective system prompt is passed separately. */
export function snapshotMessages(messages: AgentMessage[]): Message[] {
	return convertToLlm(messages.filter((message) => message.role !== "system"));
}

const sideInstructions = "\n\nThis is an ephemeral, read-only side conversation. You cannot call tools or change files. Answer using the supplied conversation context; say when fresh information is unavailable. Side-chat messages are not part of the main session.";

type Turn = { speaker: "You" | "Pi" | "Error"; text: string };

class SideChat implements Focusable {
	private readonly editor: Editor;
	private readonly turns: Turn[] = [];
	private readonly sideMessages: Message[] = [];
	private readonly requestId = uuidv7();
	private controller?: AbortController;
	private closed = false;
	private scroll = 0;
	private pending = false;
	private _focused = false;

	get focused() { return this._focused; }
	set focused(value: boolean) { this._focused = value; this.editor.focused = value; }

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly ctx: ExtensionContext,
		private readonly pi: ExtensionAPI,
		private readonly onClose: () => void,
		private readonly onReturnToMain: () => void,
		prefill: string,
	) {
		this.editor = new Editor(tui, {
			borderColor: (text) => theme.fg("accent", text),
			selectList: {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			},
		});
		this.editor.setText(prefill);
		this.editor.onSubmit = (value) => { void this.ask(value); };
	}

	setPrefill(text: string): void {
		if (!this.pending && text.trim()) this.editor.setText(text);
		this.tui.requestRender();
	}

	private async ask(value: string): Promise<void> {
		const question = value.trim();
		if (!question || this.pending || this.closed) return;
		if (!this.ctx.isIdle()) {
			this.turns.push({ speaker: "Error", text: "Wait for the main Pi turn to finish, then ask again." });
			this.tui.requestRender();
			return;
		}
		const model = this.ctx.model;
		if (!model) return;
		this.pending = true;
		this.editor.disableSubmit = true;
		this.editor.setText("");
		this.scroll = 0;
		this.turns.push({ speaker: "You", text: question });
		const userMessage: UserMessage = {
			role: "user", content: [{ type: "text", text: question }], timestamp: Date.now(),
		};
		const controller = new AbortController();
		this.controller = controller;
		this.tui.requestRender();
		try {
			// Re-read the parent branch for every question; only these side turns are retained here.
			const messages = [...snapshotMessages(this.ctx.sessionManager.buildSessionProjection().messages), ...this.sideMessages, userMessage];
			const systemPrompt = this.ctx.getSystemPrompt() + sideInstructions;
			// No tools supplied: even while the main chat remains usable, the side cannot mutate files.
			const answer = await this.ctx.modelRegistry.complete(
				model,
				{ systemPrompt, messages },
				{ signal: controller.signal, reasoningEffort: this.pi.getThinkingLevel(), sessionId: this.requestId },
			);
			if (this.closed) return;
			if (answer.stopReason === "error" || answer.stopReason === "aborted") {
				this.turns.push({ speaker: "Error", text: answer.errorMessage || answer.stopReason });
			} else {
				this.sideMessages.push(userMessage, answer);
				const text = answer.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("\n");
				this.turns.push({ speaker: "Pi", text: text || "(No text response)" });
			}
		} catch (error) {
			if (this.closed) return;
			this.turns.push({ speaker: "Error", text: error instanceof Error ? error.message : "Request failed" });
		} finally {
			if (!this.closed) {
				this.pending = false;
				this.controller = undefined;
				this.editor.disableSubmit = false;
				this.tui.requestRender();
			}
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.controller?.abort();
		this.sideMessages.length = 0;
		this.turns.length = 0;
		this.onClose();
	}

	dispose(): void { this.close(); }
	invalidate(): void { this.editor.invalidate(); }

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) return this.close();
		if (matchesKey(data, Key.ctrlAlt("s")) || matchesKey(data, "tab")) return this.onReturnToMain();
		if (matchesKey(data, "pageUp")) this.scroll += 6;
		else if (matchesKey(data, "pageDown")) this.scroll = Math.max(0, this.scroll - 6);
		else if (!this.pending) this.editor.handleInput(data);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const inner = Math.max(1, width - 2);
		const editorLines = this.editor.render(inner);
		const maxHistory = Math.max(2, Math.min(9, Math.floor(this.tui.terminal.rows * 0.9) - editorLines.length - 7));
		const lines: string[] = [];
		for (const turn of this.turns) {
			const color = turn.speaker === "You" ? "accent" : turn.speaker === "Error" ? "error" : "text";
			lines.push(...wrapTextWithAnsi(this.theme.fg(color, `${turn.speaker}: ${stripTerminalSequences(turn.text)}`), inner));
			lines.push("");
		}
		if (!lines.length) lines.push(this.theme.fg("muted", "Ask about the main conversation. Side answers are discarded on exit."));
		this.scroll = Math.min(this.scroll, Math.max(0, lines.length - maxHistory));
		const end = lines.length - this.scroll;
		const visible = lines.slice(Math.max(0, end - maxHistory), end);
		const row = (text: string) => {
			const clipped = truncateToWidth(text, inner);
			return this.theme.fg("border", "│") + clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped))) + this.theme.fg("border", "│");
		};
		const border = (left: string, right: string) => this.theme.fg("border", left + "─".repeat(inner) + right);
		return [
			border("╭", "╮"),
			row(this.theme.fg("accent", " Side chat") + this.theme.fg("dim", this.focused ? " · Tab → main" : " · main focused · Tab → here")),
			row(this.theme.fg("dim", " Main context refreshed for each question · read-only")),
			...visible.map(row),
			row(this.pending ? this.theme.fg("muted", " Thinking… Esc closes") : ""),
			...editorLines.map(row),
			row(this.theme.fg("dim", " Enter ask · Shift+Enter newline · Tab switch · Esc discard")),
			border("╰", "╯"),
		];
	}
}

export default function (pi: ExtensionAPI) {
	let active: { chat: SideChat; handle: OverlayHandle; ctx: ExtensionContext } | undefined;
	const widgetKey = "side-chat-host";

	function close(): void {
		if (!active) return;
		const current = active;
		active = undefined;
		current.ctx.ui.setWidget(widgetKey, undefined); // Disposes widget, panel and overlay.
	}

	function open(ctx: ExtensionContext, prefill = ""): void {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/side requires interactive Pi", "warning");
			return;
		}
		if (active) {
			active.chat.setPrefill(prefill);
			active.handle.focus();
			return;
		}
		if (!ctx.model) {
			ctx.ui.notify("Choose a model before opening /side", "warning");
			return;
		}
		ctx.ui.setWidget(widgetKey, (tui, theme) => {
			const focusableTui = tui as TUI & { getFocusedComponent(): Component | null };
			const mainEditor = focusableTui.getFocusedComponent();
			const chat = new SideChat(tui, theme, ctx, pi, close, () => active?.handle.unfocus(), prefill);
			const handle = tui.showOverlay(chat, {
				anchor: "right-center", width: "48%", maxHeight: "90%", margin: 1, nonCapturing: true,
			});
			// The main editor normally uses Tab for completion. When its prompt is empty,
			// Tab switches back to the side pane instead; other focused UIs keep their Tab.
			const stopListening = ctx.ui.onTerminalInput((data) => {
				if (active?.handle === handle && matchesKey(data, "tab") &&
					focusableTui.getFocusedComponent() === mainEditor && !ctx.ui.getEditorText().trim()) {
					handle.focus();
					return { consume: true };
				}
				return undefined;
			});
			active = { chat, handle, ctx };
			handle.focus();
			return {
				render: () => [], // Widget owns the overlay but consumes no editor-adjacent space.
				invalidate: () => chat.invalidate(),
				dispose: () => {
					if (active?.chat === chat) active = undefined;
					stopListening();
					handle.hide();
					chat.dispose();
				},
			};
		});
	}

	pi.registerCommand("side", {
		description: "Toggle a read-only side pane that follows the current Pi conversation",
		handler: async (args, ctx) => open(ctx, args),
	});
	pi.registerShortcut(Key.ctrlAlt("s"), {
		description: "Focus or open the side chat pane",
		handler: (ctx) => open(ctx),
	});
	pi.on("session_shutdown", () => close());
}

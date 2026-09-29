import { uuidv7, type Message, type UserMessage } from "@earendil-works/pi-ai";
import { convertToLlm, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Editor, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Focusable, type TUI } from "@earendil-works/pi-tui";

/** Copy Pi's compaction-aware active branch, excluding system patches (passed separately). */
export function snapshotMessages(messages: AgentMessage[]): Message[] {
	return convertToLlm(messages.filter((message) => message.role !== "system"));
}

const sideInstructions = "\n\nThis is an ephemeral, read-only side conversation. You cannot call tools or change files. Answer using the supplied conversation context; say when fresh information is unavailable. Side-chat messages are not part of the main session.";

type Turn = { speaker: "You" | "Pi" | "Error"; text: string };

class SideChat implements Focusable {
	private readonly editor: Editor;
	private readonly turns: Turn[] = [];
	private readonly messages: Message[];
	private readonly systemPrompt: string;
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
		private readonly ctx: ExtensionCommandContext,
		private readonly pi: ExtensionAPI,
		private readonly done: (value: void) => void,
		prefill: string,
	) {
		this.messages = snapshotMessages(ctx.sessionManager.buildSessionProjection().messages);
		this.systemPrompt = ctx.getSystemPrompt() + sideInstructions;
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

	private async ask(value: string): Promise<void> {
		const question = value.trim();
		if (!question || this.pending || this.closed || !this.ctx.model) return;
		this.pending = true;
		this.editor.disableSubmit = true;
		this.editor.setText("");
		this.scroll = 0;
		this.turns.push({ speaker: "You", text: question });
		const userMessage: UserMessage = {
			role: "user", content: [{ type: "text", text: question }], timestamp: Date.now(),
		};
		this.messages.push(userMessage);
		const controller = new AbortController();
		this.controller = controller;
		this.tui.requestRender();
		try {
			// No tools supplied: the side chat can answer but cannot mutate the project.
			const answer = await this.ctx.modelRegistry.complete(
				this.ctx.model,
				{ systemPrompt: this.systemPrompt, messages: this.messages },
				{ signal: controller.signal, reasoningEffort: this.pi.getThinkingLevel(), sessionId: this.requestId },
			);
			if (this.closed) return;
			if (answer.stopReason === "error" || answer.stopReason === "aborted") {
				this.messages.pop();
				this.turns.push({ speaker: "Error", text: answer.errorMessage || answer.stopReason });
			} else {
				this.messages.push(answer);
				const text = answer.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("\n");
				this.turns.push({ speaker: "Pi", text: text || "(No text response)" });
			}
		} catch (error) {
			if (this.closed) return;
			this.messages.pop();
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

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.controller?.abort();
		this.messages.length = 0;
		this.turns.length = 0;
		this.done();
	}

	dispose(): void { this.close(); }
	invalidate(): void { this.editor.invalidate(); }

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) return this.close();
		if (matchesKey(data, "pageUp")) this.scroll += 6;
		else if (matchesKey(data, "pageDown")) this.scroll = Math.max(0, this.scroll - 6);
		else if (!this.pending) this.editor.handleInput(data);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const inner = Math.max(1, width - 2);
		const editorLines = this.editor.render(inner);
		const maxHistory = Math.max(2, Math.min(9, Math.floor(this.tui.terminal.rows * 0.85) - editorLines.length - 7));
		const lines: string[] = [];
		for (const turn of this.turns) {
			const color = turn.speaker === "You" ? "accent" : turn.speaker === "Error" ? "error" : "text";
			const safe = stripTerminalSequences(turn.text);
			lines.push(...wrapTextWithAnsi(this.theme.fg(color, `${turn.speaker}: ${safe}`), inner));
			lines.push("");
		}
		if (!lines.length) lines.push(this.theme.fg("muted", "Ask about this conversation. Nothing here enters the main session."));
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
			row(this.theme.fg("accent", " Side chat") + this.theme.fg("dim", " · read-only · discarded on exit")),
			row(""),
			...visible.map(row),
			row(this.pending ? this.theme.fg("muted", " Thinking… Esc to cancel and leave") : ""),
			...editorLines.map(row),
			row(this.theme.fg("dim", " Enter ask · Shift+Enter newline · PgUp/PgDn scroll · Esc return")),
			border("╰", "╯"),
		];
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("side", {
		description: "Ask read-only, ephemeral questions with the current conversation as context",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/side requires interactive Pi", "warning");
				return;
			}
			if (!ctx.model) {
				ctx.ui.notify("Choose a model before opening /side", "warning");
				return;
			}
			await ctx.ui.custom<void>((tui, theme, _kb, done) => new SideChat(tui, theme, ctx, pi, done, args), {
			overlay: true,
			overlayOptions: { width: "85%", maxHeight: "85%", margin: 1 },
			});
		},
	});
}

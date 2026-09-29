import { estimateTokens, formatSkillsForPrompt, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

type Color = "accent" | "success" | "warning" | "mdLink" | "mdCode" | "toolTitle" | "summary";
type Group = { label: string; tokens: number; color: Color; details: string[] };

// Intentionally use fixed truecolor rather than theme roles: the current theme
// renders several semantic colors almost identically in the terminal footer.
const palette: Record<Color, [number, number, number]> = {
	mdLink: [41, 190, 255],     // P: cyan
	warning: [255, 156, 40],   // R: orange
	success: [72, 232, 115],   // K: green
	toolTitle: [191, 119, 255], // T: violet
	mdCode: [255, 85, 105],    // X: coral
	accent: [245, 245, 245],   // C: white
	summary: [255, 99, 217],   // Σ: pink
};
function colorize(color: Color, text: string): string {
	const [r, g, b] = palette[color];
	return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

const approximate = (text: string) => Math.ceil(text.length / 4);
const amount = (tokens: number) => tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);

function segmentWidths(tokens: number[], size: number): number[] {
	const total = tokens.reduce((sum, value) => sum + value, 0);
	const widths: number[] = tokens.map((value) => value > 0 ? 1 : 0);
	if (total === 0) return widths;
	const remaining = Math.max(0, size - widths.reduce((sum, width) => sum + width, 0));
	const shares = tokens.map((value) => remaining * value / total);
	for (let i = 0; i < tokens.length; i++) widths[i] += Math.floor(shares[i]);
	let leftover = remaining - shares.reduce((sum, share) => sum + Math.floor(share), 0);
	for (const i of tokens.map((_, index) => index)
		.sort((a, b) => (shares[b] % 1) - (shares[a] % 1))) {
		if (leftover-- <= 0) break;
		widths[i]++;
	}
	return widths;
}

export default function (pi: ExtensionAPI) {
	// Footer statuses are additive: Pi keeps its normal model, tokens, and cost lines.
	function updateMeter(ctx: ExtensionContext) {
		if (ctx.mode !== "tui") return;
		const usage = ctx.getContextUsage();
		if (!usage) {
			ctx.ui.setStatus("context-meter", undefined);
			return;
		}

		// Replay prompt sections on the active, compaction-aware branch. Full skill
		// instructions read on demand are counted with the conversation below.
		const messages = ctx.sessionManager.buildSessionProjection().messages;
		const sections = new Map<string, string>();
		let freeform = "";
		let conversation = 0;
		let summaries = 0;
		for (const message of messages) {
			if (message.role === "compactionSummary") {
				summaries += estimateTokens(message);
				continue;
			}
			if (message.role !== "system") {
				conversation += estimateTokens(message);
				continue;
			}
			if (typeof message.content === "string") freeform += message.content;
			for (const [key, value] of Object.entries(message.sections ?? {})) {
				if (value === null) sections.delete(key);
				else sections.set(key, value);
			}
		}
		const rules = approximate((sections.get("rules") ?? "") + (sections.get("project_context") ?? ""));
		const skills = approximate(sections.get("skills") ?? "");
		const system = approximate(freeform + [...sections.entries()]
			.filter(([key]) => !["rules", "project_context", "skills"].includes(key))
			.map(([, value]) => value).join(""));
		const active = new Set(pi.getActiveTools());
		const tools = pi.getAllTools().filter((tool) => active.has(tool.name));
		const estimateTools = (source: "builtin" | "other") => tools
			.filter((tool) => source === "builtin" ? tool.sourceInfo.source === "builtin" : tool.sourceInfo.source !== "builtin")
			.reduce((sum, tool) => {
				try { return sum + approximate(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters })); }
				catch { return sum + approximate(`${tool.name} ${tool.description}`); }
			}, 0);
		const parts: { tokens: number; color: Color }[] = [
			{ tokens: system, color: "mdLink" },
			{ tokens: rules, color: "warning" },
			{ tokens: skills, color: "success" },
			{ tokens: estimateTools("builtin"), color: "toolTitle" },
			{ tokens: estimateTools("other"), color: "mdCode" },
			{ tokens: summaries, color: "summary" },
			{ tokens: conversation, color: "accent" },
		];
		// Keep small nonempty categories visible beside a long conversation.
		const widths = segmentWidths(parts.map((part) => part.tokens), 18);
		const bar = parts.map((part, index) => colorize(part.color, "━".repeat(widths[index]))).join("");
		const legend = parts.map((part, index) => colorize(part.color, ["P", "R", "K", "T", "X", "Σ", "C"][index])).join(" ");
		const compactions = ctx.sessionManager.getBranch().filter((entry) => entry.type === "compaction").length;
		const summaryCount = compactions ? ` · ${colorize("summary", `Σ~${amount(summaries)}×${compactions}`)}` : "";
		ctx.ui.setStatus("context-meter", `Context [${bar}] ${legend}${summaryCount} · /context`);
	}

	pi.on("session_start", (_event, ctx) => updateMeter(ctx));
	pi.on("turn_end", (_event, ctx) => updateMeter(ctx));
	pi.on("agent_settled", (_event, ctx) => updateMeter(ctx));
	pi.on("session_tree", (_event, ctx) => updateMeter(ctx));
	pi.on("session_compact", (_event, ctx) => updateMeter(ctx));
	pi.on("model_select", (_event, ctx) => updateMeter(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode === "tui") ctx.ui.setStatus("context-meter", undefined);
	});

	pi.registerCommand("context", {
		description: "Inspect estimated context usage, loaded skills, tools, and conversation",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/context requires interactive mode", "error");
				return;
			}

			const usage = ctx.getContextUsage();
			const options = ctx.getSystemPromptOptions();
			const prompt = ctx.getSystemPrompt();
			const skillList = options.skills ?? [];
			const readable = (options.selectedTools ?? pi.getActiveTools()).some((tool) => tool === "read" || tool === "bash");
			const availableSkills = readable ? skillList.filter((skill) => !skill.disableModelInvocation) : [];
			const skillText = readable ? formatSkillsForPrompt(availableSkills).trim() : "";
			const skillsTokens = prompt.includes("<skills>") ? approximate(skillText) : 0;
			const rulesTokens = options.forceSystemPrompt === undefined
				? approximate((options.contextFiles ?? []).map((file) => `${file.path}\n${file.content}`).join("\n") +
					(options.promptGuidelines ?? []).join("\n"))
				: 0;
			const promptTokens = approximate(prompt);

			const active = new Set(pi.getActiveTools());
			const tools = pi.getAllTools().filter((tool) => active.has(tool.name));
			const builtIn = tools.filter((tool) => tool.sourceInfo.source === "builtin");
			const extensions = tools.filter((tool) => tool.sourceInfo.source !== "builtin");
			const toolTokens = (list: typeof tools) => list.reduce((total, tool) => {
				try { return total + approximate(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters })); }
				catch { return total + approximate(`${tool.name} ${tool.description}`); }
			}, 0);
			const projection = ctx.sessionManager.buildSessionProjection();
			const summaries = projection.messages.filter((message) => message.role === "compactionSummary");
			const summaryTokens = summaries.reduce((total, message) => total + estimateTokens(message), 0);
			const compactions = ctx.sessionManager.getBranch().filter((entry) => entry.type === "compaction").length;
			const conversation = projection.messages.filter((message) => message.role !== "system" && message.role !== "compactionSummary");
			const conversationTokens = conversation.reduce((total, message) => total + estimateTokens(message), 0);
			const groups: Group[] = [
				{ label: "System prompt + other", tokens: Math.max(0, promptTokens - skillsTokens - rulesTokens), color: "mdLink", details: ["Base prompt, docs, tool guidelines, and unclassified sections"] },
				{ label: "Rules / project instructions", tokens: rulesTokens, color: "warning", details: (options.contextFiles ?? []).map((file) => file.path) },
				{ label: "Skills (descriptions)", tokens: skillsTokens, color: "success", details: [
					`${availableSkills.length} in prompt; ${skillList.length} discovered`,
					...skillList.map((skill) => `${skill.disableModelInvocation ? "manual" : "prompt"}  ${skill.name}`),
				] },
				{ label: "Built-in tool definitions", tokens: toolTokens(builtIn), color: "toolTitle", details: builtIn.map((tool) => tool.name) },
				{ label: "Extension / dynamic tools", tokens: toolTokens(extensions), color: "mdCode", details: [
					...extensions.map((tool) => `${tool.name}  (${tool.sourceInfo.source})`),
					"MCP tools appear here only if an extension registers them as tools.",
				] },
				{ label: "Compaction summary (active)", tokens: summaryTokens, color: "summary", details: [
					`${compactions} compaction${compactions === 1 ? "" : "s"} on this branch; ${summaries.length} summary message${summaries.length === 1 ? "" : "s"} still active`,
					"Older summaries replaced by later compactions are not counted twice.",
				] },
				{ label: "Conversation (active context)", tokens: conversationTokens, color: "accent", details: [
					`${conversation.length} model-visible messages after compaction/edits`,
					"Includes on-demand skill reads, tool results, and images (roughly estimated).",
				] },
			];

			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				type Row = { group: number; detail?: string };
				const expanded = new Set<number>();
				let selected = 0;
				let scroll = 0;
				const pageSize = 12;
				function rows(): Row[] {
					return groups.flatMap((group, index) => [
						{ group: index },
						...(expanded.has(index) ? (group.details.length ? group.details : ["(no details)"])
							.map((detail) => ({ group: index, detail })) : []),
					]);
				}
				return {
					render(width: number) {
					const heading = theme.fg("accent", theme.bold("Context usage"));
					const total = usage?.tokens === null || usage === undefined
						? "Total: unknown until next model response"
						: `Total: ~${amount(usage.tokens)} / ${amount(usage.contextWindow)} tokens (${usage.percent?.toFixed(1)}%)`;
					const widths = segmentWidths(groups.map((group) => group.tokens), 28);
					const bar = groups.map((group, index) => colorize(group.color, "━".repeat(widths[index]))).join("");
					const items = rows();
					selected = Math.min(selected, items.length - 1);
					if (selected < scroll) scroll = selected;
					if (selected >= scroll + pageSize) scroll = selected - pageSize + 1;
					const visible = items.slice(scroll, scroll + pageSize).map((row, index) => {
						const active = scroll + index === selected;
						const marker = active ? "› " : "  ";
						if (row.detail !== undefined) {
							return theme.fg(active ? "text" : "muted", `${marker}    ${row.detail}`);
						}
						const group = groups[row.group];
						const arrow = expanded.has(row.group) ? "▾" : "▸";
						return (active ? theme.bold(marker) : marker) + colorize(group.color, `${arrow} ${group.label}`) +
							theme.fg("muted", `  ~${amount(group.tokens)} tokens`);
					});
					return [heading, theme.fg("muted", total), bar, "", ...visible,
						theme.fg("dim", `Category estimates, not an exact split of total · ${selected + 1}/${items.length}`),
						theme.fg("dim", "↑↓ select · Enter toggle · → expand · ← collapse · Esc close"),
					].map((line) => truncateToWidth(line, width));
				},
				invalidate() {},
				handleInput(data: string) {
					if (matchesKey(data, "escape") || data === "q") return done();
					const items = rows();
					if (matchesKey(data, "down") || data === "j") selected = Math.min(items.length - 1, selected + 1);
					else if (matchesKey(data, "up") || data === "k") selected = Math.max(0, selected - 1);
					else if (matchesKey(data, "pageDown")) selected = Math.min(items.length - 1, selected + pageSize);
					else if (matchesKey(data, "pageUp")) selected = Math.max(0, selected - pageSize);
					else {
						const groupIndex = items[selected]?.group;
						if (groupIndex === undefined) return;
						const collapse = matchesKey(data, "left");
						const expand = matchesKey(data, "right");
						const toggle = matchesKey(data, "enter") || matchesKey(data, "return");
						if (collapse || expand || toggle) {
							const wasExpanded = expanded.has(groupIndex);
							if (collapse || (toggle && wasExpanded)) expanded.delete(groupIndex);
							else if (expand || toggle) expanded.add(groupIndex);
							if (collapse || (toggle && wasExpanded)) selected = items.findIndex((row) => row.group === groupIndex);
						}
					}
					tui.requestRender();
				},
			};
			});
		},
	});
}

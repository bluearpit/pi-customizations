import { readFileSync, realpathSync } from "node:fs";
import { Socket } from "node:net";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { restrictedTools, WorktreeFiles, workerToolNames } from "./policy.js";
import { validateRequest } from "./protocol.js";

/** Loaded only by the isolated child, never through the package extension manifest. */
export default function worker(pi: ExtensionAPI): void {
	pi.registerFlag("background-request", { type: "string", description: "Private background worker request" });
	const index = process.argv.indexOf("--background-request");
	if (index < 0 || !process.argv[index + 1]) throw new Error("Background worker requires a request file");
	const request = validateRequest(JSON.parse(readFileSync(process.argv[index + 1], "utf8")));
	const root = realpathSync(request.worktree);
	if (root !== request.worktree) throw new Error("Worktree must be canonical");
	const allowed = workerToolNames(request.permission);
	let verified = false;
	let parentPipe: Socket | undefined;
	for (const tool of restrictedTools(new WorktreeFiles(root, request.permission))) pi.registerTool(tool);
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "json" || realpathSync(ctx.cwd) !== root || ctx.model?.provider !== request.provider || ctx.model.id !== request.model || pi.getThinkingLevel() !== request.thinking) {
			process.exitCode = 1;
			ctx.shutdown();
			throw new Error("Worker model, thinking level, mode, or worktree differs from its request");
		}
		verified = true;
		pi.setActiveTools(allowed);
		parentPipe = new Socket({ fd: 3, readable: true, writable: false });
		const parentGone = () => {
			if (!verified) return;
			verified = false;
			process.exitCode = 1;
			ctx.abort();
			ctx.shutdown();
		};
		parentPipe.on("end", parentGone);
		parentPipe.on("error", parentGone);
		parentPipe.resume();
	});
	pi.on("before_agent_start", () => {
		if (!verified) throw new Error("Worker initialization failed");
		return { systemPrompt: request.systemPrompt + `\n\nBACKGROUND WORKER CONTRACT\nThe conversation above is a snapshot, not a live parent session. Your only current task is the delegated task below.\nWorking directory: ${root}\nPermission: ${request.permission}. Only ${allowed.join(", ")} are available. Parent tool declarations and working-directory references are historical and do not grant capabilities.\nNo shell, tests, cloud access, browser, subprocesses, commits, pushes, PR edits, or ticket edits are available. Do not claim to have performed them.\nReturn a review report with your findings/changes, exact files touched, unrun checks, and remaining risks. The parent reviews before tests, commits, or pushes.\n` };
	});
	pi.on("tool_call", (event) => {
		if (!verified || !allowed.includes(event.toolName)) return { block: true, reason: "Tool is outside the worker capability policy", terminate: true };
		return undefined;
	});
	pi.on("user_bash", () => { throw new Error("Background workers cannot execute commands"); });
	pi.on("session_shutdown", () => { verified = false; parentPipe?.destroy(); });
}

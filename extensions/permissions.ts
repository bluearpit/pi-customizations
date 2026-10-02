import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { evaluate, loadPolicy, type PermissionMode, type Policy } from "./permission-policy.js";

// Set only in an explicitly trusted host process (telegram-pi), never in user settings.
const initialMode = (): PermissionMode => process.env.PI_CUSTOMIZATIONS_PERMISSIONS_MODE === "auto" ? "auto" : "default";

export default function (pi: ExtensionAPI) {
	let mode = initialMode();
	let policy: Policy | undefined;
	let policyError = "Permissions policy not loaded";
	let policyLoaded = false;
	let confirmationQueue: Promise<void> = Promise.resolve();

	function reload(): void {
		policyLoaded = true;
		try { policy = loadPolicy(); policyError = ""; }
		catch (error) {
			policy = undefined;
			policyError = error instanceof Error ? error.message : "Invalid permissions.yaml";
		}
	}

	pi.on("session_start", (_event, ctx) => {
		mode = initialMode();
		reload();
		if (ctx.mode === "tui") {
			ctx.ui.setStatus("permissions", `Perm: ${mode === "ask" ? "Always Ask" : mode === "auto" ? "Auto" : "Default"}`);
			if (!policy) ctx.ui.notify(`Permission policy unavailable: ${policyError}. All tool calls blocked.`, "error");
		}
	});

	pi.registerCommand("permissions", {
		description: "View or change tool approval mode: default, auto, ask, reload",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") return; // Noninteractive hosts choose a mode before creating sessions.
			const selected = args.trim().toLowerCase();
			if (selected === "reload") reload();
			else if (selected === "default" || selected === "auto" || selected === "ask") mode = selected;
			else if (selected) { ctx.ui.notify("Use /permissions default, auto, ask, or reload", "warning"); return; }
			ctx.ui.setStatus("permissions", `Perm: ${mode === "ask" ? "Always Ask" : mode === "auto" ? "Auto" : "Default"}`);
			ctx.ui.notify(policy ? `Permissions: ${mode}${selected === "reload" ? " (policy reloaded)" : ""}`
				: `All tool calls blocked: ${policyError}`, policy ? "info" : "error");
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		// Bare SDK sessions may execute tools without ever binding extensions and
		// emitting session_start. Load the same policy lazily rather than blocking
		// every call; missing or invalid YAML still fails closed.
		if (!policyLoaded) reload();
		if (!policy) return { block: true, reason: `Permission policy unavailable: ${policyError}` };
		const verdict = evaluate(event, policy, ctx.cwd, mode);
		if (verdict.decision === "allow") return undefined;
		if (verdict.decision === "deny") return { block: true, reason: verdict.reason };
		if (!ctx.hasUI) return { block: true, reason: `Approval required but no UI is available: ${verdict.reason}` };

		// Pi may dispatch sibling tool calls concurrently. Present one approval at a time.
		let release!: () => void;
		const next = new Promise<void>((done) => { release = done; });
		const previous = confirmationQueue;
		confirmationQueue = previous.then(() => next);
		await previous;
		try {
			if (ctx.signal?.aborted) return { block: true, reason: "Turn cancelled while awaiting approval" };
			const details = JSON.stringify(event.input, null, 2);
			if (details.length > 5000) return { block: true, reason: "Tool arguments too long to safely review" };
			const approved = await ctx.ui.confirm(
				`Approve ${event.toolName} once?`,
				`${verdict.reason}\n\n${details}\n\nDecline to block this call.`,
			);
			return approved && !ctx.signal?.aborted ? undefined : { block: true, reason: "Tool call declined or cancelled" };
		} finally { release(); }
	});
}

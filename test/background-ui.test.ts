import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import background from "../extensions/background.js";

function fixture(t: { after: (fn: () => Promise<void>) => void }) {
	const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pi-background-ui-")));
	const repo = path.join(root, "repo"); mkdirSync(repo);
	const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
	git("init", "-q"); writeFileSync(path.join(repo, "file"), "fixture"); git("add", "file"); git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Fixture");
	const worktree = path.join(root, "edit-tree"); git("worktree", "add", "-q", "-b", "worker", worktree);
	const messages: { message: any; options: any }[] = []; const notices: { text: string; severity: string }[] = [];
	const statuses: (string | undefined)[] = []; let approvals = 0; let approved = true;
	const handlers = new Map<string, (...args: any[]) => any>(); let command: any; let tool!: ToolDefinition<any>;
	const requests: { parentProject: string; worktree: string }[] = [];
	const children: (EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: (signal: string) => boolean })[] = [];
	const manager = SessionManager.inMemory(repo, { id: "parent" }); manager.appendMessage({ role: "user", content: "Main context", timestamp: 1 });
	const ctx = { mode: "tui", hasUI: true, cwd: repo, model: { provider: "fake", id: "fixture" }, sessionManager: manager,
		getSystemPrompt: () => "Parent prompt", ui: { notify: (text: string, severity: string) => notices.push({ text, severity }), setStatus: (_key: string, value: string | undefined) => statuses.push(value), confirm: async () => { approvals++; return approved; } },
	} as unknown as ExtensionCommandContext;
	background({ registerCommand: (_name: string, value: any) => { command = value.handler; }, registerTool: (value: ToolDefinition<any>) => { tool = value; }, on: (name: string, handler: any) => handlers.set(name, handler), getThinkingLevel: () => "high", sendMessage: (message: any, options: any) => messages.push({ message, options }) } as unknown as ExtensionAPI, {
		root: path.join(root, "jobs"), launch: (args) => {
			requests.push(JSON.parse(readFileSync(args[args.indexOf("--background-request") + 1], "utf8")));
			const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: (signal: string) => { queueMicrotask(() => child.emit("close", null, signal)); return true; } });
			children.push(child); return child as unknown as ChildProcess;
		},
	});
	handlers.get("session_start")!({}, ctx);
	t.after(async () => { await handlers.get("session_shutdown")!({}, ctx); rmSync(root, { recursive: true, force: true }); });
	const finish = (index: number) => {
		children[index].stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Child report" }], stopReason: "stop", usage: { cost: { total: 0 } } } }) + "\n");
		children[index].stdout.write('{"type":"agent_settled"}\n'); children[index].emit("close", 0, null);
	};
	return { ctx, repo, worktree, messages, notices, statuses, manager, children, requests, finish, command: (args: string) => command(args, ctx), execute: (args: any) => tool.execute("call", args, undefined, undefined, ctx), shutdown: () => handlers.get("session_shutdown")!({}, ctx), approvals: () => approvals, refuse: () => { approved = false; } };
}

test("slash starts return immediately and completion notifies/appends a review notice without triggering a parent turn", async (t) => {
	const ui = fixture(t);
	await ui.command(`start ${ui.repo} -- Review the implementation`);
	assert.equal(ui.children.length, 1);
	assert.match(ui.messages[0].message.content, /parent can continue immediately/);
	assert.equal(ui.messages[0].options.triggerTurn, false);
	assert.equal(ui.messages[0].options.deliverAs, undefined);
	assert.ok(ui.statuses.includes("bg: 1 running"));
	ui.finish(0);
	assert.equal(ui.notices.at(-1)?.severity, "info");
	assert.match(ui.messages.at(-1)!.message.content, /untrusted output|Report:/);
	assert.equal(ui.messages.at(-1)!.options.triggerTurn, false);
	assert.equal(ui.statuses.at(-1), undefined);
	await ui.command("list"); assert.match(ui.messages.at(-1)!.message.content, /completed/);
});

test("edit starts require a separate worktree and explicit UI approval; denied and headless starts launch nothing", async (t) => {
	const ui = fixture(t);
	await assert.rejects(ui.execute({ action: "start", worktree: ui.repo, task: "Edit", permission: "edit" }), /separate/);
	ui.refuse(); await assert.rejects(ui.execute({ action: "start", worktree: ui.worktree, task: "Edit", permission: "edit" }), /not approved/);
	assert.equal(ui.approvals(), 1); assert.equal(ui.children.length, 0);
	(ui.ctx as any).mode = "json";
	await assert.rejects(ui.execute({ action: "start", worktree: ui.repo, task: "Review" }), /long-lived/);
	assert.equal(ui.children.length, 0);
});

test("approved edits launch with inherited model/thinking, while RPC without UI cannot authorize edits", async (t) => {
	const ui = fixture(t);
	const result = await ui.execute({ action: "start", worktree: ui.worktree, task: "Implement the plan", permission: "edit" });
	assert.equal(ui.approvals(), 1);
	assert.equal(ui.children.length, 1);
	assert.match(JSON.stringify(result), /edit.*fake\/fixture \(high\)/);
	assert.equal(ui.requests[0].parentProject, ui.repo);
	assert.equal(ui.requests[0].worktree, ui.worktree);
	ui.finish(0);
	(ui.ctx as any).mode = "rpc";
	(ui.ctx as any).hasUI = false;
	await assert.rejects(ui.execute({ action: "start", worktree: ui.worktree, task: "Edit", permission: "edit" }), /user confirmation/);
	assert.equal(ui.children.length, 1);
});

test("branch changes suppress stale result injection and shutdown suppresses all old-session callbacks", async (t) => {
	const ui = fixture(t);
	await ui.command(`start ${ui.repo} -- Review`);
	ui.manager.resetLeaf(); ui.manager.appendMessage({ role: "user", content: "Different branch", timestamp: 2 });
	ui.finish(0);
	assert.equal(ui.messages.length, 1);
	assert.equal(ui.notices.length, 1);
	await ui.command(`start ${ui.repo} -- Another review`);
	const before = ui.messages.length;
	await ui.shutdown();
	assert.equal(ui.messages.length, before);
	assert.equal(ui.notices.length, 1);
	await assert.rejects(ui.execute({ action: "list" }), /unavailable/);
});

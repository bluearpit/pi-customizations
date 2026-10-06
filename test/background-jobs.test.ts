import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { BackgroundJobs } from "../extensions/background/jobs.js";
import type { JobRecord } from "../extensions/background/protocol.js";

class FakeChild extends EventEmitter {
	stdout = new PassThrough();
	stderr = new PassThrough();
	kills: string[] = [];
	kill(signal: string) { this.kills.push(signal); if (signal === "SIGKILL") queueMicrotask(() => this.emit("close", null, signal)); return true; }
	event(event: unknown) { this.stdout.write(JSON.stringify(event) + "\n"); }
	complete(code = 0) { this.emit("close", code, null); }
}
const input = () => ({ worktree: "/tmp/tree", permission: "review" as const, provider: "fake", model: "fixture", thinking: "off" as const, task: "Review", systemPrompt: "Parent instructions" });
function report(child: FakeChild, stopReason = "stop") {
	child.event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Review finished" }], stopReason, usage: { cost: { total: 0.25 } } } });
	child.event({ type: "agent_settled" });
}
function fixture(t: { after: (fn: () => Promise<void>) => void }, options: Record<string, unknown> = {}) {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-background-jobs-"));
	const children: FakeChild[] = [];
	const finished: JobRecord[] = [];
	const calls: { args: string[]; cwd: string }[] = [];
	const manager = new BackgroundJobs({ root, parentSessionId: "parent", workerExtension: "/trusted/worker.ts", killGraceMs: 5, launch: (args, cwd) => {
		calls.push({ args, cwd }); const child = new FakeChild(); children.push(child); return child as unknown as ChildProcess;
	}, onFinish: (record) => finished.push(record), ...options });
	t.after(async () => { await manager.close(); rmSync(root, { recursive: true, force: true }); });
	return { manager, children, finished, calls, root };
}

test("start returns without waiting; context/settings and explicit restricted flags reach the child", async (t) => {
	const { manager, children, calls, finished } = fixture(t);
	const job = manager.start(input(), [{ role: "user", content: "Important context", timestamp: 1 }], "/parent/session.jsonl");
	assert.equal(job.status, "running");
	assert.equal(finished.length, 0);
	assert.equal(calls[0].cwd, "/tmp/tree");
	for (const flag of ["--no-extensions", "--no-skills", "--no-context-files", "--no-approve"]) assert.ok(calls[0].args.includes(flag));
	assert.equal(calls[0].args[calls[0].args.indexOf("--model") + 1], "fake/fixture");
	assert.equal(calls[0].args[calls[0].args.indexOf("--tools") + 1], "bg_read,bg_list");
	assert.match(readFileSync(manager.paths(job.id).session, "utf8"), /Important context|parentSession/);
	children[0].event({ type: "tool_execution_start", toolName: "bg_read" });
	assert.equal(manager.get(job.id).progress, "Tool: bg_read");
	report(children[0]); children[0].complete();
	assert.equal(manager.get(job.id).status, "completed");
	assert.equal(manager.get(job.id).cost, 0.25);
	assert.match(manager.result(job.id), /Review finished/);
	assert.equal(finished.length, 1);
	children[0].emit("close", 0, null);
	assert.equal(finished.length, 1);
	const restored = new BackgroundJobs({ root: manager.directory.replace(/[/\\]parent$/, ""), parentSessionId: "parent", workerExtension: "/trusted/worker.ts" });
	assert.equal(restored.get(job.id).status, "completed");
	assert.match(restored.result(job.id), /Review finished/);
	await restored.close();
});

test("spawn failure, malformed stream, partial/error response, nonzero and missing completion all persist failures", async (t) => {
	const { manager, children } = fixture(t);
	const failures: ((child: FakeChild) => void)[] = [
		(child) => child.emit("error", new Error("spawn failed")),
		(child) => { child.stdout.write("not-json\n"); child.complete(); },
		(child) => { report(child, "error"); child.complete(); },
		(child) => { report(child); child.complete(1); },
		(child) => child.complete(),
		(child) => { child.stdout.write('{"type":'); child.complete(); },
	];
	for (const fail of failures) {
		const job = manager.start(input(), []);
		fail(children.at(-1)!);
		assert.equal(manager.get(job.id).status, "failed");
		assert.ok(manager.get(job.id).error);
		assert.equal(JSON.parse(readFileSync(manager.paths(job.id).record, "utf8")).status, "failed");
		assert.match(manager.result(job.id), /Status: failed/);
	}
});

test("tampered or missing reports fail integrity checks", async (t) => {
	const { manager, children } = fixture(t);
	const job = manager.start(input(), []);
	report(children[0]); children[0].complete();
	writeFileSync(manager.paths(job.id).result, "tampered");
	assert.throws(() => manager.result(job.id), /integrity/);
	rmSync(manager.paths(job.id).result);
	assert.throws(() => manager.result(job.id), /ENOENT/);
});

test("report write failure still persists a valid failure record", async (t) => {
	const { manager, children } = fixture(t);
	const job = manager.start(input(), []);
	mkdirSync(manager.paths(job.id).result);
	report(children[0]); children[0].complete();
	assert.equal(manager.get(job.id).status, "failed");
	assert.match(manager.get(job.id).error!, /persist worker report/);
	const stored = JSON.parse(readFileSync(manager.paths(job.id).record, "utf8"));
	assert.equal(stored.status, "failed");
	assert.ok(stored.endedAt);
});

test("synchronous launch failure preserves an inspectable attempt", async (t) => {
	const { manager } = fixture(t, { launch: () => { throw new Error("launch refused"); } });
	const job = manager.start(input(), []);
	assert.equal(job.status, "failed");
	assert.match(manager.result(job.id), /launch refused/);
});

test("cancel remains cancelling until child closes and escalates even after SIGTERM was sent", async (t) => {
	const { manager, children, finished } = fixture(t);
	const job = manager.start(input(), []);
	assert.equal(manager.cancel(job.id).status, "cancelling");
	assert.deepEqual(children[0].kills, ["SIGTERM"]);
	assert.equal(finished.length, 0);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.deepEqual(children[0].kills, ["SIGTERM", "SIGKILL"]);
	assert.equal(manager.get(job.id).status, "cancelled");
	assert.match(manager.result(job.id), /edits already made remain/);
	assert.throws(() => manager.cancel(job.id), /not running/);
});

test("session shutdown waits for cancellation without sending completion into the replacement session", async (t) => {
	const { manager, children, finished } = fixture(t);
	const job = manager.start(input(), []);
	const closed = manager.close();
	await new Promise((resolve) => setTimeout(resolve, 20));
	await closed;
	assert.equal(manager.get(job.id).status, "cancelled");
	assert.equal(finished.length, 0);
	assert.ok(children[0].kills.includes("SIGKILL"));
	assert.throws(() => manager.start(input(), []), /shutting down/);
});

test("timeout produces an explicit persisted failure", async (t) => {
	const { manager } = fixture(t, { timeoutMs: 5 });
	const job = manager.start(input(), []);
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(manager.get(job.id).status, "failed");
	assert.match(manager.get(job.id).error!, /time limit/);
});

test("concurrency cap and same-worktree writer conflict fail before another spawn", async (t) => {
	const { manager, calls } = fixture(t);
	manager.start({ ...input(), permission: "edit" }, []);
	assert.throws(() => manager.start({ ...input(), permission: "edit" }, []), /already owns/);
	for (let i = 0; i < 3; i++) manager.start(input(), []);
	assert.throws(() => manager.start(input(), []), /At most 4/);
	assert.equal(calls.length, 4);
	assert.throws(() => manager.get("missing"), /unambiguous/);
});

test("stale running records are interrupted, never silently resumed; corrupt records are rejected", async (t) => {
	const { manager, root, children } = fixture(t);
	const job = manager.start(input(), []);
	children[0].complete(1);
	const stored = JSON.parse(readFileSync(manager.paths(job.id).record, "utf8"));
	writeFileSync(manager.paths(job.id).record, JSON.stringify({ ...stored, status: "running", endedAt: undefined }));
	const restored = new BackgroundJobs({ root, parentSessionId: "parent", workerExtension: "/worker" });
	assert.equal(restored.get(job.id).status, "interrupted");
	assert.match(restored.get(job.id).error!, /not reattached/);
	await restored.close();
	for (const change of [{ schemaVersion: 2 }, { parentSessionId: "other" }, { id: "../escape" }]) {
		writeFileSync(manager.paths(job.id).record, JSON.stringify({ ...stored, ...change }));
		assert.throws(() => new BackgroundJobs({ root, parentSessionId: "parent", workerExtension: "/worker" }));
	}
});

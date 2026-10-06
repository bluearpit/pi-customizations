import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
function report(child: FakeChild, stopReason = "stop", text = "Review finished") {
	child.event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason, usage: { cost: { total: 0.25 } } } });
	child.event({ type: "agent_settled" });
}
function fixture(t: { after: (fn: () => Promise<void>) => void }, options: Record<string, unknown> = {}) {
	const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pi-background-jobs-")));
	const children: FakeChild[] = [];
	const finished: JobRecord[] = [];
	const calls: { args: string[]; cwd: string }[] = [];
	const manager = new BackgroundJobs({ root, parentSessionId: "parent", parentProject: root, workerExtension: "/trusted/worker.ts", killGraceMs: 5, launch: (args, cwd) => {
		calls.push({ args, cwd }); const child = new FakeChild(); children.push(child); return child as unknown as ChildProcess;
	}, onFinish: (record) => finished.push(record), ...options });
	t.after(async () => { await manager.close(); rmSync(root, { recursive: true, force: true }); });
	return { manager, children, finished, calls, root };
}

test("start returns without waiting; context/settings and explicit restricted flags reach the child", async (t) => {
	const { manager, children, calls, finished, root } = fixture(t);
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
	const restored = new BackgroundJobs({ root, parentSessionId: "parent", parentProject: manager.parentProject, workerExtension: "/trusted/worker.ts" });
	assert.equal(restored.get(job.id).status, "completed");
	assert.match(restored.result(job.id), /Review finished/);
	await restored.close();
});

test("identical session IDs in different projects neither expose nor interrupt each other's live jobs", async (t) => {
	const { manager, children, root } = fixture(t);
	const first = manager.start(input(), [{ role: "user", content: "Project A private context", timestamp: 1 }]);
	const initialRecord = readFileSync(manager.paths(first.id).record, "utf8");
	const projectB = path.join(root, "project-b");
	mkdirSync(projectB);
	const secondChild = new FakeChild();
	const options = { root, parentSessionId: "parent", parentProject: projectB, workerExtension: "/worker" };
	const second = new BackgroundJobs({ ...options, launch: () => secondChild as unknown as ChildProcess });
	t.after(() => second.close());
	assert.notEqual(manager.directory, second.directory);
	assert.deepEqual(second.list(), []);
	for (const operation of ["get", "result", "logs", "cancel"] as const) assert.throws(() => second[operation](first.id), /unambiguous/);
	assert.equal(readFileSync(manager.paths(first.id).record, "utf8"), initialRecord);
	assert.equal(manager.get(first.id).status, "running");
	assert.deepEqual(children[0].kills, []);

	const other = second.start({ ...input(), worktree: projectB }, [{ role: "user", content: "Project B context", timestamp: 1 }]);
	assert.doesNotMatch(readFileSync(second.paths(other.id).session, "utf8"), /Project A private context/);
	assert.equal(JSON.parse(readFileSync(second.paths(other.id).record, "utf8")).parentProject, projectB);
	report(children[0], "stop", "Project A private report"); children[0].complete();
	report(secondChild, "stop", "Project B report"); secondChild.complete();
	await second.close();
	const restored = new BackgroundJobs(options);
	assert.deepEqual(restored.list().map((record) => record.id), [other.id]);
	assert.match(restored.result(other.id), /Project B report/);
	assert.doesNotMatch(restored.result(other.id), /Project A/);
	assert.match(manager.result(first.id), /Project A private report/);
	assert.throws(() => manager.get(other.id), /unambiguous/);
	await restored.close();
});

test("project aliases recover the same namespace; invalid or missing project paths fail fast", async (t) => {
	const { manager, root, children } = fixture(t);
	const job = manager.start(input(), []);
	report(children[0]); children[0].complete();
	const alias = path.join(root, "project-alias");
	symlinkSync(root, alias, "dir");
	const options = { root, parentSessionId: "parent", parentProject: alias, workerExtension: "/worker" };
	const restored = new BackgroundJobs(options);
	assert.equal(restored.directory, manager.directory);
	assert.equal(restored.parentProject, manager.parentProject);
	assert.equal(restored.get(job.id).status, "completed");
	await restored.close();
	for (const parentProject of ["", "relative/project", path.join(root, "missing-project")]) assert.throws(() => new BackgroundJobs({ ...options, parentProject }));
});

test("legacy unscoped records are never imported or marked interrupted", async (t) => {
	const { manager, children, root } = fixture(t);
	const job = manager.start(input(), []);
	children[0].complete(1);
	const legacy = path.join(root, "parent", job.id);
	cpSync(manager.paths(job.id).directory, legacy, { recursive: true });
	const legacyFile = path.join(legacy, "job.json");
	const stored = JSON.parse(readFileSync(legacyFile, "utf8"));
	writeFileSync(legacyFile, JSON.stringify({ ...stored, schemaVersion: 1, parentProject: undefined, status: "running", endedAt: undefined }));
	const original = readFileSync(legacyFile, "utf8");
	rmSync(manager.paths(job.id).directory, { recursive: true });
	const restored = new BackgroundJobs({ root, parentSessionId: "parent", parentProject: manager.parentProject, workerExtension: "/worker" });
	assert.deepEqual(restored.list(), []);
	assert.equal(readFileSync(legacyFile, "utf8"), original);
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
	const restored = new BackgroundJobs({ root, parentSessionId: "parent", parentProject: manager.parentProject, workerExtension: "/worker" });
	assert.equal(restored.get(job.id).status, "interrupted");
	assert.match(restored.get(job.id).error!, /not reattached/);
	await restored.close();
	for (const change of [{ schemaVersion: 1 }, { schemaVersion: 999 }, { parentSessionId: "other" }, { parentProject: "/other-project" }, { parentProject: undefined }, { id: "../escape" }]) {
		writeFileSync(manager.paths(job.id).record, JSON.stringify({ ...stored, ...change }));
		assert.throws(() => new BackgroundJobs({ root, parentSessionId: "parent", parentProject: manager.parentProject, workerExtension: "/worker" }));
	}
});

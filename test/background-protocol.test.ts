import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { forkSnapshot, JsonLines, snapshotConversation, validateRecord, validateRequest, WorkerEvents, type WorkerRequest } from "../extensions/background/protocol.js";
import { parseBackgroundCommand } from "../extensions/background.js";

export const request = (): WorkerRequest => ({ schemaVersion: 1, id: randomUUID(), parentSessionId: "parent", worktree: "/tmp/worktree", permission: "review", provider: "fake", model: "fixture", thinking: "high", task: "Review this code", systemPrompt: "Parent instructions" });
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } };
export const assistant = (text = "Review report", stopReason = "stop") => ({ role: "assistant", content: [{ type: "text", text }], provider: "fake", api: "openai-completions", model: "fixture", timestamp: 3, stopReason, usage });

test("snapshot uses the active projection, preserves summaries, excludes prompt/tool declarations and unfinished batches", () => {
	const source = [
		{ role: "system", content: "Parent shell capabilities", timestamp: 1 },
		{ role: "compactionSummary", summary: "Keep the decision", tokensBefore: 100, timestamp: 2 },
		{ role: "user", content: "Task context", timestamp: 3 },
		{ ...assistant(), content: [{ type: "toolCall", id: "pending", name: "background", arguments: {} }], stopReason: "toolUse" },
	] as AgentMessage[];
	const messages = snapshotConversation(source);
	assert.equal(messages.length, 2);
	assert.match(JSON.stringify(messages), /Keep the decision/);
	assert.doesNotMatch(JSON.stringify(messages), /Parent shell capabilities|pending/);
	assert.equal(source.length, 4);
	(source[2] as { content: string }).content = "Changed parent";
	assert.doesNotMatch(JSON.stringify(messages), /Changed parent/);
});

test("snapshot round-trips into a separate session with parent link and inherited settings", () => {
	const input = request();
	const source = [{ role: "user", content: "Keep this context", timestamp: 1 }, assistant()] as AgentMessage[];
	const serialized = forkSnapshot(input, source, "/parent/session.jsonl");
	const entries = serialized.trim().split("\n").map((line) => JSON.parse(line));
	const fork = SessionManager.inMemory(input.worktree, {}, entries);
	assert.equal(fork.getHeader()?.parentSession, "/parent/session.jsonl");
	assert.equal(fork.getSessionId(), input.id);
	assert.equal(fork.getCwd(), input.worktree);
	assert.deepEqual(fork.buildSessionProjection().model, { provider: input.provider, modelId: input.model });
	assert.equal(fork.buildSessionProjection().thinkingLevel, "high");
	assert.match(JSON.stringify(fork.buildSessionProjection().messages), /Keep this context/);
	assert.equal(source.length, 2);
});

test("completed historical tool batches are retained", () => {
	const source = [{ ...assistant(), content: [{ type: "toolCall", id: "done", name: "read", arguments: {} }], stopReason: "toolUse" }, { role: "toolResult", toolCallId: "done", toolName: "read", content: [{ type: "text", text: "Evidence" }], isError: false, timestamp: 4 }] as AgentMessage[];
	assert.equal(snapshotConversation(source).length, 2);
});

test("JSON stream handles split UTF-8 and Unicode line separators, rejects malformed/truncated/oversized records", () => {
	const records: unknown[] = [];
	const decoder = new JsonLines((record) => records.push(record));
	const text = Buffer.from(JSON.stringify({ type: "text", value: "héllo\u2028world" }) + "\r\n");
	for (const byte of text) decoder.push(Buffer.from([byte]));
	decoder.end();
	assert.deepEqual(records, [{ type: "text", value: "héllo\u2028world" }]);
	assert.throws(() => new JsonLines(() => {}).push(Buffer.from("bad\n")));
	const torn = new JsonLines(() => {}); torn.push(Buffer.from("{\"type\":\"x\"}"));
	assert.throws(() => torn.end(), /Truncated/);
	assert.throws(() => new JsonLines(() => {}, 10).push(Buffer.from("{\"type\":\"long\"}\n")), /size limit/);
});

test("success needs a settled final report; partial, error, abort, missing and nonzero paths fail explicitly", () => {
	for (const stopReason of ["error", "aborted", "toolUse", "length"]) {
		const events = new WorkerEvents();
		events.accept({ type: "message_end", message: assistant("partial", stopReason) });
		events.accept({ type: "agent_settled" });
		assert.match(events.failure(0, null)!, /successfully/);
	}
	const events = new WorkerEvents();
	assert.match(events.failure(0, null)!, /agent_settled/);
	events.accept({ type: "agent_settled" });
	assert.match(events.failure(0, null)!, /no assistant/);
	events.accept({ type: "message_end", message: assistant() });
	assert.equal(events.failure(0, null), undefined);
	assert.equal(events.cost, 0.01);
	assert.match(events.failure(1, null)!, /exited/);
	assert.match(events.failure(null, "SIGTERM")!, /SIGTERM/);
	events.accept({ type: "agent_start" });
	assert.equal(events.settled, false);
	assert.throws(() => events.accept({ type: "message_end", message: { role: "assistant" } }), /Malformed/);
});

test("records reject unsupported, malformed and mismatched identities", () => {
	const input = request();
	const record = { ...input, status: "completed", startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), progress: "Done", cost: 0, resultSha256: "a".repeat(64) };
	assert.equal(validateRecord(record, input.id, input.parentSessionId).id, input.id);
	for (const [key, value] of Object.entries({ schemaVersion: 2, id: randomUUID(), parentSessionId: "other", permission: "unsafe", thinking: "invalid", cost: -1, startedAt: "not a date", status: "unknown", endedAt: undefined, resultSha256: undefined })) {
		assert.throws(() => validateRecord({ ...record, [key]: value }, input.id, input.parentSessionId), key);
	}
	assert.throws(() => validateRequest({ ...input, task: "" }), /task/);
});

test("commands require an explicit worktree, task separator, and one job ID", () => {
	assert.equal(parseBackgroundCommand(""), undefined);
	assert.deepEqual(parseBackgroundCommand('edit "/tmp/work tree" -- Build this'), { action: "start", permission: "edit", worktree: "/tmp/work tree", task: "Build this" });
	assert.equal(parseBackgroundCommand("start /tmp/tree -- Review this")?.permission, "review");
	assert.deepEqual(parseBackgroundCommand("cancel abcd"), { action: "cancel", id: "abcd" });
	for (const input of ["start", "start /tmp/tree no separator", "result", "cancel a b", "unsafe", "list extra"]) assert.throws(() => parseBackgroundCommand(input), input);
});

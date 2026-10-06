import assert from "node:assert/strict";
import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import type { Socket } from "node:net";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BackgroundJobs } from "../extensions/background/jobs.js";
import { childEnvironment } from "../extensions/background/policy.js";
import type { JobRecord } from "../extensions/background/protocol.js";

const cli = process.env.PI_BACKGROUND_TEST_CLI ?? fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url));
const extension = fileURLToPath(new URL("../extensions/background/worker.ts", import.meta.url));

test("real Pi child inherits context/model, exposes only restricted capabilities, executes a safe read and persists its report", { timeout: 30_000 }, async (t) => {
	const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pi-background-integration-")));
	const config = path.join(root, "config"); const worktree = path.join(root, "worktree");
	mkdirSync(config); mkdirSync(worktree);
	writeFileSync(path.join(worktree, "evidence.txt"), "Fixture evidence\n");
	const requests: Record<string, any>[] = [];
	let releaseOrphan!: () => void; const orphanGate = new Promise<void>((resolve) => { releaseOrphan = resolve; });
	let orphanStarted!: () => void; const orphanRequest = new Promise<void>((resolve) => { orphanStarted = resolve; });
	const server = createServer(async (req, res) => {
		let raw = ""; for await (const chunk of req) raw += chunk;
		const body = JSON.parse(raw); requests.push(body);
		if (requests.length > 2) { orphanStarted(); await orphanGate; }
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		const chunk = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: "fixture-response", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
		if (requests.length === 1) {
			chunk({ role: "assistant", tool_calls: [{ index: 0, id: "read1", type: "function", function: { name: "bg_read", arguments: JSON.stringify({ path: "evidence.txt" }) } }] });
			chunk({}, "tool_calls");
		} else {
			chunk({ role: "assistant", content: "Review report: fixture evidence verified. No changes, commands, cloud access, commits, or pushes." });
			chunk({}, "stop");
		}
		res.write("data: [DONE]\n\n"); res.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address(); assert.ok(address && typeof address === "object");
	writeFileSync(path.join(config, "models.json"), JSON.stringify({ providers: { "background-fixture": { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "local-fixture-only", models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
	let finish!: (record: JobRecord) => void;
	const completed = new Promise<JobRecord>((resolve) => { finish = resolve; });
	const manager = new BackgroundJobs({ root: path.join(root, "jobs"), parentSessionId: "parent", workerExtension: extension, onFinish: finish,
		launch: (args, cwd) => spawn(process.execPath, [cli, "--offline", ...args], { cwd, env: { ...childEnvironment(process.env), PI_CODING_AGENT_DIR: config }, stdio: ["ignore", "pipe", "pipe", "pipe"] }),
	});
	let orphanManager: BackgroundJobs | undefined;
	t.after(async () => { releaseOrphan(); await orphanManager?.close(); await manager.close(); await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); });
	const job = manager.start({ worktree, permission: "review", provider: "background-fixture", model: "fixture", thinking: "off", task: "Read evidence.txt and report", systemPrompt: "Preserve the parent design decision" }, [{ role: "compactionSummary", summary: "Archived design decision: do not push", tokensBefore: 100, timestamp: 1 }, { role: "user", content: "Inherited parent context", timestamp: 2 }]);
	assert.equal(job.status, "running");
	const record = await completed;
	assert.equal(record.status, "completed", manager.logs(job.id));
	assert.equal(requests.length, 2);
	assert.equal(requests[0].model, "fixture");
	assert.match(JSON.stringify(requests[0].messages), /Inherited parent context/);
	assert.match(JSON.stringify(requests[0].messages), /Archived design decision/);
	assert.match(JSON.stringify(requests[0].messages), /BACKGROUND WORKER CONTRACT/);
	assert.deepEqual(requests[0].tools.map((tool: any) => tool.function.name).sort(), ["bg_list", "bg_read"]);
	assert.match(JSON.stringify(requests[1].messages), /Fixture evidence/);
	assert.match(manager.result(job.id), /fixture evidence verified/);
	assert.equal(readFileSync(path.join(worktree, "evidence.txt"), "utf8"), "Fixture evidence\n");

	let orphanChild!: ChildProcess;
	let orphanDone!: (record: JobRecord) => void;
	const orphanCompletion = new Promise<JobRecord>((resolve) => { orphanDone = resolve; });
	orphanManager = new BackgroundJobs({ root: path.join(root, "jobs"), parentSessionId: "orphan-parent", workerExtension: extension, onFinish: orphanDone,
		launch: (args, cwd) => {
			orphanChild = spawn(process.execPath, [cli, "--offline", ...args], { cwd, env: { ...childEnvironment(process.env), PI_CODING_AGENT_DIR: config }, stdio: ["ignore", "pipe", "pipe", "pipe"] });
			return orphanChild;
		},
	});
	orphanManager.start({ worktree, permission: "review", provider: "background-fixture", model: "fixture", thinking: "off", task: "Review", systemPrompt: "Parent instructions" }, []);
	await orphanRequest;
	(orphanChild.stdio[3] as Socket).destroy();
	const orphanRecord = await orphanCompletion;
	assert.equal(orphanRecord.status, "failed", orphanManager.logs(orphanRecord.id));
	assert.ok(orphanRecord.error);
});

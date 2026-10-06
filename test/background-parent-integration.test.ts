import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JsonLines } from "../extensions/background/protocol.js";
import { childEnvironment } from "../extensions/background/policy.js";

function respond(res: ServerResponse, delta: unknown, reason: string): void {
	res.writeHead(200, { "Content-Type": "text/event-stream" });
	for (const [part, finish] of [[delta, null], [{}, reason]]) res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: part, finish_reason: finish }] })}\n\n`);
	res.end("data: [DONE]\n\n");
}

test("real RPC parent settles while its child is still running, then receives the report without another model turn", { timeout: 30_000 }, async (t) => {
	const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pi-background-parent-")));
	const repo = path.join(root, "repo"); const config = path.join(root, "config"); mkdirSync(repo); mkdirSync(config);
	execFileSync("git", ["-C", repo, "init", "-q"], { stdio: "pipe" });
	let releaseChild!: () => void; const childGate = new Promise<void>((resolve) => { releaseChild = resolve; });
	let parentCalls = 0; let childCalls = 0;
	const server = createServer(async (req, res) => {
		let raw = ""; for await (const chunk of req) raw += chunk;
		const body = JSON.parse(raw);
		const isChild = body.tools.some((tool: any) => tool.function.name === "bg_read");
		if (isChild) {
			childCalls++;
			assert.match(JSON.stringify(body.messages), /Parent context must survive/);
			await childGate;
			respond(res, { role: "assistant", content: "Child review report, ready for parent review." }, "stop");
		} else if (++parentCalls === 1) {
			respond(res, { role: "assistant", tool_calls: [{ index: 0, id: "background-start", type: "function", function: { name: "background", arguments: JSON.stringify({ action: "start", worktree: repo, task: "Review independently" }) } }] }, "tool_calls");
		} else respond(res, { role: "assistant", content: "Parent continued without waiting." }, "stop");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address(); assert.ok(address && typeof address === "object");
	writeFileSync(path.join(config, "models.json"), JSON.stringify({ providers: { "background-fixture": { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "fixture", models: [{ id: "fixture", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 1024 }] } } }));
	const cli = process.env.PI_BACKGROUND_TEST_CLI ?? fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url));
	const parent = spawn(process.execPath, [cli, "--offline", "--mode", "rpc", "--model", "background-fixture/fixture", "--thinking", "off", "--session-id", "parent", "--no-extensions", "--extension", fileURLToPath(new URL("../extensions/background.ts", import.meta.url)), "--no-approve"], { cwd: repo, env: { ...childEnvironment(process.env), PI_CODING_AGENT_DIR: config }, stdio: ["pipe", "pipe", "pipe"] });
	let stderr = ""; parent.stderr.on("data", (chunk) => { stderr += chunk; });
	const events: Record<string, any>[] = [];
	const waiters: { predicate: (event: Record<string, any>) => boolean; resolve: (event: Record<string, any>) => void }[] = [];
	const decoder = new JsonLines((event) => {
		events.push(event);
		for (const waiter of [...waiters]) if (waiter.predicate(event)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(event); }
	});
	parent.stdout.on("data", (chunk) => decoder.push(chunk));
	const waitFor = (predicate: (event: Record<string, any>) => boolean): Promise<Record<string, any>> => {
		const found = events.find(predicate);
		return found ? Promise.resolve(found) : new Promise((resolve) => waiters.push({ predicate, resolve }));
	};
	t.after(async () => {
		releaseChild(); parent.kill("SIGTERM");
		if (parent.exitCode === null && parent.signalCode === null) await new Promise<void>((resolve) => parent.once("close", () => resolve()));
		await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(root, { recursive: true, force: true });
	});
	parent.stdin.write(JSON.stringify({ type: "prompt", id: "prompt", message: "Parent context must survive. Delegate a review, then continue." }) + "\n");
	await waitFor((event) => event.type === "agent_settled");
	assert.equal(parentCalls, 2, stderr);
	assert.match(JSON.stringify(events), /Parent continued without waiting/);
	assert.doesNotMatch(JSON.stringify(events), /Child review report, ready/);
	releaseChild();
	const notice = await waitFor((event) => event.type === "message_end" && event.message?.role === "custom" && String(event.message.content).includes("Background worker finished"));
	assert.match(notice.message.content, /Child review report, ready for parent review/);
	assert.equal(parentCalls, 2);
	assert.equal(childCalls, 1);
	parent.stdin.write('{"type":"get_state","id":"state"}\n');
	const state = await waitFor((event) => event.type === "response" && event.id === "state");
	assert.equal(state.data.isStreaming, false);
});

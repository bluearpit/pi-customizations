import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { childEnvironment, workerToolNames } from "./policy.js";
import { forkSnapshot, isRunning, JsonLines, validateRecord, validateRequest, WorkerEvents, type JobRecord, type WorkerRequest } from "./protocol.js";

const MAX_ACTIVE = 4;
const MAX_LOG_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 30 * 60 * 1000;
const KILL_GRACE_MS = 2000;
export type Launch = (args: string[], cwd: string) => ChildProcess;
interface LiveJob {
	record: JobRecord;
	child?: ChildProcess;
	events: WorkerEvents;
	decoder: JsonLines;
	logBytes: number;
	failure?: string;
	cancelled: boolean;
	finished: boolean;
	timeout?: NodeJS.Timeout;
	killTimer?: NodeJS.Timeout;
	done: Promise<void>;
	resolveDone: () => void;
}
export interface ManagerOptions {
	root: string;
	parentSessionId: string;
	workerExtension: string;
	launch?: Launch;
	timeoutMs?: number;
	killGraceMs?: number;
	onChange?: (record: JobRecord) => void;
	onFinish?: (record: JobRecord) => void;
}

export function piInvocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/root/") && existsSync(script)) return { command: process.execPath, args: [script, ...args] };
	if (!/^(node|bun)(\.exe)?$/.test(path.basename(process.execPath).toLowerCase())) return { command: process.execPath, args };
	return { command: "pi", args };
}
export function workerArgs(request: WorkerRequest, directory: string, extension: string): string[] {
	return ["--mode", "json", "--print", "--session", path.join(directory, "session.jsonl"),
		"--model", `${request.provider}/${request.model}`, "--thinking", request.thinking,
		"--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--offline",
		"--extension", extension, "--tools", workerToolNames(request.permission).join(","),
		"--background-request", path.join(directory, "request.json"),
		"--", `Delegated background task (only this task):\n\n${request.task}`];
}
function atomicJson(file: string, value: unknown): void {
	const temporary = file + ".tmp";
	writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
	renameSync(temporary, file);
}

/** Session-owned workers are cancelled on reload/switch/exit; records remain inspectable. */
export class BackgroundJobs {
	private records = new Map<string, JobRecord>();
	private live = new Map<string, LiveJob>();
	private closing = false;
	readonly directory: string;
	constructor(private options: ManagerOptions) {
		if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(options.parentSessionId)) throw new Error("Invalid parent session ID");
		this.directory = path.join(options.root, options.parentSessionId);
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
			if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
			const file = path.join(this.directory, entry.name, "job.json");
			const record = validateRecord(JSON.parse(readFileSync(file, "utf8")), entry.name, options.parentSessionId);
			if (isRunning(record)) {
				record.status = "interrupted";
				record.error = "Previous manager stopped; workers are not reattached or automatically resumed";
				record.endedAt = new Date().toISOString();
				const resultFile = path.join(this.directory, entry.name, "result.md");
				const partial = existsSync(resultFile) ? readFileSync(resultFile, "utf8") : "No final report was persisted.";
				const report = `# Interrupted background worker\n\n${record.error}\n\n${partial}`;
				writeFileSync(resultFile, report, { mode: 0o600 });
				record.resultSha256 = createHash("sha256").update(report).digest("hex");
				atomicJson(file, record);
			}
			this.records.set(record.id, record);
		}
	}
	list(): JobRecord[] { return [...this.records.values()].map((record) => structuredClone(record)); }
	get(id: string): JobRecord {
		const matches = [...this.records.values()].filter((record) => record.id.startsWith(id));
		if (!id || matches.length !== 1) throw new Error("Specify one unambiguous background job ID");
		return structuredClone(matches[0]);
	}
	paths(id: string) {
		const directory = path.join(this.directory, id);
		return { directory, record: path.join(directory, "job.json"), events: path.join(directory, "events.jsonl"), stderr: path.join(directory, "stderr.log"), result: path.join(directory, "result.md"), session: path.join(directory, "session.jsonl") };
	}
	start(input: Omit<WorkerRequest, "schemaVersion" | "id" | "parentSessionId">, messages: AgentMessage[], parentSession?: string): JobRecord {
		if (this.closing) throw new Error("Background manager is shutting down");
		if (this.live.size >= MAX_ACTIVE) throw new Error(`At most ${MAX_ACTIVE} workers can run at once`);
		if (input.permission === "edit" && [...this.live.values()].some((job) => job.record.permission === "edit" && job.record.worktree === input.worktree)) throw new Error("An edit worker already owns this worktree");
		const request = validateRequest({ ...input, schemaVersion: 1, id: randomUUID(), parentSessionId: this.options.parentSessionId });
		const record: JobRecord = { ...request, status: "running", startedAt: new Date().toISOString(), progress: "Starting", cost: 0 };
		delete (record as Partial<WorkerRequest>).systemPrompt;
		const files = this.paths(record.id);
		mkdirSync(files.directory, { mode: 0o700 });
		// Publish the initial failure-readable record before snapshotting or launching.
		atomicJson(files.record, record);
		this.records.set(record.id, record);
		const events = new WorkerEvents();
		let resolveDone!: () => void;
		const done = new Promise<void>((resolve) => { resolveDone = resolve; });
		const job: LiveJob = { record, events, logBytes: 0, cancelled: false, finished: false, decoder: new JsonLines((event) => {
			events.accept(event);
			record.progress = events.progress;
			record.cost = events.cost;
			if (!this.closing) this.options.onChange?.(structuredClone(record));
		}), done, resolveDone };
		this.live.set(record.id, job);
		try {
			atomicJson(path.join(files.directory, "request.json"), request);
			writeFileSync(files.session, forkSnapshot(request, messages, parentSession), { mode: 0o600 });
			writeFileSync(files.events, "", { mode: 0o600 });
			writeFileSync(files.stderr, "", { mode: 0o600 });
			const args = workerArgs(request, files.directory, this.options.workerExtension);
			const child = (this.options.launch ?? ((args, cwd) => {
				const invocation = piInvocation(args);
				return spawn(invocation.command, invocation.args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe", "pipe"], env: childEnvironment(process.env) });
			}))(args, request.worktree);
			job.child = child;
			const consume = (chunk: Buffer, file: string, decode: boolean) => {
				if (job.finished || job.failure) return;
				try {
					job.logBytes += chunk.length;
					if (job.logBytes > MAX_LOG_BYTES) throw new Error("Worker log exceeded 20 MiB; stopped to bound disk usage");
					appendFileSync(file, chunk);
					if (decode) job.decoder.push(chunk);
				} catch (error) { this.fail(job, error); }
			};
			child.stdout?.on("data", (chunk: Buffer) => consume(chunk, files.events, true));
			child.stderr?.on("data", (chunk: Buffer) => consume(chunk, files.stderr, false));
			child.once("error", (error) => { job.failure = error.message; this.finish(job, null, null); });
			child.once("close", (code, signal) => this.finish(job, code, signal));
			job.timeout = setTimeout(() => this.fail(job, new Error("Worker exceeded its 30-minute time limit")), this.options.timeoutMs ?? TIMEOUT_MS);
			job.timeout.unref();
		} catch (error) {
			job.failure = error instanceof Error ? error.message : String(error);
			this.finish(job, null, null);
		}
		return structuredClone(record);
	}
	private fail(job: LiveJob, error: unknown): void {
		if (job.finished) return;
		job.failure = error instanceof Error ? error.message : String(error);
		this.stop(job);
	}
	private stop(job: LiveJob): void {
		if (!job.child) return;
		job.child.kill("SIGTERM");
		if (!job.killTimer) {
			job.killTimer = setTimeout(() => { if (!job.finished) job.child?.kill("SIGKILL"); }, this.options.killGraceMs ?? KILL_GRACE_MS);
			job.killTimer.unref();
		}
	}
	private finish(job: LiveJob, code: number | null, signal: string | null): void {
		if (job.finished) return;
		job.finished = true;
		clearTimeout(job.timeout);
		clearTimeout(job.killTimer);
		try { job.decoder.end(); } catch (error) { job.failure ??= error instanceof Error ? error.message : String(error); }
		const record = job.record;
		record.error = job.failure ?? job.events.failure(code, signal);
		record.status = job.cancelled ? "cancelled" : record.error ? "failed" : "completed";
		if (job.cancelled) record.error = "Cancelled; any worktree edits already made remain for review";
		record.endedAt = new Date().toISOString();
		record.cost = job.events.cost;
		record.progress = record.error || "Finished; awaiting parent review";
		try {
			const result = `# Background worker ${record.id}\n\nStatus: ${record.status}\nWorktree: ${record.worktree}\nPermission: ${record.permission}\n${record.error ? `Error: ${record.error}\n` : ""}\n${job.events.finalText || "No assistant report was produced. Inspect stderr.log and events.jsonl."}\n`;
			writeFileSync(this.paths(record.id).result, result, { mode: 0o600 });
			record.resultSha256 = createHash("sha256").update(result).digest("hex");
		} catch (error) {
			record.status = "failed";
			record.error = `Cannot persist worker report: ${error instanceof Error ? error.message : String(error)}`;
		}
		try { atomicJson(this.paths(record.id).record, record); } catch (error) {
			record.status = "failed";
			record.error = `Cannot persist worker outcome: ${error instanceof Error ? error.message : String(error)}`;
			// The initial running record survives and is marked interrupted on recovery.
		}
		this.live.delete(record.id);
		job.resolveDone();
		if (!this.closing) this.options.onFinish?.(structuredClone(record));
	}
	cancel(id: string): JobRecord {
		const record = this.get(id);
		const job = this.live.get(record.id);
		if (!job) throw new Error("Job is not running");
		job.cancelled = true;
		job.record.status = "cancelling";
		job.record.progress = "Cancelling";
		try { atomicJson(this.paths(record.id).record, job.record); } finally { this.stop(job); }
		return structuredClone(job.record);
	}
	result(id: string): string {
		const record = this.get(id);
		if (isRunning(record)) throw new Error("Worker is still running; use status or logs");
		const text = readFileSync(this.paths(record.id).result, "utf8");
		if (!record.resultSha256 || createHash("sha256").update(text).digest("hex") !== record.resultSha256) throw new Error("Worker report integrity check failed; inspect logs instead");
		return text;
	}
	logs(id: string): string {
		const files = this.paths(this.get(id).id);
		const tail = (file: string) => existsSync(file) ? readFileSync(file).subarray(-32 * 1024).toString("utf8") : "(not created)";
		return `Events: ${files.events}\n${tail(files.events)}\n\nStderr: ${files.stderr}\n${tail(files.stderr)}`;
	}
	async close(): Promise<void> {
		this.closing = true;
		const jobs = [...this.live.values()];
		for (const job of jobs) {
			job.cancelled = true;
			this.stop(job);
			job.killTimer?.ref();
		}
		await Promise.all(jobs.map((job) => job.done));
	}
}

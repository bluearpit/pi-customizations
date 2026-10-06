import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";

export const SCHEMA_VERSION = 1;
export const MAX_RESULT_BYTES = 256 * 1024;
export type Permission = "review" | "edit";
export type JobStatus = "running" | "cancelling" | "completed" | "failed" | "cancelled" | "interrupted";
export interface WorkerRequest {
	schemaVersion: 1;
	id: string;
	parentSessionId: string;
	worktree: string;
	permission: Permission;
	provider: string;
	model: string;
	thinking: ThinkingLevel;
	task: string;
	systemPrompt: string;
}
export interface JobRecord extends Omit<WorkerRequest, "systemPrompt"> {
	status: JobStatus;
	startedAt: string;
	endedAt?: string;
	progress: string;
	error?: string;
	cost: number;
	resultSha256?: string;
}
export const isRunning = (record: JobRecord) => record.status === "running" || record.status === "cancelling";

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
	return value as Record<string, unknown>;
}
export function validateRequest(value: unknown): WorkerRequest {
	const data = object(value);
	if (data.schemaVersion !== SCHEMA_VERSION) throw new Error("Unsupported background schema version");
	for (const key of ["id", "parentSessionId", "worktree", "provider", "model", "task", "systemPrompt"]) {
		if (typeof data[key] !== "string" || !(data[key] as string).trim()) throw new Error(`Invalid ${key}`);
	}
	if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(data.id as string)) throw new Error("Invalid job ID");
	if (!path.isAbsolute(data.worktree as string)) throw new Error("Worktree must be absolute");
	if ((data.task as string).length > 16_384) throw new Error("Task exceeds 16 KiB");
	if (data.permission !== "review" && data.permission !== "edit") throw new Error("Invalid permission");
	if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(data.thinking))) throw new Error("Invalid thinking level");
	return data as unknown as WorkerRequest;
}
export function validateRecord(value: unknown, id: string, parentSessionId: string): JobRecord {
	const data = object(value);
	validateRequest({ ...data, systemPrompt: "stored separately" });
	if (data.id !== id || data.parentSessionId !== parentSessionId) throw new Error("Background record belongs to another job/session");
	if (!["running", "cancelling", "completed", "failed", "cancelled", "interrupted"].includes(String(data.status))) throw new Error("Invalid job status");
	if (typeof data.startedAt !== "string" || !Number.isFinite(Date.parse(data.startedAt))) throw new Error("Invalid start time");
	if (typeof data.progress !== "string" || typeof data.cost !== "number" || !Number.isFinite(data.cost) || data.cost < 0) throw new Error("Invalid job progress/usage");
	if (data.error !== undefined && typeof data.error !== "string") throw new Error("Invalid job error");
	if (data.endedAt !== undefined && (typeof data.endedAt !== "string" || !Number.isFinite(Date.parse(data.endedAt)))) throw new Error("Invalid end time");
	if (!["running", "cancelling"].includes(String(data.status)) && !data.endedAt) throw new Error("Terminal job has no end time");
	if (data.resultSha256 !== undefined && (typeof data.resultSha256 !== "string" || !/^[a-f0-9]{64}$/.test(data.resultSha256))) throw new Error("Invalid result integrity field");
	if (data.status === "completed" && (!data.resultSha256 || data.error)) throw new Error("Completed job has no integrity field or contains an error");
	return data as unknown as JobRecord;
}

/** Snapshot the finalized active projection, omitting an unfinished tool batch at dispatch. */
export function snapshotConversation(messages: AgentMessage[]): AgentMessage[] {
	const turns = convertToLlm(messages.filter((message) => message.role !== "system"));
	for (let i = 0; i < turns.length; i++) {
		const turn = turns[i];
		if (turn.role !== "assistant") continue;
		const calls = turn.content.filter((part) => part.type === "toolCall");
		if (!calls.length) continue;
		const results = new Set<string>();
		for (let j = i + 1; j < turns.length && turns[j].role === "toolResult"; j++) {
			const result = turns[j];
			if (result.role === "toolResult") results.add(result.toolCallId);
		}
		if (calls.some((call) => !results.has(call.id))) return structuredClone(turns.slice(0, i));
	}
	return structuredClone(turns);
}

export function forkSnapshot(request: WorkerRequest, messages: AgentMessage[], parentSession?: string): string {
	const manager = SessionManager.inMemory(request.worktree, { id: request.id, parentSession });
	manager.appendModelChange(request.provider, request.model);
	manager.appendThinkingLevelChange(request.thinking);
	for (const message of snapshotConversation(messages)) {
		if (message.role === "system" || message.role === "user" || message.role === "assistant" || message.role === "toolResult") manager.appendMessage(message);
	}
	return [manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

/** Decode LF-framed JSON, preserving UTF-8 split across pipe chunks. */
export class JsonLines {
	private decoder = new StringDecoder("utf8");
	private buffer = "";
	constructor(private onRecord: (record: Record<string, unknown>) => void, private maxBytes = 8 * 1024 * 1024) {}
	push(chunk: Buffer): void { this.consume(this.decoder.write(chunk)); }
	end(): void {
		this.consume(this.decoder.end());
		if (this.buffer.trim()) throw new Error("Truncated worker event stream");
	}
	private consume(text: string): void {
		this.buffer += text;
		let newline: number;
		while ((newline = this.buffer.indexOf("\n")) !== -1) {
			const line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (Buffer.byteLength(line) > this.maxBytes) throw new Error("Worker event exceeds size limit");
			if (line.trim()) this.onRecord(object(JSON.parse(line)));
		}
		if (Buffer.byteLength(this.buffer) > this.maxBytes) throw new Error("Worker event exceeds size limit");
	}
}

export class WorkerEvents {
	settled = false;
	finalText = "";
	stopReason?: string;
	error?: string;
	progress = "Starting";
	cost = 0;
	accept(event: Record<string, unknown>): void {
		if (typeof event.type !== "string") throw new Error("Worker event has no type");
		if (event.type === "agent_start") this.settled = false;
		if (event.type === "agent_settled") this.settled = true;
		if (event.type === "tool_execution_start") this.progress = `Tool: ${String(event.toolName).slice(0, 100)}`;
		if (event.type === "message_update") {
			const update = object(event.assistantMessageEvent);
			if (update.type === "text_delta" && typeof update.delta === "string") this.progress = update.delta.slice(-120).replace(/\s+/g, " ");
		}
		if (event.type !== "message_end") return;
		const message = object(event.message);
		if (message.role !== "assistant") return;
		if (!Array.isArray(message.content) || typeof message.stopReason !== "string") throw new Error("Malformed worker assistant message");
		this.finalText = message.content.map((part: unknown) => {
			const block = object(part);
			return block.type === "text" && typeof block.text === "string" ? block.text : "";
		}).filter(Boolean).join("\n");
		if (Buffer.byteLength(this.finalText) > MAX_RESULT_BYTES) throw new Error("Worker result exceeds size limit; see event log");
		this.stopReason = message.stopReason;
		this.error = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
		const usage = object(message.usage);
		const cost = object(usage.cost).total;
		if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) throw new Error("Malformed worker usage");
		this.cost += cost;
	}
	failure(exitCode: number | null, signal: string | null): string | undefined {
		if (signal || exitCode !== 0) return this.error || `Worker exited with ${signal || exitCode}`;
		if (!this.settled) return "Worker exited before agent_settled";
		if (this.stopReason !== "stop") return this.error || `Worker did not finish successfully (${this.stopReason || "no assistant response"})`;
		if (!this.finalText.trim()) return "Worker returned no review report";
		return undefined;
	}
}

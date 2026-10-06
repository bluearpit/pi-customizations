import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { defineTool, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Permission } from "./protocol.js";

const exec = promisify(execFile);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_READ_CHARS = 64 * 1024;
const protectedName = /^(?:\.git|\.pi|\.aws|\.ssh|\.gnupg|\.env(?:\..*)?|auth\.json|credentials(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/i;
export const workerToolNames = (permission: Permission) => permission === "edit" ? ["bg_read", "bg_list", "bg_edit", "bg_write"] : ["bg_read", "bg_list"];

export function childEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const allowed = ["HOME", "PATH", "LANG", "LC_ALL", "TMPDIR", "SYSTEMROOT", "WINDIR", "PI_CODING_AGENT_DIR",
		"ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY", "XAI_API_KEY", "OPENROUTER_API_KEY", "MISTRAL_API_KEY"];
	return Object.fromEntries(allowed.filter((key) => env[key] !== undefined).map((key) => [key, env[key]]));
}

export async function validateWorktree(cwd: string, selected: string, permission: Permission): Promise<string> {
	const root = await realpath(path.resolve(cwd, selected));
	const git = async (directory: string, args: string[]) => (await exec("git", ["-C", directory, ...args], { env: childEnvironment(process.env), timeout: 10_000 })).stdout.trim();
	const parentRoot = await realpath(await git(cwd, ["rev-parse", "--show-toplevel"]));
	const targetRoot = await realpath(await git(root, ["rev-parse", "--show-toplevel"]));
	if (targetRoot !== root) throw new Error("Select the worktree root, not a subdirectory");
	const commonDir = async (directory: string) => realpath(path.resolve(directory, await git(directory, ["rev-parse", "--git-common-dir"])));
	if (await commonDir(cwd) !== await commonDir(root)) throw new Error("Worktree must belong to the parent's repository");
	const listed = await git(cwd, ["worktree", "list", "--porcelain", "-z"]);
	if (!listed.split("\0").includes(`worktree ${root}`)) throw new Error("Target is not a registered Git worktree");
	if (permission === "edit") {
		if (root === parentRoot) throw new Error("Edit workers require a separate worktree from the parent");
		if (await git(root, ["status", "--porcelain"])) throw new Error("Edit workers require a clean worktree");
	}
	return root;
}

/** Model-facing filesystem capabilities; no command execution or network tools are exposed. */
export class WorktreeFiles {
	constructor(readonly root: string, readonly permission: Permission) {}
	private async resolve(input: string, allowMissing = false): Promise<string> {
		if (!input || input.includes("\0")) throw new Error("Invalid path");
		const target = path.resolve(this.root, input);
		const relative = path.relative(this.root, target);
		if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("Path is outside the worktree");
		const parts = relative ? relative.split(path.sep) : [];
		if (parts.some((part) => protectedName.test(part))) throw new Error("Protected metadata/credential path");
		if (await realpath(this.root) !== this.root) throw new Error("Worktree root changed");
		let current = this.root;
		for (const part of parts) {
			current = path.join(current, part);
			try {
				const stat = await lstat(current);
				if (stat.isSymbolicLink()) throw new Error("Symlinks are not accessible to workers");
				if (!stat.isFile() && !stat.isDirectory()) throw new Error("Special files are not accessible to workers");
				if (stat.isFile() && stat.nlink > 1) throw new Error("Hard-linked files are not accessible to workers");
			} catch (error) {
				if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
		}
		return target;
	}
	async read(input: string, offset = 1, limit = 200): Promise<string> {
		if (!Number.isInteger(offset) || offset < 1 || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid line range");
		const target = await this.resolve(input);
		const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const stat = await file.stat();
			if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES) throw new Error("Read requires a regular, single-link file of at most 1 MiB");
			const text = await file.readFile("utf8");
			if (text.includes("\0")) throw new Error("Binary files are not supported");
			const lines = text.split("\n");
			return lines.slice(offset - 1, offset - 1 + limit).map((line, i) => `${offset + i}: ${line}`).join("\n").slice(0, MAX_READ_CHARS) + `\n[${lines.length} total lines; read with offset to continue]`;
		} finally { await file.close(); }
	}
	async list(input: string): Promise<string> {
		const target = await this.resolve(input);
		const entries = await readdir(target, { withFileTypes: true });
		return entries.filter((entry) => !protectedName.test(entry.name) && !entry.isSymbolicLink()).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 500).map((entry) => entry.name + (entry.isDirectory() ? "/" : "")).join("\n");
	}
	private assertWritable(): void {
		if (this.permission !== "edit") throw new Error("Review workers cannot write files");
	}
	private async writeAt(target: string, content: string): Promise<void> {
		if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error("Writes are limited to 1 MiB");
		await mkdir(path.dirname(target), { recursive: true });
		await this.resolve(target, true);
		let mode = 0o644;
		try {
			const stat = await lstat(target);
			if (!stat.isFile() || stat.nlink !== 1) throw new Error("Write requires a regular, single-link file");
			mode = stat.mode & 0o777;
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		const temporary = path.join(path.dirname(target), `.background-${randomUUID()}.tmp`);
		const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
		try {
			await file.writeFile(content, "utf8");
			await file.sync();
			await this.resolve(target, true);
			await rename(temporary, target);
		} finally { await file.close(); await rm(temporary, { force: true }); }
	}
	async write(input: string, content: string): Promise<void> {
		this.assertWritable();
		const target = await this.resolve(input, true);
		await withFileMutationQueue(target, () => this.writeAt(target, content));
	}
	async edit(input: string, oldText: string, newText: string): Promise<void> {
		this.assertWritable();
		if (!oldText) throw new Error("oldText must not be empty");
		const target = await this.resolve(input);
		await withFileMutationQueue(target, async () => {
			await this.resolve(target);
			const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
			let text: string;
			try {
				const stat = await file.stat();
				if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES) throw new Error("Invalid edit target");
				text = await file.readFile("utf8");
			} finally { await file.close(); }
			if (text.includes("\0")) throw new Error("Binary files are not supported");
			const first = text.indexOf(oldText);
			if (first < 0 || text.indexOf(oldText, first + 1) !== -1) throw new Error("oldText must match exactly once");
			await this.writeAt(target, text.slice(0, first) + newText + text.slice(first + oldText.length));
		});
	}
}

export function restrictedTools(files: WorktreeFiles) {
	const result = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });
	const tools = [
		defineTool({ name: "bg_read", label: "Read worktree file", description: "Read a worktree text file with numbered lines. Cannot access symlinks, secrets, or paths outside the worktree.", parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })) }), execute: async (_id, args) => result(await files.read(args.path, args.offset, args.limit)) }),
		defineTool({ name: "bg_list", label: "List worktree", description: "List one directory inside the worktree. Use this and bg_read to explore code; there is no shell.", parameters: Type.Object({ path: Type.String() }), execute: async (_id, args) => result(await files.list(args.path)) }),
	];
	if (files.permission === "edit") tools.push(
		defineTool({ name: "bg_edit", label: "Edit worktree file", description: "Replace one unique exact match in a worktree text file. No changes to Git metadata or credential files.", parameters: Type.Object({ path: Type.String(), oldText: Type.String(), newText: Type.String() }), executionMode: "sequential", execute: async (_id, args) => { await files.edit(args.path, args.oldText, args.newText); return result("Edited " + args.path); } }),
		defineTool({ name: "bg_write", label: "Write worktree file", description: "Create or rewrite a text file inside the worktree. No changes to Git metadata or credential files.", parameters: Type.Object({ path: Type.String(), content: Type.String() }), executionMode: "sequential", execute: async (_id, args) => { await files.write(args.path, args.content); return result("Wrote " + args.path); } }),
	);
	return tools;
}

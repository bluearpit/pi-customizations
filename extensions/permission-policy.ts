import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";

export type PermissionMode = "default" | "auto" | "ask";
export type Decision = "allow" | "deny" | "ask";
export interface Policy {
	allowShell: string[];
	denyShell: string[];
	allowFetch: string[];
	workspaceWrite: boolean;
	externalWrite: string[];
}
export interface ProposedTool {
	toolName: string;
	input: Record<string, unknown>;
}
export interface Verdict { decision: Decision; reason: string }

export const policyFile = () => join(homedir(), ".agents", "permissions.yaml");
const list = (value: unknown, name: string): string[] => {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
		throw new Error(`${name} must be a list of non-empty strings`);
	}
	return value.map((item: string) => item.trim());
};

export function loadPolicy(file = policyFile()): Policy {
	if (!existsSync(file)) throw new Error(`Missing ${file}; run agentrecall permissions init --apply`);
	const parsed: unknown = parse(readFileSync(file, "utf8"), { uniqueKeys: true });
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("permissions.yaml must be a mapping");
	const data = parsed as Record<string, unknown>;
	if (data.workspace_write !== undefined && typeof data.workspace_write !== "boolean") throw new Error("workspace_write must be a boolean");
	return {
		allowShell: list(data.allow_shell, "allow_shell"),
		denyShell: list(data.deny_shell, "deny_shell"),
		allowFetch: list(data.allow_fetch, "allow_fetch"),
		workspaceWrite: data.workspace_write === undefined ? true : data.workspace_write,
		externalWrite: list(data.external_write, "external_write"),
	};
}

function shellPrefix(command: string, prefix: string): boolean {
	const tokens = prefix.trim().split(/\s+/).map((token) => token.replace(/^['"]|['"]$/g, ""));
	if (!tokens.length || !tokens[0]) return false;
	const pattern = tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
	return new RegExp(`^\\s*${pattern}(?=\\s|$)`, "i").test(command);
}

/** Deliberately over-matches denials in compound commands; shell text is not a security boundary. */
export function deniedShell(command: string, prefixes: string[]): boolean {
	// Shell quote fragments and escapes can disguise a visible denied command.
	// Normalize them for denial only; false positives are safer than missed denies.
	const normalized = command.replace(/['"\\]/g, "");
	return prefixes.some((prefix) => {
		const tokens = prefix.trim().split(/\s+/);
		if (!tokens[0]) return false;
		const pattern = tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
		return new RegExp(`(?:^|[^\\w-])${pattern}(?=\\s|[;&|)\\n]|$)`, "i").test(normalized);
	});
}

const shellOperators = /[;&|<>\n\r`$\\]/;
function simpleAllowedShell(command: string, prefixes: string[]): boolean {
	// Never auto-approve a compound command, expansion, redirect or escaped shell syntax.
	return !shellOperators.test(command) && prefixes.some((prefix) => shellPrefix(command, prefix));
}

function expandPath(path: string, cwd: string): string {
	const expanded = path === "~" ? homedir() : path.startsWith(`~${sep}`) ? join(homedir(), path.slice(2)) : path;
	return resolve(isAbsolute(expanded) ? expanded : resolve(cwd, expanded));
}

/** Resolve existing symlinks in the target or its nearest existing ancestor. */
function actualPath(path: string): string {
	let parent = path;
	while (dirname(parent) !== parent) {
		try { lstatSync(parent); break; }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			parent = dirname(parent);
		}
	}
	return resolve(realpathSync(parent), relative(parent, path));
}

function within(path: string, root: string): boolean {
	const diff = relative(root, path);
	return diff === "" || (diff !== ".." && !diff.startsWith(`..${sep}`) && !isAbsolute(diff));
}

function filePath(input: Record<string, unknown>, cwd: string, optional = false): string | undefined {
	const raw = input.path;
	if (raw === undefined && optional) return actualPath(cwd);
	if (typeof raw !== "string" || !raw.trim()) return undefined;
	try { return actualPath(expandPath(raw, cwd)); } catch { return undefined; }
}

export function evaluate(tool: ProposedTool, policy: Policy, cwd: string, mode: PermissionMode, file = policyFile()): Verdict {
	const name = tool.toolName;
	const command = tool.input.command;
	if ((name === "bash" || name === "powershell") && typeof command === "string" && deniedShell(command, policy.denyShell)) {
		return mode === "ask" ? { decision: "ask", reason: "Explicitly denied shell command" }
			: { decision: "deny", reason: "Explicitly denied by permissions.yaml" };
	}
	if (name === "edit" || name === "write") {
		const path = filePath(tool.input, cwd);
		// A model must not rewrite the policy it is being evaluated against.
		if (path && path === actualPath(file)) {
			return mode === "ask" ? { decision: "ask", reason: "Permission policy file" }
				: { decision: "deny", reason: "Permission policy file is protected" };
		}
	}
	if (mode === "auto") return { decision: "allow", reason: "Auto mode" };
	if (mode === "ask") return { decision: "ask", reason: "Always Ask mode" };
	if (name === "bash" || name === "powershell") {
		return typeof command === "string" && simpleAllowedShell(command, policy.allowShell)
			? { decision: "allow", reason: "Allowed shell prefix" } : { decision: "ask", reason: "Unlisted shell command" };
	}
	if (name === "read" || name === "grep" || name === "find" || name === "ls") {
		const path = filePath(tool.input, cwd, name !== "read");
		return path && within(path, actualPath(cwd)) ? { decision: "allow", reason: "Workspace read" }
			: { decision: "ask", reason: "Read outside workspace or unknown path" };
	}
	if (name === "edit" || name === "write") {
		const path = filePath(tool.input, cwd);
		const roots = policy.externalWrite.map((root) => actualPath(expandPath(root, cwd)));
		return path && ((policy.workspaceWrite && within(path, actualPath(cwd))) || roots.some((root) => within(path, root)))
			? { decision: "allow", reason: "Writable root" } : { decision: "ask", reason: "Write outside allowed roots" };
	}
	if ((name === "webfetch" || name === "web_fetch") && typeof tool.input.url === "string") {
		try {
			const hostname = new URL(tool.input.url).hostname.toLowerCase();
			if (policy.allowFetch.some((raw) => {
				const host = raw.replace(/^https?:\/\//i, "").split("/")[0]!.toLowerCase();
				return hostname === host || hostname.endsWith(`.${host}`);
			})) return { decision: "allow", reason: "Allowed fetch host" };
		} catch { /* Ask about malformed URLs rather than assuming they are safe. */ }
	}
	return { decision: "ask", reason: "Unlisted tool" };
}

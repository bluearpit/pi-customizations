import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile, readFile, symlink, link, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { childEnvironment, restrictedTools, validateWorktree, workerToolNames, WorktreeFiles } from "../extensions/background/policy.js";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
	const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-background-policy-")));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const root = path.join(directory, "worktree");
	await mkdir(root);
	await writeFile(path.join(root, "source.txt"), "one\ntwo\nthree\n");
	return { directory, root };
}

test("review capabilities allow local reads/lists, reject edits and expose no shell/network tools", async (t) => {
	const { root } = await fixture(t);
	const files = new WorktreeFiles(root, "review");
	assert.match(await files.read("source.txt", 2, 1), /^2: two/);
	assert.match(await files.list("."), /source.txt/);
	await assert.rejects(files.write("source.txt", "bad"), /cannot write/);
	await assert.rejects(files.edit("source.txt", "one", "bad"), /cannot write/);
	assert.deepEqual(restrictedTools(files).map((tool) => tool.name), workerToolNames("review"));
	assert.doesNotMatch(workerToolNames("edit").join(), /bash|cloud|fetch|exec/);
});

test("edit capabilities create and precisely change files; ambiguous edits leave content unchanged", async (t) => {
	const { root } = await fixture(t);
	const files = new WorktreeFiles(root, "edit");
	await files.write("new/child.txt", "created");
	await files.edit("source.txt", "two", "changed");
	assert.equal(await readFile(path.join(root, "new/child.txt"), "utf8"), "created");
	assert.match(await readFile(path.join(root, "source.txt"), "utf8"), /changed/);
	await files.write("repeat.txt", "same same");
	for (const oldText of ["same", "missing", ""]) await assert.rejects(files.edit("repeat.txt", oldText, "bad"));
	assert.equal(await readFile(path.join(root, "repeat.txt"), "utf8"), "same same");
	await assert.rejects(files.write("too-big", "a".repeat(1024 * 1024 + 1)), /limited/);
	await assert.rejects(files.read("source.txt", 0), /Invalid/);
});

test("traversal, absolute escapes, metadata/secrets, symlinks and hardlinks are denied on reads and writes", async (t) => {
	const { root, directory } = await fixture(t);
	const files = new WorktreeFiles(root, "edit");
	const outside = path.join(directory, "outside.txt");
	await writeFile(outside, "secret");
	await symlink(outside, path.join(root, "file-link"));
	await symlink(directory, path.join(root, "dir-link"));
	await link(outside, path.join(root, "hard-link"));
	for (const input of ["../outside.txt", outside, ".git/config", ".pi/settings.json", ".env", ".env.production", "credentials", "private.pem", "file-link", "dir-link/outside.txt", "dir-link/new/file", "hard-link"]) {
		await assert.rejects(files.read(input), `read ${input}`);
		await assert.rejects(files.write(input, "bad"), `write ${input}`);
	}
	assert.equal(await readFile(outside, "utf8"), "secret");
	assert.doesNotMatch(await files.list("."), /file-link|dir-link/);
});

test("environment strips production and executable injection credentials while retaining model authentication", () => {
	const env = childEnvironment({ HOME: "/home/pi", PATH: "/usr/bin", ANTHROPIC_API_KEY: "model-key", AWS_PROFILE: "prod", AWS_ACCESS_KEY_ID: "prod-key", DATABASE_URL: "prod", GH_TOKEN: "write", NODE_OPTIONS: "--require injection", NODE_PATH: "/evil", LD_PRELOAD: "evil", PI_SESSION_FILE: "/parent" });
	assert.deepEqual(env, { HOME: "/home/pi", PATH: "/usr/bin", ANTHROPIC_API_KEY: "model-key" });
});

test("worktree validation requires a registered root in the same repo; edits need a clean separate worktree", async (t) => {
	const { root, directory } = await fixture(t);
	const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
	git(root, "init", "-q");
	git(root, "add", "source.txt");
	git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Fixture");
	const other = path.join(directory, "other");
	git(root, "worktree", "add", "-q", "-b", "worker", other);
	assert.equal(await validateWorktree(root, root, "review"), root);
	assert.equal(await validateWorktree(root, other, "edit"), other);
	await assert.rejects(validateWorktree(root, root, "edit"), /separate/);
	await mkdir(path.join(other, "subdir"));
	await assert.rejects(validateWorktree(root, path.join(other, "subdir"), "review"), /root/);
	await writeFile(path.join(other, "dirty"), "untracked");
	await assert.rejects(validateWorktree(root, other, "edit"), /clean/);
	const unrelated = path.join(directory, "unrelated");
	await mkdir(unrelated); git(unrelated, "init", "-q");
	await assert.rejects(validateWorktree(root, unrelated, "review"), /parent's repository/);
});

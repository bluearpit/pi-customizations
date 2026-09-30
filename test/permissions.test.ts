import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import permissionsExtension from "../extensions/permissions.js";
import { evaluate, loadPolicy, type PermissionMode, type ProposedTool } from "../extensions/permission-policy.js";

const shell = (command: string): ProposedTool => ({ toolName: "bash", input: { command } });
const tool = (toolName: string, path: string): ProposedTool => ({ toolName, input: { path } });

function fixture(run: (paths: { home: string; cwd: string; outside: string }) => void | Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "pi-permissions-"));
  const oldHome = process.env.HOME;
  const oldMode = process.env.PI_CUSTOMIZATIONS_PERMISSIONS_MODE;
  process.env.HOME = home;
  const cwd = join(home, "project");
  const outside = join(home, "private");
  mkdirSync(join(home, ".agents"));
  mkdirSync(cwd);
  mkdirSync(outside);
  writeFileSync(join(home, ".agents", "permissions.yaml"), `allow_shell:\n  - git status\n  - git diff\n  - agentrecall\ndeny_shell:\n  - git push -f\n  - git push --force\nallow_fetch:\n  - github.com\nworkspace_write: true\nexternal_write:\n  - ${outside}\n`);
  return Promise.resolve().then(() => run({ home, cwd, outside })).finally(() => {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldMode === undefined) delete process.env.PI_CUSTOMIZATIONS_PERMISSIONS_MODE;
    else process.env.PI_CUSTOMIZATIONS_PERMISSIONS_MODE = oldMode;
    rmSync(home, { recursive: true, force: true });
  });
}

test("policy allows only simple listed shell commands and treats denies as hard blocks except in Always Ask", () => fixture(({ cwd }) => {
  const policy = loadPolicy();
  const verdict = (command: string, mode: PermissionMode) => evaluate(shell(command), policy, cwd, mode).decision;
  assert.equal(verdict("git status --short", "default"), "allow");
  assert.equal(verdict("git status; rm -rf /tmp/x", "default"), "ask");
  assert.equal(verdict("git status $(touch /tmp/x)", "default"), "ask");
  assert.equal(verdict("rm -rf /tmp/x", "default"), "ask");
  assert.equal(verdict("rm -rf /tmp/x", "auto"), "allow");
  assert.equal(verdict("git push -f origin main", "default"), "deny");
  assert.equal(verdict("echo hi; git push --force origin main", "auto"), "deny");
  assert.equal(verdict("git 'push' '--force' origin main", "auto"), "deny");
  assert.equal(verdict("git push -f origin main", "ask"), "ask");
  assert.equal(verdict("git status --short", "ask"), "ask");
}));

test("workspace and external writes, symlink escapes, reads, fetch, and policy protection", () => fixture(({ home, cwd, outside }) => {
  const policy = loadPolicy();
  symlinkSync(outside, join(cwd, "escape"));
  assert.equal(evaluate(tool("read", join(cwd, "src", "missing.ts")), policy, cwd, "default").decision, "allow");
  assert.equal(evaluate(tool("read", join(cwd, "escape", "secret.txt")), policy, cwd, "default").decision, "ask");
  assert.equal(evaluate(tool("edit", join(cwd, "a.ts")), policy, cwd, "default").decision, "allow");
  assert.equal(evaluate(tool("write", join(outside, "index.json")), policy, cwd, "default").decision, "allow");
  assert.equal(evaluate(tool("write", join(home, "other.json")), policy, cwd, "default").decision, "ask");
  const config = tool("write", join(home, ".agents", "permissions.yaml"));
  assert.equal(evaluate(config, policy, cwd, "auto").decision, "deny");
  assert.equal(evaluate(config, policy, cwd, "ask").decision, "ask");
  assert.equal(evaluate({ toolName: "webfetch", input: { url: "https://github.com/org" } }, policy, cwd, "default").decision, "allow");
  assert.equal(evaluate({ toolName: "webfetch", input: { url: "https://github.com.evil.example/" } }, policy, cwd, "default").decision, "ask");
}));

test("extension changes interactive modes and refuses unapproved headless calls", () => fixture(async ({ cwd }) => {
  process.env.PI_CUSTOMIZATIONS_PERMISSIONS_MODE = "auto";
  const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
  let command!: (args: string, ctx: any) => Promise<void>;
  permissionsExtension({
    on: (name: string, handler: (event: any, ctx: any) => Promise<any>) => { handlers.set(name, handler); return () => {}; },
    registerCommand: (_name: string, options: { handler: typeof command }) => { command = options.handler; },
  } as unknown as ExtensionAPI);
  let confirmations = 0;
  const ctx = {
    cwd, mode: "tui", hasUI: true, ui: {
      setStatus: () => {}, notify: () => {},
      confirm: async () => { confirmations++; return true; },
    },
  };
  await handlers.get("session_start")!({}, ctx);
  const call = (command: string, context = ctx) => handlers.get("tool_call")!({ ...shell(command), type: "tool_call" }, context);
  assert.equal(await call("git status"), undefined); // Gateway Auto.
  assert.equal((await call("git push -f origin main"))?.block, true); // Explicit deny survives Auto.
  await command("ask", ctx);
  assert.equal(await call("git push -f origin main"), undefined); // A person explicitly approves.
  assert.equal(confirmations, 1);
  assert.equal((await call("git status", { ...ctx, hasUI: false }))?.block, true);
  await command("default", ctx);
  assert.equal(await call("git status"), undefined);
  assert.equal((await call("uname -a", { ...ctx, hasUI: false }))?.block, true);
  rmSync(join(process.env.HOME!, ".agents", "permissions.yaml"));
  await command("reload", ctx);
  await command("auto", ctx);
  assert.equal((await call("git status"))?.block, true); // Missing deny list fails closed even in Auto.
}));

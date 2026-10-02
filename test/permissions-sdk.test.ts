import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";

test("SDK session binds the permission gate and allows Auto except explicit denies", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-permissions-sdk-"));
  const before = { HOME: process.env.HOME, PI_CUSTOMIZATIONS_PERMISSIONS_MODE: process.env.PI_CUSTOMIZATIONS_PERMISSIONS_MODE, PI_OFFLINE: process.env.PI_OFFLINE };
  process.env.HOME = home;
  process.env.PI_CUSTOMIZATIONS_PERMISSIONS_MODE = "auto";
  process.env.PI_OFFLINE = "1";
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    mkdirSync(join(home, ".agents"));
    writeFileSync(join(home, ".agents", "permissions.yaml"), "deny_shell:\n  - blocked-command\n");
    const loader = new DefaultResourceLoader({
      cwd: home, agentDir: join(home, "pi-agent"),
      additionalExtensionPaths: [fileURLToPath(new URL("../extensions/permissions.ts", import.meta.url))],
    });
    await loader.reload();
    const created = await createAgentSession({ cwd: home, resourceLoader: loader, sessionManager: SessionManager.inMemory() });
    session = created.session;
    assert.equal(created.extensionsResult.extensions.filter((extension) => extension.commands.has("permissions")).length, 1);
    await session.bindExtensions({});
    const agent = session.agent as typeof session.agent & { beforeToolCall: (call: { toolCall: { id: string; name: string }; args: { command: string } }) => Promise<{ block?: boolean; reason?: string } | undefined> };
    const call = (command: string) => agent.beforeToolCall({ toolCall: { id: "test", name: "bash" }, args: { command } });
    assert.equal(await call("pwd"), undefined);
    const blocked = await call("blocked-command");
    assert.equal(blocked?.block, true);
    assert.match(blocked?.reason || "", /Explicitly denied/);
  } finally {
    session?.dispose();
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentTool } from "@earendil-works/pi-agent-core";

test("live headless SDK browser tool survives host replacement with the same Pi session", { skip: process.env.PI_BROWSER_LIVE !== "1", timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-browser-sdk-live-"));
  const before = { HOME: process.env.HOME, PI_CUSTOMIZATIONS_PERMISSIONS_MODE: process.env.PI_CUSTOMIZATIONS_PERMISSIONS_MODE, PI_OFFLINE: process.env.PI_OFFLINE, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_BROWSER_LOCK_DIR: process.env.PI_BROWSER_LOCK_DIR };
  process.env.HOME = root;
  process.env.PI_CUSTOMIZATIONS_PERMISSIONS_MODE = "auto";
  process.env.PI_OFFLINE = "1";
  process.env.PI_CODING_AGENT_DIR = join(root, "pi-agent");
  process.env.PI_BROWSER_LOCK_DIR = join(tmpdir(), `pi-browser-live-locks-${process.getuid?.() ?? 0}`);
  const server = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html" }); response.end("<!doctype html><title>Headless SDK smoke</title><h1>Telegram-style browser access works</h1>"); });
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let tool: AgentTool | undefined;
  try {
    await mkdir(join(root, ".agents"));
    await writeFile(join(root, ".agents", "permissions.yaml"), "deny_shell: []\n");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const loader = new DefaultResourceLoader({
      cwd: root, agentDir: join(root, "pi-agent"),
      additionalExtensionPaths: ["permissions", "brave"].map((name) => fileURLToPath(new URL(`../extensions/${name}.ts`, import.meta.url))),
    });
    await loader.reload();
    const manager = SessionManager.inMemory();
    const create = async () => {
      const created = await createAgentSession({ cwd: root, resourceLoader: loader, sessionManager: manager });
      session = created.session;
      await session.bindExtensions({});
      tool = session.agent.state.tools.find((entry) => entry.name === "brave_browser");
      assert.ok(tool);
    };
    await create();
    const result = await tool!.execute("live-open", { action: "open", page: "sdk", url: `http://127.0.0.1:${address.port}/` });
    assert.equal((result.details as { title: string }).title, "Headless SDK smoke");
    session!.dispose();
    await create(); // SDK host restarted, same session ID, no in-memory tab map.
    const read = await tool!.execute("live-read", { action: "read", page: "sdk" });
    assert.match((read.details as { text: string }).text, /Telegram-style browser access works/);
    const screenshot = await tool!.execute("live-screenshot", { action: "screenshot", page: "sdk" });
    assert.ok(screenshot.content.some((block) => block.type === "image" && block.mimeType === "image/png"));
  } finally {
    await tool?.execute("cleanup", { action: "close", page: "sdk" }).catch(() => {});
    session?.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

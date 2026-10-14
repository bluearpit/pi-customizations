import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";

async function checkBatchOrder(tool: AgentTool) {
  let turns = 0;
  const order: string[] = [];
  const agent = new Agent({
    toolExecution: "parallel",
    initialState: {
      model: { id: "fixture", name: "Fixture", provider: "fixture", api: "openai-completions", baseUrl: "http://127.0.0.1", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      tools: [{ ...tool, execute: async (_id, params) => {
        const action = (params as { action: string }).action;
        order.push(action + ":start");
        if (action === "fill") await new Promise((resolve) => setTimeout(resolve, 50));
        order.push(action + ":end");
        return { content: [{ type: "text", text: "done" }], details: undefined };
      } }],
    },
    streamFn: () => {
      const first = turns++ === 0;
      const message: AssistantMessage = {
        role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture", timestamp: Date.now(),
        content: first ? [
          { type: "toolCall", id: "fill", name: "brave_browser", arguments: { action: "fill", selector: "#name", text: "example" } },
          { type: "toolCall", id: "press", name: "brave_browser", arguments: { action: "press", key: "Enter" } },
        ] : [{ type: "text", text: "Finished" }],
        stopReason: first ? "toolUse" : "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
      stream.end();
      return stream;
    },
  });
  await agent.prompt("Fill then submit");
  assert.deepEqual(order, ["fill:start", "fill:end", "press:start", "press:end"]);
}

for (const mode of ["default", "auto"] as const) {
  test(`browser loads into headless SDK; ${mode} permissions enforce the expected gate`, async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-browser-sdk-"));
    const before = { HOME: process.env.HOME, PI_CUSTOMIZATIONS_PERMISSIONS_MODE: process.env.PI_CUSTOMIZATIONS_PERMISSIONS_MODE, PI_OFFLINE: process.env.PI_OFFLINE, PI_BROWSER_CDP_URL: process.env.PI_BROWSER_CDP_URL, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
    process.env.HOME = root;
    process.env.PI_CUSTOMIZATIONS_PERMISSIONS_MODE = mode;
    process.env.PI_OFFLINE = "1";
    process.env.PI_BROWSER_CDP_URL = "http://127.0.0.1:1";
    process.env.PI_CODING_AGENT_DIR = join(root, "pi-agent");
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      await mkdir(join(root, ".agents"));
      await writeFile(join(root, ".agents", "permissions.yaml"), "deny_shell:\n  - blocked-command\n");
      const loader = new DefaultResourceLoader({
        cwd: root, agentDir: join(root, "pi-agent"),
        additionalExtensionPaths: ["permissions", "brave"].map((name) => fileURLToPath(new URL(`../extensions/${name}.ts`, import.meta.url))),
      });
      await loader.reload();
      const created = await createAgentSession({ cwd: root, resourceLoader: loader, sessionManager: SessionManager.inMemory() });
      session = created.session;
      assert.deepEqual(created.extensionsResult.errors, []);
      await session.bindExtensions({});
      const tool = session.agent.state.tools.find((tool) => tool.name === "brave_browser");
      assert.ok(tool, "Headless SDK sessions advertise the browser tool");
      assert.equal(tool.executionMode, "sequential", "Browser tool preserves model action order even in a parallel batch");
      const schema = JSON.stringify(tool.parameters);
      for (const parameter of ["select", "check", "upload", "frame", "elementOffset", "optionOffset", "contenteditable"]) assert.ok(schema.includes(parameter), `SDK advertises ${parameter}`);
      const agent = session.agent as typeof session.agent & { beforeToolCall: (call: { toolCall: { id: string; name: string }; args: object }) => Promise<{ block?: boolean; reason?: string } | undefined> };
      const verdict = await agent.beforeToolCall({ toolCall: { id: "test", name: "brave_browser" }, args: { action: "status" } });
      for (const args of [
        { action: "select", selector: "#sort", values: ["new"] },
        { action: "check", selector: "#box", checked: true },
        { action: "upload", selector: "#files", paths: ["/tmp/approved.txt"] },
      ]) {
        const gate = await agent.beforeToolCall({ toolCall: { id: "control", name: "brave_browser" }, args });
        assert.equal(gate?.block === true, mode === "default", `${args.action} uses the same permission boundary`);
      }
      if (mode === "default") {
        assert.equal(verdict?.block, true);
        assert.match(verdict?.reason || "", /Approval required/);
      } else {
        assert.equal(verdict, undefined);
        // Execute via Pi's actual wrapped tool, with its SDK ExtensionContext. No LLM/network credentials needed.
        await assert.rejects(tool.execute("test", { action: "status" }), /BROWSER_UNAVAILABLE/);
        await checkBatchOrder(tool);
      }
    } finally {
      session?.dispose();
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
}

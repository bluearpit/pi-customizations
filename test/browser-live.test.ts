import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runBrowser } from "../extensions/browser/client.js";
import { DEFAULT_CDP_ENDPOINT, validateEndpoint } from "../extensions/browser/protocol.js";

test("live Brave: owned tabs, interaction, screenshot, handoff, and closed-tab recovery", { skip: process.env.PI_BROWSER_LIVE !== "1", timeout: 120000 }, async () => {
  // Uses only new test-owned tabs in an already-running browser; never launches/closes Brave.
  const root = await mkdtemp(join(tmpdir(), "pi-browser-live-"));
  const options = { stateDir: root, lockDir: join(tmpdir(), `pi-browser-live-locks-${process.getuid?.() ?? 0}`), endpoint: validateEndpoint(process.env.PI_BROWSER_CDP_URL || DEFAULT_CDP_ENDPOINT) };
  const session = randomUUID();
  const other = randomUUID();
  const html = `<!doctype html><title>Pi browser fixture</title><h1>Browser fixture</h1>
<form id="form"><label>Name <input id="name"></label><button id="submit">Submit</button></form>
<p id="count">Submitted 0</p><p id="value"></p>
<a id="blank" target="_blank" href="/popup">Open popup link</a>
<button id="script-popup" onclick="window.open('/popup-script','_blank')">Open script popup</button>
<p>${"transcript fixture ".repeat(4000)}</p>
<script>let count=0; document.getElementById('form').addEventListener('submit',e=>{e.preventDefault();count++;document.getElementById('count').innerText='Submitted '+count;document.getElementById('value').innerText=document.getElementById('name').value;});</script>`;
  const server = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html" }); response.end(html); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const url = `http://127.0.0.1:${address.port}/`;
  const call = async (request: Parameters<typeof runBrowser>[0]) => {
    try { return await runBrowser(request, session, options); }
    catch (error) { (error as Error).message = `${request.action}/${request.page}: ${(error as Error).message}`; throw error; }
  };
  try {
    assert.equal((await call({ action: "status" })).connected, true);
    assert.equal((await call({ action: "open", page: "fixture", url })).title, "Pi browser fixture");
    const snapshot = await call({ action: "read", page: "fixture", maxChars: 500 });
    assert.equal(snapshot.text?.length, 500);
    assert.equal(snapshot.nextOffset, 500);
    assert.ok(snapshot.elements?.some((element) => element.selector === "#submit"));
    await call({ action: "fill", page: "fixture", selector: "#name", text: "Pi test" });
    await call({ action: "click", page: "fixture", selector: "#submit" });
    const after = await call({ action: "read", page: "fixture", maxChars: 500 });
    assert.match(after.text || "", /Submitted 1/);
    assert.match(after.text || "", /Pi test/);
    const screenshot = await call({ action: "screenshot", page: "fixture" });
    assert.ok(typeof screenshot.image === "string" && screenshot.image.length > 1000);
    await call({ action: "fill", page: "fixture", selector: "#name", text: "Handoff" });
    await call({ action: "press", page: "fixture", key: "Enter" });
    // Fresh client options simulate another host resuming the same session.
    const resumed = await runBrowser({ action: "read", page: "fixture", maxChars: 500 }, session, { ...options });
    assert.match(resumed.text || "", /Submitted 2/);
    assert.match(resumed.text || "", /Handoff/);
    const linkPopup = await call({ action: "click", page: "fixture", selector: "#blank" });
    assert.ok(Number(linkPopup.blockedPopups) >= 1, "target=_blank popup is closed and reported");
    const scriptPopup = await call({ action: "click", page: "fixture", selector: "#script-popup" });
    assert.ok(Number(scriptPopup.blockedPopups) >= 1, "window.open popup is closed and reported");
    // Crash immediately after creating a reserved tab; close must recover its identity without creating another.
    const crashWorker = join(root, "crash-after-create.mjs");
    await writeFile(crashWorker, `let raw=''; for await (const part of process.stdin) raw+=part; const r=JSON.parse(raw); await fetch(r.endpoint+'/json/new?'+encodeURIComponent(r.url),{method:'PUT'}); process.exit(1);`);
    await assert.rejects(runBrowser({ action: "open", page: "reservation", url }, session, { ...options, workerPath: crashWorker }), /WORKER_CRASH/);
    assert.equal((await call({ action: "close", page: "reservation" })).closed, true);
    assert.deepEqual((await call({ action: "status" })).pages, ["fixture"]);
    await assert.rejects(runBrowser({ action: "read", page: "fixture" }, other, options), /PAGE_MISSING/);
    await runBrowser({ action: "open", page: "fixture", url }, other, options);
    assert.match((await runBrowser({ action: "read", page: "fixture", maxChars: 500 }, other, options)).text || "", /Submitted 0/);
    // Simulate an externally closed owned tab using its precise target ID, not any user tab.
    const state = JSON.parse(await readFile(join(root, createHash("sha256").update(session).digest("hex") + ".json"), "utf8"));
    const response = await fetch(`${options.endpoint}/json/close/${encodeURIComponent(state.pages.fixture.targetId)}`);
    assert.equal(response.ok, true);
    await assert.rejects(call({ action: "read", page: "fixture" }), /PAGE_MISSING/);
    await call({ action: "open", page: "fixture", url });
    assert.match((await call({ action: "read", page: "fixture", maxChars: 500 })).text || "", /Submitted 0/);
  } finally {
    await call({ action: "close", page: "reservation" }).catch(() => {});
    await call({ action: "close", page: "fixture" }).catch(() => {});
    await runBrowser({ action: "close", page: "fixture" }, other, options).catch(() => {});
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

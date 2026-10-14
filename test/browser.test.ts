import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runBrowser, runWorker } from "../extensions/browser/client.js";
import { validateEndpoint, validateRequest } from "../extensions/browser/protocol.js";
import { targetIdentity, trackPopup } from "../extensions/browser/targets.mjs";

async function fixture(body: string) {
  const root = await mkdtemp(join(tmpdir(), "pi-browser-test-"));
  const workerPath = join(root, "worker.mjs");
  const counter = join(root, "count");
  await writeFile(workerPath, `import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
let input=''; for await(const chunk of process.stdin) input+=chunk;
const request=JSON.parse(input);
const counter=${JSON.stringify(counter)};
const reply=(result)=>process.stdout.write(JSON.stringify({ok:true,result}));
const failure=(code,message)=>process.stdout.write(JSON.stringify({ok:false,code,message}));
${body}`);
  return { root, workerPath, counter, options: { workerPath, stateDir: join(root, "state"), timeoutMs: 3000 }, cleanup: () => rm(root, { recursive: true, force: true }) };
}
const normalWorker = `
if(request.action==='create') reply({targetId:'owned',browserId:'browser',url:request.url});
else if(request.action==='probe') reply({exists:true});
else if(request.action==='status') reply({connected:true});
else reply({url:request.url||'https://example.com/',text:'verified'});
`;

test("browser rejects nonlocal CDP, privileged navigation, and invalid inputs", () => {
  assert.equal(validateEndpoint("http://127.0.0.1:9222"), "http://127.0.0.1:9222");
  for (const endpoint of ["http://example.com:9222", "http://127.0.0.1:9222/path", "http://user@127.0.0.1:9222", "https://127.0.0.1:9222"]) assert.throws(() => validateEndpoint(endpoint));
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "brave://settings", "https://user:secret@example.com"]) assert.throws(() => validateRequest({ action: "open", url }));
  assert.throws(() => validateRequest({ action: "read", page: "../other" }));
  assert.throws(() => validateRequest({ action: "read", maxChars: 20001 }));
  assert.throws(() => validateRequest({ action: "click" }));
  for (const key of ["Meta+q", "Alt+F4", "Control+l", "F12", "Meta"]) assert.throws(() => validateRequest({ action: "press", key }));
  for (const key of ["Enter", "Tab", "Shift+Tab", "ArrowDown", "a"]) validateRequest({ action: "press", key });
  validateRequest({ action: "fill", selector: "#field", text: "" });
  validateRequest({ action: "select", selector: "#sort", values: ["newest"] });
  validateRequest({ action: "check", selector: "#box", checked: false });
  validateRequest({ action: "upload", selector: "#files", paths: ["/tmp/approved.txt"] });
  validateRequest({ action: "fill", selector: "#editor", text: "whole draft", frame: ["#outer", "#inner"] });
  for (const request of [
    { action: "select" as const, selector: "#sort" },
    { action: "select" as const, selector: "#sort", values: ["x", "x"] },
    { action: "check" as const, selector: "#box" },
    { action: "upload" as const, selector: "#file", paths: [] },
    { action: "upload" as const, selector: "#file", paths: ["relative.txt"] },
    { action: "read" as const, frame: [] },
    { action: "read" as const, frame: ["#a", "#b", "#c", "#d", "#e"] },
    { action: "close" as const, frame: ["#a"] },
  ]) assert.throws(() => validateRequest(request));
});

test("target identity survives URL changes and popup tracking excludes existing/self/foreign tabs", () => {
  const target = { _targetId: "owned", url: () => "https://example.com/redirected" };
  assert.equal(targetIdentity(target), "owned");
  assert.throws(() => targetIdentity({}), /Unsupported Puppeteer/);
  const owned = new Set(["owned"]);
  const initial = new Set(["existing"]);
  assert.equal(trackPopup({ type: "page", targetId: "new", openerId: "owned" }, owned, initial, "owned"), true);
  for (const info of [
    { type: "page", targetId: "existing", openerId: "owned" },
    { type: "page", targetId: "owned", openerId: "owned" },
    { type: "page", targetId: "localhost:9222:owned", openerId: "owned" },
    { type: "page", targetId: "other", openerId: "foreign" },
    { type: "shared_worker", targetId: "worker", openerId: "owned" },
  ]) assert.equal(trackPopup(info, owned, initial, "owned"), false);
});

test("unfinished reservation can be discarded without retrying creation", async () => {
  const f = await fixture(`if(request.action==='create') {appendFileSync(counter,'create'); process.exit(1);} else if(request.action==='discard') {appendFileSync(counter,'discard'); reply({closed:true});} else reply({connected:true});`);
  try {
    await assert.rejects(runBrowser({ action: "open", url: "https://example.com" }, "session", f.options), /WORKER_CRASH/);
    assert.equal((await runBrowser({ action: "close" }, "session", f.options)).closed, true);
    assert.equal(await readFile(f.counter, "utf8"), "creatediscard");
    assert.deepEqual((await runBrowser({ action: "status" }, "session", f.options)).pages, []);
  } finally { await f.cleanup(); }
});

test("a page's oversized URL cannot poison its persistent tab state", async () => {
  const f = await fixture(`if(request.action==='create') reply({targetId:'owned',browserId:'browser'}); else if(request.action==='probe') reply({exists:true}); else reply({url:'https://example.com/#'+'x'.repeat(20000),text:'still available'});`);
  try {
    const result = await runBrowser({ action: "open", url: "https://example.com" }, "session", f.options);
    assert.equal(result.urlTruncated, true);
    assert.equal(result.url?.length, 16384);
    assert.equal((await runBrowser({ action: "read" }, "session", f.options)).text, "still available");
  } finally { await f.cleanup(); }
});

test("tabs persist across calls and are isolated by Pi session identity", async () => {
  const f = await fixture(normalWorker);
  try {
    await runBrowser({ action: "open", page: "docs", url: "https://example.com" }, "terminal-session", f.options);
    const resumed = await runBrowser({ action: "read", page: "docs" }, "terminal-session", f.options);
    assert.equal(resumed.text, "verified");
    await assert.rejects(runBrowser({ action: "read", page: "docs" }, "different-telegram-session", f.options), /PAGE_MISSING/);
    const status = await runBrowser({ action: "status" }, "terminal-session", f.options);
    assert.deepEqual(status.pages, ["docs"]);
    await runBrowser({ action: "close", page: "docs" }, "terminal-session", f.options);
    await assert.rejects(runBrowser({ action: "read", page: "docs" }, "terminal-session", f.options), /PAGE_MISSING/);
  } finally { await f.cleanup(); }
});

test("read retries a crashed worker once; mutation crashes are NOT retried", async () => {
  const f = await fixture(String.raw`
if(request.action==='create') reply({targetId:'owned',browserId:'browser'});
else if(request.action==='probe') reply({exists:true});
else if(request.action==='open') reply({url:request.url});
else {
 const count=existsSync(counter)?Number(readFileSync(counter,'utf8')):0;
 writeFileSync(counter,String(count+1));
 if(request.action==='click'||count===0) process.exit(1);
 reply({text:'reconnected'});
}`);
  try {
    await runBrowser({ action: "open", url: "https://example.com" }, "session", f.options);
    assert.equal((await runBrowser({ action: "read" }, "session", f.options)).text, "reconnected");
    assert.equal(await readFile(f.counter, "utf8"), "2");
    await assert.rejects(runBrowser({ action: "click", selector: "#submit" }, "session", f.options), /WORKER_CRASH/);
    assert.equal(await readFile(f.counter, "utf8"), "3");
  } finally { await f.cleanup(); }
});

test("new control mutations forward their arguments and are never automatically replayed", async () => {
  const f = await fixture(`if(request.action==='create') reply({targetId:'owned',browserId:'browser'}); else if(request.action==='open') reply({url:request.url}); else {appendFileSync(counter,JSON.stringify(request)+'\\n'); process.exit(1);}`);
  try {
    await runBrowser({ action: "open", url: "https://example.com" }, "session", f.options);
    const requests = [
      { action: "select" as const, selector: "#sort", values: ["newest"], frame: ["#frame"] },
      { action: "check" as const, selector: "#box", checked: false },
      { action: "upload" as const, selector: "#files", paths: ["/tmp/approved.txt"] },
    ];
    for (const request of requests) await assert.rejects(runBrowser(request, "session", f.options), /WORKER_CRASH/);
    const calls = (await readFile(f.counter, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(calls.length, requests.length);
    for (const [index, request] of requests.entries()) for (const [key, value] of Object.entries(request)) assert.deepEqual(calls[index][key], value);
  } finally { await f.cleanup(); }
});

test("timed-out navigation retains target ownership and is not replayed", async () => {
  const f = await fixture(String.raw`
if(request.action==='create') reply({targetId:'saved',browserId:'browser'});
else if(request.action==='open') {appendFileSync(counter,'open\n'); await new Promise(resolve=>setTimeout(resolve,60000));}
else reply({text:request.record.targetId});
`);
  try {
    await assert.rejects(runBrowser({ action: "open", url: "https://example.com" }, "session", { ...f.options, timeoutMs: 1000 }), /WORKER_TIMEOUT|WORKER_CRASH/);
    const stateFiles = (await readdir(f.options.stateDir)).filter((path) => path.endsWith(".json"));
    const state = JSON.parse(await readFile(join(f.options.stateDir, stateFiles[0]), "utf8"));
    assert.equal(state.pages.main.targetId, "saved");
    assert.equal(await readFile(f.counter, "utf8"), "open\n");
    assert.equal((await runBrowser({ action: "read" }, "session", f.options)).text, "saved");
  } finally { await f.cleanup(); }
});

test("creation crash keeps a durable reservation for the next explicit open", async () => {
  const f = await fixture(String.raw`
if(request.action==='create') {
 if(!existsSync(counter)) {writeFileSync(counter,request.url); process.exit(1);}
 if(readFileSync(counter,'utf8')!==request.url) throw new Error('changed reservation');
 reply({targetId:'recovered',browserId:'browser'});
} else reply({url:request.url||'https://example.com'});
`);
  try {
    await assert.rejects(runBrowser({ action: "open", url: "https://example.com" }, "session", f.options), /WORKER_CRASH/);
    const result = await runBrowser({ action: "open", url: "https://example.com" }, "session", f.options);
    assert.equal(result.url, "https://example.com/");
    assert.match(await readFile(f.counter, "utf8"), /^about:blank#pi-browser-/);
  } finally { await f.cleanup(); }
});

test("parallel calls in different hosts serialize for the same session", async () => {
  const f = await fixture(String.raw`
if(request.action==='create') reply({targetId:'owned',browserId:'browser'});
else if(request.action==='probe') reply({exists:true});
else if(request.action==='open') reply({url:request.url});
else {appendFileSync(counter,'start\n'); await new Promise(resolve=>setTimeout(resolve,100)); appendFileSync(counter,'end\n'); reply({text:'done'});}
`);
  try {
    await runBrowser({ action: "open", url: "https://example.com" }, "session", f.options);
    await Promise.all([runBrowser({ action: "read" }, "session", f.options), runBrowser({ action: "read" }, "session", f.options)]);
    assert.equal(await readFile(f.counter, "utf8"), "start\nend\nstart\nend\n");
  } finally { await f.cleanup(); }
});

test("different sessions and hosts share a browser-wide operation lock", async () => {
  const f = await fixture(String.raw`appendFileSync(counter,'start\n'); await new Promise(resolve=>setTimeout(resolve,100)); appendFileSync(counter,'end\n'); reply({connected:true});`);
  try {
    const shared = { ...f.options, lockDir: join(f.root, "locks") };
    await Promise.all([
      runBrowser({ action: "status" }, "terminal", { ...shared, stateDir: join(f.root, "terminal-state") }),
      runBrowser({ action: "status" }, "telegram", { ...shared, stateDir: join(f.root, "telegram-state") }),
    ]);
    assert.equal(await readFile(f.counter, "utf8"), "start\nend\nstart\nend\n");
  } finally { await f.cleanup(); }
});

test("stale host lock is reclaimed; corrupt state is not discarded", async () => {
  const f = await fixture(normalWorker);
  try {
    await mkdir(f.options.stateDir);
    const path = join(f.options.stateDir, createHash("sha256").update("session").digest("hex") + ".json");
    await mkdir(path + ".lock");
    await utimes(path + ".lock", new Date(0), new Date(0));
    assert.equal((await runBrowser({ action: "status" }, "session", f.options)).connected, true);
    await writeFile(path, "corrupt state");
    await assert.rejects(runBrowser({ action: "open", url: "https://example.com" }, "session", f.options), /STATE/);
    assert.equal(await readFile(path, "utf8"), "corrupt state");
  } finally { await f.cleanup(); }
});

test("cancellation kills a helper and releases the session lock", async () => {
  const f = await fixture(`setInterval(()=>{},1000);`);
  try {
    const controller = new AbortController();
    const request = runBrowser({ action: "status" }, "session", { ...f.options, signal: controller.signal });
    setTimeout(() => controller.abort(), 150);
    await assert.rejects(request, /CANCELLED/);
    assert.equal((await readdir(f.options.stateDir)).filter((name) => name.endsWith(".lock")).length, 0);
    await assert.rejects(runWorker({ action: "status", endpoint: "http://127.0.0.1:9222" }, { ...f.options, signal: controller.signal }), /CANCELLED/);
  } finally { await f.cleanup(); }
});

test("closed tab can be forgotten; explicit open recreates a missing tab", async () => {
  const f = await fixture(`
if(request.action==='create') {const count=existsSync(counter)?Number(readFileSync(counter,'utf8')):0; writeFileSync(counter,String(count+1)); reply({targetId:'owned'+count,browserId:'browser'});}
else if(request.action==='probe'||request.action==='close') failure('PAGE_MISSING','Tab is gone');
else reply({url:request.url});
`);
  try {
    await runBrowser({ action: "open", url: "https://example.com" }, "session", f.options);
    await runBrowser({ action: "open", url: "https://example.com" }, "session", f.options);
    assert.equal(await readFile(f.counter, "utf8"), "2");
    assert.equal((await runBrowser({ action: "close" }, "session", f.options)).alreadyGone, true);
    await assert.rejects(runBrowser({ action: "read" }, "session", f.options), /PAGE_MISSING/);
  } finally { await f.cleanup(); }
});

test("cancellation while waiting for another host's lock does not steal it", async () => {
  const f = await fixture(normalWorker);
  try {
    await mkdir(f.options.stateDir);
    const path = join(f.options.stateDir, createHash("sha256").update("session").digest("hex") + ".json.lock");
    await mkdir(path);
    const controller = new AbortController();
    const request = runBrowser({ action: "status" }, "session", { ...f.options, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(request, /CANCELLED/);
    assert.ok((await readdir(f.options.stateDir)).some((entry) => entry.endsWith(".lock")));
  } finally { await f.cleanup(); }
});

test("unavailable browser produces an actionable error rather than starting Brave", async () => {
  const f = await fixture(normalWorker);
  try {
    await assert.rejects(runBrowser({ action: "status" }, "session", { stateDir: f.options.stateDir, endpoint: "http://127.0.0.1:1", timeoutMs: 8000 }), /BROWSER_UNAVAILABLE/);
  } finally { await f.cleanup(); }
});

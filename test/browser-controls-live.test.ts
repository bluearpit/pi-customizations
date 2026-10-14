import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runBrowser } from "../extensions/browser/client.js";
import { DEFAULT_CDP_ENDPOINT, validateEndpoint, type BrowserRequest } from "../extensions/browser/protocol.js";

test("live controls: whole rich-text drafts, native/ARIA state, uploads, and nested cross-origin frames", { skip: process.env.PI_BROWSER_LIVE !== "1", timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-browser-controls-"));
  const options = { stateDir: root, lockDir: join(tmpdir(), `pi-browser-live-locks-${process.getuid?.() ?? 0}`), endpoint: validateEndpoint(process.env.PI_BROWSER_CDP_URL || DEFAULT_CDP_ENDPOINT) };
  const session = randomUUID();
  let port = 0;
  let uploaded = "";
  const html = () => `<!doctype html><title>Control fixture</title><h1>Control fixture</h1>
<p id="events">Enter 0; checkbox 0</p><p id="editor-result"></p><p id="area-result"></p><p id="select-result"></p><p id="file-result"></p><p id="controlled-result"></p><p id="parent-result">Parent unchanged</p>
${Array.from({ length: 100 }, (_, i) => `<a href="#link${i}">Navigation ${i}</a>`).join("")}
<div id="editor" contenteditable="true" role="textbox" aria-label="Post draft"><b>old rich</b> draft</div>
<div id="plain" contenteditable="plaintext-only" aria-label="Plain editor">old</div>
<label>Note <textarea id="area">old</textarea></label>
<label>Text <input id="text" value="not part of inspect metadata"></label>
<input id="controlled" value="old controlled"><input id="number" type="number" value="123"><input id="email" type="email" value="old@example.com">
<input id="inside" value="parent remains unchanged"><input id="card" autocomplete="cc-number" value="must-not-expose-card">
<input id="readonly" readonly value="unchanged"><input id="disabled" disabled>
<input id="password" type="password" value="must-not-expose-password"><input id="otp" autocomplete="one-time-code" value="must-not-expose-otp">
<button id="focus-password" onclick="document.querySelector('#password').focus()">Focus password fixture</button>
<button id="focus-card-select" onclick="document.querySelector('#sensitive-select').focus()">Focus card fixture</button>
<button id="focus-private-editor" onclick="document.querySelector('#sensitive-editor').focus()">Focus private editor fixture</button>
<div id="locked-editor" contenteditable="true" aria-readonly="true">Locked</div>
<div id="sensitive-editor" contenteditable="true" autocomplete="one-time-code">must-not-expose-editor-text</div>
<textarea id="sensitive-area" autocomplete="one-time-code">must-not-expose-area-text</textarea>
<select id="sensitive-select" autocomplete="cc-number"><option value="must-not-expose-select-value">must-not-expose-select-label</option></select>
<div autocomplete="cc-number"><select id="sensitive-child"><option value="must-not-expose-child-value">must-not-expose-child-label</option></select></div>
<label>Sort <select id="sort"><option value="old">Oldest</option><option value="new">Newest</option><option value="disabled" disabled>Disabled</option></select></label>
<select id="many" multiple><option value="a">A</option><option value="b">B</option></select>
<select id="duplicate"><option value="x">One</option><option value="x">Two</option></select>
<select id="long">${Array.from({ length: 55 }, (_, i) => `<option value="v${i}">Option ${i}</option>`).join("")}</select>
<label><input id="box" type="checkbox">Enable alerts</label>
<label><input id="radio" type="radio" name="r">Radio</label>
<div id="switch" role="switch" aria-checked="false" tabindex="0" aria-label="Feature switch" onclick="this.setAttribute('aria-checked',this.getAttribute('aria-checked')==='true'?'false':'true')">Switch</div>
<input id="files" type="file" multiple hidden accept=".txt"><input id="single-file" type="file" hidden>
<iframe id="outer" title="Cross-origin example" src="http://localhost:${port}/inner?token=must-not-expose-frame-token"></iframe>
<iframe id="sibling" title="Sibling example" src="http://localhost:${port}/nested"></iframe>
<script>
let enters=0,checks=0;const events=()=>document.querySelector('#events').textContent='Enter '+enters+'; checkbox '+checks;
document.addEventListener('keydown',e=>{if(e.key==='Enter'){enters++;events();}});
document.querySelector('#editor').addEventListener('input',e=>document.querySelector('#editor-result').textContent='Draft: '+e.target.innerText);
document.querySelector('#area').addEventListener('input',e=>document.querySelector('#area-result').textContent='Note: '+e.target.value);
const controlledValues=[];document.querySelector('#controlled').addEventListener('input',e=>{controlledValues.push(e.target.value);e.target.value=controlledValues.at(-1);document.querySelector('#controlled-result').textContent='Controlled changes: '+JSON.stringify(controlledValues);});
document.querySelector('#box').addEventListener('click',()=>{checks++;events();});
document.querySelector('#inside').addEventListener('input',()=>document.querySelector('#parent-result').textContent='Parent changed');
document.querySelector('#sort').addEventListener('change',e=>document.querySelector('#select-result').textContent='Sort: '+e.target.value);
document.querySelector('#files').addEventListener('change',async e=>{document.querySelector('#file-result').textContent='Attached: '+Array.from(e.target.files).map(f=>f.name).join(',');const data=await Promise.all(Array.from(e.target.files).map(f=>f.text()));await fetch('/upload',{method:'POST',body:data.join('|')});});
</script>`;
  const server = createServer(async (request, response) => {
    if (request.url === "/upload") {
      for await (const part of request) uploaded += part.toString();
      response.end("received"); return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    if (request.url?.startsWith("/inner")) response.end('<!doctype html><h1>Inner frame</h1><iframe id="nested" title="Nested example" src="/nested"></iframe>');
    else if (request.url === "/nested") response.end('<!doctype html><h1>Nested frame</h1><input id="inside" aria-label="Inside frame"><input id="other" aria-label="Other control"><input type="password" value="must-not-expose-frame-password"><input autocomplete="one-time-code" value="must-not-expose-frame-otp"><input autocomplete="cc-number" value="must-not-expose-frame-card"><p id="result"></p><script>document.querySelector("#inside").oninput=e=>document.querySelector("#result").textContent=e.target.value;document.querySelector("#inside").value="frame initial";</script>');
    else response.end(html());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  port = address.port;
  const call = async (request: BrowserRequest) => {
    try { return await runBrowser({ page: "controls", ...request }, session, options); }
    catch (error) {
      (error as Error).message += ` [${request.action} ${request.selector || ""}]`;
      throw error;
    }
  };
  const inspect = () => call({ action: "read", maxChars: 2000 });
  const fileA = join(root, "approved-a.txt"), fileB = join(root, "approved-b.txt");
  await writeFile(fileA, "fixture A"); await writeFile(fileB, "fixture B");
  try {
    await call({ action: "open", url: `http://127.0.0.1:${port}/` });
    const before = await inspect();
    const element = (selector: string) => before.elements?.find((element) => element.selector === selector);
    assert.equal(element("#editor")?.kind, "rich-text");
    assert.ok(element("#editor")?.actions?.includes("fill"), "Editor survives 100 earlier navigation links");
    assert.equal(element("#area")?.label, "Note");
    assert.equal(element("#disabled")?.disabled, true);
    assert.equal(element("#readonly")?.readOnly, true);
    assert.equal(element("#files")?.visible, false);
    assert.deepEqual(element("#files")?.actions, ["upload"]);
    assert.equal(element("#outer")?.kind, "iframe");
    assert.equal(element("#box")?.checked, false);
    assert.equal(element("#sort")?.options?.find(option=>option.value==='new')?.label, "Newest");
    assert.doesNotMatch(JSON.stringify(before), /must-not-expose|not part of inspect metadata/);
    for (const selector of ["#sensitive-select", "#sensitive-child"]) {
      const protectedControl = element(selector);
      assert.equal(protectedControl?.sensitive, true);
      assert.deepEqual(protectedControl?.actions, []);
      assert.equal(protectedControl?.options, undefined);
      await assert.rejects(call({ action: "select", selector, values: ["must-not-expose-select-value"] }), /does not support/);
    }
    assert.doesNotMatch(JSON.stringify(await call({ action: "read", selector: "#sensitive-editor" })), /must-not-expose/);
    for (const [selector, key] of [["#focus-password", "a"], ["#focus-card-select", "ArrowDown"], ["#focus-private-editor", "Backspace"]]) {
      await call({ action: "click", selector }); // Simulate site/user focus changes, not secret extraction.
      await assert.rejects(call({ action: "press", key }), /sensitive control/);
    }
    assert.doesNotMatch(JSON.stringify(await inspect()), /must-not-expose/);
    assert.equal(before.nextElementOffset, 80);
    assert.ok((await call({ action: "read", elementOffset: 80 })).elements?.some(element=>element.tag==='a'));
    const tailOptions = await call({ action: "read", selector: "#long", optionOffset: 50 });
    assert.equal(tailOptions.elements?.length, 1);
    assert.equal(tailOptions.elements?.[0].options?.length, 5);
    assert.equal(tailOptions.elements?.[0].options?.[4].value, "v54");
    assert.deepEqual((await call({ action: "select", selector: "#long", values: ["v54"] })).selected, ["v54"]);
    const draft = "A timeout is not a failure 👋\nVerify before retrying <b>plain text</b>";
    assert.equal((await call({ action: "fill", selector: "#editor", text: draft })).filled, true);
    const after = await call({ action: "read", selector: "#editor" });
    assert.equal(after.elements?.length, 1);
    assert.equal(after.text, draft);
    assert.match(after.text || "", /Verify before retrying <b>plain text<\/b>/);
    assert.match((await inspect()).text || "", /Enter 0; checkbox 0/);
    await call({ action: "fill", selector: "#editor", text: "Replacement" });
    assert.doesNotMatch((await inspect()).text || "", /A timeout is not a failure/);
    await call({ action: "fill", selector: "#editor", text: "" });
    assert.equal((await inspect()).elements?.find(element=>element.selector==="#editor")?.empty, true);
    await call({ action: "fill", selector: "#plain", text: "Plain 👋\nNext line" });
    await call({ action: "fill", selector: "#area", text: "Two lines\nNo Enter shortcut" });
    assert.match((await inspect()).text || "", /Enter 0; checkbox 0/);
    await call({ action: "fill", selector: "#controlled", text: "Complete value" });
    assert.match((await inspect()).text || "", /Controlled changes: \["Complete value"\]/);
    await call({ action: "fill", selector: "#number", text: "456" });
    await call({ action: "fill", selector: "#email", text: "new@example.com" });
    for (const selector of ["#readonly", "#disabled", "#password", "#otp", "#card", "#locked-editor", "#sensitive-editor", "#sensitive-area"])  await assert.rejects(call({ action: "fill", selector, text: "should not be entered" }), /INPUT/);
    await assert.rejects(call({ action: "fill", selector: "#text", text: "no\nnewlines" }), /single-line/);
    assert.deepEqual((await call({ action: "select", selector: "#sort", values: ["new"] })).selected, ["new"]);
    assert.match((await inspect()).text || "", /Sort: new/);
    await assert.rejects(call({ action: "select", selector: "#sort", values: ["disabled"] }), /missing or disabled/);
    await assert.rejects(call({ action: "select", selector: "#sort", values: ["missing"] }), /missing or disabled/);
    await assert.rejects(call({ action: "select", selector: "#duplicate", values: ["x"] }), /missing or disabled/);
    assert.deepEqual((await call({ action: "select", selector: "#many", values: ["b", "a"] })).selected, ["a", "b"]);
    assert.deepEqual((await call({ action: "select", selector: "#many", values: [] })).selected, []);
    assert.equal((await call({ action: "check", selector: "#box", checked: true })).changed, true);
    assert.equal((await call({ action: "check", selector: "#box", checked: true })).changed, false);
    assert.match((await inspect()).text || "", /Enter 0; checkbox 1/);
    assert.equal((await call({ action: "check", selector: "#box", checked: false })).checked, false);
    assert.equal((await call({ action: "check", selector: "#switch", checked: true })).checked, true);
    assert.equal((await call({ action: "check", selector: "#radio", checked: true })).checked, true);
    await assert.rejects(call({ action: "check", selector: "#radio", checked: false }), /radio cannot/);
    assert.equal((await call({ action: "upload", selector: "#files", paths: [fileA, fileB] })).attachedFiles, 2);
    assert.equal(uploaded, "fixture A|fixture B");
    const attached = JSON.stringify(await inspect());
    assert.doesNotMatch(attached, /must-not-expose|fakepath/);
    assert.equal(attached.includes(root), false, "Snapshot does not expose local attachment paths");
    await assert.rejects(call({ action: "upload", selector: "#single-file", paths: [fileA, fileB] }), /only accepts one/);
    const frame = ["#outer", "#nested"];
    const inside = await call({ action: "read", frame });
    assert.match(inside.text || "", /Nested frame/);
    assert.doesNotMatch(JSON.stringify(inside), /must-not-expose/);
    const parentFrame = await call({ action: "read", frame: ["#outer"] });
    assert.doesNotMatch(JSON.stringify(parentFrame), /must-not-expose-frame-token/);
    await call({ action: "fill", frame, selector: "#inside", text: "Scoped 👋" });
    assert.match((await call({ action: "read", frame })).text || "", /Scoped 👋/);
    assert.doesNotMatch((await call({ action: "read", frame: ["#sibling"] })).text || "", /Scoped 👋/);
    assert.match((await inspect()).text || "", /Parent unchanged/);
    assert.doesNotMatch((await inspect()).text || "", /Parent changed/);
    await assert.rejects(call({ action: "press", key: "Enter" }), /exact requested frame/);
    await assert.rejects(call({ action: "press", frame: ["#outer"], key: "Enter" }), /exact requested frame/);
    await call({ action: "press", frame, selector: "#inside", key: "a" });
    await call({ action: "fill", frame, selector: "#other", text: "Focus moved" });
    await assert.rejects(call({ action: "press", frame, selector: "#inside", key: "Enter" }), /no longer focused/);
    await call({ action: "fill", selector: "#text", text: "Main frame" });
    await assert.rejects(call({ action: "press", frame, key: "Enter" }), /Focus a control/);
    await call({ action: "press", selector: "#text", key: "ArrowLeft" });
    await assert.rejects(call({ action: "read", frame: ["#editor"] }), /iframe elements/);
  } finally {
    await call({ action: "close" }).catch(() => {});
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

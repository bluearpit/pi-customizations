// One request per process: client/native crashes cannot kill the Pi host.
import puppeteer from "puppeteer-core";
import { targetIdentity, trackPopup } from "./targets.mjs";
import { controlDOM } from "./dom.mjs";
import { validateUploadFiles } from "./uploads.mjs";
import { MAX_ELEMENTS, MAX_OPTIONS } from "./limits.mjs";

class Failure extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

async function json(endpoint, path, method = "GET") {
  try {
    const response = await fetch(endpoint + path, { method, signal: AbortSignal.timeout(5000), redirect: "error" });
    if (!response.ok) throw new Failure("BROWSER_UNAVAILABLE", "Brave's classic CDP endpoint is unavailable. Start Brave with local debugging; the inspect permission server is not the same endpoint.");
    return await response.json();
  } catch (error) {
    if (error instanceof Failure) throw error;
    throw new Failure("BROWSER_UNAVAILABLE", "Cannot reach Brave. It must already be running with --remote-debugging-port. The tool will not quit or restart your browser.");
  }
}

async function ownedPage(browser, info) {
  // Target discovery sees metadata, but only the recorded target is operated on.
  for (const target of browser.targets()) {
    if (target.type() !== "page" || targetIdentity(target) !== info.id) continue;
    const session = await target.createCDPSession();
    try {
      const { targetInfo } = await session.send("Target.getTargetInfo");
      if (targetInfo.targetId === info.id) {
        const page = await target.page();
        if (page) return page;
      }
    } finally { await session.detach().catch(() => {}); }
  }
  throw new Failure("PAGE_MISSING", "This session's tab is gone or unavailable. Use open with an explicit URL to recreate it; actions are never replayed into another tab.");
}

async function uniqueElement(page, selector, allowHidden = false) {
  await page.waitForSelector(selector, { visible: !allowHidden, timeout: 7000 });
  const matches = await page.$$(selector);
  if (matches.length !== 1) {
    await Promise.all(matches.map((element) => element.dispose()));
    throw new Failure("SELECTOR", `Selector matches ${matches.length} elements; read the page and choose a unique selector.`);
  }
  return matches[0];
}

async function scopedFrame(page, selectors = []) {
  let frame = page.mainFrame();
  for (const selector of selectors) {
    const element = await uniqueElement(frame, selector);
    try {
      if (!await element.evaluate((node) => node.tagName === "IFRAME")) throw new Failure("INPUT", "frame selectors must identify iframe elements.");
      const child = await element.contentFrame();
      if (!child) throw new Failure("FRAME_MISSING", "The iframe is not available; inspect its parent again.");
      frame = child;
    } finally { await element.dispose(); }
  }
  return frame;
}

async function run(request) {
  const version = await json(request.endpoint, "/json/version");
  const ws = new URL(version.webSocketDebuggerUrl);
  const endpoint = new URL(request.endpoint);
  if (ws.protocol !== "ws:" || !["localhost", "127.0.0.1"].includes(ws.hostname) || ws.port !== endpoint.port || ws.username || ws.password) throw new Failure("CONFIG", "Unexpected nonlocal browser WebSocket.");
  ws.hostname = "127.0.0.1";
  const browserId = ws.pathname;
  if (request.action === "status") return { connected: true, browser: version.Browser, backend: "puppeteer-core", endpoint: request.endpoint };
  if (request.action === "create") {
    if (!/^about:blank#pi-browser-[a-f0-9-]+$/.test(request.url)) throw new Failure("INPUT", "Invalid tab reservation.");
    const targets = await json(request.endpoint, "/json/list");
    // Recover a creation that succeeded before the helper/host died. Never adopt an unrelated tab.
    const existing = targets.find((target) => target.type === "page" && target.url === request.url);
    const created = existing || await json(request.endpoint, "/json/new?" + encodeURIComponent(request.url), "PUT");
    return { targetId: created.id, browserId, url: request.url };
  }
  if (request.action === "discard") {
    const marker = request.record?.url;
    if (!/^about:blank#pi-browser-[a-f0-9-]+$/.test(marker)) throw new Failure("INPUT", "Invalid tab reservation.");
    const targets = await json(request.endpoint, "/json/list");
    const reserved = targets.find((target) => target.type === "page" && target.url === marker);
    if (reserved) {
      const response = await fetch(request.endpoint + "/json/close/" + encodeURIComponent(reserved.id), { signal: AbortSignal.timeout(5000), redirect: "error" });
      if (!response.ok) throw new Failure("CLIENT_ERROR", "Reserved tab could not be closed. Its ownership was retained.");
    }
    return { closed: true, alreadyGone: !reserved };
  }
  let info;
  if (request.action !== "create") {
    if (!request.record || request.record.browserId !== browserId) throw new Failure("PAGE_MISSING", "Brave restarted, or this session has no tab. Use open with an explicit URL; previous form actions are not restored.");
    const targets = await json(request.endpoint, "/json/list");
    info = targets.find((target) => target.type === "page" && target.id === request.record.targetId);
    if (!info) throw new Failure("PAGE_MISSING", "This session's tab was closed. Use open with an explicit URL to recreate it.");
    if (request.action === "probe") return { exists: true };
  }
  const browser = await puppeteer.connect({
    browserWSEndpoint: ws.href,
    protocolTimeout: 10000,
    defaultViewport: null,
    // Exclude unrelated pages/shared workers, independent of URL changes or redirects.
    targetFilter: (target) => ["browser", "tab", "other"].includes(target.type()) || (target.type() === "page" && targetIdentity(target) === info.id),
  });
  let popupGuard;
  const popupIds = new Set();
  const closePopups = async () => {
    if (!popupGuard) return;
    for (const targetId of popupIds) {
      try {
        const reply = await popupGuard.send("Target.closeTarget", { targetId });
        if (reply.success) popupIds.delete(targetId);
        else {
          try { await popupGuard.send("Target.getTargetInfo", { targetId }); }
          catch { popupIds.delete(targetId); } // Already closed by the site/user.
        }
      } catch {
        try { await popupGuard.send("Target.getTargetInfo", { targetId }); }
        catch { popupIds.delete(targetId); } // The site may close its popup before cleanup.
      }
    }
  };
  try {
    const page = await ownedPage(browser, info);
    page.setDefaultTimeout(7000);
    // Never silently accept alert/confirmation dialogs.
    page.on("dialog", (dialog) => { void dialog.dismiss().catch(() => {}); });
    if (["open", "click", "fill", "select", "check", "upload", "press"].includes(request.action)) {
      popupGuard = await browser.target().createCDPSession();
      let active = false;
      const initial = await popupGuard.send("Target.getTargets");
      const initialIds = new Set(initial.targetInfos.map((target) => target.targetId));
      const owned = new Set([request.record.targetId, ...initial.targetInfos.filter((target) => target.targetId.endsWith(":" + request.record.targetId)).map((target) => target.targetId)]);
      popupGuard.on("Target.targetCreated", ({ targetInfo }) => {
        if (!active || !trackPopup(targetInfo, owned, initialIds, request.record.targetId)) return;
        owned.add(targetInfo.targetId);
        popupIds.add(targetInfo.targetId);
      });
      await popupGuard.send("Target.setDiscoverTargets", { discover: true });
      active = true; // Ignore existing targets emitted by initial discovery.
    }
    const finish = async (result) => {
      let blockedPopups = 0;
      if (popupGuard) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        blockedPopups = popupIds.size;
        // Close after the originating input event settles; closing during mouse dispatch can stall CDP.
        await closePopups();
        if (popupIds.size) throw new Failure("POPUP_CLOSE_FAILED", "A popup from the owned page could not be closed. The action may have completed; inspect the browser before retrying.");
      }
      return blockedPopups ? { ...result, blockedPopups } : result;
    };
    const frame = await scopedFrame(page, request.frame);
    const dom = (action, extra = {}) => frame.evaluate(controlDOM, { action, selector: request.selector, maxOptions: MAX_OPTIONS, ...extra });
    let outcome = {};
    if (request.action === "open") {
      await page.goto(request.url, { waitUntil: "domcontentloaded", timeout: 15000 });
    } else if (["click", "fill", "select", "check", "upload"].includes(request.action)) {
      const element = await uniqueElement(frame, request.selector, request.action === "upload");
      try {
        const control = await dom("describe");
        if (control.error || !control.actions.includes(request.action)) throw new Failure("INPUT", control.error || "This control does not support the requested action; inspect its kind, state, and actions.");
        if (request.action === "click") await element.click();
        else if (request.action === "fill") {
          await page.bringToFront(); // Input.insertText requires actual tab focus, not just activeElement.
          const prepared = await dom("prepareFill", { text: request.text });
          if (prepared.error) throw new Failure("INPUT", prepared.error);
          if (!request.text) await page.keyboard.press("Backspace");
          const focused = await dom("focusMatches");
          if (!focused.matches) throw new Failure("INPUT", "The editor lost focus or changed; inspect before typing again.");
          // Insert the whole plaintext as one browser input operation, not Enter/key
          // events per character. Multiline drafts must not trigger Enter-to-send.
          if (request.text) await page.keyboard.sendCharacter(request.text);
          const verified = await dom("verifyFill", { text: request.text });
          if (!verified.matches) throw new Failure("INPUT", "The editor did not accept the complete text. Inspect before repeating fill.");
          outcome = { filled: true, characters: request.text.length };
        } else if (request.action === "select") {
          if (!control.multiple && request.values.length !== 1) throw new Failure("INPUT", "A single-select requires exactly one option value.");
          const valid = await element.evaluate((node, values) => values.every((value) => { const matches = Array.from(node.options).filter((option) => option.value === value); return matches.length === 1 && !matches[0].disabled && !matches[0].parentElement?.disabled; }), request.values);
          if (!valid) throw new Failure("INPUT", "A requested option is missing or disabled; inspect the select again.");
          await element.select(...request.values);
          const selected = await dom("selected");
          if (selected.values.length !== request.values.length || !request.values.every((value) => selected.values.includes(value))) throw new Failure("INPUT", "Selection was not confirmed; inspect before repeating it.");
          outcome = { selected: selected.values };
        } else if (request.action === "check") {
          if (control.kind === "radio" && !request.checked && control.checked) throw new Failure("INPUT", "A radio cannot be unchecked by clicking it; choose another radio instead.");
          const changed = control.checked !== request.checked;
          if (changed) await element.click();
          const verified = await dom("describe");
          if (verified.checked !== request.checked) throw new Failure("INPUT", "Checked state was not confirmed; inspect before repeating it.");
          outcome = { checked: verified.checked, changed };
        } else {
          const paths = await validateUploadFiles(request.paths);
          if (!control.multiple && paths.length !== 1) throw new Failure("INPUT", "This file input only accepts one file.");
          await element.uploadFile(...paths);
          const count = await element.evaluate((node) => node.files.length);
          if (count !== paths.length) throw new Failure("INPUT", "File attachment was not confirmed; inspect before repeating it.");
          outcome = { attachedFiles: count }; // Attachment is not proof of server-side upload success.
        }
      } finally { await element.dispose(); }
    } else if (request.action === "press") {
      await page.bringToFront();
      const focus = await dom("focusedState");
      if (focus.sensitive) throw new Failure("INPUT", "Keyboard input into a sensitive control is refused, even without a selector.");
      if (focus.descendant || request.frame && !focus.focused) throw new Failure("INPUT", "Focus a control in the exact requested frame before pressing a key; descendant-frame focus is not accepted.");
      if (request.selector && !(await dom("focusMatches", { forPress: true })).matches) throw new Failure("INPUT", "The expected control is no longer focused; inspect before pressing a key.");
      if (request.key.startsWith("Shift+")) {
        await page.keyboard.down("Shift");
        try { await page.keyboard.press(request.key.slice(6)); }
        finally { await page.keyboard.up("Shift"); }
      } else await page.keyboard.press(request.key);
    } else if (request.action === "close") {
      await page.close({ runBeforeUnload: false });
      return { closed: true };
    }
    if (request.action === "screenshot") {
      const image = await page.screenshot({ type: "png", fullPage: false, encoding: "base64" });
      if (image.length > 8000000) throw new Failure("OUTPUT_LIMIT", "Screenshot exceeds the output limit.");
      return { url: page.url(), title: await page.title(), image };
    }
    if (request.action === "read") {
      await frame.waitForFunction(() => document.readyState !== "loading", { timeout: 7000 });
      const snapshot = await frame.evaluate(controlDOM, { action: "inspect", selector: request.selector, offset: request.offset || 0, maxChars: request.maxChars || 12000, elementOffset: request.elementOffset || 0, optionOffset: request.optionOffset || 0, maxElements: MAX_ELEMENTS, maxOptions: MAX_OPTIONS });
      if (snapshot.error) throw new Failure("SELECTOR", snapshot.error);
      return { url: page.url(), title: await page.title(), ...(request.frame ? { frame: request.frame, frameOrigin: new URL(frame.url()).origin } : {}), ...snapshot };
    }
    return await finish({ url: page.url(), title: await page.title(), done: true, ...outcome });
  } finally {
    await closePopups();
    await popupGuard?.detach().catch(() => {});
    await browser.disconnect().catch(() => {}); // NEVER browser.close(): Brave belongs to the user.
  }
}

let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 50000) throw new Error("Oversized request");
}
let request;
try {
  request = JSON.parse(input);
  const result = await run(request);
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  const code = error.code || (error.name === "TimeoutError" ? "TIMEOUT" : "CLIENT_ERROR");
  const mutation = request && !["status", "probe", "read", "screenshot"].includes(request.action);
  const message = (error.message || "Browser operation failed").slice(0, 2000) +
    (mutation ? " The action may have partially completed. Read the page before deciding whether to repeat it." : "");
  process.stdout.write(JSON.stringify({ ok: false, code, message }));
}

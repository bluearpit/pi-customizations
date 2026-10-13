// One request per process: client/native crashes cannot kill the Pi host.
import puppeteer from "puppeteer-core";
import { targetIdentity, trackPopup } from "./targets.mjs";

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

async function uniqueElement(page, selector) {
  await page.waitForSelector(selector, { visible: true, timeout: 7000 });
  const matches = await page.$$(selector);
  if (matches.length !== 1) {
    await Promise.all(matches.map((element) => element.dispose()));
    throw new Failure("SELECTOR", `Selector matches ${matches.length} elements; read the page and choose a unique selector.`);
  }
  return matches[0];
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
    if (["open", "click", "fill", "press"].includes(request.action)) {
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
    if (request.action === "open") {
      await page.goto(request.url, { waitUntil: "domcontentloaded", timeout: 15000 });
    } else if (request.action === "click") {
      const element = await uniqueElement(page, request.selector);
      try { await element.click(); } finally { await element.dispose(); }
    } else if (request.action === "fill") {
      const element = await uniqueElement(page, request.selector);
      try {
        const editable = await element.evaluate((node) => node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement);
        if (!editable) throw new Failure("INPUT", "fill supports input and textarea elements only.");
        await element.focus();
        await element.evaluate((node) => {
          const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, "value").set.call(node, "");
          node.dispatchEvent(new Event("input", { bubbles: true }));
        });
        if (request.text) await element.type(request.text);
      } finally { await element.dispose(); }
    } else if (request.action === "press") {
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
      await page.waitForFunction(() => document.readyState !== "loading", { timeout: 7000 });
      const snapshot = await page.evaluate(({ offset, maxChars }) => {
        const all = (document.body?.innerText || "").slice(0, 10000000);
        const selectorFor = (node) => {
          if (node.id && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) return `#${CSS.escape(node.id)}`;
          const parts = [];
          for (let current = node; current && current !== document.body; current = current.parentElement) {
            const tag = current.tagName.toLowerCase();
            const peers = Array.from(current.parentElement?.children || []).filter((child) => child.tagName === current.tagName);
            parts.unshift(`${tag}:nth-of-type(${peers.indexOf(current) + 1})`);
          }
          return "body > " + parts.join(" > ");
        };
        const elements = Array.from(document.querySelectorAll("a,button,input,textarea,select,[role=button]")).filter((node) => node.getClientRects().length).slice(0, 80).map((node) => ({
          selector: selectorFor(node), tag: node.tagName.toLowerCase(),
          label: (node.getAttribute("aria-label") || node.getAttribute("placeholder") || node.innerText || node.getAttribute("type") || "").slice(0, 120),
        }));
        return { text: all.slice(offset, offset + maxChars), totalChars: all.length, nextOffset: offset + maxChars < all.length ? offset + maxChars : undefined, elements };
      }, { offset: request.offset || 0, maxChars: request.maxChars || 12000 });
      return { url: page.url(), title: await page.title(), ...snapshot };
    }
    return await finish({ url: page.url(), title: await page.title(), done: true });
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

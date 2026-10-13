import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import { DEFAULT_CDP_ENDPOINT, MAX_URL_CHARS, BrowserError, readOnly, validateEndpoint, validateRequest, validateUrl, type BrowserRequest, type BrowserResult, type PageRecord, type WorkerRequest } from "./protocol.js";

export interface BrowserOptions {
  endpoint?: string;
  stateDir?: string;
  lockDir?: string;
  workerPath?: string;
  timeoutMs?: number;
  lockWaitMs?: number;
  signal?: AbortSignal;
}
interface State { pages: Record<string, PageRecord> }
const defaultWorker = fileURLToPath(new URL("./worker.mjs", import.meta.url));
const cancelled = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new BrowserError("CANCELLED", "Browser request cancelled. If an action was in flight, inspect before retrying.");
};
const delay = async (ms: number, signal?: AbortSignal) => {
  cancelled(signal);
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(new BrowserError("CANCELLED", "Browser request cancelled.")); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
};

export async function runWorker(request: WorkerRequest, options: BrowserOptions = {}): Promise<BrowserResult> {
  cancelled(options.signal);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [options.workerPath || defaultWorker], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let failure: BrowserError | undefined;
    const fail = (error: BrowserError) => { failure ||= error; child.kill("SIGKILL"); };
    const abort = () => fail(new BrowserError("CANCELLED", "Browser operation cancelled. Inspect before retrying any action."));
    const timer = setTimeout(() => fail(new BrowserError("WORKER_TIMEOUT", "Browser worker exceeded its deadline. An action may have completed; inspect before repeating it.")), options.timeoutMs ?? 25000);
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > 10000000) fail(new BrowserError("OUTPUT_LIMIT", "Browser output exceeded its limit."));
    });
    // Drain diagnostics, but do not send unrelated tab URLs or stacks to the model.
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.on("error", () => { failure ||= new BrowserError("WORKER_CRASH", "Browser worker could not start."); });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (failure) { reject(failure); return; }
      if (code !== 0) { reject(new BrowserError("WORKER_CRASH", "Browser client crashed. Pi is still running. Inspect before repeating any action.")); return; }
      try {
        const reply = JSON.parse(stdout);
        if (reply.ok === false && typeof reply.code === "string" && typeof reply.message === "string") throw new BrowserError(reply.code, reply.message);
        if (reply.ok !== true || !reply.result || typeof reply.result !== "object" || Array.isArray(reply.result)) throw new Error("Invalid response");
        resolve(reply.result as BrowserResult);
      } catch (error) {
        reject(error instanceof BrowserError ? error : new BrowserError("WORKER_CRASH", "Browser client returned an invalid response."));
      }
    });
    child.stdin.end(JSON.stringify(request));
    if (options.signal?.aborted) abort();
  });
}

async function callWorker(request: WorkerRequest, options: BrowserOptions): Promise<BrowserResult> {
  // Reads can reconnect once. NEVER retry create/navigation/click/fill/press/close.
  for (let attempt = 0; ; attempt++) {
    try { return await runWorker(request, options); }
    catch (error) {
      if (attempt > 0 || !readOnly(request.action) || !(error instanceof BrowserError) || !["WORKER_CRASH", "WORKER_TIMEOUT", "CLIENT_ERROR", "TIMEOUT"].includes(error.code)) throw error;
      await delay(200, options.signal);
    }
  }
}
async function loadState(path: string): Promise<State> {
  try {
    const raw = await readFile(path, "utf8");
    if (raw.length > 1000000) throw new Error("Oversized state");
    const data = JSON.parse(raw);
    if (!data.pages || typeof data.pages !== "object" || Array.isArray(data.pages) || Object.keys(data.pages).length > 20) throw new Error("Invalid state");
    for (const [name, record] of Object.entries(data.pages)) {
      const page = record as PageRecord;
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name) || !page || typeof page !== "object" ||
        typeof page.targetId !== "string" || typeof page.browserId !== "string" || typeof page.url !== "string" ||
        page.targetId.length > 200 || page.browserId.length > 200 || page.url.length > MAX_URL_CHARS ||
        (!page.targetId && (page.browserId || !/^about:blank#pi-browser-[a-f0-9-]+$/.test(page.url)))) throw new Error("Invalid page state");
    }
    return { pages: Object.assign(Object.create(null), data.pages) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { pages: Object.create(null) };
    throw new BrowserError("STATE", "Browser state cannot be read. It was not reset, to avoid duplicating or stealing tabs.");
  }
}
async function saveState(path: string, state: State): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, JSON.stringify(state), { mode: 0o600 }); await rename(temp, path); }
  finally { await rm(temp, { force: true }); }
}
async function acquire(path: string, options: BrowserOptions, controller: AbortController): Promise<() => Promise<void>> {
  const deadline = Date.now() + (options.lockWaitMs ?? 70000);
  while (true) {
    cancelled(controller.signal);
    try {
      return await lockfile.lock(path, {
        realpath: false, stale: 60000, update: 5000, retries: 0,
        onCompromised: () => controller.abort(new BrowserError("LOCK", "Session browser lock lost; request stopped.")),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
      if (Date.now() >= deadline) throw new BrowserError("BUSY", "Another operation owns this session's browser. Try again after it settles.");
      await delay(100, controller.signal);
    }
  }
}

export async function runBrowser(request: BrowserRequest, sessionId: string, options: BrowserOptions = {}): Promise<BrowserResult> {
  validateRequest(request);
  if (!sessionId) throw new BrowserError("SESSION", "A Pi session ID is required.");
  const endpoint = validateEndpoint(options.endpoint || process.env.PI_BROWSER_CDP_URL || DEFAULT_CDP_ENDPOINT);
  const root = options.stateDir || join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "browser-state");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, createHash("sha256").update(sessionId).digest("hex") + ".json");
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  let release: (() => Promise<void>) | undefined;
  let releaseBrowser: (() => Promise<void>) | undefined;
  const workerOptions = { ...options, signal: controller.signal };
  try {
    release = await acquire(path, options, controller);
    const lockRoot = options.lockDir || process.env.PI_BROWSER_LOCK_DIR || root;
    await mkdir(lockRoot, { recursive: true, mode: 0o700 });
    // Multiple CDP clients can interfere with target auto-attachment/focus. One Pi operation per browser.
    const browserLock = join(lockRoot, "endpoint-" + createHash("sha256").update(endpoint).digest("hex"));
    releaseBrowser = await acquire(browserLock, options, controller);
    const state = await loadState(path);
    const name = request.page || "main";
    if (request.action === "status") {
      const result = await callWorker({ action: "status", endpoint }, workerOptions);
      return { ...result, pages: Object.keys(state.pages) }; // Names only, never foreign tab URLs.
    }
    let record: PageRecord | undefined = state.pages[name];
    if (request.action === "open") {
      if (record?.targetId) {
        try { await callWorker({ action: "probe", endpoint, record }, workerOptions); }
        catch (error) {
          if (!(error instanceof BrowserError) || error.code !== "PAGE_MISSING") throw error;
          delete state.pages[name];
          await saveState(path, state);
          record = undefined;
        }
      }
      if (!record?.targetId) {
        if (!record && Object.keys(state.pages).length >= 20) throw new BrowserError("PAGE_LIMIT", "Close an owned tab before opening more (20 per session).");
        record ||= { targetId: "", browserId: "", url: `about:blank#pi-browser-${randomUUID()}` };
        state.pages[name] = record;
        // Durable reservation lets a later explicit open adopt a tab created before a crash.
        await saveState(path, state);
        const created = await callWorker({ action: "create", endpoint, url: record.url }, workerOptions);
        if (typeof created.targetId !== "string" || typeof created.browserId !== "string") throw new BrowserError("WORKER_CRASH", "Created tab identity was not returned. The reservation is saved; inspect before retrying open.");
        record = { targetId: created.targetId, browserId: created.browserId, url: record.url };
        state.pages[name] = record;
        // Persist BEFORE navigation: a timeout must not lose ownership and duplicate the tab.
        await saveState(path, state);
      }
    }
    if (!record) throw new BrowserError("PAGE_MISSING", `No owned tab named ${name}. Use open with a URL first.`);
    let result: BrowserResult;
    try { result = await callWorker({ ...request, url: request.url ? validateUrl(request.url) : undefined, action: request.action === "close" && !record.targetId ? "discard" : request.action, record, endpoint }, workerOptions); }
    catch (error) {
      if (request.action !== "close" || !(error instanceof BrowserError) || error.code !== "PAGE_MISSING" || !record.targetId) throw error;
      result = { closed: true, alreadyGone: true };
    }
    cancelled(controller.signal);
    // URLs are display metadata, not tab identity. A page can pushState a URL beyond our input limit.
    if (typeof result.url === "string" && result.url.length > MAX_URL_CHARS) result = { ...result, url: result.url.slice(0, MAX_URL_CHARS), urlTruncated: true };
    if (request.action === "close") delete state.pages[name];
    else if (typeof result.url === "string") record.url = result.url;
    await saveState(path, state);
    return { page: name, ...result };
  } finally {
    await releaseBrowser?.().catch(() => {});
    await release?.().catch(() => {});
    options.signal?.removeEventListener("abort", abort);
  }
}

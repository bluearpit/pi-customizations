export const DEFAULT_CDP_ENDPOINT = "http://127.0.0.1:9222";
export const MAX_URL_CHARS = 16384;
const pageKeys = new Set(["Enter", "Tab", "Backspace", "Delete", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Space", "Shift+Tab", "Shift+Enter"]);
export const actions = ["status", "open", "read", "click", "fill", "press", "screenshot", "close"] as const;
export type BrowserAction = typeof actions[number];
export interface BrowserRequest {
  action: BrowserAction;
  page?: string;
  url?: string;
  selector?: string;
  text?: string;
  key?: string;
  offset?: number;
  maxChars?: number;
}
export interface PageRecord {
  targetId: string;
  browserId: string;
  url: string;
}
export interface WorkerRequest {
  action: BrowserAction | "create" | "probe" | "discard";
  endpoint: string;
  record?: PageRecord;
  url?: string;
  selector?: string;
  text?: string;
  key?: string;
  offset?: number;
  maxChars?: number;
}
export interface BrowserResult {
  page?: string;
  targetId?: string;
  browserId?: string;
  url?: string;
  title?: string;
  text?: string;
  totalChars?: number;
  nextOffset?: number;
  elements?: Array<{ selector: string; tag: string; label: string }>;
  image?: string;
  [key: string]: unknown;
}
export class BrowserError extends Error {
  constructor(public readonly code: string, message: string) { super(`${code}: ${message}`); }
}
export const readOnly = (action: WorkerRequest["action"]) => ["status", "probe", "read", "screenshot"].includes(action);

export function validateEndpoint(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new BrowserError("CONFIG", "CDP must be http://127.0.0.1:<port>, without credentials or a path.");
  }
  return url.origin;
}
export function validateUrl(raw: string): string {
  const url = new URL(raw);
  if (raw.length > MAX_URL_CHARS || !["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new BrowserError("INPUT", "Only HTTP(S) navigation without embedded credentials is supported.");
  }
  return url.href;
}
export function validateRequest(request: BrowserRequest): void {
  if (!actions.includes(request.action)) throw new BrowserError("INPUT", "Unknown browser action.");
  if (request.page !== undefined && !/^[a-zA-Z0-9_-]{1,64}$/.test(request.page)) throw new BrowserError("INPUT", "Use a short alphanumeric page name.");
  if (request.action === "open") {
    if (!request.url) throw new BrowserError("INPUT", "open requires url.");
    validateUrl(request.url);
  }
  if (["click", "fill"].includes(request.action) && (!request.selector || request.selector.length > 2000)) throw new BrowserError("INPUT", "A CSS selector of at most 2000 characters is required.");
  if (request.action === "fill" && (typeof request.text !== "string" || request.text.length > 10000)) throw new BrowserError("INPUT", "fill requires text (at most 10000 characters).");
  if (request.action === "press" && (!request.key || (!pageKeys.has(request.key) && !/^[a-zA-Z0-9]$/.test(request.key)))) throw new BrowserError("INPUT", "Only page-safe keys are supported, e.g. Enter, Tab, arrows or a single alphanumeric character. Browser/OS shortcuts are blocked.");
  for (const [name, value, max] of [["offset", request.offset, 10000000], ["maxChars", request.maxChars, 20000]] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < (name === "maxChars" ? 1 : 0) || value > max)) throw new BrowserError("INPUT", `Invalid ${name}.`);
  }
}

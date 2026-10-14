import { isAbsolute } from "node:path";
import { MAX_URL_CHARS, MAX_SELECTOR_CHARS, MAX_TEXT_CHARS, MAX_OPTIONS, MAX_FRAMES, MAX_FILES, MAX_PATH_CHARS } from "./limits.mjs";
export { MAX_URL_CHARS } from "./limits.mjs";
export const DEFAULT_CDP_ENDPOINT = "http://127.0.0.1:9222";
const pageKeys = new Set(["Enter", "Tab", "Backspace", "Delete", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Space", "Shift+Tab", "Shift+Enter"]);
export const actions = ["status", "open", "read", "click", "fill", "select", "check", "upload", "press", "screenshot", "close"] as const;
export type BrowserAction = typeof actions[number];
export interface BrowserRequest {
  action: BrowserAction;
  page?: string;
  url?: string;
  selector?: string;
  frame?: string[];
  text?: string;
  values?: string[];
  checked?: boolean;
  paths?: string[];
  key?: string;
  offset?: number;
  maxChars?: number;
  elementOffset?: number;
  optionOffset?: number;
}
export interface PageRecord {
  targetId: string;
  browserId: string;
  url: string;
}
export interface WorkerRequest extends Omit<BrowserRequest, "action" | "page"> {
  action: BrowserAction | "create" | "probe" | "discard";
  endpoint: string;
  record?: PageRecord;
}
export interface BrowserElement {
  selector: string;
  tag: string;
  label: string;
  kind?: string;
  type?: string;
  role?: string;
  visible?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  sensitive?: boolean;
  editable?: boolean;
  checked?: boolean | "mixed";
  empty?: boolean;
  actions?: string[];
  multiple?: boolean;
  options?: Array<{ value: string; label: string; selected: boolean; disabled: boolean }>;
  optionsTruncated?: boolean;
  optionCount?: number;
  nextOptionOffset?: number;
  accept?: string;
  name?: string;
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
  elements?: BrowserElement[];
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
  if ((["click", "fill", "select", "check", "upload"].includes(request.action) || request.selector !== undefined) && (typeof request.selector !== "string" || !request.selector || request.selector.length > MAX_SELECTOR_CHARS)) throw new BrowserError("INPUT", "A unique CSS selector is required.");
  if (request.frame !== undefined && (!Array.isArray(request.frame) || request.frame.length < 1 || request.frame.length > MAX_FRAMES || !["read", "click", "fill", "select", "check", "upload", "press"].includes(request.action) || request.frame.some((selector) => typeof selector !== "string" || !selector || selector.length > MAX_SELECTOR_CHARS))) throw new BrowserError("INPUT", "frame requires 1–4 unique iframe selectors, outermost first, for read or control actions.");
  if (request.action === "fill" && (typeof request.text !== "string" || request.text.length > MAX_TEXT_CHARS)) throw new BrowserError("INPUT", "fill requires text (at most 10000 characters).");
  if (request.action === "select" && (!Array.isArray(request.values) || request.values.length > MAX_OPTIONS || request.values.some((value) => typeof value !== "string" || value.length > MAX_SELECTOR_CHARS) || new Set(request.values).size !== request.values.length)) throw new BrowserError("INPUT", "select requires distinct option values (at most 50).");
  if (request.action === "check" && typeof request.checked !== "boolean") throw new BrowserError("INPUT", "check requires a desired checked boolean.");
  if (request.action === "upload" && (!Array.isArray(request.paths) || request.paths.length < 1 || request.paths.length > MAX_FILES || request.paths.some((path) => typeof path !== "string" || !isAbsolute(path) || path.length > MAX_PATH_CHARS || path.includes("\0")))) throw new BrowserError("INPUT", "upload requires 1–5 absolute file paths explicitly approved by the user.");
  if (request.action === "press" && (!request.key || (!pageKeys.has(request.key) && !/^[a-zA-Z0-9]$/.test(request.key)))) throw new BrowserError("INPUT", "Only page-safe keys are supported, e.g. Enter, Tab, arrows or a single alphanumeric character. Browser/OS shortcuts are blocked.");
  for (const [name, value, max] of [["offset", request.offset, 10000000], ["maxChars", request.maxChars, 20000], ["elementOffset", request.elementOffset, 1000000], ["optionOffset", request.optionOffset, 1000000]] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < (name === "maxChars" ? 1 : 0) || value > max)) throw new BrowserError("INPUT", `Invalid ${name}.`);
  }
}

// Puppeteer serializes this function into the selected frame. Keep it closure-free:
// no module globals, imports, or page-provided executable strings.
export function controlDOM(request) {
  const selectorFor = (node) => {
    if (node === document.body) return "body";
    if (node.id && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) return `#${CSS.escape(node.id)}`;
    const parts = [];
    for (let current = node; current && current !== document.body; current = current.parentElement) {
      const tag = current.tagName.toLowerCase();
      const peers = Array.from(current.parentElement?.children || []).filter((child) => child.tagName === current.tagName);
      parts.unshift(`${tag}:nth-of-type(${peers.indexOf(current) + 1})`);
    }
    return "body > " + parts.join(" > ");
  };
  const sensitiveNode = (node) => node.matches('input[type="password" i]') || /(?:password|one-time-code|cc-)/i.test(node.getAttribute("autocomplete") || "");
  const sensitiveControl = (node) => {
    for (let current = node; current; current = current.parentElement || current.getRootNode()?.host) if (sensitiveNode(current)) return true;
    return false;
  };
  // Never temporarily mutate live controls to redact a read: that could trigger
  // framework observers/autosave. Recurse only around protected subtrees, using
  // rendered innerText for ordinary branches (not hidden script/textContent).
  const renderedText = (node) => {
    if (!node) return "";
    const style = getComputedStyle(node);
    if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(node.tagName) || style.display === "none" || style.visibility === "hidden") return "";
    if (sensitiveControl(node)) return "[sensitive control]";
    if (!Array.from(node.querySelectorAll('[autocomplete],input[type="password" i]')).some(sensitiveNode)) return node.innerText || "";
    return Array.from(node.childNodes).map((child) => child.nodeType === Node.TEXT_NODE ? child.textContent : child.nodeType === Node.ELEMENT_NODE ? renderedText(child) : "").join("\n");
  };
  const describe = (node) => {
    const tag = node.tagName.toLowerCase();
    const type = node instanceof HTMLInputElement ? node.type : undefined;
    const role = node.getAttribute("role") || undefined;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    const visible = rect.width > 0 && rect.height > 0 && !["hidden", "collapse"].includes(style.visibility);
    const disabled = node.matches(":disabled") || !!node.closest('[aria-disabled="true"],[inert]');
    const readOnly = node.readOnly === true || !!node.closest('[aria-readonly="true"]');
    const sensitive = sensitiveControl(node);
    const labelled = (node.getAttribute("aria-labelledby") || "").split(/\s+/).map((id) => renderedText(document.getElementById(id))).join(" ").trim();
    const label = sensitive ? "[sensitive control]" : (node.getAttribute("aria-label") || labelled || Array.from(node.labels || []).map(renderedText).join(" ") || node.getAttribute("placeholder") || node.getAttribute("title") || renderedText(node) || type || "").trim().slice(0, 120);
    const editable = node.isContentEditable;
    const nativeCheck = type === "checkbox" || type === "radio";
    const ariaCheck = ["checkbox", "radio", "switch"].includes(role);
    const checked = nativeCheck ? (node.indeterminate ? "mixed" : node.checked) : ariaCheck ? (node.getAttribute("aria-checked") === "mixed" ? "mixed" : node.getAttribute("aria-checked") === "true" ? true : node.getAttribute("aria-checked") === "false" ? false : undefined) : undefined;
    const kind = tag === "iframe" ? "iframe" : type === "file" ? "file" : nativeCheck || ariaCheck ? (type || role) : tag === "select" ? "select" : editable ? "rich-text" : tag === "textarea" || tag === "input" || role === "textbox" ? "text" : role || tag;
    const fillable = !sensitive && (editable || tag === "textarea" || (tag === "input" && ["text", "search", "email", "tel", "url", "number"].includes(type)));
    const actions = [];
    if (!disabled && visible && !sensitive && tag !== "iframe") actions.push("click");
    if (!disabled && !readOnly && visible && fillable) actions.push("fill");
    if (!sensitive && !disabled && !readOnly && visible && tag === "select") actions.push("select");
    if (!sensitive && !disabled && !readOnly && visible && typeof checked === "boolean") actions.push("check");
    if (!sensitive && !disabled && !readOnly && type === "file") actions.push("upload"); // Native file inputs are often hidden.
    const result = { selector: selectorFor(node), tag, label, kind, type, role, visible, disabled, readOnly, sensitive, editable, checked: sensitive ? undefined : checked, actions };
    // Never expose text-field values, password contents, or local file paths.
    if (!sensitive && (editable || tag === "textarea" || tag === "input" && fillable)) result.empty = !(editable ? node.textContent : node.value);
    if (tag === "select" && !sensitive) {
      result.multiple = node.multiple;
      const start = request.optionOffset || 0;
      result.options = Array.from(node.options).slice(start, start + request.maxOptions).map((option) => ({ value: option.value.slice(0, 2000), label: option.label.slice(0, 120), selected: option.selected, disabled: option.disabled || option.parentElement?.disabled === true }));
      result.optionCount = node.options.length;
      result.nextOptionOffset = start + request.maxOptions < node.options.length ? start + request.maxOptions : undefined;
      result.optionsTruncated = start > 0 || node.options.length > request.maxOptions;
    }
    if (tag === "iframe" && !sensitive) result.name = (node.getAttribute("name") || "").slice(0, 120);
    if (type === "file" && !sensitive) { result.multiple = node.multiple; result.accept = (node.accept || "").slice(0, 200); }
    return result;
  };
  if (request.action === "inspect") {
    let root = document.body;
    if (request.selector) {
      const matches = document.querySelectorAll(request.selector);
      if (matches.length !== 1) return { error: "Inspection requires a unique selector; inspect the parent again." };
      root = matches[0];
    }
    const all = renderedText(root).slice(0, 10000000);
    const query = 'a,button,input,textarea,select,iframe,[contenteditable],[role="textbox"],[role="button"],[role="checkbox"],[role="radio"],[role="switch"],[role="combobox"],[role="listbox"],[role="option"]';
    const nodes = root ? [...(root.matches(query) ? [root] : []), ...root.querySelectorAll(query)] : [];
    const described = nodes.map(describe).filter((node) => node.visible || node.type === "file");
    // Controls first: a long navigation/feed must not crowd an editor out of the snapshot.
    const priority = (node) => ["text", "rich-text", "select", "file", "checkbox", "radio", "switch", "iframe", "combobox", "listbox", "textbox"].includes(node.kind);
    described.sort((a, b) => Number(priority(b)) - Number(priority(a)));
    const start = request.elementOffset || 0;
    return { text: all.slice(request.offset, request.offset + request.maxChars), totalChars: all.length, nextOffset: request.offset + request.maxChars < all.length ? request.offset + request.maxChars : undefined, elements: described.slice(start, start + request.maxElements), elementCount: described.length, nextElementOffset: start + request.maxElements < described.length ? start + request.maxElements : undefined, elementsTruncated: start > 0 || described.length > request.maxElements };
  }
  if (request.action === "focusedState") {
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    return { focused: document.hasFocus() && active !== document.body, descendant: ["IFRAME", "FRAME"].includes(active?.tagName), sensitive: active ? sensitiveControl(active) : false };
  }
  const matches = document.querySelectorAll(request.selector);
  if (matches.length !== 1) return { error: "The control changed or the selector is not unique; inspect again." };
  const node = matches[0];
  const control = describe(node);
  if (request.action === "describe") return control;
  if (request.action === "focusMatches") return { matches: (request.forPress ? !control.disabled && !control.sensitive && control.visible : control.actions.includes("fill")) && (document.activeElement === node || node.contains(document.activeElement)) };
  if (request.action === "prepareFill") {
    if (!control.actions.includes("fill")) return { error: "This control cannot be filled (unsupported, disabled, readonly, hidden, or sensitive)." };
    if (node instanceof HTMLInputElement && /[\r\n]/.test(request.text)) return { error: "A single-line input cannot accept newlines." };
    node.focus();
    if (document.activeElement !== node && !node.contains(document.activeElement)) return { error: "The editor could not retain focus; inspect again." };
    if (control.editable) {
      const selection = window.getSelection();
      if (!selection) return { error: "The editor has no text selection." };
      const range = document.createRange();
      range.selectNodeContents(node);
      selection.removeAllRanges();
      selection.addRange(range);
    } else node.select(); // Replace in one native input event; never autosave a transient empty value.
    return { editable: control.editable };
  }
  if (request.action === "verifyFill") {
    const normalize = (text) => text.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");
    const actual = control.editable ? (node.textContent === "" && node.innerText === "\n" ? "" : node.innerText) : node.value;
    return { matches: typeof actual === "string" && normalize(actual) === normalize(request.text) };
  }
  if (request.action === "selected") return { values: Array.from(node.selectedOptions || []).map((option) => option.value) };
  return { error: "Unsupported DOM operation." };
}

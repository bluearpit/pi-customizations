import { realpath, stat } from "node:fs/promises";
import { isAbsolute, normalize, sep } from "node:path";
import { MAX_FILES, MAX_PATH_CHARS, MAX_FILE_BYTES, MAX_UPLOAD_BYTES } from "./limits.mjs";

const fail = (message) => { throw Object.assign(new Error(message), { code: "INPUT" }); };
const privatePath = (path) => normalize(path).split(sep).some((part) => part.startsWith(".") || /^(?:auth\.json|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/i.test(part) || /(?:\.env(?:\..*)?|\.(?:pem|key|p12|pfx|keystore))$/i.test(part));

// Name-based defense in depth, not a secret scanner or filesystem sandbox.
// Never read file contents into Pi. Chromium receives only validated paths.
export async function validateUploadFiles(paths) {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > MAX_FILES) fail(`Upload requires 1–${MAX_FILES} explicitly approved files.`);
  const resolved = [];
  let total = 0;
  for (const path of paths) {
    if (typeof path !== "string" || !isAbsolute(path) || path.length > MAX_PATH_CHARS || path.includes("\0") || privatePath(path)) fail("Upload requires absolute, non-hidden, non-credential file paths.");
    let canonical;
    let info;
    try {
      canonical = await realpath(path);
      if (privatePath(canonical)) fail("The upload resolves to a hidden or credential path.");
      info = await stat(canonical);
    } catch (error) {
      if (error.code === "INPUT") throw error;
      fail("An upload file cannot be accessed.");
    }
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_FILE_BYTES) fail(`Upload requires non-hardlinked regular files of at most ${MAX_FILE_BYTES / 1024 ** 2} MiB each.`);
    total += info.size;
    if (total > MAX_UPLOAD_BYTES) fail(`Uploads exceed the ${MAX_UPLOAD_BYTES / 1024 ** 2} MiB total limit.`);
    if (resolved.includes(canonical)) fail("Choose distinct upload files.");
    resolved.push(canonical);
  }
  return resolved;
}

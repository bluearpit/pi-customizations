import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, symlink, link, open, realpath, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateUploadFiles } from "../extensions/browser/uploads.mjs";
import { MAX_FILE_BYTES } from "../extensions/browser/limits.mjs";

test("upload paths require bounded, distinct regular files and refuse credential aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-browser-uploads-"));
  try {
    const file = join(root, "approved.txt");
    await writeFile(file, "explicitly approved fixture");
    assert.equal((await validateUploadFiles([file])).length, 1);
    const publicAlias = join(root, "public-alias.txt");
    await symlink(file, publicAlias);
    assert.deepEqual(await validateUploadFiles([publicAlias]), [await realpath(file)]);
    await assert.rejects(validateUploadFiles([file, publicAlias]), /distinct/);
    // The validator is not a content scanner or a file/inode pin: a trusted local
    // writer can change an innocuously named file after validation. Document it.
    const approved = await validateUploadFiles([file]);
    await writeFile(file, "dummy sensitive-looking data written after validation");
    assert.equal(await readFile(approved[0], "utf8"), "dummy sensitive-looking data written after validation");
    assert.equal((await validateUploadFiles([file])).length, 1);
    await mkdir(join(root, ".private"));
    const privateFile = join(root, ".private", "token.txt");
    await writeFile(privateFile, "dummy test data only");
    const alias = join(root, "alias.txt");
    await symlink(privateFile, alias);
    const hardAlias = join(root, "hard-alias.txt");
    await link(privateFile, hardAlias);
    for (const paths of [[], Array(6).fill(file), [file, file], [root], ["relative.txt"], [alias], [hardAlias], [join(root, "auth.json")], [join(root, "telegram-pi.env")], [join(root, "private.key")], [join(root, "missing.txt")]]) {
      await assert.rejects(validateUploadFiles(paths), /INPUT|absolute|Upload|upload|hidden|credential|distinct|regular|accessed|linked/);
    }
    const large = join(root, "large.bin");
    const handle = await open(large, "w");
    try { await handle.truncate(MAX_FILE_BYTES + 1); } finally { await handle.close(); }
    await assert.rejects(validateUploadFiles([large]), /regular files/);
    const sized = [];
    for (let i = 0; i < 3; i++) {
      const path = join(root, `bounded-${i}.bin`);
      const handle = await open(path, "w");
      try { await handle.truncate(MAX_FILE_BYTES); } finally { await handle.close(); }
      sized.push(path);
    }
    await assert.rejects(validateUploadFiles(sized), /total limit/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

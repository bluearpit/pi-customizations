import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { snapshotMessages } from "../extensions/side.js";

test("side chat snapshots the active messages without passing system patches as turns", () => {
  const original = [
    { role: "system", content: "Prompt instructions", timestamp: 1 },
    { role: "compactionSummary", summary: "Keep this decision", tokensBefore: 100, timestamp: 2 },
    { role: "user", content: [{ type: "text", text: "Question" }], timestamp: 3 },
  ] as AgentMessage[];
  const snapshot = snapshotMessages(original);
  assert.equal(snapshot.length, 2);
  assert.equal(snapshot[0].role, "user");
  assert.match(JSON.stringify(snapshot[0]), /Keep this decision/);
  assert.equal(snapshot[1].role, "user");
  assert.equal(original.length, 3);
  assert.equal(original[0].role, "system");
});

import assert from "node:assert/strict";
import test from "node:test";
import { WorkJournal, WorkPersistenceError } from "./work-memory.ts";

const evidence = { citations: [{ messageId: 7, messageIdentifier: "source-7" }], fileCitations: [] };

test("#3770 lost acknowledgement retries the same record before subsequent work", async () => {
  const stored = new Map<number, unknown>();
  const writes: number[] = [];
  let failures = 0;
  const journal = new WorkJournal(async (record) => {
    const sequence = record.sequence as number;
    writes.push(sequence);
    if (stored.has(sequence)) assert.deepEqual(stored.get(sequence), record);
    stored.set(sequence, structuredClone(record));
    if (writes.length === 1) throw new Error("connection lost after commit");
    return { sequence };
  }, () => evidence, () => { failures++; });
  await Promise.all([
    journal.tool("echo_inbox_messages", { cursor: "page-2" }, "verified source", evidence),
    journal.checkpoint("Source 7 found; page 2 remains unread"),
  ]);
  assert.deepEqual(writes, [1, 1, 2]);
  assert.equal((stored.get(2) as any).coversThrough, 1);
  assert.equal(failures, 0);
});

test("#3770 persistence failure prevents later research from silently losing work", async () => {
  let writes = 0;
  let stopped = false;
  const journal = new WorkJournal(async () => { writes++; throw new Error("database unavailable"); }, () => evidence, () => { stopped = true; });
  await assert.rejects(journal.tool("echo_inbox_messages", {}, "first result", evidence), WorkPersistenceError);
  await assert.rejects(journal.checkpoint("must not replace previous checkpoint"), WorkPersistenceError);
  assert.equal(writes, 2);
  assert.equal(stopped, true);
});

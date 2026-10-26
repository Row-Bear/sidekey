import { test } from "node:test";
import assert from "node:assert/strict";
import { addSavedCall, parseSavedCalls, removeSavedCall, renameSavedCall, MAX_SAVED_CALLS, type SavedCall } from "./savedCalls.ts";

const call = (fn: string, args: string[] = [], signer = "master") => ({ contract: "C1", function: fn, args, signer });

test("adds calls per account and rejects duplicates", () => {
  let saved: SavedCall[] = addSavedCall([], "A", "claim", call("claim", ["x"]));
  assert.throws(() => addSavedCall(saved, "A", "again", call("claim", ["x"])), /already saved/);
  saved = addSavedCall(saved, "B", "claim", call("claim", ["x"])); // same call, other account
  saved = addSavedCall(saved, "A", "other args", call("claim", ["y"]));
  assert.equal(saved.length, 3);
});

test("limits each account to six calls", () => {
  let saved: SavedCall[] = [];
  for (let i = 0; i < MAX_SAVED_CALLS; i++) saved = addSavedCall(saved, "A", `c${i}`, call("f", [String(i)]));
  assert.throws(() => addSavedCall(saved, "A", "seventh", call("f", ["7"])), /at most 6/);
  assert.equal(addSavedCall(saved, "B", "ok", call("f")).length, 7);
});

test("validates the name", () => {
  assert.throws(() => addSavedCall([], "A", "  ", call("f")), /name/);
  assert.throws(() => addSavedCall([], "A", "x".repeat(31), call("f")), /30/);
});

test("removes and renames by the account's own index", () => {
  let saved: SavedCall[] = [];
  saved = addSavedCall(saved, "A", "a0", call("f", ["0"]));
  saved = addSavedCall(saved, "B", "b0", call("f", ["0"]));
  saved = addSavedCall(saved, "A", "a1", call("f", ["1"]));
  assert.deepEqual(removeSavedCall(saved, "A", 1).map((s) => s.label), ["a0", "b0"]);
  assert.deepEqual(renameSavedCall(saved, "A", 1, "new").map((s) => s.label), ["a0", "b0", "new"]);
  assert.deepEqual(renameSavedCall(saved, "A", 1, " ").map((s) => s.label), ["a0", "b0", "a1"]);
  assert.equal(removeSavedCall(saved, "A", 5).length, 3);
});

test("parsing drops malformed entries and survives bad input", () => {
  assert.deepEqual(parseSavedCalls("not json"), []);
  assert.deepEqual(parseSavedCalls(null), []);
  const raw = JSON.stringify([
    { account: "A", label: "ok", call: call("f") },
    { account: "A", label: "", call: call("f") },
    { account: "A", label: "bad args", call: { ...call("f"), args: [1] } },
    { label: "no account", call: call("f") },
  ]);
  assert.deepEqual(parseSavedCalls(raw).map((s) => s.label), ["ok"]);
});

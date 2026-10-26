import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import {
  addSaved,
  BLENT_BACKSTOP,
  BLENT_FIXED_POOL,
  builtInEntries,
  MAX_LABEL_LENGTH,
  MAX_SAVED_ENTRIES,
  parseSaved,
  removeSaved,
  renameSaved,
} from "./addressBook.ts";

const contractId = () => StrKey.encodeContract(Buffer.from(Keypair.random().rawPublicKey()));

describe("builtInEntries", () => {
  it("lists the simulator, the native asset and the two Blent contracts", () => {
    const [simulator, nativeToken] = [contractId(), contractId()];
    const entries = builtInEntries({ simulator, nativeToken });
    assert.deepEqual(
      entries.map((e) => e.id),
      [simulator, nativeToken, BLENT_FIXED_POOL, BLENT_BACKSTOP],
    );
    assert.ok(entries.every((e) => e.builtIn && e.label !== ""));
  });

  it("has valid, distinct contract addresses", () => {
    assert.ok(StrKey.isValidContract(BLENT_FIXED_POOL));
    assert.ok(StrKey.isValidContract(BLENT_BACKSTOP));
    assert.notEqual(BLENT_FIXED_POOL, BLENT_BACKSTOP);
  });

  it("leaves out the server's contracts until they are known", () => {
    assert.deepEqual(builtInEntries(null).map((e) => e.id), [BLENT_FIXED_POOL, BLENT_BACKSTOP]);
  });
});

describe("parseSaved", () => {
  const [a, b] = [contractId(), contractId()];

  it("reads a saved list and trims names", () => {
    assert.deepEqual(parseSaved(JSON.stringify([{ id: a, label: "  Mine " }, { id: b, label: "Other" }])), [
      { id: a, label: "Mine" },
      { id: b, label: "Other" },
    ]);
  });

  it("returns nothing for missing or broken storage", () => {
    for (const text of [null, "", "not json", "{}", '"x"', "null"]) assert.deepEqual(parseSaved(text), [], String(text));
  });

  it("drops malformed entries and repeated ids", () => {
    const text = JSON.stringify([
      { id: a, label: "Keep" },
      { id: a, label: "Repeat" },
      { id: "GABC", label: "Not a contract" },
      { id: b, label: "   " },
      { id: b, label: "x".repeat(MAX_LABEL_LENGTH + 1) },
      { id: b },
      null,
      { label: "No id" },
    ]);
    assert.deepEqual(parseSaved(text), [{ id: a, label: "Keep" }]);
  });

  it("keeps at most the allowed number", () => {
    const many = Array.from({ length: MAX_SAVED_ENTRIES + 5 }, (_, i) => ({ id: contractId(), label: `c${i}` }));
    assert.equal(parseSaved(JSON.stringify(many)).length, MAX_SAVED_ENTRIES);
  });
});

describe("addSaved", () => {
  it("adds an entry last, trimming the id and name", () => {
    const [a, b] = [contractId(), contractId()];
    const first = addSaved([], ` ${a} `, " First ");
    assert.deepEqual(first, [{ id: a, label: "First" }]);
    assert.deepEqual(addSaved(first, b, "Second").map((e) => e.id), [a, b]);
  });

  it("refuses what cannot be saved", () => {
    const a = contractId();
    const saved = addSaved([], a, "A");
    assert.throws(() => addSaved(saved, "GABC", "x"), /contract id/);
    assert.throws(() => addSaved(saved, contractId(), "   "), /name/i);
    assert.throws(() => addSaved(saved, contractId(), "x".repeat(MAX_LABEL_LENGTH + 1)), /characters/);
    assert.throws(() => addSaved(saved, a, "Again"), /already/);
    assert.throws(() => addSaved([], BLENT_FIXED_POOL, "Pool", new Set([BLENT_FIXED_POOL])), /already/);
  });

  it("refuses to go past the limit", () => {
    const full = Array.from({ length: MAX_SAVED_ENTRIES }, (_, i) => ({ id: contractId(), label: `c${i}` }));
    assert.throws(() => addSaved(full, contractId(), "One more"), /at most/);
  });

  it("does not change the list it was given", () => {
    const saved = [{ id: contractId(), label: "A" }];
    addSaved(saved, contractId(), "B");
    assert.equal(saved.length, 1);
  });
});

describe("removeSaved and renameSaved", () => {
  const [a, b] = [contractId(), contractId()];
  const saved = [
    { id: a, label: "A" },
    { id: b, label: "B" },
  ];

  it("removes only the chosen entry", () => {
    assert.deepEqual(removeSaved(saved, a), [{ id: b, label: "B" }]);
    assert.deepEqual(removeSaved(saved, contractId()), saved);
  });

  it("renames only the chosen entry", () => {
    assert.deepEqual(renameSaved(saved, b, " Renamed "), [{ id: a, label: "A" }, { id: b, label: "Renamed" }]);
  });

  it("ignores a blank name and cuts a long one", () => {
    assert.deepEqual(renameSaved(saved, a, "   "), saved);
    assert.equal(renameSaved(saved, a, "x".repeat(100))[0].label.length, MAX_LABEL_LENGTH);
  });
});

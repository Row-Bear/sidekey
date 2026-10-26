import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SignerView } from "@poc/core";
import { delegatesFirst, signerStatus } from "./signers.ts";

const make = (id: string, patch: Partial<SignerView> = {}): SignerView => ({
  id,
  label: "other",
  kind: "ed25519",
  address: id,
  hasKey: false,
  viaBrowser: false,
  registered: true,
  policy: { validUntilLedger: null, rpIdHashHex: null, rules: [] },
  ...patch,
});
const withExpiry = (validUntilLedger: number | null) => ({ policy: { validUntilLedger, rpIdHashHex: null, rules: [] } });

describe("signerStatus", () => {
  it("never expires the master", () => {
    assert.deepEqual(signerStatus(make("m", { label: "master", policy: null }), 999), { kind: "master" });
  });

  it("knows an unregistered signer", () => {
    assert.deepEqual(signerStatus(make("a", { registered: false, policy: null }), 10), { kind: "unregistered" });
    assert.deepEqual(signerStatus(make("a", { registered: true, policy: null }), 10), { kind: "unregistered" });
    // The `registered` flag decides, even if a policy value is present.
    assert.deepEqual(signerStatus(make("a", { registered: false, ...withExpiry(500) }), 10), { kind: "unregistered" });
  });

  it("reports no expiry, an expiry still ahead, and an expiry that has passed", () => {
    assert.deepEqual(signerStatus(make("a", withExpiry(null)), 100), { kind: "no-expiry" });
    assert.deepEqual(signerStatus(make("a", withExpiry(200)), 100), { kind: "active", validUntil: 200 });
    assert.deepEqual(signerStatus(make("a", withExpiry(100)), 100), { kind: "active", validUntil: 100 });
    assert.deepEqual(signerStatus(make("a", withExpiry(99)), 100), { kind: "expired", validUntil: 99 });
  });
});

describe("delegatesFirst", () => {
  const latest = 100;
  const delegate = make("delegate", { label: "delegate", registered: false, policy: null });
  const working = make("working", withExpiry(500));
  const open = make("open", withExpiry(null));
  const unregistered = make("unregistered", { registered: false, policy: null });
  const expired = make("expired", withExpiry(50));
  const master = make("master", { label: "master", policy: null });

  it("puts the account's delegate first, then working signers, unregistered ones, and expired ones last", () => {
    const ordered = delegatesFirst([expired, unregistered, master, working, delegate, open], latest);
    assert.deepEqual(ordered.map((s) => s.id), ["delegate", "working", "open", "unregistered", "expired"]);
  });

  it("leaves the master out and keeps the order of equals", () => {
    assert.deepEqual(delegatesFirst([make("b", withExpiry(500)), make("a", withExpiry(500)), master], latest).map((s) => s.id), ["b", "a"]);
    assert.deepEqual(delegatesFirst([master], latest), []);
  });

  it("does not change the list it is given", () => {
    const input = [expired, delegate];
    delegatesFirst(input, latest);
    assert.deepEqual(input.map((s) => s.id), ["expired", "delegate"]);
  });
});

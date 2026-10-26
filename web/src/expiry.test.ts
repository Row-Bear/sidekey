import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STORAGE_LIFETIME_MINUTES, toExpiry } from "./expiry.ts";

describe("toExpiry", () => {
  it("means no expiry whatever number is typed", () => {
    assert.deepEqual(toExpiry("none", ""), { kind: "none" });
    assert.deepEqual(toExpiry("none", "abc"), { kind: "none" });
  });

  it("turns minutes, hours and days into minutes", () => {
    assert.deepEqual(toExpiry("minutes", "30"), { kind: "minutes", minutes: 30 });
    assert.deepEqual(toExpiry("hours", "2"), { kind: "minutes", minutes: 120 });
    assert.deepEqual(toExpiry("days", "1.5"), { kind: "minutes", minutes: 2160 });
  });

  it("uses a whole ledger number for an absolute expiry", () => {
    assert.deepEqual(toExpiry("ledger", "5392774.9"), { kind: "ledger", ledger: 5392774 });
  });

  it("refuses a missing, zero, negative or non-numeric amount", () => {
    for (const kind of ["minutes", "hours", "days", "ledger"] as const) {
      for (const value of ["", "0", "-3", "abc", "NaN", "Infinity"]) assert.equal(toExpiry(kind, value), null, `${kind} ${value}`);
    }
  });

  it("knows how long the stored policy lasts", () => {
    assert.equal(STORAGE_LIFETIME_MINUTES, 30 * 24 * 60);
  });
});

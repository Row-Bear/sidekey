import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeRule, durationText, friendlyError } from "./api.ts";

describe("friendlyError", () => {
  it("explains a missing-data host error and keeps the original", () => {
    const raw = "HostError: Error(Storage, MissingValue)";
    const result = friendlyError(raw);
    assert.match(result.summary, /data that does not exist yet/);
    assert.equal(result.detail, raw);
  });

  it("names a contract's own error number", () => {
    const result = friendlyError("HostError: Error(Contract, #12)");
    assert.match(result.summary, /error #12/);
    assert.equal(result.detail, "HostError: Error(Contract, #12)");
  });

  it("hides other host errors and very long text behind a generic summary", () => {
    assert.equal(friendlyError("HostError: Error(WasmVm, InvalidAction)").summary, "The call could not be run.");
    const long = "x".repeat(200);
    assert.deepEqual(friendlyError(long), { summary: "The call could not be run.", detail: long });
  });

  it("leaves short readable messages alone", () => {
    assert.deepEqual(friendlyError("That passkey is not registered on the account yet"), { summary: "That passkey is not registered on the account yet" });
  });
});

describe("durationText", () => {
  it("picks the unit that reads best", () => {
    assert.equal(durationText(0), "0 s");
    assert.equal(durationText(-30), "0 s");
    assert.equal(durationText(45), "45 s");
    assert.equal(durationText(89), "89 s");
    assert.equal(durationText(90), "2 min");
    assert.equal(durationText(120), "2 min");
    assert.equal(durationText(60 * 89), "89 min");
    assert.equal(durationText(3600 * 2), "2 h");
    assert.equal(durationText(3600 * 10.5), "10.5 h");
    assert.equal(durationText(3600 * 35), "35 h");
    assert.equal(durationText(3600 * 48), "2 days");
    assert.equal(durationText(3600 * 36), "1.5 days");
  });
});

describe("describeRule", () => {
  it("writes every constraint kind", () => {
    assert.equal(
      describeRule({
        contract: "C",
        function: "transfer",
        args: [{ kind: "self" }, { kind: "any" }, { kind: "lessThan", limit: "100" }, { kind: "exact", display: "7", xdrHex: "00" }],
      }),
      "transfer(this account, any, < 100, = 7)",
    );
  });
});

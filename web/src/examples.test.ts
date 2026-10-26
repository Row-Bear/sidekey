import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { examplesFor, type ExampleContext } from "./examples.ts";

const context: ExampleContext = { simulator: "CSIM", nativeToken: "CNATIVE", account: "CACCOUNT", master: "GMASTER" };

describe("examplesFor", () => {
  it("offers claim and withdraw for the simulator", () => {
    assert.deepEqual(examplesFor("CSIM", context), [
      { label: "claim(this account)", fn: "claim", args: ["CACCOUNT"] },
      { label: "withdraw(this account, 1 XLM)", fn: "withdraw", args: ["CACCOUNT", "10000000"] },
    ]);
  });

  it("offers a balance check and a transfer to the master for the native asset", () => {
    assert.deepEqual(examplesFor("CNATIVE", context), [
      { label: "balance(this account)", fn: "balance", args: ["CACCOUNT"] },
      { label: "send 1 XLM to the master", fn: "transfer", args: ["CACCOUNT", "GMASTER", "10000000"] },
    ]);
  });

  it("leaves out the transfer when the master is not known", () => {
    assert.deepEqual(examplesFor("CNATIVE", { ...context, master: "" }).map((e) => e.fn), ["balance"]);
  });

  it("offers nothing for other contracts, an empty choice or no active account", () => {
    assert.deepEqual(examplesFor("COTHER", context), []);
    assert.deepEqual(examplesFor("", context), []);
    assert.deepEqual(examplesFor("CSIM", { ...context, account: "" }), []);
    // Before the server's data has loaded, an empty contract must not match an empty simulator id.
    assert.deepEqual(examplesFor("", { ...context, simulator: "", nativeToken: "" }), []);
  });

  it("ignores surrounding spaces in the chosen contract", () => {
    assert.equal(examplesFor("  CSIM ", context).length, 2);
  });
});

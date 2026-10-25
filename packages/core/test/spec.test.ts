import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Address, contract, nativeToScVal, scValToNative } from "@stellar/stellar-sdk";
import { argKind, describeFunctions, encodeArgs, toNative, typeLabel } from "../src/spec.ts";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/specs.json", import.meta.url), "utf8")) as Record<string, string[]>;
const simulator = new contract.Spec(fixtures.simulator);
const nativeToken = new contract.Spec(fixtures.native);

const ACCOUNT = "CAMKCCLKP5HVC4BECOV4JAGPHED4UABO2PPMR5DL5HQO2XNLK5NMV3MT";

describe("describeFunctions", () => {
  it("lists the simulator's callable functions with typed arguments", () => {
    const fns = describeFunctions(simulator);
    const byName = Object.fromEntries(fns.map((f) => [f.name, f]));
    assert.deepEqual(Object.keys(byName).sort(), [
      "accrued_yield",
      "balance",
      "claim",
      "deposit",
      "deposit_asset_balance",
      "payout_asset_balance",
      "total_deposits",
      "withdraw",
    ]);
    assert.deepEqual(byName.claim.args, [{ name: "user", type: "Address", kind: "address", optional: false }]);
    assert.deepEqual(
      byName.withdraw.args.map((a) => [a.name, a.type, a.kind]),
      [["user", "Address", "address"], ["amount", "i128", "integer"]],
    );
  });

  it("hides the constructor and check_auth hooks", () => {
    assert.ok(describeFunctions(simulator).every((f) => !f.name.startsWith("__")));
  });

  it("reads the native token (Stellar Asset Contract) interface", () => {
    const names = describeFunctions(nativeToken).map((f) => f.name);
    for (const expected of ["transfer", "balance", "approve", "allowance"]) assert.ok(names.includes(expected), expected);
    assert.equal(describeFunctions(nativeToken).find((f) => f.name === "balance")?.args[0].kind, "address");
  });
});

describe("encodeArgs", () => {
  it("encodes an address and an i128 amount", () => {
    const [user, amount] = encodeArgs(simulator, "deposit", [ACCOUNT, "95000000000"]);
    assert.equal(Address.fromScVal(user).toString(), ACCOUNT);
    assert.equal(scValToNative(amount), 95000000000n);
    assert.deepEqual(amount.toXDR(), nativeToScVal(95000000000n, { type: "i128" }).toXDR());
  });

  it("accepts negative i128 values and rejects negative unsigned ones", () => {
    assert.equal(scValToNative(encodeArgs(simulator, "deposit", [ACCOUNT, "-5"])[1]), -5n);
    assert.throws(() => toNative("-1", { type: "scSpecTypeU32" } as never), /negative/);
  });

  it("names the argument in every error", () => {
    assert.throws(() => encodeArgs(simulator, "deposit", [ACCOUNT, "12.5"]), /amount: expected a whole number/);
    assert.throws(() => encodeArgs(simulator, "deposit", ["", "1"]), /user: a value is required/);
    assert.throws(() => encodeArgs(simulator, "deposit", ["not-an-address", "1"]), /user:/);
  });

  it("rejects the wrong number of arguments and unknown functions", () => {
    assert.throws(() => encodeArgs(simulator, "claim", []), /takes 1 argument/);
    assert.throws(() => encodeArgs(simulator, "claim", [ACCOUNT, "1"]), /takes 1 argument/);
    assert.throws(() => encodeArgs(simulator, "nope", []));
  });

  it("does not trim or alter string values but trims addresses and numbers", () => {
    assert.equal(Address.fromScVal(encodeArgs(simulator, "claim", [`  ${ACCOUNT}  `])[0]).toString(), ACCOUNT);
    assert.equal(scValToNative(encodeArgs(simulator, "withdraw", [ACCOUNT, " 7 "])[1]), 7n);
  });
});

describe("types", () => {
  it("labels and classifies the simulator's argument types", () => {
    const deposit = simulator.getFunc("deposit");
    assert.deepEqual(deposit.inputs.map((i) => typeLabel(i.type)), ["Address", "i128"]);
    assert.deepEqual(deposit.inputs.map((i) => argKind(i.type)), ["address", "integer"]);
  });
});

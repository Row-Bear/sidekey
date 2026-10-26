import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Address, nativeToScVal, scValToNative } from "@stellar/stellar-sdk";
import {
  argConstraintScVal,
  describeRule,
  evaluateCalls,
  integerArg,
  parseLimit,
  ruleScVal,
  parseSignerPolicy,
  type CallContext,
  type SignerPolicyView,
} from "../src/policy.ts";

const ACCOUNT = "CAMKCCLKP5HVC4BECOV4JAGPHED4UABO2PPMR5DL5HQO2XNLK5NMV3MT";
const OTHER = "CCSAUKV4PT4L7MBUG43ADEFZMJON6BYWLNFBLHE4JSXVE2IADYJNBDAT";
const SIM = "CDGOE4WK2MAL2U2VFIFPVGIAWNZU5A2KJ5FJTJ7GMXVNS2GGWK4N33DL";

const addr = (a: string) => new Address(a).toScVal();
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });

const claimOnly: SignerPolicyView = {
  validUntilLedger: 200,
  rules: [{ contract: SIM, function: "claim", args: [{ kind: "self" }] }],
};
const call = (fn: string, ...args: ReturnType<typeof addr>[]): CallContext => ({ kind: "contract", contract: SIM, function: fn, args });

describe("evaluateCalls", () => {
  it("allows a call that matches a rule", () => {
    assert.deepEqual(evaluateCalls(claimOnly, [call("claim", addr(ACCOUNT))], ACCOUNT, 100), { allowed: true });
  });

  it("allows a call that needs no authorization from the account", () => {
    assert.deepEqual(evaluateCalls(claimOnly, [], ACCOUNT, 100), { allowed: true });
  });

  it("refuses an unregistered signer", () => {
    const v = evaluateCalls(null, [call("claim", addr(ACCOUNT))], ACCOUNT, 100);
    assert.equal(v.allowed === false && v.error, "UnknownSigner");
  });

  it("allows up to and including the expiry ledger and refuses after it", () => {
    assert.equal(evaluateCalls(claimOnly, [call("claim", addr(ACCOUNT))], ACCOUNT, 200).allowed, true);
    const v = evaluateCalls(claimOnly, [call("claim", addr(ACCOUNT))], ACCOUNT, 201);
    assert.equal(v.allowed === false && v.error, "SignerExpired");
  });

  it("explains a function that has no rule", () => {
    const v = evaluateCalls(claimOnly, [call("withdraw", addr(ACCOUNT), i128(1n))], ACCOUNT, 100);
    assert.equal(v.allowed, false);
    assert.match(v.allowed === false ? v.reason : "", /no rule allows withdraw\(\)/);
  });

  it("explains an argument that breaks a self constraint", () => {
    const v = evaluateCalls(claimOnly, [call("claim", addr(OTHER))], ACCOUNT, 100);
    assert.match(v.allowed === false ? v.reason : "", /argument 1 must be this account/);
  });

  it("explains a wrong argument count", () => {
    const v = evaluateCalls(claimOnly, [call("claim", addr(ACCOUNT), addr(ACCOUNT))], ACCOUNT, 100);
    assert.match(v.allowed === false ? v.reason : "", /1 argument\(s\), this call has 2/);
  });

  it("matches exact values by their XDR, so the type matters", () => {
    const exactRule = ruleScVal({ contract: SIM, function: "withdraw", args: [{ kind: "self" }, { kind: "exact", value: i128(100n) }] });
    // Decode the encoded rule the same way a `get_signer` result is decoded.
    const native = { valid_until_ledger: null, rules: [scValToNative(exactRule)] };
    const policy = parseSignerPolicy(native);
    const ok = evaluateCalls(policy, [call("withdraw", addr(ACCOUNT), i128(100n))], ACCOUNT, 1);
    const wrongValue = evaluateCalls(policy, [call("withdraw", addr(ACCOUNT), i128(101n))], ACCOUNT, 1);
    const wrongType = evaluateCalls(policy, [call("withdraw", addr(ACCOUNT), nativeToScVal(100, { type: "u32" }))], ACCOUNT, 1);
    assert.equal(ok.allowed, true);
    assert.equal(wrongValue.allowed, false);
    assert.equal(wrongType.allowed, false);
  });

  it("checks every call in the tree, so a smuggled sub-invocation is caught", () => {
    const v = evaluateCalls(
      claimOnly,
      [call("claim", addr(ACCOUNT)), call("withdraw", addr(ACCOUNT), i128(1n))],
      ACCOUNT,
      100,
    );
    assert.equal(v.allowed, false);
  });

  it("refuses calls on the account itself and contract deployments", () => {
    const self: CallContext = { kind: "contract", contract: ACCOUNT, function: "set_signer", args: [] };
    assert.equal(evaluateCalls(claimOnly, [self], ACCOUNT, 100).allowed, false);
    assert.equal(evaluateCalls(claimOnly, [{ kind: "other", description: "a contract deployment" }], ACCOUNT, 100).allowed, false);
  });
});

describe("describeRule", () => {
  it("writes constraints readably", () => {
    assert.equal(
      describeRule({ contract: SIM, function: "withdraw", args: [{ kind: "self" }, { kind: "any" }, { kind: "exact", display: "100", xdrHex: "00" }] }),
      "withdraw(this account, any, = 100)",
    );
  });
});

describe("less than constraints", () => {
  const below = (limit: string): SignerPolicyView => ({
    validUntilLedger: null,
    rules: [{ contract: SIM, function: "poke", args: [{ kind: "lessThan", limit }] }],
  });
  const poke = (value: ReturnType<typeof i128>): CallContext => ({ kind: "contract", contract: SIM, function: "poke", args: [value] });
  const verdict = (limit: string, value: ReturnType<typeof i128>) => evaluateCalls(below(limit), [poke(value)], ACCOUNT, 100);

  it("is encoded as the LessThan variant holding an i128", () => {
    assert.deepEqual(scValToNative(argConstraintScVal({ kind: "lessThan", limit: 100n })), ["LessThan", 100n]);
    assert.deepEqual(scValToNative(argConstraintScVal({ kind: "lessThan", limit: -5n })), ["LessThan", -5n]);
    assert.equal((argConstraintScVal({ kind: "lessThan", limit: 100n }) as unknown as { vec: { type: string }[] }).vec[1].type, "scvI128");
  });

  it("is read back from what the contract returns", () => {
    const view = parseSignerPolicy({
      valid_until_ledger: null,
      rules: [{ contract: SIM, function: "poke", args: [["LessThan", 1234567890123456789012n], ["Any"]] }],
    });
    assert.deepEqual(view.rules[0].args, [{ kind: "lessThan", limit: "1234567890123456789012" }, { kind: "any" }]);
  });

  it("is written readably", () => {
    assert.equal(describeRule({ contract: SIM, function: "poke", args: [{ kind: "lessThan", limit: "100" }] }), "poke(< 100)");
  });

  it("allows only integers strictly below the limit, as the contract does", () => {
    assert.deepEqual(verdict("100", i128(99n)), { allowed: true });
    assert.equal(verdict("100", i128(100n)).allowed, false);
    assert.equal(verdict("100", i128(101n)).allowed, false);
    assert.deepEqual(verdict("100", i128(-1n)), { allowed: true });
  });

  it("explains why a value is refused", () => {
    const refused = verdict("100", i128(250n));
    assert.equal(refused.allowed === false && refused.error, "NotAllowed");
    assert.match(refused.allowed === false ? refused.reason : "", /less than 100, this call has 250/);
  });

  it("compares every integer type and refuses everything else", () => {
    const ok = (v: ReturnType<typeof i128>) => verdict("100", v).allowed;
    assert.equal(ok(nativeToScVal(99, { type: "u32" })), true);
    assert.equal(ok(nativeToScVal(100, { type: "u32" })), false);
    assert.equal(ok(nativeToScVal(-9, { type: "i32" })), true);
    assert.equal(ok(nativeToScVal(99n, { type: "u64" })), true);
    assert.equal(ok(nativeToScVal(100n, { type: "i64" })), false);
    assert.equal(ok(nativeToScVal(99n, { type: "u128" })), true);
    assert.equal(ok(addr(ACCOUNT)), false);
    assert.equal(ok(nativeToScVal("5", { type: "string" })), false);
    assert.equal(ok(nativeToScVal("small", { type: "symbol" })), false);
    assert.equal(ok(nativeToScVal(true)), false);
  });

  it("does not let a u128 above the i128 range wrap around", () => {
    assert.equal(integerArg(nativeToScVal(2n ** 127n, { type: "u128" })), null);
    assert.equal(integerArg(nativeToScVal(2n ** 127n - 1n, { type: "u128" })), 2n ** 127n - 1n);
    assert.equal(verdict(String(2n ** 127n - 1n), nativeToScVal(2n ** 128n - 1n, { type: "u128" })).allowed, false);
  });

  it("is checked together with the other constraints of the rule", () => {
    const policy: SignerPolicyView = {
      validUntilLedger: null,
      rules: [{ contract: SIM, function: "transfer", args: [{ kind: "self" }, { kind: "any" }, { kind: "lessThan", limit: "1000" }] }],
    };
    const transfer = (from: string, amount: bigint): CallContext => ({
      kind: "contract",
      contract: SIM,
      function: "transfer",
      args: [addr(from), addr(OTHER), i128(amount)],
    });
    assert.equal(evaluateCalls(policy, [transfer(ACCOUNT, 999n)], ACCOUNT, 100).allowed, true);
    assert.equal(evaluateCalls(policy, [transfer(ACCOUNT, 1000n)], ACCOUNT, 100).allowed, false);
    assert.equal(evaluateCalls(policy, [transfer(OTHER, 1n)], ACCOUNT, 100).allowed, false);
  });
});

describe("parseLimit", () => {
  it("reads whole numbers, trimmed, including negative ones", () => {
    assert.equal(parseLimit(" 10000000 "), 10000000n);
    assert.equal(parseLimit("-5"), -5n);
    assert.equal(parseLimit("0"), 0n);
  });

  it("accepts the 128-bit extremes and nothing beyond", () => {
    assert.equal(parseLimit(String(2n ** 127n - 1n)), 2n ** 127n - 1n);
    assert.equal(parseLimit(String(-(2n ** 127n))), -(2n ** 127n));
    assert.throws(() => parseLimit(String(2n ** 127n)), /128-bit/);
    assert.throws(() => parseLimit(String(-(2n ** 127n) - 1n)), /128-bit/);
  });

  it("refuses anything that is not a whole number", () => {
    for (const text of ["", "  ", "1.5", "1e6", "abc", "0x10", "--1", "+5", "1,000", "10 000"]) {
      assert.throws(() => parseLimit(text), /whole number/, text);
    }
  });
});

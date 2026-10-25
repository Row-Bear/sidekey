import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Address, nativeToScVal, scValToNative } from "@stellar/stellar-sdk";
import {
  describeRule,
  evaluateCalls,
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

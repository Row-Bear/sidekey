import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { dataKeyName, MAX_RECORDED_ACCOUNTS, nextFreeIndex, parseRecordedEntry } from "../src/registry.ts";

const contractId = () => StrKey.encodeContract(Buffer.from(Keypair.random().rawPublicKey()));
const entry = (index: number) => ({ index, smartAccountId: contractId() });

describe("dataKeyName", () => {
  it("numbers the keys from 1 and fits a data entry name (64 bytes at most)", () => {
    assert.equal(dataKeyName(1), "smart_account_1");
    assert.equal(dataKeyName(MAX_RECORDED_ACCOUNTS), `smart_account_${MAX_RECORDED_ACCOUNTS}`);
    assert.ok(dataKeyName(MAX_RECORDED_ACCOUNTS).length <= 64);
  });
});

describe("nextFreeIndex", () => {
  it("starts at 1, fills gaps and ignores order", () => {
    assert.equal(nextFreeIndex([]), 1);
    assert.equal(nextFreeIndex([entry(1), entry(2)]), 3);
    assert.equal(nextFreeIndex([entry(3), entry(1)]), 2);
  });

  it("is null when every slot is used", () => {
    const all = Array.from({ length: MAX_RECORDED_ACCOUNTS }, (_, i) => entry(i + 1));
    assert.equal(nextFreeIndex(all), null);
    assert.equal(nextFreeIndex(all.slice(1)), 1);
    assert.equal(nextFreeIndex(all.slice(0, -1)), MAX_RECORDED_ACCOUNTS, "the last slot is usable");
  });
});

describe("parseRecordedEntry", () => {
  const id = contractId();
  const value = Buffer.from(id);

  it("reads a recorded account", () => {
    assert.deepEqual(parseRecordedEntry("smart_account_7", value), { index: 7, smartAccountId: id });
  });

  it("ignores other entries and malformed keys", () => {
    for (const name of ["smart_account_", "smart_account_0", "smart_account_01", "smart_account_x", "my_smart_account_1", "smart_account_1 ", "smart_account_33"]) {
      assert.equal(parseRecordedEntry(name, value), null, name);
    }
  });

  it("ignores values that are not a contract id", () => {
    assert.equal(parseRecordedEntry("smart_account_1", Buffer.from(Keypair.random().publicKey())), null);
    assert.equal(parseRecordedEntry("smart_account_1", Buffer.from("C123")), null);
    assert.equal(parseRecordedEntry("smart_account_1", Buffer.from([0xff, 0xfe])), null);
  });
});

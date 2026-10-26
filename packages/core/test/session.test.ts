import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { loadSession, rememberAccount, saveSession, type WalletAccount } from "../src/session.ts";

const account = (address = Keypair.random().publicKey()): WalletAccount => ({
  address,
  smartAccountId: StrKey.encodeContract(Buffer.from(Keypair.random().rawPublicKey())),
});

describe("rememberAccount", () => {
  it("puts the newest account first and keeps each account once", () => {
    const [a, b] = [account(), account()];
    assert.deepEqual(rememberAccount(rememberAccount(undefined, a), b), [b, a]);
    assert.deepEqual(rememberAccount([b, a], a), [a, b]);
  });

  it("keeps at most 30 accounts, dropping the oldest", () => {
    let known: WalletAccount[] | undefined;
    const all = Array.from({ length: 35 }, () => account());
    for (const a of all) known = rememberAccount(known, a);
    assert.equal(known?.length, 30);
    assert.equal(known?.[0], all[34]);
    assert.ok(!known?.includes(all[0]));
  });
});

describe("known accounts in the session file", () => {
  const withFile = (content: unknown, check: (path: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "session-"));
    const path = join(dir, "wallet-session.json");
    try {
      writeFileSync(path, JSON.stringify(content));
      check(path);
    } finally {
      rmSync(dir, { recursive: true });
    }
  };

  it("round-trips through save and load", () => {
    const [a, b] = [account(), account()];
    withFile({}, (path) => {
      saveSession(path, { mode: "wallet", delegate: "key", wallet: b, known: [b, a] });
      const loaded = loadSession(path);
      assert.deepEqual(loaded.known, [b, a]);
      assert.deepEqual(loaded.wallet, b);
    });
  });

  it("drops malformed entries and ignores a non-list", () => {
    const good = account();
    withFile({ known: [good, { address: "nope", smartAccountId: good.smartAccountId }, { address: good.address, smartAccountId: "C123" }, null] }, (path) => {
      assert.deepEqual(loadSession(path).known, [good]);
    });
    withFile({ known: "x" }, (path) => assert.equal(loadSession(path).known, undefined));
  });

  it("has no known accounts when the file is missing", () => {
    assert.equal(loadSession(join(tmpdir(), "does-not-exist-session.json")).known, undefined);
  });
});

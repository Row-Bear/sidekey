import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { Keypair, scValToNative } from "@stellar/stellar-sdk";
import {
  decodeWalletSignature,
  type MessageWallet,
  SEP53_PREFIX,
  sep53Digest,
  walletMessage,
  walletMessageSigner,
} from "../src/wallet.ts";

const ACCOUNT = "CAMKCCLKP5HVC4BECOV4JAGPHED4UABO2PPMR5DL5HQO2XNLK5NMV3MT";
const PAYLOAD = Buffer.from("ab".repeat(32), "hex");
const master = Keypair.random();

// xBull's sign-message component (Creit-Tech/xBull-Wallet): the message is read as base64 when it looks
// like base64 and as UTF-8 otherwise; the signature covers sha256(prefix + bytes).
const XBULL_BASE64 = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
function xbullFullMessage(message: string): Buffer {
  return Buffer.concat([Buffer.from(SEP53_PREFIX, "utf8"), Buffer.from(message, XBULL_BASE64.test(message) ? "base64" : "utf8")]);
}

function xbullLike(key: Keypair, encoding: "base64" | "hex" = "base64"): MessageWallet & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async signMessage(message) {
      asked.push(message);
      const digest = createHash("sha256").update(xbullFullMessage(message)).digest();
      return { signedMessage: Buffer.from(key.sign(digest)).toString(encoding), signerAddress: key.publicKey() };
    },
  };
}

/** A wallet that follows SEP-53 literally: the message is always UTF-8. */
function strictSep53(key: Keypair): MessageWallet {
  return {
    async signMessage(message) {
      return { signedMessage: Buffer.from(key.sign(sep53Digest(message))).toString("base64"), signerAddress: key.publicKey() };
    },
  };
}

const options = { account: ACCOUNT, masterAddress: master.publicKey() };

describe("walletMessage", () => {
  it("names the account and the payload, with spaces", () => {
    const text = walletMessage(ACCOUNT, PAYLOAD);
    assert.equal(text, `Authorize ${ACCOUNT} payload ${"ab".repeat(32)}`);
    assert.ok(text.includes(" "));
  });

  it("does not look like base64, so xBull reads it as UTF-8 (a bare hex payload would not)", () => {
    const hex = PAYLOAD.toString("hex");
    // The trap: 64 hex characters are valid base64, so xBull would sign 48 different bytes.
    assert.ok(XBULL_BASE64.test(hex));
    assert.notDeepEqual(xbullFullMessage(hex), Buffer.concat([Buffer.from(SEP53_PREFIX), Buffer.from(hex)]));
    // Our message is read as UTF-8, exactly what SEP-53 and the contract expect.
    const text = walletMessage(ACCOUNT, PAYLOAD);
    assert.equal(XBULL_BASE64.test(text), false);
    assert.deepEqual(xbullFullMessage(text), Buffer.concat([Buffer.from(SEP53_PREFIX), Buffer.from(text)]));
  });
});

describe("decodeWalletSignature", () => {
  const sig = Buffer.from(master.sign(Buffer.from("x")));
  it("accepts base64 and hex", () => {
    assert.deepEqual(decodeWalletSignature(sig.toString("base64")), sig);
    assert.deepEqual(decodeWalletSignature(sig.toString("hex")), sig);
    assert.deepEqual(decodeWalletSignature(`  ${sig.toString("base64")}\n`), sig);
  });
  it("rejects anything that is not 64 bytes", () => {
    assert.throws(() => decodeWalletSignature(""), /64 bytes/);
    assert.throws(() => decodeWalletSignature("abcd"), /64 bytes/);
    assert.throws(() => decodeWalletSignature(Buffer.alloc(65).toString("base64")), /64 bytes/);
  });
});

describe("walletMessageSigner", () => {
  it("works with an xBull-style wallet, whether it returns base64 or hex", async () => {
    for (const encoding of ["base64", "hex"] as const) {
      const wallet = xbullLike(master, encoding);
      const scVal = await walletMessageSigner(wallet, options)("", PAYLOAD);
      // Message(Ed25519Signature { sig, signer })
      const [kind, body] = scValToNative(scVal) as [string, { sig: Uint8Array; signer: Uint8Array }];
      assert.equal(kind, "Message");
      assert.equal(Buffer.from(body.signer).toString("hex"), Buffer.from(master.rawPublicKey()).toString("hex"));
      assert.equal(body.sig.length, 64);
      assert.deepEqual(wallet.asked, [walletMessage(ACCOUNT, PAYLOAD)]);
    }
  });

  it("works with a strict SEP-53 wallet and produces the same signature as xBull", async () => {
    const a = await walletMessageSigner(strictSep53(master), options)("", PAYLOAD);
    const b = await walletMessageSigner(xbullLike(master), options)("", PAYLOAD);
    assert.equal(a.toXDR("base64"), b.toXDR("base64"));
  });

  it("catches a wallet that signed a different message (the base64 trap) before anything is sent", async () => {
    // Asking xBull to sign the bare hex would make it sign the base64-decoded bytes instead.
    const trapped: MessageWallet = {
      async signMessage(message) {
        const digest = createHash("sha256").update(xbullFullMessage(PAYLOAD.toString("hex"))).digest();
        void message;
        return { signedMessage: Buffer.from(master.sign(digest)).toString("base64"), signerAddress: master.publicKey() };
      },
    };
    await assert.rejects(walletMessageSigner(trapped, options)("", PAYLOAD), /does not match the SEP-53 message/);
  });

  it("rejects a signature from a different key and a different reported signer", async () => {
    const stranger = Keypair.random();
    await assert.rejects(walletMessageSigner(strictSep53(stranger), options)("", PAYLOAD), /not the master/);
    const lying: MessageWallet = {
      async signMessage(message) {
        const real = await strictSep53(stranger).signMessage(message);
        return { ...real, signerAddress: master.publicKey() };
      },
    };
    await assert.rejects(walletMessageSigner(lying, options)("", PAYLOAD), /does not match/);
  });

  it("signs a different message for a different payload or account", async () => {
    const wallet = xbullLike(master);
    const sign = walletMessageSigner(wallet, options);
    await sign("", PAYLOAD);
    await sign("", Buffer.alloc(32, 1));
    await walletMessageSigner(wallet, { ...options, account: "CCSAUKV4PT4L7MBUG43ADEFZMJON6BYWLNFBLHE4JSXVE2IADYJNBDAT" })("", PAYLOAD);
    assert.equal(new Set(wallet.asked).size, 3);
  });
});

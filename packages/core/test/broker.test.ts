import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  Account,
  Address,
  buildAuthorizationEntryPreimage,
  Keypair,
  Networks,
  nativeToScVal,
  Operation,
  scValToNative,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import {
  brokerSigner,
  SignatureBroker,
  SigningCancelled,
  summarizePreimage,
} from "../src/broker.ts";
import { sep53Digest, walletMessage } from "../src/wallet.ts";
import { readFileSync } from "node:fs";
import { publicKeyFromSpki, rpIdHash } from "../src/passkey.ts";

const ACCOUNT = "CAMKCCLKP5HVC4BECOV4JAGPHED4UABO2PPMR5DL5HQO2XNLK5NMV3MT";
const SIM = "CDGOE4WK2MAL2U2VFIFPVGIAWNZU5A2KJ5FJTJ7GMXVNS2GGWK4N33DL";
const master = Keypair.random();
const stranger = Keypair.random();
const PAYLOAD = Buffer.alloc(32, 0xab);

const request = (broker: SignatureBroker, extra: { timeoutMs?: number } = {}) =>
  broker.request({
    account: ACCOUNT,
    signerRaw: master.rawPublicKey(),
    signerLabel: "master",
    preimageXdr: "AAAA",
    payload: PAYLOAD,
    summary: ["claim(x) on y"],
    ...extra,
  });

const b64 = (sig: Uint8Array) => Buffer.from(sig).toString("base64");
const kindOf = (scVal: xdr.ScVal) => (scValToNative(scVal) as [string, unknown])[0];

/** A real unsigned auth entry: the smart account is asked to authorize claim(account) on the simulator. */
function claimPreimage(withSubInvocation = false): string {
  const call = (fn: string) =>
    new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(SIM).toScAddress(),
          functionName: fn,
          args: [new Address(ACCOUNT).toScVal(), nativeToScVal(5n, { type: "i128" })],
        }),
      ),
      subInvocations: [],
    });
  const root = call("withdraw");
  const invocation = withSubInvocation
    ? new xdr.SorobanAuthorizedInvocation({ function: root.function, subInvocations: [call("claim")] })
    : root;
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(ACCOUNT).toScAddress(),
        nonce: 1n,
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVec([]),
      }),
    ),
    rootInvocation: invocation,
  });
  return buildAuthorizationEntryPreimage(entry, 1000, Networks.TESTNET).toXDR("base64");
}

describe("SignatureBroker", () => {
  it("pauses a job until the browser answers, then resumes it with the signature", async () => {
    const broker = new SignatureBroker();
    let resumed = false;
    const job = request(broker).then((v) => ((resumed = true), v));

    await new Promise((r) => setTimeout(r, 20));
    assert.equal(resumed, false, "the job must wait");
    const [pending] = broker.pending();
    assert.equal(pending.signer.address, master.publicKey());
    assert.equal(pending.payloadHex, PAYLOAD.toString("hex"));
    assert.equal(pending.message, walletMessage(ACCOUNT, PAYLOAD));

    assert.deepEqual(broker.submit(pending.id, { kind: "payload", signature: b64(master.sign(PAYLOAD)) }), { ok: true });
    assert.equal(kindOf(await job), "Ed25519");
    assert.equal(broker.pending().length, 0);
  });

  it("accepts a SEP-53 message signature as the Message variant", async () => {
    const broker = new SignatureBroker();
    const job = request(broker);
    const [pending] = broker.pending();
    const sig = master.sign(sep53Digest(pending.message));
    assert.deepEqual(broker.submit(pending.id, { kind: "message", signature: Buffer.from(sig).toString("hex") }), { ok: true });
    assert.equal(kindOf(await job), "Message");
  });

  it("refuses a signature by the wrong key, keeps waiting, and accepts the right one afterwards", async () => {
    const broker = new SignatureBroker();
    const job = request(broker);
    const [{ id }] = broker.pending();

    const wrong = broker.submit(id, { kind: "payload", signature: b64(stranger.sign(PAYLOAD)) });
    assert.equal(wrong.ok, false);
    assert.equal(broker.pending().length, 1, "a bad answer must not consume the request");

    assert.deepEqual(broker.submit(id, { kind: "payload", signature: b64(master.sign(PAYLOAD)) }), { ok: true });
    assert.equal(kindOf(await job), "Ed25519");
  });

  it("refuses a signature over a different payload, the wrong kind, and malformed answers", async () => {
    const broker = new SignatureBroker();
    void request(broker).catch(() => {});
    const [{ id, message }] = broker.pending();

    const refused = (response: unknown) => {
      const result = broker.submit(id, response as never);
      assert.equal(result.ok, false);
      return result;
    };
    refused({ kind: "payload", signature: b64(master.sign(Buffer.alloc(32, 1))) });
    // A message signature presented as a payload signature, and the reverse.
    refused({ kind: "payload", signature: b64(master.sign(sep53Digest(message))) });
    refused({ kind: "message", signature: b64(master.sign(PAYLOAD)) });
    refused({ kind: "payload", signature: "not a signature" });
    refused({ kind: "payload" });
    refused({ kind: "nope", signature: b64(master.sign(PAYLOAD)) });
    refused({});
    refused(null);
    assert.equal(broker.pending().length, 1);
    broker.cancel(id);
  });

  it("is single use: a second answer to the same request is refused", async () => {
    const broker = new SignatureBroker();
    const job = request(broker);
    const [{ id }] = broker.pending();
    const answer = { kind: "payload" as const, signature: b64(master.sign(PAYLOAD)) };
    assert.equal(broker.submit(id, answer).ok, true);
    await job;
    const again = broker.submit(id, answer);
    assert.equal(again.ok === false && again.reason, "unknown");
  });

  it("refuses unknown ids", () => {
    const result = new SignatureBroker().submit("nope", { kind: "payload", signature: "x" });
    assert.equal(result.ok === false && result.reason, "unknown");
  });

  it("cancels: the job rejects with SigningCancelled and the request disappears", async () => {
    const broker = new SignatureBroker();
    const job = request(broker);
    const [{ id }] = broker.pending();
    assert.equal(broker.cancel(id, "No thanks"), true);
    await assert.rejects(job, (e: Error) => e instanceof SigningCancelled && e.message === "No thanks");
    assert.equal(broker.pending().length, 0);
    assert.equal(broker.cancel(id), false);
    assert.equal(broker.submit(id, { kind: "payload", signature: b64(master.sign(PAYLOAD)) }).ok, false);
  });

  it("times out and cleans up", async () => {
    const broker = new SignatureBroker();
    await assert.rejects(request(broker, { timeoutMs: 30 }), /Timed out/);
    assert.equal(broker.pending().length, 0);
  });

  it("uses the default timeout from the constructor", async () => {
    await assert.rejects(request(new SignatureBroker(30)), /Timed out/);
  });

  it("keeps concurrent requests independent", async () => {
    const broker = new SignatureBroker();
    const a = request(broker);
    const b = request(broker);
    const [first, second] = broker.pending();
    assert.notEqual(first.id, second.id);
    broker.cancel(first.id);
    await assert.rejects(a, SigningCancelled);
    assert.equal(broker.submit(second.id, { kind: "payload", signature: b64(master.sign(PAYLOAD)) }).ok, true);
    await b;
  });
});

describe("summarizePreimage and brokerSigner", () => {
  it("describes what an auth entry authorizes", () => {
    assert.deepEqual(summarizePreimage(claimPreimage()), [`withdraw(${ACCOUNT}, 5) on ${SIM}`]);
  });

  it("lists nested invocations too", () => {
    const lines = summarizePreimage(claimPreimage(true));
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^withdraw\(/);
    assert.match(lines[1], /^claim\(/);
  });

  it("rejects XDR that is not an authorization preimage", () => {
    assert.throws(() => summarizePreimage("AAAA"));
  });

  it("a broker signer asks the browser with a readable summary and returns its signature", async () => {
    const broker = new SignatureBroker();
    const sign = brokerSigner(broker, { account: ACCOUNT, signerRaw: master.rawPublicKey(), signerLabel: "master" });
    const job = sign(claimPreimage(), PAYLOAD);
    const [pending] = broker.pending();
    assert.deepEqual(pending.summary, [`withdraw(${ACCOUNT}, 5) on ${SIM}`]);
    broker.submit(pending.id, { kind: "payload", signature: b64(master.sign(PAYLOAD)) });
    assert.equal(kindOf(await job), "Ed25519");
  });
});

describe("transaction requests (a wallet signs a whole transaction)", () => {
  const build = (fee = "100", source = master) =>
    new TransactionBuilder(new Account(source.publicKey(), "7"), { fee, networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.bumpSequence({ bumpTo: "100" }))
      .setTimeout(300)
      .build();

  const ask = (broker: SignatureBroker, tx = build()) =>
    broker.requestTransaction({
      signerRaw: master.rawPublicKey(),
      signerLabel: "master",
      transactionXdr: tx.toXDR(),
      networkPassphrase: Networks.TESTNET,
      summary: ["transfer(...)"],
    });

  const signedBy = (key: Keypair, tx = build()) => {
    tx.sign(key);
    return tx.toXDR();
  };

  it("pauses, shows the transaction and its hash, and resumes with the signed transaction", async () => {
    const broker = new SignatureBroker();
    const tx = build();
    const job = ask(broker, tx);
    const [pending] = broker.pending();
    assert.equal(pending.kind, "transaction");
    assert.equal(pending.kind === "transaction" && pending.transactionHashHex, Buffer.from(tx.hash()).toString("hex"));
    assert.equal(pending.signer.address, master.publicKey());

    const answered = broker.submit(pending.id, { kind: "transaction", signedXdr: signedBy(master, build()) });
    assert.deepEqual(answered, { ok: true });
    const signed = TransactionBuilder.fromXDR(await job, Networks.TESTNET);
    assert.equal(signed.signatures.length, 1);
    assert.ok(master.verify(Buffer.from(signed.hash()), Buffer.from(signed.signatures[0].signature.value)));
  });

  it("refuses a transaction signed by another key, an unsigned one and garbage, and keeps waiting", async () => {
    const broker = new SignatureBroker();
    void ask(broker).catch(() => {});
    const [{ id }] = broker.pending();
    const refused = (signedXdr: string, pattern: RegExp) => {
      const result = broker.submit(id, { kind: "transaction", signedXdr });
      assert.equal(result.ok, false);
      assert.match(result.ok === false ? result.message : "", pattern);
    };
    refused(signedBy(stranger), /not signed by master/);
    refused(build().toXDR(), /not signed by master/);
    refused("not xdr", /./);
    assert.equal(broker.pending().length, 1);
    broker.cancel(id);
  });

  it("refuses a forged signature that carries the master's hint but was made by another key", async () => {
    const broker = new SignatureBroker();
    void ask(broker).catch(() => {});
    const [{ id }] = broker.pending();
    const forged = build();
    // The hint is the last 4 bytes of the public key, so it can be copied; the signature itself cannot.
    // (The SDK's addSignature verifies, so the decorated signature is built by hand.)
    forged.signatures.push(
      new xdr.DecoratedSignature({ hint: master.signatureHint(), signature: stranger.sign(Buffer.from(forged.hash())) }),
    );
    assert.equal(forged.signatures.length, 1);
    assert.equal(
      TransactionBuilder.fromXDR(forged.toXDR(), Networks.TESTNET).signatures.length,
      1,
      "the forged signature must survive the XDR round trip, or this test proves nothing",
    );
    const result = broker.submit(id, { kind: "transaction", signedXdr: forged.toXDR() });
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.message : "", /not signed by master/);
    broker.cancel(id);
  });

  it("refuses a changed transaction even if the master signed it", async () => {
    const broker = new SignatureBroker();
    void ask(broker).catch(() => {});
    const [{ id }] = broker.pending();
    const result = broker.submit(id, { kind: "transaction", signedXdr: signedBy(master, build("9999")) });
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.message : "", /changed the transaction/);
    // A transaction for a different source is a different transaction too.
    assert.equal(broker.submit(id, { kind: "transaction", signedXdr: signedBy(master, build("100", stranger)) }).ok, false);
    broker.cancel(id);
  });

  it("drops anything extra the wallet attached; only the verified signature is kept", async () => {
    const broker = new SignatureBroker();
    const job = ask(broker);
    const [{ id }] = broker.pending();
    const both = build();
    both.sign(stranger);
    both.sign(master);
    assert.equal(broker.submit(id, { kind: "transaction", signedXdr: both.toXDR() }).ok, true);
    const result = TransactionBuilder.fromXDR(await job, Networks.TESTNET);
    assert.equal(result.signatures.length, 1);
  });

  it("does not mix request kinds", async () => {
    const broker = new SignatureBroker();
    void ask(broker).catch(() => {});
    void request(broker).catch(() => {});
    const [tx, auth] = broker.pending();
    assert.equal(broker.submit(tx.id, { kind: "payload", signature: b64(master.sign(PAYLOAD)) }).ok, false);
    assert.equal(broker.submit(auth.id, { kind: "transaction", signedXdr: signedBy(master) }).ok, false);
    assert.equal(broker.pending().length, 2);
    broker.cancel(tx.id);
    broker.cancel(auth.id);
  });

  it("is single use and cancellable", async () => {
    const broker = new SignatureBroker();
    const job = ask(broker);
    const [{ id }] = broker.pending();
    assert.equal(broker.submit(id, { kind: "transaction", signedXdr: signedBy(master) }).ok, true);
    await job;
    assert.equal(broker.submit(id, { kind: "transaction", signedXdr: signedBy(master) }).ok, false);

    const second = ask(broker);
    const [next] = broker.pending();
    broker.cancel(next.id, "No");
    await assert.rejects(second, SigningCancelled);
  });
});

describe("passkey requests (a WebAuthn assertion answers)", () => {
  const fx = JSON.parse(
    readFileSync(new URL("../../../contracts/smart-account/test-fixtures/webauthn-assertions.json", import.meta.url), "utf8"),
  ) as { spki: string; assertions: { challenge: string; authenticatorData: string; clientDataJSON: string; signature: string }[] };
  const passkey = publicKeyFromSpki(Buffer.from(fx.spki, "base64"));
  const rp = rpIdHash("localhost");
  const [one, two] = fx.assertions;
  const payloadOf = (a: typeof one) => Buffer.from(a.challenge, "base64");
  const answer = (a: typeof one, edit: Partial<{ authenticatorData: string; clientDataJson: string; signature: string }> = {}) => ({
    kind: "passkey" as const,
    authenticatorData: a.authenticatorData,
    clientDataJson: a.clientDataJSON,
    signature: a.signature,
    ...edit,
  });

  const ask = (broker: SignatureBroker, payload = payloadOf(one), rpIdHashValue = rp) =>
    broker.request({
      account: ACCOUNT,
      signerRaw: passkey,
      rpIdHash: rpIdHashValue,
      signerLabel: "delegate",
      preimageXdr: "AAAA",
      payload,
      summary: ["claim(x) on y"],
    });

  it("shows the passkey as a signer, takes a real assertion and returns the contract's Passkey signature", async () => {
    const broker = new SignatureBroker();
    const job = ask(broker);
    const [pending] = broker.pending();
    assert.equal(pending.signer.kind, "passkey");
    assert.equal(pending.signer.id, passkey.toString("hex"));
    assert.equal(pending.kind === "auth-entry" && pending.payloadHex, payloadOf(one).toString("hex"));

    assert.deepEqual(broker.submit(pending.id, answer(one)), { ok: true });
    const [kind, body] = scValToNative(await job) as [string, Record<string, Uint8Array>];
    assert.equal(kind, "Passkey");
    assert.equal(Buffer.from(body.public_key).toString("hex"), passkey.toString("hex"));
    assert.equal(body.sig.length, 64, "the DER signature is converted to compact r||s");
  });

  it("accepts every real assertion, whether the authenticator's s was high or low", async () => {
    for (const a of fx.assertions) {
      const broker = new SignatureBroker();
      const job = ask(broker, payloadOf(a));
      assert.equal(broker.submit(broker.pending()[0].id, answer(a)).ok, true);
      await job;
    }
  });

  it("refuses an assertion for another request, another site, or without verification, and keeps waiting", async () => {
    const broker = new SignatureBroker();
    void ask(broker).catch(() => {});
    const [{ id }] = broker.pending();
    const refused = (response: Parameters<SignatureBroker["submit"]>[1], pattern: RegExp) => {
      const result = broker.submit(id, response);
      assert.equal(result.ok, false);
      assert.match(result.ok === false ? result.message : "", pattern);
    };
    refused(answer(two), /challenge does not match/);
    const data = Buffer.from(one.authenticatorData, "base64");
    data[32] &= ~0x04;
    refused(answer(one, { authenticatorData: data.toString("base64") }), /verify the user/);
    data[0] ^= 1;
    refused(answer(one, { authenticatorData: data.toString("base64") }), /different site/);
    const json = Buffer.from(one.clientDataJSON, "base64").toString().replace("localhost", "localhosx");
    refused(answer(one, { clientDataJson: Buffer.from(json).toString("base64") }), /not .*passkey signature/);
    refused(answer(one, { signature: "AAAA" }), /Malformed/);
    refused(answer(one, { signature: "" }), /Malformed/);
    refused({ kind: "passkey", authenticatorData: "!!", clientDataJson: "!!", signature: "!!" }, /./);
    assert.equal(broker.pending().length, 1);
    broker.cancel(id);
  });

  it("refuses another passkey's signature even when everything else is right", async () => {
    const broker = new SignatureBroker();
    void ask(broker).catch(() => {});
    const [{ id }] = broker.pending();
    // The assertion is valid, but the request is for a different public key.
    const otherKey = Buffer.from(passkey);
    otherKey[20] ^= 1;
    const second = new SignatureBroker();
    void second
      .request({ account: ACCOUNT, signerRaw: otherKey, rpIdHash: rp, signerLabel: "delegate", preimageXdr: "AAAA", payload: payloadOf(one), summary: [] })
      .catch(() => {});
    const result = second.submit(second.pending()[0].id, answer(one));
    assert.equal(result.ok, false);
    broker.cancel(id);
    second.cancel(second.pending()[0].id);
  });

  it("does not mix passkey and key requests", async () => {
    const broker = new SignatureBroker();
    void ask(broker).catch(() => {});
    void request(broker).catch(() => {});
    const [passkeyRequest, keyRequest] = broker.pending();
    const keyToPasskey = broker.submit(passkeyRequest.id, { kind: "payload", signature: b64(master.sign(PAYLOAD)) });
    assert.equal(keyToPasskey.ok, false);
    assert.match(keyToPasskey.ok === false ? keyToPasskey.message : "", /is a passkey: it must answer with a passkey assertion/);
    const passkeyToKey = broker.submit(keyRequest.id, answer(one));
    assert.equal(passkeyToKey.ok, false);
    assert.match(passkeyToKey.ok === false ? passkeyToKey.message : "", /is a key, not a passkey/);
    assert.equal(broker.pending().length, 2);
    broker.cancel(passkeyRequest.id);
    broker.cancel(keyRequest.id);
  });

  it("needs the relying party hash, and is single use", async () => {
    const broker = new SignatureBroker();
    assert.throws(() => broker.request({ account: ACCOUNT, signerRaw: passkey, signerLabel: "d", preimageXdr: "AAAA", payload: PAYLOAD, summary: [] }), /relying party/);
    const job = ask(broker);
    const [{ id }] = broker.pending();
    assert.equal(broker.submit(id, answer(one)).ok, true);
    await job;
    assert.equal(broker.submit(id, answer(one)).ok, false);
  });
});

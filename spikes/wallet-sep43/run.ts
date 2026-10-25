// WP0 spike: does the smart account accept a signature produced the way SEP-43 describes?
//
// SEP-43 `signAuthEntry(authEntryPreimageXdr)` signs the *hash of the preimage* and returns the
// signature. This mock wallet implements exactly that, holding a key the way a wallet would, and
// the spike checks two things on testnet:
//   1. the 32-byte payload the contract verifies equals sha256(preimage XDR), so "sign the hash of
//      the preimage" is the right operation for a real wallet to perform;
//   2. a master signature produced through that interface is accepted by `__check_auth`.
//
// Run: npx tsx spikes/wallet-sep43/run.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Address, Keypair } from "@stellar/stellar-sdk";
import {
  createScenarioContext,
  ed25519SignatureScVal,
  invoke,
  latestLedger,
  LEDGERS_PER_MINUTE,
  optionLedgerScVal,
  signerIdScVal,
} from "@poc/core";

/** The SEP-43 wallet surface we need, as a wallet (or the Wallets Kit) exposes it. */
interface Sep43Wallet {
  signAuthEntry(authEntry: string, opts?: { networkPassphrase?: string; address?: string }): Promise<{ signedAuthEntry: string; signerAddress: string }>;
}

class MockSep43Wallet implements Sep43Wallet {
  constructor(private readonly key: Keypair) {}

  async signAuthEntry(authEntry: string, _opts?: { networkPassphrase?: string; address?: string }) {
    const preimage = Buffer.from(authEntry, "base64");
    const hash = createHash("sha256").update(preimage).digest();
    // Keypair.sign returns a Uint8Array, whose toString ignores "base64", so wrap it in a Buffer.
    return { signedAuthEntry: Buffer.from(this.key.sign(hash)).toString("base64"), signerAddress: this.key.publicKey() };
  }
}

const ctx = createScenarioContext();
const wallet = new MockSep43Wallet(ctx.master);
let observedPayloadMatches: boolean | null = null;

const result = await invoke(ctx, {
  contractId: ctx.smartAccountId,
  method: "set_expiry",
  args: [
    signerIdScVal(ctx.delegate.rawPublicKey()),
    optionLedgerScVal((await latestLedger(ctx)) + 30 * LEDGERS_PER_MINUTE),
  ],
  authorizers: [
    {
      kind: "smart-remote",
      address: ctx.smartAccountId,
      sign: async (preimageXdr, payload) => {
        // (1) the hash a wallet signs is exactly the payload the contract will verify
        observedPayloadMatches = createHash("sha256").update(Buffer.from(preimageXdr, "base64")).digest().equals(Buffer.from(payload));
        const { signedAuthEntry, signerAddress } = await wallet.signAuthEntry(preimageXdr, { address: ctx.master.publicKey() });
        assert.equal(signerAddress, ctx.master.publicKey());
        return ed25519SignatureScVal(ctx.master.rawPublicKey(), Buffer.from(signedAuthEntry, "base64"));
      },
    },
  ],
});

console.log("sha256(preimage XDR) == contract payload:", observedPayloadMatches);
assert.equal(observedPayloadMatches, true);
console.log("master signature via SEP-43 interface accepted by the smart account:", result.ok);
if (!result.ok) throw new Error(`${result.stage}: ${result.error}`);
console.log(`transaction: https://stellar.expert/explorer/testnet/tx/${result.hash}`);
console.log(`account: ${new Address(ctx.smartAccountId).toString()}`);

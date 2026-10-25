import {
  Account,
  Address,
  authorizeEntry,
  Contract,
  Keypair,
  Operation,
  rpc,
  scValToNative,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASE } from "./config.js";
import { ed25519SignatureScVal, type CallContext } from "./policy.js";

/** Who must authorize a Soroban call: a classic G account or the smart account. */
export type Authorizer =
  | { kind: "classic"; address: string; keypair: Keypair }
  // The smart account (C address); `keypair` is the G key that signs for it.
  | { kind: "smart"; address: string; keypair: Keypair }
  // The smart account, signed somewhere else (a wallet, a passkey). `sign` receives the base64
  // auth-entry preimage XDR and its 32-byte hash, and returns the account's signature ScVal.
  | { kind: "smart-remote"; address: string; sign: (preimageXdr: string, payload: Uint8Array) => Promise<xdr.ScVal> };

export interface ChainContext {
  server: rpc.Server;
  sponsor: Keypair;
}

export interface InvokeParams {
  contractId: string;
  method: string;
  args: xdr.ScVal[];
  authorizers?: Authorizer[];
}

export interface InvokeSuccess {
  ok: true;
  hash: string;
  returnValue: unknown;
}

export interface InvokeFailure {
  ok: false;
  stage: "simulation" | "enforcing-simulation" | "submission";
  error: string;
  /** Full simulator error text, including diagnostic events when available. */
  detail?: string;
}

export type InvokeResult = InvokeSuccess | InvokeFailure;

const INCLUSION_FEE = "10000";
const AUTH_VALIDITY_LEDGERS = 60;

/** Encodes the smart account's `AccSignature::Ed25519` signature for a G-key signer. */
export function smartAccountSignature(signer: Keypair, signature: Uint8Array): xdr.ScVal {
  return ed25519SignatureScVal(signer.rawPublicKey(), signature);
}

function buildTransaction(source: Account, func: xdr.HostFunction, auth: xdr.SorobanAuthorizationEntry[]) {
  return new TransactionBuilder(source, { fee: INCLUSION_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.invokeHostFunction({ func, auth }))
    .setTimeout(120)
    .build();
}

function credentialAddress(entry: xdr.SorobanAuthorizationEntry): string | null {
  const credentials = entry.credentials;
  switch (credentials.type) {
    case "sorobanCredentialsAddress":
      return Address.fromScAddress(credentials.address.address).toString();
    case "sorobanCredentialsAddressV2":
      return Address.fromScAddress(credentials.addressV2.address).toString();
    default:
      return null;
  }
}

async function signAuthEntries(
  entries: xdr.SorobanAuthorizationEntry[],
  authorizers: Authorizer[],
  validUntilLedger: number,
): Promise<xdr.SorobanAuthorizationEntry[]> {
  return Promise.all(
    entries.map(async (entry) => {
      // Source-account credentials are covered by the transaction signature.
      const address = credentialAddress(entry);
      if (address === null) return entry;
      const authorizer = authorizers.find((a) => a.address === address);
      if (!authorizer) throw new Error(`No authorizer provided for ${address}`);

      if (authorizer.kind === "classic") {
        return authorizeEntry(entry, authorizer.keypair, validUntilLedger, NETWORK_PASSPHRASE);
      }
      if (authorizer.kind === "smart-remote") {
        return authorizeEntry(
          entry,
          async (preimage, payload) => ({ signatureScVal: await authorizer.sign(preimage.toXDR("base64"), payload) }),
          validUntilLedger,
          NETWORK_PASSPHRASE,
        );
      }
      return authorizeEntry(
        entry,
        async (_preimage, payload) => ({
          signatureScVal: smartAccountSignature(authorizer.keypair, authorizer.keypair.sign(Buffer.from(payload))),
        }),
        validUntilLedger,
        NETWORK_PASSPHRASE,
      );
    }),
  );
}

function errorText(error: string): string {
  return error.split("\n")[0].trim();
}

const SMART_ACCOUNT_ERRORS: Record<number, string> = {
  1: "NotInitialized",
  2: "UnknownSigner",
  3: "NotAllowed",
  4: "InvalidPolicy",
  5: "SignerExpired",
};

/** The host reports any failed `__check_auth` as Auth/InvalidAction; the real error is in the diagnostics. */
function accountAuthError(detail: string): string | undefined {
  const match = detail.match(/failed account authentication with error",\s*(C[A-Z2-7]{55}),\s*Error\(Contract, #(\d+)\)/);
  if (!match) return undefined;
  const code = Number(match[2]);
  return `smart account ${match[1]} rejected the signature in __check_auth: ${SMART_ACCOUNT_ERRORS[code] ?? "error"} (#${code})`;
}

async function waitForTransaction(server: rpc.Server, hash: string): Promise<rpc.Api.GetTransactionResponse> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const result = await server.getTransaction(hash);
    if (result.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) return result;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`Timed out waiting for transaction ${hash}`);
}

function contractCallFunction(params: Pick<InvokeParams, "contractId" | "method" | "args">): xdr.HostFunction {
  const { body } = new Contract(params.contractId).call(params.method, ...params.args);
  if (body.type !== "invokeHostFunction") throw new Error("Unexpected operation body for contract call");
  return body.invokeHostFunctionOp.hostFunction;
}

function flattenInvocation(node: xdr.SorobanAuthorizedInvocation, into: CallContext[]): void {
  const fn = node.function;
  if (fn.type === "sorobanAuthorizedFunctionTypeContractFn") {
    into.push({
      kind: "contract",
      contract: Address.fromScAddress(fn.contractFn.contractAddress).toString(),
      function: fn.contractFn.functionName.toString(),
      args: fn.contractFn.args,
    });
  } else {
    into.push({ kind: "other", description: "a contract deployment" });
  }
  for (const sub of node.subInvocations) flattenInvocation(sub, into);
}

export type RecordedAuth =
  | { ok: true; /** Every invocation `account` is asked to authorize, root and nested. */ calls: CallContext[] }
  | { ok: false; error: string; detail: string };

/**
 * Simulates a call (without signing or submitting anything) and returns the invocations the given
 * smart account would have to authorize. This is the same tree its `__check_auth` receives.
 */
export async function recordAuthContexts(ctx: ChainContext, params: Pick<InvokeParams, "contractId" | "method" | "args">, account: string): Promise<RecordedAuth> {
  const { server, sponsor } = ctx;
  const recording = await server.simulateTransaction(
    buildTransaction(await server.getAccount(sponsor.publicKey()), contractCallFunction(params), []),
  );
  if (rpc.Api.isSimulationError(recording)) {
    return { ok: false, error: errorText(recording.error), detail: recording.error };
  }
  const calls: CallContext[] = [];
  for (const entry of recording.result?.auth ?? []) {
    if (credentialAddress(entry) === account) flattenInvocation(entry.rootInvocation, calls);
  }
  return { ok: true, calls };
}

/**
 * Invokes a contract function. The sponsor is the transaction source and pays all fees.
 * Auth is recorded by a first simulation, signed by the given authorizers, then verified
 * by a second (enforcing) simulation, so policy violations fail before submission.
 */
export async function invoke(ctx: ChainContext, params: InvokeParams): Promise<InvokeResult> {
  const { server, sponsor } = ctx;
  const hostFunction = contractCallFunction(params);

  const recording = await server.simulateTransaction(
    buildTransaction(await server.getAccount(sponsor.publicKey()), hostFunction, []),
  );
  if (rpc.Api.isSimulationError(recording)) {
    return { ok: false, stage: "simulation", error: errorText(recording.error), detail: recording.error };
  }

  const unsigned = recording.result?.auth ?? [];
  const signed = await signAuthEntries(unsigned, params.authorizers ?? [], recording.latestLedger + AUTH_VALIDITY_LEDGERS);

  const withAuth = buildTransaction(await server.getAccount(sponsor.publicKey()), hostFunction, signed);
  const enforcing = await server.simulateTransaction(withAuth);
  if (rpc.Api.isSimulationError(enforcing)) {
    return {
      ok: false,
      stage: "enforcing-simulation",
      error: accountAuthError(enforcing.error) ?? errorText(enforcing.error),
      detail: enforcing.error,
    };
  }

  const prepared = rpc.assembleTransaction(withAuth, enforcing).build();
  prepared.sign(sponsor);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    return { ok: false, stage: "submission", error: `sendTransaction rejected: ${sent.errorResult?.toXDR("base64") ?? "unknown"}` };
  }
  const final = await waitForTransaction(server, sent.hash);
  if (final.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    return { ok: false, stage: "submission", error: `transaction ${sent.hash} ended with status ${final.status}` };
  }
  return {
    ok: true,
    hash: sent.hash,
    returnValue: final.returnValue === undefined ? undefined : scValToNative(final.returnValue),
  };
}

/** Read-only call evaluated by simulation; nothing is submitted. */
export async function read(ctx: ChainContext, contractId: string, method: string, args: xdr.ScVal[] = []): Promise<unknown> {
  const source = new Account(ctx.sponsor.publicKey(), "0");
  const tx = new TransactionBuilder(source, { fee: INCLUSION_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await ctx.server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${method}: ${errorText(sim.error)}`);
  return sim.result ? scValToNative(sim.result.retval) : undefined;
}

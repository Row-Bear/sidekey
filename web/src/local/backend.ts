// The static build's replacement for the dev server's `/api/*`: the same requests and answers, handled in the
// browser with the core's browser-safe modules. Chain reads go straight to the RPC, transactions go through a
// relayer, signatures come from the wallet or passkey through the same signing broker, and the session and
// history live in localStorage. Nothing here needs a server, a CLI or a key of ours.
import { Keypair } from "@stellar/stellar-sdk";
import {
  accountFeatures,
  accountStatus,
  type Authorizer,
  brokerAuthorizer,
  type CallRequest,
  checkWalletAccount,
  contractFunctions,
  createAccountViaFactory,
  createScenarioContext,
  findFactoryAccounts,
  fundWithFriendbot,
  latestLedger,
  listSigners,
  NETWORK_PASSPHRASE,
  previewCall,
  readDelegatePolicy,
  readRecordedAccounts,
  rememberAccount,
  runCall,
  runPolicyOp,
  sessionEnv,
  SignatureBroker,
  type SigningSource,
} from "../../../packages/core/src/browser.ts";
import type { DemoState, RunRequest } from "../api-types.ts";
import { isText, parseAddress, parseCallRequest, parsePasskey, parseRunRequest, parseSignatureBody } from "../parse.ts";
import { relay, relayTransaction } from "./channels.ts";
import { clearHistory, loadHistory, loadSession, saveRecord, saveSession } from "./store.ts";

const env = (key: string, fallback: string): string => (import.meta.env?.[key] as string | undefined) || fallback;

/** The testnet contracts the page works with; a build can point them elsewhere with VITE_* variables. */
export const CONFIG = {
  yieldSimulator: env("VITE_YIELD_SIM_ID", "CDGOE4WK2MAL2U2VFIFPVGIAWNZU5A2KJ5FJTJ7GMXVNS2GGWK4N33DL"),
  factory: env("VITE_FACTORY_ID", "CAXEX3UHU7VQBWVPO7XVWSVQBOFNJO4HA7VUML2WWI6IH7H43WSCXXSB"),
};

const MAX_LOG_LINES = 60;
const NOT_AVAILABLE = "The guided demo needs a server and is not part of this build";

// The scenario context wants keys for roles this build never uses (a fee sponsor, the demo's master and delegate).
// They are throwaway: nothing is ever signed or paid with them.
const spare = { sponsor: Keypair.random(), master: Keypair.random(), delegate: Keypair.random() };

const broker = new SignatureBroker();

const currentContext = () => {
  const session = loadSession();
  const base = createScenarioContext({
    SPONSOR_SECRET: spare.sponsor.secret(),
    MASTER_SECRET: spare.master.secret(),
    MASTER_PUBLIC: spare.master.publicKey(),
    DELEGATE_SECRET: spare.delegate.secret(),
    SMART_ACCOUNT_ID: CONFIG.factory,
    YIELD_SIM_CONTRACT_ID: CONFIG.yieldSimulator,
    ...sessionEnv(session),
  });
  // The master (a wallet account that exists on chain) is the simulation source, and the relayer pays every fee.
  return { ...base, relay, relayTransaction, simulationSource: base.master.publicKey() };
};
type Context = ReturnType<typeof currentContext>;

const run: DemoState["run"] = { busy: false, currentStep: null, label: null, log: [], lastError: null };
const log = (message: string) => {
  run.log.push(`${new Date().toLocaleTimeString("en-GB")}  ${message}`);
  if (run.log.length > MAX_LOG_LINES) run.log.splice(0, run.log.length - MAX_LOG_LINES);
};

/** Who signs in the browser: a wallet master, and a passkey, always (neither can be done any other way here). */
const signingFor = (ctx: Context): SigningSource => {
  const browser = (signer: { label: string; raw: Uint8Array; rpIdHash?: Uint8Array }): Authorizer[] => [
    brokerAuthorizer(broker, { account: ctx.smartAccountId, signerRaw: signer.raw, rpIdHash: signer.rpIdHash, signerLabel: signer.label }),
  ];
  return (signer) => browser(signer);
};

/** Asks the wallet to sign a transaction of its own account. */
const walletTransactionSigner = (ctx: Context) => (transactionXdr: string, summary: string[]) =>
  broker.requestTransaction({ signerRaw: ctx.master.rawPublicKey(), signerLabel: "master", transactionXdr, networkPassphrase: NETWORK_PASSPHRASE, summary });

async function buildState(): Promise<DemoState> {
  const ctx = currentContext();
  const session = loadSession();
  const state: DemoState = {
    network: "testnet",
    accounts: {
      sponsor: "",
      master: session.wallet?.address ?? "",
      delegate: ctx.delegatePasskey ? `passkey ${Buffer.from(ctx.delegatePasskey.publicKey).toString("hex").slice(2, 10)}…` : "",
      smartAccount: session.wallet?.smartAccountId ?? "",
      simulator: CONFIG.yieldSimulator,
    },
    mode: ctx.walletMaster ? "wallet" : "demo",
    wallet: session.wallet ?? null,
    knownAccounts: session.known ?? [],
    delegate: ctx.delegatePasskey ? "passkey" : "key",
    passkey: session.passkey ?? null,
    snapshot: null,
    delegatePolicy: null,
    latestLedger: null,
    steps: [],
    results: {},
    calls: loadHistory(),
    pendingSignatures: broker.pending(),
    run: { ...run, log: [...run.log] },
    updatedAt: new Date().toISOString(),
  };
  if (ctx.walletMaster) {
    try {
      [state.delegatePolicy, state.latestLedger] = await Promise.all([readDelegatePolicy(ctx), latestLedger(ctx)]);
    } catch (err) {
      state.readError = err instanceof Error ? err.message : String(err);
    }
  }
  return state;
}

/** Deploys a new smart account for the wallet through the factory and makes it the active one. */
async function createAccount(address: string): Promise<void> {
  run.label = "Creating a smart account for your wallet";
  const ctx = currentContext();
  const existing = await findFactoryAccounts(ctx, CONFIG.factory, address);
  const used = new Set(existing.map((a) => a.index));
  let index = 0;
  while (used.has(index)) index++;
  if (index >= 8) throw new Error("This wallet already has 8 smart accounts, the most this page makes");
  log(`Creating account number ${index + 1} (your wallet signs one transaction; a relayer pays the fee)`);
  // The wallet may not be the session's master yet, so the signer is built for this address.
  const forWallet = { ...ctx, master: Keypair.fromPublicKey(address) };
  const result = await createAccountViaFactory({
    ctx: forWallet,
    factoryId: CONFIG.factory,
    master: address,
    index,
    signTransaction: walletTransactionSigner(forWallet),
  });
  if (!result.ok) throw new Error(`${result.error}${result.stage === "simulation" ? " (is the wallet's account funded?)" : ""}`);
  const smartAccountId = String(result.returnValue);
  const session = loadSession();
  const wallet = { address, smartAccountId };
  saveSession({ ...session, mode: "wallet", wallet, known: rememberAccount(session.known, wallet) });
  clearHistory();
  log(`Created ${smartAccountId} (${result.hash.slice(0, 10)}…)`);
}

async function execute(request: RunRequest): Promise<void> {
  try {
    if (request.action === "call" || request.action === "policy") {
      const ctx = currentContext();
      run.label =
        request.action === "call"
          ? `Sending ${request.call.function}() as ${request.call.signer === "master" ? "master" : "a delegate"}`
          : "Applying a policy edit as the master";
      const record = request.action === "call" ? await runCall(ctx, request.call, signingFor(ctx)) : await runPolicyOp(ctx, request.policy, signingFor(ctx));
      saveRecord(record);
      log(`${record.title}: ${record.outcome}${record.error ? ` (${record.error})` : ""}`);
      return;
    }
    if (request.action === "wallet-fund") {
      run.label = "Funding the wallet account with Friendbot";
      await fundWithFriendbot(request.address);
      log(`Funded ${request.address} with Friendbot`);
      return;
    }
    if (request.action === "wallet-account" || (request.action === "fresh" && loadSession().wallet)) {
      const address = request.action === "wallet-account" ? request.address : loadSession().wallet!.address;
      await createAccount(address);
      return;
    }
    if (request.action === "record-account") {
      log("Nothing to record: your accounts are found from your wallet's address");
      return;
    }
    throw new Error(NOT_AVAILABLE);
  } catch (err) {
    run.lastError = err instanceof Error ? err.message : String(err);
    log(`Error: ${run.lastError}`);
  } finally {
    run.busy = false;
    run.currentStep = null;
    run.label = null;
  }
}

export interface ApiReply {
  status: number;
  body: unknown;
}
const reply = (status: number, body: unknown): ApiReply => ({ status, body });

/** Answers one `/api/...` request. `path` includes the query string; `body` is the parsed JSON, if any. */
export async function handle(method: string, path: string, body: unknown): Promise<ApiReply> {
  try {
    const url = new URL(path, "http://local");
    const route = url.pathname.replace(/^\/api/, "");
    const query = url.searchParams;

    if (method === "GET" && route === "/state") return reply(200, await buildState());

    if (method === "GET" && route === "/signers") {
      const ctx = currentContext();
      if (!ctx.walletMaster) return reply(409, { error: "No smart account yet: connect a wallet and create one" });
      const [signers, ledger, features] = await Promise.all([listSigners(ctx, { demoDelegate: false }), latestLedger(ctx), accountFeatures(ctx)]);
      return reply(200, {
        smartAccount: ctx.smartAccountId,
        simulator: ctx.simId,
        nativeToken: ctx.nativeId,
        master: ctx.master.publicKey(),
        latestLedger: ledger,
        features,
        signers,
      });
    }

    if (method === "GET" && route === "/wallet-status") {
      const status = await accountStatus(currentContext().rpcUrl, parseAddress(query.get("address")));
      return reply(200, status.exists ? { exists: true, stroops: status.stroops.toString() } : { exists: false });
    }

    if (method === "GET" && route === "/wallet-accounts") {
      const address = parseAddress(query.get("address"));
      const ctx = currentContext();
      const [fromFactory, recorded] = await Promise.all([
        findFactoryAccounts(ctx, CONFIG.factory, address),
        readRecordedAccounts(ctx, address).catch(() => []),
      ]);
      // Accounts the factory made are found from the address alone; ones recorded on the wallet's account are older.
      const accounts = [...fromFactory.map((a) => ({ index: a.index + 1, smartAccountId: a.smartAccountId })), ...recorded];
      const unique = accounts.filter((a, i) => accounts.findIndex((b) => b.smartAccountId === a.smartAccountId) === i);
      return reply(200, { accounts: unique });
    }

    if (method === "POST" && route === "/wallet-load") {
      if (run.busy) return reply(409, { error: "A run is in progress" });
      const b = body as Record<string, unknown>;
      if (!isText(b.smartAccountId)) throw new Error("smartAccountId is required");
      const wallet = await checkWalletAccount(currentContext(), parseAddress(b.address), b.smartAccountId.trim());
      const session = loadSession();
      saveSession({ ...session, mode: "wallet", wallet, known: rememberAccount(session.known, wallet) });
      clearHistory();
      return reply(200, { wallet });
    }

    if (method === "POST" && route === "/passkey") {
      if (run.busy) return reply(409, { error: "A run is in progress" });
      const b = body as Record<string, unknown>;
      const session = loadSession();
      if (b.action === "register") {
        saveSession({ ...session, delegate: "passkey", passkey: parsePasskey(b, location.host) });
        return reply(200, { delegate: "passkey" });
      }
      if (b.action === "select") {
        if (b.delegate === "passkey" && !session.passkey) return reply(409, { error: "Create a passkey first" });
        if (b.delegate !== "key" && b.delegate !== "passkey") return reply(400, { error: 'delegate must be "key" or "passkey"' });
        saveSession({ ...session, delegate: b.delegate });
        return reply(200, { delegate: b.delegate });
      }
      return reply(400, { error: 'action must be "register" or "select"' });
    }

    if (method === "POST" && route === "/mode") {
      const mode = (body as { mode?: unknown }).mode;
      const session = loadSession();
      if (mode === "wallet" && !session.wallet) return reply(409, { error: "No wallet smart account yet: connect a wallet and create one first" });
      if (mode !== "wallet" && mode !== "demo") return reply(400, { error: 'mode must be "demo" or "wallet"' });
      if (run.busy) return reply(409, { error: "A run is in progress" });
      saveSession({ ...session, mode });
      return reply(200, { mode });
    }

    if (method === "GET" && route === "/contract-functions") {
      const id = query.get("id") ?? "";
      return reply(200, { contract: id, functions: await contractFunctions(currentContext(), id) });
    }

    if (method === "POST" && route === "/signature") {
      const answer = parseSignatureBody(body);
      if ("cancel" in answer) {
        return broker.cancel(answer.id, answer.reason) ? reply(200, { cancelled: true }) : reply(404, { error: "No such signing request" });
      }
      const result = broker.submit(answer.id, answer.response);
      if (result.ok) return reply(200, { accepted: true });
      return reply(result.reason === "unknown" ? 404 : 422, { error: result.message });
    }

    if (method === "POST" && route === "/preview") {
      return reply(200, await previewCall(currentContext(), parseCallRequest(body) as CallRequest));
    }

    if (method === "POST" && route === "/run") {
      if (run.busy) return reply(409, { error: "A run is already in progress" });
      const request = parseRunRequest(body);
      run.busy = true;
      run.lastError = null;
      run.log = [];
      log(`Requested: ${request.action}`);
      void execute(request);
      return reply(202, { started: true });
    }

    return reply(404, { error: "Not found" });
  } catch (err) {
    return reply(400, { error: err instanceof Error ? err.message : String(err) });
  }
}

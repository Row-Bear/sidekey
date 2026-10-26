import "dotenv/config";
import { parse } from "dotenv";
import { StrKey } from "@stellar/stellar-sdk";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { Plugin } from "vite";
import {
  accountStatus,
  type Authorizer,
  brokerAuthorizer,
  brokerSigner,
  type CallRequest,
  clearCallHistory,
  clearResults,
  type ConstraintInput,
  contractFunctions,
  CORE_STEP_COUNT,
  createFreshDemoAccount,
  createWalletAccount,
  createScenarioContext,
  type ExpiryInput,
  fundWithFriendbot,
  latestLedger,
  listSigners,
  loadCallHistory,
  loadResults,
  loadSession,
  NETWORK_PASSPHRASE,
  type PasskeyDelegate,
  type PolicyOp,
  previewCall,
  readDelegatePolicy,
  runCall,
  runPolicyOp,
  runStep,
  saveCallRecord,
  saveResult,
  saveSession,
  sessionEnv,
  SignatureBroker,
  type SignatureResponse,
  type SigningSource,
  snapshot,
  STEPS,
} from "../../packages/core/src/index.ts";
import type { DemoState, RunRequest } from "../src/api-types.ts";
import { checkApiRequest } from "./guard.ts";

const MAX_LOG_LINES = 60;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

const isText = (v: unknown): v is string => typeof v === "string";

/** Rebuilds a call request from untrusted JSON, keeping only the known fields. */
function parseCallRequest(body: unknown): CallRequest {
  const c = (body ?? {}) as Record<string, unknown>;
  if (isText(c.contract) && isText(c.function) && isText(c.signer) && Array.isArray(c.args) && c.args.every(isText)) {
    return { contract: c.contract, function: c.function, signer: c.signer, args: [...c.args] };
  }
  throw new Error("Invalid call: expected contract, function and signer as text and args as a list of text");
}

function parseExpiry(value: unknown): ExpiryInput | undefined {
  if (value === undefined) return undefined;
  const e = value as Record<string, unknown>;
  if (e?.kind === "none") return { kind: "none" };
  if (e?.kind === "minutes" && typeof e.minutes === "number") return { kind: "minutes", minutes: e.minutes };
  if (e?.kind === "ledger" && typeof e.ledger === "number") return { kind: "ledger", ledger: e.ledger };
  throw new Error('Invalid expiry: expected {kind:"none"}, {kind:"minutes",minutes} or {kind:"ledger",ledger}');
}

function parsePolicyOp(body: unknown): PolicyOp {
  const p = (body ?? {}) as Record<string, unknown>;
  if (!isText(p.signer)) throw new Error("Invalid policy edit: signer is required");
  switch (p.op) {
    case "allow": {
      const constraints = p.constraints;
      const valid = Array.isArray(constraints) && constraints.every((c) =>
        c && ["any", "self", "exact"].includes(c.kind) && (c.value === undefined || isText(c.value)));
      if (!isText(p.contract) || !isText(p.function) || !valid) {
        throw new Error("Invalid policy edit: allow needs contract, function and a list of constraints");
      }
      const list = (constraints as ConstraintInput[]).map((c) => ({ kind: c.kind, ...(c.value !== undefined ? { value: c.value } : {}) }));
      return { op: "allow", signer: p.signer, contract: p.contract, function: p.function, constraints: list, expiry: parseExpiry(p.expiry) };
    }
    case "remove-rule":
      if (isText(p.contract) && isText(p.function)) return { op: "remove-rule", signer: p.signer, contract: p.contract, function: p.function };
      break;
    case "set-expiry": {
      const expiry = parseExpiry(p.expiry);
      if (expiry) return { op: "set-expiry", signer: p.signer, expiry };
      break;
    }
    case "revoke":
      return { op: "revoke", signer: p.signer };
  }
  throw new Error("Invalid policy edit");
}

/** Whether signatures come from the browser (wallet, passkey, pasted) instead of the demo's own keys. */
const parseVia = (value: unknown): { via?: "browser" } => (value === "browser" ? { via: "browser" } : {});

type SignatureBody = { id: string; response: SignatureResponse } | { id: string; cancel: true; reason?: string };

function parseSignatureBody(body: unknown): SignatureBody {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!isText(b.id)) throw new Error("Invalid signature answer: id is required");
  if (b.cancel === true) return { id: b.id, cancel: true, ...(isText(b.reason) ? { reason: b.reason } : {}) };
  const r = (b.response ?? {}) as Record<string, unknown>;
  if ((r.kind === "payload" || r.kind === "message") && isText(r.signature)) {
    return { id: b.id, response: { kind: r.kind, signature: r.signature } };
  }
  if (r.kind === "transaction" && isText(r.signedXdr)) return { id: b.id, response: { kind: "transaction", signedXdr: r.signedXdr } };
  if (r.kind === "passkey" && isText(r.authenticatorData) && isText(r.clientDataJson) && isText(r.signature)) {
    return {
      id: b.id,
      response: { kind: "passkey", authenticatorData: r.authenticatorData, clientDataJson: r.clientDataJson, signature: r.signature },
    };
  }
  throw new Error(
    'Invalid signature answer: expected response {kind: "payload" | "message", signature}, {kind: "transaction", signedXdr}, {kind: "passkey", authenticatorData, clientDataJson, signature} or cancel: true',
  );
}

/** A passkey the browser just created; its relying party must be the host the page is served from. */
function parsePasskey(body: Record<string, unknown>, host: string): PasskeyDelegate {
  const hostname = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  const { credentialId, publicKeyHex, rpId } = body;
  if (!isText(credentialId) || !/^[A-Za-z0-9_-]{8,1024}$/.test(credentialId)) throw new Error("Invalid passkey: credentialId must be base64url");
  if (!isText(publicKeyHex) || !/^04[0-9a-f]{128}$/.test(publicKeyHex)) throw new Error("Invalid passkey: publicKeyHex must be a 65-byte uncompressed P-256 key");
  if (!isText(rpId) || rpId !== hostname) throw new Error(`Invalid passkey: its relying party must be ${hostname}`);
  return { credentialId, publicKeyHex, rpId };
}

function parseAddress(value: unknown): string {
  if (isText(value) && StrKey.isValidEd25519PublicKey(value)) return value;
  throw new Error("Invalid wallet address: expected a Stellar G address");
}

function parseRunRequest(body: unknown): RunRequest {
  const b = body as Partial<RunRequest> & { from?: unknown; to?: unknown; call?: unknown; policy?: unknown; via?: unknown };
  if (b.action === "full" || b.action === "fresh") return { action: b.action };
  if (b.action === "wallet-account") return { action: "wallet-account", address: parseAddress((b as { address?: unknown }).address) };
  if (b.action === "wallet-fund") return { action: "wallet-fund", address: parseAddress((b as { address?: unknown }).address) };
  if (b.action === "call") return { action: "call", call: parseCallRequest(b.call), ...parseVia(b.via) };
  if (b.action === "policy") return { action: "policy", policy: parsePolicyOp(b.policy), ...parseVia(b.via) };
  if (b.action === "steps") {
    const from = Number(b.from);
    const to = Number(b.to);
    const valid = (n: number) => Number.isInteger(n) && n >= 1 && n <= STEPS.length;
    if (valid(from) && valid(to) && from <= to) return { action: "steps", from, to, ...parseVia(b.via) };
  }
  throw new Error(`Invalid run request; expected action "full", "fresh", "steps" (from/to in 1-${STEPS.length}), "call", "policy", "wallet-account" or "wallet-fund"`);
}

export function demoApi(repoRoot: string): Plugin {
  const resultsPath = join(repoRoot, "demo-run.json");
  const historyPath = join(repoRoot, "demo-calls.json");
  const sessionPath = join(repoRoot, "wallet-session.json");
  const broker = new SignatureBroker();
  const envPath = join(repoRoot, ".env");

  // `.env` is the source of truth: the CLI (`npm run poc -- --fresh`) can replace the master and
  // smart account while this server runs, so read it per request instead of trusting process.env.
  const currentContext = () =>
    createScenarioContext({ ...process.env, ...parse(readFileSync(envPath)), ...sessionEnv(loadSession(sessionPath)) });

  /**
   * Who signs in the browser: everything when asked, a wallet master always, and a passkey always (it
   * never leaves the browser). Otherwise null, and the demo signs with the key it holds.
   */
  const signingFor = (ctx: ReturnType<typeof currentContext>, via: "browser" | undefined): SigningSource | undefined => {
    const browser = (signer: { label: string; raw: Uint8Array; rpIdHash?: Uint8Array }): Authorizer[] => [
      brokerAuthorizer(broker, { account: ctx.smartAccountId, signerRaw: signer.raw, rpIdHash: signer.rpIdHash, signerLabel: signer.label }),
    ];
    if (via === "browser") return browser;
    if (!ctx.walletMaster && !ctx.delegatePasskey) return undefined;
    return (signer) => (signer.raw.length === 65 || (ctx.walletMaster && signer.id === "master") ? browser(signer) : null);
  };

  const run: DemoState["run"] = { busy: false, currentStep: null, label: null, log: [], lastError: null };
  const log = (message: string) => {
    run.log.push(`${new Date().toLocaleTimeString("en-GB")}  ${message}`);
    if (run.log.length > MAX_LOG_LINES) run.log.splice(0, run.log.length - MAX_LOG_LINES);
  };

  async function buildState(): Promise<DemoState> {
    const ctx = currentContext();
    const state: DemoState = {
      network: "testnet",
      accounts: {
        sponsor: ctx.sponsor.publicKey(),
        master: ctx.master.publicKey(),
        delegate: ctx.delegatePasskey ? `passkey ${Buffer.from(ctx.delegatePasskey.publicKey).toString("hex").slice(2, 10)}…` : ctx.delegate.publicKey(),
        smartAccount: ctx.smartAccountId,
        simulator: ctx.simId,
      },
      mode: ctx.walletMaster ? "wallet" : "demo",
      wallet: loadSession(sessionPath).wallet ?? null,
      delegate: ctx.delegatePasskey ? "passkey" : "key",
      passkey: loadSession(sessionPath).passkey ?? null,
      snapshot: null,
      delegatePolicy: null,
      latestLedger: null,
      steps: STEPS.map((s, i) => ({
        n: i + 1,
        name: s.name,
        signer: s.signer,
        expected: s.expected,
        ...(s.optional ? { optional: true } : {}),
      })),
      results: loadResults(resultsPath),
      calls: loadCallHistory(historyPath),
      pendingSignatures: broker.pending(),
      run: { ...run, log: [...run.log] },
      updatedAt: new Date().toISOString(),
    };
    try {
      const [snap, policy, ledger] = await Promise.all([snapshot(ctx), readDelegatePolicy(ctx), latestLedger(ctx)]);
      state.snapshot = snap;
      state.delegatePolicy = policy;
      state.latestLedger = ledger;
    } catch (err) {
      state.readError = err instanceof Error ? err.message : String(err);
    }
    return state;
  }

  async function execute(request: RunRequest): Promise<void> {
    try {
      if (request.action === "call" || request.action === "policy") {
        const ctx = currentContext();
        const signing = signingFor(ctx, request.via);
        run.label = request.action === "call"
          ? `Sending ${request.call.function}() as ${request.call.signer === "master" ? "master" : "a delegate"}`
          : "Applying a policy edit as the master";
        const record = request.action === "call"
          ? await runCall(ctx, request.call, signing)
          : await runPolicyOp(ctx, request.policy, signing);
        saveCallRecord(historyPath, record);
        log(`${record.title}: ${record.outcome}${record.error ? ` (${record.error})` : ""}`);
        return;
      }
      if (request.action === "wallet-fund") {
        run.label = "Funding the wallet account with Friendbot";
        await fundWithFriendbot(request.address);
        log(`Funded ${request.address} with Friendbot`);
        return;
      }
      if (request.action === "wallet-account") {
        run.label = "Deploying a smart account for the wallet";
        clearResults(resultsPath);
        clearCallHistory(historyPath);
        await createWalletAccount({ repoRoot, sessionPath, masterAddress: request.address, log });
        return;
      }
      if (request.action === "fresh" || request.action === "full") {
        clearResults(resultsPath);
        clearCallHistory(historyPath);
        const session = loadSession(sessionPath);
        if (session.mode === "wallet" && session.wallet) {
          // The wallet stays the master; only the smart account is new.
          run.label = "Deploying a fresh smart account for the wallet";
          await createWalletAccount({ repoRoot, sessionPath, masterAddress: session.wallet.address, log });
        } else {
          run.label = "Creating a fresh master account and smart account";
          await createFreshDemoAccount({ repoRoot, envPath, log });
        }
      }
      if (request.action === "fresh") return;

      const from = request.action === "steps" ? request.from : 1;
      // "full" is the core demo (steps 1-7); the optional expiry steps run on request.
      const to = request.action === "steps" ? request.to : CORE_STEP_COUNT;
      const ctx = currentContext();
      const viaBrowser = request.action === "steps" && request.via === "browser";
      if (viaBrowser || ctx.walletMaster) {
        const asBrowser = (label: "master" | "delegate", raw: Uint8Array) =>
          brokerSigner(broker, { account: ctx.smartAccountId, signerRaw: raw, signerLabel: label });
        ctx.remoteSigners = { master: asBrowser("master", ctx.master.rawPublicKey()) };
        // The delegate's key is held by the demo, so it signs itself unless the browser was asked to.
        if (viaBrowser) ctx.remoteSigners.delegate = asBrowser("delegate", ctx.delegate.rawPublicKey());
      }
      if (ctx.delegatePasskey) {
        // A passkey never leaves the browser, so its steps always ask for it.
        ctx.remoteSigners = {
          ...ctx.remoteSigners,
          delegate: brokerSigner(broker, {
            account: ctx.smartAccountId,
            signerRaw: ctx.delegatePasskey.publicKey,
            rpIdHash: ctx.delegatePasskey.rpIdHash,
            signerLabel: "delegate",
          }),
        };
      }
      if (ctx.walletMaster) {
        ctx.remoteTransactionSigner = (transactionXdr, summary) =>
          broker.requestTransaction({
            signerRaw: ctx.master.rawPublicKey(),
            signerLabel: "master",
            transactionXdr,
            networkPassphrase: NETWORK_PASSPHRASE,
            summary,
          });
      }
      for (let step = from; step <= to; step++) {
        run.currentStep = step;
        run.label = `Step ${step}/${STEPS.length}: ${STEPS[step - 1].name}`;
        log(`Starting step ${step}`);
        const result = await runStep(ctx, step);
        saveResult(resultsPath, result);
        log(
          `Step ${step} ${result.outcome}${result.asExpected ? " (as expected)" : " (UNEXPECTED)"}` +
            (result.error ? `: ${result.error}` : ""),
        );
        if (!result.asExpected) {
          run.lastError = `Step ${step} did not behave as expected; stopped.`;
          return;
        }
      }
      log("Run complete");
    } catch (err) {
      run.lastError = err instanceof Error ? err.message : String(err);
      log(`Error: ${run.lastError}`);
    } finally {
      run.busy = false;
      run.currentStep = null;
      run.label = null;
    }
  }

  return {
    name: "demo-api",
    configureServer(server) {
      server.middlewares.use("/api", async (req, res) => {
        const guard = checkApiRequest(req.method, req.headers);
        if (!guard.allowed) return json(res, guard.status, { error: guard.reason });
        try {
          const path = (req.url ?? "/").split("?")[0];
          if (req.method === "GET" && path === "/state") return json(res, 200, await buildState());

          if (req.method === "GET" && path === "/signers") {
            const ctx = currentContext();
            const [signers, ledger] = await Promise.all([listSigners(ctx), latestLedger(ctx)]);
            return json(res, 200, {
              smartAccount: ctx.smartAccountId,
              simulator: ctx.simId,
              nativeToken: ctx.nativeId,
              master: ctx.master.publicKey(),
              latestLedger: ledger,
              signers,
            });
          }

          if (req.method === "GET" && path === "/wallet-status") {
            const address = parseAddress(new URL(req.url ?? "", "http://localhost").searchParams.get("address"));
            const status = await accountStatus(currentContext().rpcUrl, address);
            return json(res, 200, status.exists ? { exists: true, stroops: status.stroops.toString() } : { exists: false });
          }

          if (req.method === "POST" && path === "/passkey") {
            if (run.busy) return json(res, 409, { error: "A run is in progress" });
            const body = (await readBody(req)) as Record<string, unknown>;
            const session = loadSession(sessionPath);
            if (body.action === "register") {
              const passkey = parsePasskey(body, req.headers.host ?? "");
              saveSession(sessionPath, { ...session, delegate: "passkey", passkey });
              return json(res, 200, { delegate: "passkey" });
            }
            if (body.action === "select") {
              if (body.delegate === "passkey" && !session.passkey) {
                return json(res, 409, { error: "Create a passkey first" });
              }
              if (body.delegate !== "key" && body.delegate !== "passkey") return json(res, 400, { error: 'delegate must be "key" or "passkey"' });
              saveSession(sessionPath, { ...session, delegate: body.delegate });
              return json(res, 200, { delegate: body.delegate });
            }
            return json(res, 400, { error: 'action must be "register" or "select"' });
          }

          if (req.method === "POST" && path === "/mode") {
            const mode = ((await readBody(req)) as { mode?: unknown }).mode;
            const session = loadSession(sessionPath);
            if (mode === "wallet" && !session.wallet) {
              return json(res, 409, { error: "No wallet smart account yet: connect a wallet and create one first" });
            }
            if (mode !== "wallet" && mode !== "demo") return json(res, 400, { error: 'mode must be "demo" or "wallet"' });
            if (run.busy) return json(res, 409, { error: "A run is in progress" });
            saveSession(sessionPath, { ...session, mode });
            return json(res, 200, { mode });
          }

          if (req.method === "GET" && path === "/contract-functions") {
            const id = new URL(req.url ?? "", "http://localhost").searchParams.get("id") ?? "";
            return json(res, 200, { contract: id, functions: await contractFunctions(currentContext(), id) });
          }

          if (req.method === "POST" && path === "/signature") {
            const answer = parseSignatureBody(await readBody(req));
            if ("cancel" in answer) {
              return broker.cancel(answer.id, answer.reason)
                ? json(res, 200, { cancelled: true })
                : json(res, 404, { error: "No such signing request" });
            }
            const result = broker.submit(answer.id, answer.response);
            if (result.ok) return json(res, 200, { accepted: true });
            return json(res, result.reason === "unknown" ? 404 : 422, { error: result.message });
          }

          if (req.method === "POST" && path === "/preview") {
            return json(res, 200, await previewCall(currentContext(), parseCallRequest(await readBody(req))));
          }

          if (req.method === "POST" && path === "/run") {
            if (run.busy) return json(res, 409, { error: "A run is already in progress" });
            const request = parseRunRequest(await readBody(req));
            run.busy = true;
            run.lastError = null;
            run.log = [];
            log(`Requested: ${request.action}`);
            // Runs continue server-side; the browser follows progress by polling /api/state.
            void execute(request);
            return json(res, 202, { started: true });
          }
          json(res, 404, { error: "Not found" });
        } catch (err) {
          json(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
      });
    },
  };
}

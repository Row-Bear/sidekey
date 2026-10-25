import "dotenv/config";
import { parse } from "dotenv";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { Plugin } from "vite";
import {
  clearResults,
  CORE_STEP_COUNT,
  createFreshDemoAccount,
  createScenarioContext,
  latestLedger,
  loadResults,
  readDelegatePolicy,
  runStep,
  saveResult,
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

function parseRunRequest(body: unknown): RunRequest {
  const b = body as Partial<RunRequest> & { from?: unknown; to?: unknown };
  if (b.action === "full" || b.action === "fresh") return { action: b.action };
  if (b.action === "steps") {
    const from = Number(b.from);
    const to = Number(b.to);
    const valid = (n: number) => Number.isInteger(n) && n >= 1 && n <= STEPS.length;
    if (valid(from) && valid(to) && from <= to) return { action: "steps", from, to };
  }
  throw new Error(`Invalid run request; expected action "full", "fresh" or "steps" with from/to in 1-${STEPS.length}`);
}

export function demoApi(repoRoot: string): Plugin {
  const resultsPath = join(repoRoot, "demo-run.json");
  const envPath = join(repoRoot, ".env");

  // `.env` is the source of truth: the CLI (`npm run poc -- --fresh`) can replace the master and
  // smart account while this server runs, so read it per request instead of trusting process.env.
  const currentContext = () => createScenarioContext({ ...process.env, ...parse(readFileSync(envPath)) });

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
        delegate: ctx.delegate.publicKey(),
        smartAccount: ctx.smartAccountId,
        simulator: ctx.simId,
      },
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
      if (request.action === "fresh" || request.action === "full") {
        run.label = "Creating a fresh master account and smart account";
        clearResults(resultsPath);
        await createFreshDemoAccount({ repoRoot, envPath, log });
      }
      if (request.action === "fresh") return;

      const from = request.action === "steps" ? request.from : 1;
      // "full" is the core demo (steps 1-7); the optional expiry steps run on request.
      const to = request.action === "steps" ? request.to : CORE_STEP_COUNT;
      const ctx = currentContext();
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

import "dotenv/config";
import { fileURLToPath } from "node:url";
import { clearResults, createFreshDemoAccount, createScenarioContext, runStep, saveResult, STEPS } from "@poc/core";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENV_PATH = fileURLToPath(new URL("../.env", import.meta.url));
const RESULTS_PATH = new URL("../demo-run.json", import.meta.url);

const xlm = (stroops: string) => (Number(BigInt(stroops)) / 1e7).toFixed(4);

function parseSteps(args: string[]): number[] {
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : Number(args[i + 1]);
  };
  const only = flag("--only");
  const from = flag("--from") ?? 1;
  const to = flag("--to") ?? STEPS.length;
  if (only !== undefined) return [only];
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

async function main(): Promise<void> {
  // --fresh: new master account and smart account first, so the full 7 steps can be repeated.
  if (process.argv.includes("--fresh")) {
    clearResults(RESULTS_PATH);
    const { master, smartAccountId } = await createFreshDemoAccount({
      repoRoot: ROOT,
      envPath: ENV_PATH,
      log: (message) => console.log(`   ${message}`),
    });
    console.log(`Fresh run: master ${master}, smart account ${smartAccountId}`);
  }

  const ctx = createScenarioContext();
  let allAsExpected = true;

  for (const step of parseSteps(process.argv.slice(2))) {
    console.log(`\n== Step ${step}/${STEPS.length}: ${STEPS[step - 1]?.name}`);
    const result = await runStep(ctx, step);
    saveResult(RESULTS_PATH, result);

    const verdict = result.asExpected ? "AS EXPECTED" : "UNEXPECTED";
    console.log(`   ${result.outcome.toUpperCase()} (${verdict}; expected ${result.expected}), signer: ${result.signer}`);
    if (result.note) console.log(`   ${result.note}`);
    if (result.explorerUrl) console.log(`   ${result.explorerUrl}`);
    if (result.error) console.log(`   rejected at ${result.failureStage}: ${result.error}`);
    console.log(
      `   smart account XLM ${xlm(result.before.accountXlm)} -> ${xlm(result.after.accountXlm)}, ` +
        `deposited ${xlm(result.before.deposited)} -> ${xlm(result.after.deposited)}, ` +
        `accrued yield ${xlm(result.before.accruedYield)} -> ${xlm(result.after.accruedYield)}`,
    );

    if (!result.asExpected) {
      allAsExpected = false;
      console.error(`\nStep ${step} did not behave as expected; stopping.`);
      break;
    }
  }
  process.exitCode = allAsExpected ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

# Development Plan: Sidekey, a Stellar smart account PoC (testnet)

Goal: a live testnet demo of a Soroban smart account whose default signer is a
Stellar `G...` key (master) and whose signing policy lets a second account
(delegate) call only specific functions on specific contracts.

Yield simulator (testnet): `CDGOE4WK2MAL2U2VFIFPVGIAWNZU5A2KJ5FJTJ7GMXVNS2GGWK4N33DL`
(stored in `.env` as `YIELD_SIM_CONTRACT_ID`).

## Decisions

- Deposit token is native XLM (native contract `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`).
- Delegate may only call `claim()` on the yield simulator.
- Only the master signer can change policy, via the account's own `require_auth`.
- Scripts and front end are TypeScript and share code in `packages/core`.
- Front end: Vite + React + TypeScript, a read-only dashboard plus a run-the-demo button.

## Yield simulator interface (read from testnet)

- `deposit(user: Address, amount: i128)`
- `claim(user: Address)`
- `withdraw(user: Address, amount: i128)`
- Views: `balance(user)`, `accrued_yield(user)`, `total_deposits()`,
  `payout_asset_balance()`, `deposit_asset_balance()`
- Errors: `InvalidAmount`=1, `InsufficientDeposit`=2, `NoClaimableYield`=3,
  `ArithmeticOverflow`=4, `InsufficientPayoutReserve`=5

## Auth model

The sponsor G account is the transaction source and pays fees. The smart account
appears only in Soroban auth entries, which its `__check_auth` verifies, so
policy applies to each simulator call rather than to the transaction envelope.

## Phase 0 – Scaffold (~20 min)

- [x] Monorepo layout: `contracts/smart-account/` (Rust), `packages/core/`
      (TypeScript), `scripts/`, `web/`.
- [x] `Cargo.toml` with `soroban-sdk` 29.0.1 (testnet is protocol 29);
      `package.json` with `@stellar/stellar-sdk` 17.4, `tsx`, `dotenv`.
- [x] Extend `.env.example`: `SPONSOR_PUBLIC/SECRET`, `MASTER_PUBLIC/SECRET`,
      `DELEGATE_PUBLIC/SECRET`, `SMART_ACCOUNT_ID`, `RPC_URL`.
- [x] Confirm the simulator's `deposit_token` is native XLM and read
      `payout_asset_balance()`. Verified 2026-10-25: the simulator's native XLM
      balance equals `deposit_asset_balance()` (75,972,978,745 stroops, about
      7,597 XLM), so the payout reserve is funded.

## Phase 1 – Testnet identities (~20 min, `scripts/01-setup-accounts.ts`)

- [x] Generate the sponsor keypair, fund via Friendbot, write keys to `.env`.
- [x] Generate the master G keypair, fund via Friendbot (10,000 XLM), write to `.env`.
- [x] Generate the delegate keypair. It only signs auth entries, so it needs no
      funding. Write to `.env`.
- [x] Keep sponsor and master separate: sponsor submits and pays fees, master authorizes.

Done via `npm run setup:accounts` (idempotent: reuses existing keys, only funds
missing accounts). Testnet addresses:

| Role | Address |
|------|---------|
| Sponsor | `GBCIX4QSYNOWSRIONC2P63WDRQBOF3HFULSDTMPFJRTEQNOGHV3G5XXN` |
| Master | `GDPF2WOK2HCGTGMZ4X7QSTTCHPHMLGIWSXG7U4W22EHHAU7IFSBHU5QF` |
| Delegate | `GDMDAHVCURPQB4OVUDZIR7EBAQFVLKUSKBN4N6JMLLKENUKGMIEMJHRE` |

## Phase 2 – Smart account contract (~2–3 h, critical path)

- [x] `__constructor(master: BytesN<32>)`: master is the default signer and can do anything.
- [x] Storage: instance storage, `Policy(signer) -> Vec<Rule>` with
      `Rule { contract: Address, function: Symbol, self_arg: bool }`.
- [x] Admin: `add_policy(signer, contract, function, self_arg)`,
      `remove_policy(signer, contract, function)`, `get_policy(signer)`, `master()`.
      Each admin call requires the account's own auth, so only the master can change policy.
- [x] `__check_auth(payload, signature, contexts)` with signature
      `{ signer: BytesN<32>, sig: BytesN<64> }`:
  - [x] Verify with `ed25519_verify` (traps on an invalid signature).
  - [x] Master: allow all contexts.
  - [x] Other signers: every context must be a `Context::Contract` matching one of
        their rules. Other context types, unlisted calls and extra sub-invocations
        fail closed with `NotAllowed`. A delegate can never authorize calls on the
        account itself, and the master cannot be given a delegate policy.
- [x] Demo policy: delegate -> `[(YIELD_SIM, "claim", self_arg = true)]` (set in Phase 3, step 1).
- [x] Decided: `claim` is locked to `args[0] == smart account` via `self_arg`.
      Confirmed that the simulator's `claim()` calls `require_auth()` on `user`.
- [x] Unit tests (soroban-sdk testutils), 16 passing (`npm run test:contract`):
  - [x] master allowed for any call
  - [x] delegate allowed for `claim` for itself, denied for another user
  - [x] delegate denied for `withdraw`, unknown contracts, smuggled sub-invocations,
        calls on the account itself and contract deployments
  - [x] bad signature rejected, including a master/delegate key mix-up
  - [x] unknown signer and emptied policy rejected
  - [x] policy changes require the account's auth; add is idempotent; master cannot get a policy
  - [x] mutation check: removing the `self_arg` check makes the lock test fail
- [x] Built (8.3 KB wasm) and deployed to testnet via `npm run deploy:account`
      (idempotent, `--force` redeploys). `SMART_ACCOUNT_ID` is recorded in `.env`.

Deployed smart account: `CAMKCCLKP5HVC4BECOV4JAGPHED4UABO2PPMR5DL5HQO2XNLK5NMV3MT`
(wasm hash `edbac156…13bbbf`; the master and an empty delegate policy were verified on-chain).

## Phase 3 – Scripted PoC flow (~2 h, `packages/core` and `scripts/`)

- [x] Helpers (`packages/core/src/chain.ts`): `invoke()` simulates to record auth, signs
      the smart account's auth entry (custom `AccSignature` struct via the SDK's
      `signatureScVal` callback, 60-ledger expiry), re-simulates in enforcing mode so
      policy violations fail before submission, then the sponsor signs and submits.
      `read()` does simulation-only views.
- [x] Scenario (`packages/core/src/scenario.ts`) and runner (`npm run poc`; flags
      `--only N`, `--from N`, `--to N`). Results are saved to `demo-run.json`.
- [x] Step 1: master signs `add_policy` for the delegate (verified on-chain:
      `claim` on the simulator, `self_arg = true`).
- [x] Step 2: master sends 9,500 XLM to the smart account via native `transfer`.
- [x] Step 3: `deposit` of the full 9,500 XLM signed by master; succeeds (nested token
      transfer authorized through `__check_auth`).
- [x] Step 4: `claim()` signed by master; succeeds. The script waits for
      `accrued_yield() > 0` first.
- [x] Step 5: `claim()` signed by delegate; succeeds.
- [x] Step 6: `withdraw()` signed by delegate is rejected at enforcing simulation. The host
      reports `Auth/InvalidAction`; the diagnostics show `__check_auth` returned
      `NotAllowed (#3)`, which the runner parses and displays.
- [x] Step 7: `withdraw()` signed by master; succeeds.
- [x] Each step logs its tx hash, Stellar Expert link and before/after balances.
- [x] Answered: yield accrues quickly. About 10,000 stroops (0.001 XLM) was available
      within seconds of the deposit, so no long wait is needed between steps 4 and 5.

First full run (testnet): step 1 `b377d566…`, step 2 `41b69c85…`, step 3 `2b3b8457…`,
step 4 `4f4a39ab…`, step 5 `1fcb0ccc…`, step 7 `ebc4b435…`. Step 6 was rejected by the
policy before submission, so it has no transaction hash.

Known limitation (handled in Phase 5): the runner is not yet re-runnable. The master has
about 500 XLM left, so step 2 cannot send another 9,500 XLM. A re-run needs a fresh master
and smart account. Steps 6 and 7 in `demo-run.json` come from a later re-check with a
100 XLM deposit; the original 9,500 XLM withdrawal is the `ebc4b435…` transaction above.

## Phase 4 – Front end (~2 h)

Start as soon as Phase 3 steps 1–4 work. It reads `demo-run.json` and on-chain
views, so it runs in parallel with contract edge cases and doubles as a demo
fallback if live testnet misbehaves.

- [x] Scaffold `web/` (Vite, React, TypeScript). Start with `npm run web`
      (http://localhost:5173). The browser only talks to `/api`; keys stay on the server.
- [x] Read-only dashboard:
  - [x] smart account balance, deposited amount, accrued yield (live via RPC, polled)
  - [x] signer policy table: master vs delegate permissions (read from the contract)
  - [x] timeline of the 7 steps with status and Stellar Expert links
- [x] "Run full demo" button: Vite dev middleware (`web/server/api.ts`) runs the scenario
      server-side. `GET /api/state`, `POST /api/run` (`full`, `fresh` or `steps`). One run at
      a time (409 otherwise); the browser follows progress by polling and a run log is shown.
- [x] The delegate's `withdraw` rejection is shown prominently, with the account's own
      `NotAllowed (#3)` error and a "Blocked before submission" label.
- [x] Verified live: "Run full demo" from the UI created a fresh account and passed all
      7 steps in about 64 seconds.

## Phase 5 – Hardening and demo prep (~1 h)

- [x] Scenario is re-runnable: "Run full demo" creates a fresh master and smart account
      first (`createFreshDemoAccount`), updating `.env` and clearing `demo-run.json`.
      Each fresh account replaces `MASTER_*` and `SMART_ACCOUNT_ID` in `.env`; the previous
      master secret is not kept, so funds left on an older smart account are unreachable.
- [x] Write a short demo script; update `.readme` with run instructions. The `.readme`
      now has the overview, command reference, a 3-minute demo script, layout and limitations.
- [x] Capture a recorded run (tx hashes) as a fallback: `docs/recorded-run.md`, exported
      with `npm run export:run` from a clean `npm run poc -- --fresh` run (all 7 steps
      as expected on one fresh account).
- [ ] Stretch: policy expiry, per-argument policy rules, wallet connection and a passkey
      delegate. See [STRETCH_PLAN.md](STRETCH_PLAN.md).

## Risks

- Auth entry signing is the fiddliest part (preimage construction,
  `signatureExpirationLedger`, custom signature encoding). Build and test the
  helper early against a simulation.
- `deposit` triggers a token `transfer` from the smart account as a
  sub-invocation. The master path must authorize that context; the delegate path must not.
- The simulator's payout reserve may be empty, which would break `claim()`.

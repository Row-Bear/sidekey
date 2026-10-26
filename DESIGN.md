# Sidekey: design notes and findings

A condensed record of how the project works, what was decided and why, what was found along the way, and what is
still unverified. The README covers usage; this file is for reviewers. The detailed work logs that this replaces
are in git history (`PLAN.md`, `STRETCH_PLAN.md`).

## What it is

A Soroban smart account on Stellar testnet. A **master** (a G address, usually a wallet) can authorize anything. A
**delegate** (a passkey, or another G key) is authorized only if every invocation in the call matches one of its
**rules**: contract, function, and a constraint per argument (any value, this account, an exact value, or an integer
below a limit), with an optional expiry ledger per signer.

## Pieces

| Piece | Where | Notes |
|---|---|---|
| Smart account contract | `contracts/smart-account` | `__check_auth` plus master-only admin functions. `version()` is 4. 68 tests. |
| Factory contract | `contracts/factory` | `create(master, index)` deploys an account for a G address (the master must authorize). Address = f(factory, master, index), so accounts are found from the wallet address alone. Admin can change the WASM for new accounts. 3 tests. |
| Core library | `packages/core` | Encoding, preview (mirrors the contract), signature broker, chain helpers, factory helpers. `browser.ts` is the browser-safe subset; `*-file.ts`, `deploy`, `envfile`, `fresh`, `results` are Node-only. |
| Dev server | `web/server` | Vite plugin serving `/api/*`; holds the fee sponsor key; runs the guided demo (`/demo`) and the CLI-based flows. Localhost only. |
| Web app | `web/src` | `/` is the plain policy and call tester; `/demo` the guided demo. One `App` with a `variant`. |
| Static build | `web/src/local` | `npm run web:build:static`: the page answers its own `/api/*` in the browser (localStorage, RPC, relayer). No server. Published by `.github/workflows/pages.yml`. |
| Scripts, spikes | `scripts/`, `spikes/` | CLI demo runner and testnet end-to-end checks (`npm run e2e:*`). |

## How signing and fees work

- The smart account appears only in auth entries; its `__check_auth` verifies them. Policy is applied per invocation
  in the authorization tree, not to the transaction envelope.
- **Signatures**: `Ed25519` (raw payload), `Message` (a SEP-53 text `Authorize <account> payload <hex>`, for wallets
  without `signAuthEntry`) and `Passkey` (WebAuthn: relying-party hash from the stored policy, user presence and
  verification, challenge in a fixed position, `secp256r1_verify`, low-S).
- **Signature broker**: jobs pause until the browser answers; every answer is verified against the one key the
  request is for, a wrong answer leaves the request pending, a good one resolves it once.
- **Dev server**: the sponsor pays fees. **Static build**: OpenZeppelin Channels pays. Policy edits and delegate
  calls go as function plus signed auth entries (`ChainContext.relay`). Account creation goes as a wallet-signed
  transaction the wallet is the source of, wrapped in a fee bump (`relayTransaction`). The master is the simulation
  source, which makes the simulator record its auth as source-account credentials; core converts those to address
  credentials before signing (`detachSourceCredentials`).

## Decisions and findings

**Wallets**
- xBull cannot `signAuthEntry` and Freighter refuses it for a contract address, so both sign the SEP-53 `Message`
  form. The text has spaces because xBull decodes message text that looks like base64.
- A wallet signs a whole transaction only for calls the G account authorizes itself, so account creation and the
  master's own transfers use `signTransaction`.
- Both xBull and Freighter were verified by hand on the dev server. The static path was only tested with the dev
  test wallet.

**Passkeys**
- Half of real WebAuthn signatures are high-S and the host rejects them, so signatures are normalized to low-S
  before sending (done in `packages/core/src/passkey.ts`, one tested implementation).
- The check costs about 3.4M CPU instructions (under 1% of the testnet limit).
- The passkey is a delegate only. The relying-party hash is stored with the signer, so a passkey is tied to a
  domain: a hosted page needs a new passkey.
- Verified with Chrome's virtual authenticator, a software authenticator and a password-manager passkey. Not
  verified with hardware keys, Touch ID or Windows Hello.

**Policy semantics**
- Rules are alternatives: a call is allowed if any rule of the signer matches. To tighten, remove the old rule first.
- A rule has a constraint for every argument position; a different argument count is refused.
- `Exact` compares XDR bytes, so inputs are encoded from the contract spec.
- `LessThan` (added in version 3) applies per call; it is not a cumulative limit. An older account accepts such a
  rule at registration and only fails when a matching call is evaluated, hence the `version()` probe in the editor.
- Rules naming the account itself are rejected when stored and again when evaluated, so a delegate can never grant
  itself more.

**Fees and relayer (static build)**
- The master must already exist on chain (an unfunded key fails `require_auth`).
- Channels requires the wallet-signed transaction to carry only the resource fee and to expire within 60 seconds,
  so the wallet has 55 seconds to sign `create`.
- Each browser fetches its own Channels API key from the public key endpoint; the only protection is the per-key
  fair-use fee limit.

**Storage lifetime**
- Version 4 extends the account's lifetime on every authorized call. Earlier versions only did so on policy
  changes (about 30 days). An account idle for more than about 30 days is archived and needs a restore.

**Other**
- Deploying with the CLI blocked the dev server for 5 seconds, so it runs asynchronously.
- The Buffer shim used in browsers lacks the `base64url` encoding, so core encodes it by hand.
- Blind signing: a wallet shows `Authorize <account> payload <hash>`; the dashboard's call summary is the only
  readable description of what is approved.

## Security review

A review of the contract and factory (read-only, 2026-10-26) found no exploitable vulnerabilities: admin functions
need the account's own auth, non-contract contexts and self-targeting rules fail closed, signatures bind to the
host payload, `LessThan` fails closed on odd types, and the factory cannot be front-run. It was a code read, not
an audit. Compared with OpenZeppelin's `stellar-accounts` (0.8.0): this contract restricts functions and arguments
natively (OpenZeppelin needs a custom policy), checks the passkey's relying party in the account (OpenZeppelin's
verifier omits it) and cannot lock out its master; OpenZeppelin has pluggable verifiers, spending-limit and
threshold policies, rule-level expiry, an opt-in upgrade path, size caps and audit reports.

**Known gaps**: no master rotation or recovery; no cumulative spend or rate limits; no upgrade path (a fix means a
new account); the factory admin controls the WASM hash for new accounts and `create` does not pin it; passkey
verification is custom code; not audited. Do not use with real funds.

## Verification status

Automated: 68 contract tests, 3 factory tests, 96 core tests, 67 web tests, typecheck; testnet end-to-end scripts
(`e2e:wallet`, `e2e:passkey`, `e2e:broker`, `e2e:lessthan`, `e2e:factory`).

Checked by hand: the full demo with xBull and Freighter; save and load of accounts with xBull; the static page with
a test wallet and a virtual authenticator (create through the factory, policy edit, passkey call, all relayer-paid);
a production build under a sub-path with the service worker.

Not checked: the GitHub Pages workflow itself; real wallets on the static path; hardware passkeys; a phone; PWA
install.

## History

The project started as a PoC plan (accounts, contract, scripted flow, dashboard, hardening), then added: per-signer
expiry and per-argument rules, a policy editor and call builder, the signature broker, wallet connection, a passkey
delegate, reusing wallet accounts (recorded as `manage_data` entries, later found from the factory instead), a
contract address book, `LessThan`, hours and days expiry, a UI review of the plain page, a searchable function
picker, Run buttons on policy rules, the PWA and static build, the factory and relayer, and storage lifetime
extension on use.

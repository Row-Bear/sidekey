# Stretch Goals Plan

Builds on the working PoC (see [PLAN.md](PLAN.md)). Everything here is optional
for the hackathon submission; the core demo already works.

## Goals and decisions

| # | Goal | Decision |
|---|------|----------|
| 1 | Expiry ledger for the delegate signer | Absolute ledger stored per signer; UI also offers "expires in N minutes" |
| 2 | UI to define contract id, function and arguments for the delegate | Policy editor **and** call builder; rules constrain **each argument** (any / this account / exact value) |
| 3 | Pick which policy signer invokes a call | Dropdown of the signers registered on the account; the choice decides how the call is signed |
| 4 | Wallet connection (Stellar Wallets Kit) | **xBull**. The connected G address becomes the master of a new smart account. The server-held master stays as a "demo mode" fallback |
| 5 | Delegate as a passkey signer | **Both signer types supported.** Passkey is the UI default; ed25519 stays for the CLI runner and the recorded run |

## Design overview

### Contract v2 (breaking change; every run already deploys a fresh account)

- **Signer id**: `Ed25519(BytesN<32>)` or `Passkey(BytesN<65>)` (uncompressed secp256r1 key).
- **Per-signer policy**:
  `{ valid_until_ledger: Option<u32>, rp_id_hash: Option<BytesN<32>>, rules: Vec<Rule> }`.
  The master never expires and has no rules.
- **Rule**: `{ contract, function, args: Vec<ArgConstraint> }`, where
  `ArgConstraint = Any | SelfAddress | Exact(Bytes)` and `Exact` holds the XDR of the
  allowed value. A rule lists a constraint for **every** argument position, and a call
  with a different argument count is refused (fail closed). This replaces `self_arg`.
- **Admin (master-only, via the account's own auth)**: `set_signer`, `add_rule`,
  `remove_rule`, `revoke_signer`, `set_expiry`; views `get_signer`, `list_signers`.
- **Signature**: `Ed25519 { signer, sig }` or
  `Passkey { public_key, authenticator_data, client_data_json, sig }`.
- **`__check_auth`** for a non-master signer: signer registered, then not expired
  (`env.ledger().sequence() <= valid_until_ledger`, new error `SignerExpired`), then every
  invocation in the tree matches a rule, as today.
- **Passkey verification** (WebAuthn assertion):
  1. `client_data_json` has `"type":"webauthn.get"` and `"challenge"` equal to
     base64url of the 32-byte `signature_payload`.
  2. `authenticator_data[0..32]` equals the stored `rp_id_hash`; the user-present flag
     (and user-verified flag) is set.
  3. `secp256r1_verify(public_key, sha256(authenticator_data || sha256(client_data_json)), sig)`.
  4. The signature must be **low-S**: Soroban rejects high-S, and WebAuthn authenticators
     often return high-S, so the browser normalizes before sending.
- Not to be confused with the **auth-entry** `signatureExpirationLedger` the host already
  enforces (replay window of one signature). Signer expiry is a policy of the account.

### Signature broker (lets the browser sign without moving orchestration)

The server keeps running scenarios and ad-hoc calls (it holds the sponsor key, simulates,
submits and saves results). When a step needs a signature the server cannot produce, it
pauses and asks the browser:

1. The signing callback in `invoke()` awaits a **remote signer**. The server publishes
   `pendingSignature { id, signerKind, address, callSummary, preimageXdr, payloadHex }`
   in `GET /api/state`.
2. The UI (already polling) shows a prompt, then signs:
   - master (wallet): `StellarWalletsKit.signAuthEntry(preimageXdr)`
   - passkey delegate: `navigator.credentials.get({ challenge: payload })`, then DER to
     compact low-S
3. The UI posts `POST /api/signature { id, signature }`. The server builds the signature
   `ScVal`, runs the enforcing simulation, assembles, sponsor-signs and submits as today.

Only the signing source differs, so scenario steps and the CLI runner are unchanged.
Fallback if a wallet lacks `signAuthEntry`: a `signTransaction` request for flows where the
G account is the transaction source (for example step 2).

## Work packages

Suggested order is by value per hour. Each package is shippable on its own.

### WP0: Spikes (about 1 h)

- [ ] xBull on testnet: does the kit's `signAuthEntry` return a signature over
      `sha256(preimage)` that the contract's `ed25519_verify` accepts? (SEP-43 says so;
      confirm with xBull.)
- [ ] `secp256r1_verify` in `soroban-sdk` 29: signature format, low-S rule, and the CPU cost
      of the full passkey check in a simulation.
- [ ] Does a WebAuthn authenticator exist in the dev setup? If not, plan on a Playwright
      virtual authenticator for tests and a hardware key or phone for the demo.
- [ ] `contract.Spec` from `@stellar/stellar-sdk` can read a contract's function names and
      argument types, and encode typed inputs to `ScVal`, for the form builder.

### WP1: Contract v2 with expiry (goal 1; about 3 h) — done

- [x] Signer model, per-signer policy, `ArgConstraint` rules, `list_signers`, new error
      `SignerExpired`, and `InvalidPolicy` for an expiry in the past, a rule on the account
      itself, or more than 32 rules or 16 arguments.
- [x] `set_signer(signer, valid_until_ledger, rules)` replaces a signer's whole policy in one
      call (so demo step 1 stays one transaction); `add_rule`, `remove_rule`, `set_expiry`
      and `revoke_signer` edit it. `get_policy` was replaced by `get_signer`.
- [x] Scope decision: the **passkey** signer and signature variants, and the `rp_id_hash`
      field, are left to WP5 so no dead code ships now. `SignerId` and `AccSignature` are
      enums, so adding a `Passkey` variant later does not change how ed25519 is encoded.
- [x] Unit tests: 34 pass (`npm run test:contract`). They cover the v1 behaviours, plus
      expiry (last valid ledger, expired, master unaffected, `set_expiry` extends, shortens
      or removes, invalid past expiry), each constraint kind, wrong argument count, value
      type confusion (u32 vs i128), revoked signer and listing signers. Mutation checks
      (expiry disabled, expiry off-by-one, arity removed, `Exact` and `SelfAddress` always
      true, past expiry accepted, rule on the account itself allowed) each fail the
      intended test.
- [x] TS encoders and decoders in `packages/core/src/policy.ts`; scenario updated. Step 1
      sets `claim` on the simulator with `[SelfAddress]` and an expiry of about 30 minutes.
      A step that expects a failure now also checks the failure's cause
      (`NotAllowed` for step 6, `SignerExpired` for step 9).
- [x] Optional steps 8 and 9: shorten the expiry to about 1 minute, then a delegate `claim`
      after it passes is rejected with `SignerExpired`. `npm run poc -- --extended` and the
      dashboard's **Run expiry demo** run them; **Run full demo** stays at steps 1-7.
- [x] Dashboard shows the delegate's expiry (ledger and approximate time left, or an
      "expired" tag) and each rule's argument constraints.
- [x] Redeployed on testnet (wasm 12.7 KB, 10 exports); `npm run poc -- --fresh --extended`
      and the UI's full demo plus expiry demo passed; `docs/recorded-run.md` refreshed.
- Done when: the full demo passes on contract v2 and an expired delegate is refused. Met.

### WP2: Policy editor and call builder (goals 2 and 3; about 3 h)

- [ ] Server: `GET /api/signers` (registered signers with expiry and rules), `GET
      /api/contract-spec?id=C…` (function names, argument names and types).
- [ ] **Policy editor** (master action): pick a contract id, choose a function from its
      spec, set a constraint per argument (any / this account / exact value), set the
      signer and expiry (ledger number or "in N minutes", converted with the current
      ledger), submit `set_signer` and `add_rule`. Show existing rules with remove buttons.
- [ ] **Call builder**: pick contract, function and typed argument inputs (generated from
      the spec), then a **signer dropdown** listing the master and every registered signer
      with its expiry.
- [ ] **Policy preview** before sending: evaluate the call against the selected signer's
      rules client-side and say "allowed" or "would be rejected: <reason>". A "send anyway"
      action sends it so the on-chain rejection can be shown.
- [ ] Results appear in the timeline with transaction links or the account's own error.
- [ ] In this package, signing uses the server-held keys (demo mode), so it works before
      WP3 and WP4.
- Done when: a user can allow `claim` for the delegate, call it as the delegate, and see
  `withdraw` rejected, all from the form.

### WP3: Signature broker (foundation for goals 4 and 5; about 2 h)

- [x] **Hardening first** (done): every `/api` request now goes through `web/server/guard.ts`.
      It requires a localhost `Host` header (also blocks DNS rebinding), refuses a cross-origin
      `Origin` or cross-site `Sec-Fetch-Site`, and requires `application/json` on POST. Scripts
      that send no `Origin` still work. Covered by `npm run test:web` and checked live against
      the real attack (cross-origin `text/plain` POST asking for a `fresh` run).
- [x] The dev server binds to `localhost` explicitly, and re-reads `.env` on every request, so
      a CLI `--fresh` run can no longer leave the dashboard acting on a different account.
- [ ] Remote signer in `packages/core` (returns a promise that the server resolves when the
      browser posts), with a timeout (about 3 min) and cancellation.
- [ ] `pendingSignature` in the state; `POST /api/signature`; reject a stale or unknown id,
      allow each id once.
- [ ] A signing modal in the UI showing what is being signed (contract, function,
      arguments, signer) before the wallet or passkey prompt opens.
- Done when: a scenario step can pause for a browser signature and continue, using a mock
  signer in a test.

### WP4: Wallet connection, xBull (goal 4; about 2.5 h)

- [ ] Add `@creit.tech/stellar-wallets-kit` (npm 2.7.1; also on JSR). Initialize with the xBull
      module on testnet; use the kit's connect button or a custom one.
- [ ] Show the connected G address and network; block if the wallet is not on testnet.
- [ ] If the connected account does not exist on testnet, a "Fund with Friendbot" button.
- [ ] **Wallet mode**: "Create smart account for my wallet" deploys a smart account whose
      master is the connected address. No master secret is stored; the master authorizer is
      the remote signer from WP3. The session state records `masterMode: wallet`.
- [ ] Master steps (1, 2, 3, 4, 7 and policy edits) prompt the wallet via `signAuthEntry`.
      Step 2 uses the wallet's classic auth entry; if `signAuthEntry` is unavailable, send
      the transaction to the wallet with `signTransaction` (wallet as source).
- [ ] Keep **demo mode** (server-held master) as a toggle for headless and fallback runs.
- Done when: with xBull connected, the master steps are signed in the wallet and the demo
  completes on a new smart account owned by the wallet's G address.

### WP5: Passkey delegate (goal 5; about 3 h)

- [ ] Contract: passkey verification from the design above, with unit tests using a P-256
      key and a synthetic WebAuthn assertion (valid, wrong challenge, wrong rp id hash,
      user-present flag missing, high-S signature, wrong key, expired signer).
- [ ] Registration: "Add passkey delegate" calls `navigator.credentials.create` (ES256,
      user verification required, rp id from the page host), extracts the 65-byte public key,
      stores the credential id (local storage, keyed by smart account), then the master
      registers it with `set_signer(Passkey(pk), expiry, sha256(rp id))` and its rules.
- [ ] Signing: `navigator.credentials.get` with the signature payload as the challenge, DER
      to compact, normalize to low-S, post through the broker.
- [ ] Signer dropdown shows the passkey signer; steps 5 and 6 can run with it (each needs a
      user touch). The default demo uses the passkey; the CLI runner and the recorded run
      keep the ed25519 delegate.
- [ ] Origin binding: the rp id hash is stored on-chain. Localhost works for dev; a hosted
      demo needs HTTPS and its own registration.
- Done when: a passkey-signed `claim` succeeds, a passkey-signed `withdraw` is rejected by
  the policy, and the same passkey is refused after its expiry.

### WP6: Integration, docs and recorded run (about 1.5 h)

- [ ] Playwright test with a **virtual authenticator** for the passkey flow; a mock wallet
      module for the wallet flow (xBull itself is a manual check).
- [ ] Manual checklist: xBull connect, fund, create account, sign each master step, passkey
      registration and signing.
- [ ] Update `.readme` (command reference, demo script variants), `docs/recorded-run.md`
      (include the passkey and expiry steps) and the limitations section.
- [ ] Typecheck and all contract tests green; a clean `npm run poc -- --fresh` still passes.

## Suggested cut line

About 12 hours in total. If time is short, the value order is:
**WP1 (expiry) → WP2 (policy editor and call builder) → WP3 and WP4 (wallet) → WP5 (passkey)**.
WP3 is cheap and unlocks both wallet and passkey, so do it right after WP2.

## Risks and open items

- **xBull and `signAuthEntry`**: support is wallet-specific. The spike confirms it; the
  fallback is `signTransaction` with the wallet as source, or another wallet through the
  same kit (Freighter, Albedo).
- **Passkey signature format**: DER to compact conversion and low-S normalization are the
  usual failure points. Test against real authenticator output early.
- **Passkey cost**: `secp256r1_verify` plus JSON checking may use a large share of the CPU
  budget. Measure in a simulation before building UI on it.
- **Secure context**: WebAuthn needs HTTPS or localhost, and the rp id is baked into the
  signer. A hosted demo means registering a new passkey on that domain.
- **Argument-level policy semantics**: requiring a constraint for every position is strict
  but safe. `Exact` compares XDR bytes, so inputs must be encoded canonically from the
  contract spec (the form builder does this).
- **Interactive demo length**: wallet mode adds a prompt to each master step, and the
  passkey adds two more. Keep demo mode for rehearsals and as the fallback.
- **Not audited**: the contract still has no key rotation or recovery. Passkey verification
  is security-sensitive; keep the tests adversarial and say so in the docs.

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
   - master (wallet): `StellarWalletsKit.signMessage(walletMessage(account, payload))` (xBull,
     Freighter); `signAuthEntry(preimageXdr)` is kept for other wallets that accept it, but Freighter
     blocks it for a contract address (found by hand); both are implemented by the contract
   - passkey delegate: `navigator.credentials.get({ challenge: payload })`, then DER to
     compact low-S
3. The UI posts `POST /api/signature { id, signature }`. The server builds the signature
   `ScVal`, runs the enforcing simulation, assembles, sponsor-signs and submits as today.

Only the signing source differs, so scenario steps and the CLI runner are unchanged.
`signTransaction` is **not** a fallback for calls the smart account authorizes: a wallet signs the
transaction-envelope hash, while `__check_auth` verifies the auth-entry payload. It only works where
the G account itself is the authorizer, such as the master's XLM transfer (step 2).

## Work packages

Suggested order is by value per hour. Each package is shippable on its own.

### WP0: Spikes (about 1 h) — done

- [x] **Wallet signing of auth entries.** `signAuthEntry` signs sha256 of the preimage, which
      equals the payload the contract verifies; a master signature produced that way through a
      SEP-43 interface is accepted on testnet (`spikes/wallet-sep43/run.ts`). But the Wallets Kit
      modules for **xBull, Albedo, LOBSTR, Hana, Ledger and Trezor reject `signAuthEntry`**
      (read from the kit source); Freighter, Hot Wallet, Klever, D'Cent and others implement it.
- [x] **`signMessage` for wallets without `signAuthEntry`** (decided: implemented, see below).
- [x] **`secp256r1_verify` in `soroban-sdk` 29** (`spikes/passkey-verify`, 4 tests on 32 real
      browser assertions from a Chrome virtual authenticator, ES256):
      - **Low-S is mandatory.** Exactly half of the real signatures (16 of 32) were rejected by
        the host as high-S; after normalizing to low-S all 32 verify, and the mirrored high-S form
        of every signature is rejected. The browser must normalize before sending (DER to
        compact `r||s`, then `s = n - s` when `s > n/2`).
      - **Cost is small.** The full check (assertion checks, two sha256, `secp256r1_verify`) uses
        about 3.4 M CPU instructions and 1.2 MB of memory, 0.8% of the testnet per-transaction
        limit (400 M instructions, 40 MB). The ed25519 check used today costs about 0.7 M.
      - **Format.** The 65-byte key is the last 65 bytes of the 91-byte SPKI from
        `getPublicKey()`; `authenticatorData` is 37 bytes with flags `0x05` (present and
        verified); `clientDataJSON` is about 120 bytes with `"type":"webauthn.get"` and the
        base64url challenge.
      - **Rejected as intended**: wrong challenge, wrong rp id hash, missing present or verified
        flag, truncated or empty or oversized data, a `webauthn.create` ceremony, tampered
        client data (signature trap) and another key.
      - **For WP5:** the spike finds `"challenge":"<payload>"` anywhere in `clientDataJSON`.
        Tighten that to the canonical position (right after `"type":"webauthn.get",`) and cap
        the size, so no other field can carry a look-alike challenge.
- [x] A WebAuthn authenticator is available in the dev browser: the embedded Chrome exposes a
      CDP virtual authenticator (ES256, user verification), and 32 real assertions are saved in
      `spikes/passkey-verify/assertions.json`. A real device is still needed for the demo.
- [x] `contract.Spec` reads a contract's functions and encodes typed inputs; used by WP2.

**`signMessage` findings.** xBull signs `sha256("Stellar Signed Message:\n" + message)` (SEP-53) and
returns the signature plus the full text it signed. It reads the message as **base64 when it looks
like base64, otherwise UTF-8**, so a bare 64-character hex payload would be silently decoded into
different bytes. The contract therefore verifies the text
`Authorize <account> payload <hex>` (spaces keep it plain text in every wallet), via a new
`AccSignature::Message` variant. Implemented with 7 contract tests (mutation-checked: wrong
payload, wrong account, exact text, kinds not interchangeable, delegates still under policy and
expiry), `packages/core/src/wallet.ts` with mock xBull-style and strict-SEP-53 wallets, and a
testnet run where set_expiry, deposit (nested transfer), claim and withdraw were all authorized
by message signatures (`spikes/wallet-sep43/message.ts`). The client checks the wallet's signature
locally before sending, accepts base64 or hex, and catches the base64 trap with a clear error.
**Verified by hand against the real xBull extension in WP4/WP6** (full demo, all steps as expected).

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

### WP3: Signature broker (foundation for goals 4 and 5; about 2 h) — done

- [x] **Hardening first** (done): every `/api` request now goes through `web/server/guard.ts`.
      It requires a localhost `Host` header (also blocks DNS rebinding), refuses a cross-origin
      `Origin` or cross-site `Sec-Fetch-Site`, and requires `application/json` on POST. Scripts
      that send no `Origin` still work. Covered by `npm run test:web` and checked live against
      the real attack (cross-origin `text/plain` POST asking for a `fresh` run).
- [x] The dev server binds to `localhost` explicitly, and re-reads `.env` on every request, so
      a CLI `--fresh` run can no longer leave the dashboard acting on a different account.
- [x] **Broker** (`packages/core/src/broker.ts`): a job awaits a promise; the browser sees a
      pending item and answers it. The server verifies every answer against the one key the
      request is for (the browser cannot choose the signer): a `payload` signature (what
      `signAuthEntry` returns) or a SEP-53 `message` signature (what `signMessage` returns). A wrong
      or malformed answer is refused and the request **stays pending** so the person can retry; a
      good one resolves the job exactly once. Cancel rejects the job with `SigningCancelled`; a
      request times out after 3 minutes. 14 tests with a mock signer, mutation-checked (verification
      removed, request not consumed, a bad answer consuming the request).
- [x] **Jobs can sign in the browser**: `via: "browser"` on call, policy and step jobs; scenario
      steps take `ctx.remoteSigners`, calls and policy edits take a `SigningSource`. A scenario
      step pauses for the browser and then continues (tested on testnet with step 1).
- [x] **State and endpoint**: `pendingSignatures` in `GET /api/state`; `POST /api/signature`
      with `{id, response}` or `{id, cancel: true}` (200 accepted, 404 unknown or already used,
      422 invalid signature, 400 malformed).
- [x] **Signing modal** (`web/src/SigningModal.tsx`): shows who signs, what is being authorized
      (every invocation), a countdown, and a manual path (copy the payload or the SEP-53 message,
      paste a signature in base64 or hex). The policy editor and call builder have a "Sign with"
      choice (demo keys or my signature). `web/src/signing.ts` is the registry where WP4 (wallet)
      and WP5 (passkey) add one-click signers; it is empty for now.
- [x] Verified end to end on testnet over HTTP (`npm run e2e:broker`, spikes/broker/run.ts):
      pause, wrong signer refused and still pending, right signer accepted, replay refused,
      message-kind answer, cancel, scenario step 1 via the browser, malformed answers. Also
      verified in the dashboard: wrong signature shows the server's refusal and the modal stays
      open; the right one closes it and the transaction completes.
- Done when: a scenario step can pause for a browser signature and continue, using a mock
  signer in a test. Met.
- Limits: only the smart account's own signature can come from the browser. Calls the G account
  itself must authorize (step 2's transfer) still need the demo key, so step 2 is not offered
  with browser signing. Pending requests live in the server's memory and are lost on a restart.
  The modal prints call arguments as plain values, so a signer enum shows as
  `["Ed25519","0x…"]`.

### WP4: Wallet connection, xBull (goal 4; about 2.5 h) — done, real xBull verified by hand

- [x] **Wallets Kit** (`@creit.tech/stellar-wallets-kit` 2.7.1) in `web/`, with only the xBull and
      Freighter modules bundled (plus dev test wallets). The kit's own connect modal is used.
      Production build: 435 KB (137 KB gzipped); the test wallet is excluded from it.
- [x] **Wallet panel**: connect and disconnect, address, network chip (testnet / not testnet /
      unknown, since xBull cannot report its network), XLM balance, "Fund with Friendbot" for an
      account not on testnet yet, "Use this wallet as master", and a Demo keys / My wallet switch.
- [x] **Wallet mode** (`wallet-session.json`, gitignored; `.env` untouched): the smart account's
      master is the wallet's G address; no secret is stored anywhere. "Run full demo" in wallet mode
      deploys a fresh smart account for the same wallet (sponsor pays, no prompt), then runs the steps.
      Demo mode is unchanged and is one click away.
- [x] **Signing**: the master's auth entries use `signMessage` for xBull and Freighter (`MESSAGE_ONLY`);
      other wallets try `signAuthEntry` first and fall back to `signMessage` if it is unsupported.
      **Freighter finding (by hand):** its `signAuthEntry` only signs entries for the connected G
      account and shows "Freighter is set to a different account" for the smart account's C address, so
      it is not "unsupported" and never falls back; Freighter was added to `MESSAGE_ONLY`. Step 2 is
      the master's own transfer: the **wallet signs the whole transaction** (`signTransaction`), is the
      transaction source and pays its fee (`invokeAsSource`). The broker has a new `transaction`
      kind: the server accepts the answer only if it is the same transaction (same hash) with a valid
      signature by the master key, and rebuilds it with only that signature.
- [x] Funds can be moved back to the wallet with the call builder's "send 1 XLM to the master"
      example, so the same wallet can run the demo again. A balance check before step 2 gives a
      clear message instead of asking the wallet to sign something that cannot succeed.
- [x] **Dev test wallets** (`web/src/testWallet.ts`, dev server only): "like xBull" (messages only,
      with xBull's base64 reading of messages) and "like Freighter" (auth entries). They go through
      the same kit code path and ask `confirm()` showing what a real wallet would show.
- [x] Tests: broker transaction kind (7 tests, mutation-checked, including a forged signature that
      copies the master's 4-byte hint), plus end to end on testnet:
      `npm run e2e:wallet` (HTTP, plays a wallet: 5 prompts, all 7 steps, funds returned, a second
      full run with the same wallet) and `spikes/broker/transaction.ts`. In the dashboard with the
      test wallet: connect through the kit, fund, create the account, full demo (4 message prompts
      and 1 transaction prompt, all steps as expected), and the Freighter-like path for a policy edit.
- [x] **Manual check with the real xBull extension** (done by hand: full demo on a wallet-owned smart account, 5 prompts, every step as expected): connect; make sure
      the message shown is `Authorize C… payload <hash>`; confirm it signs, and that the dashboard
      accepts the signature (the server accepts base64 or hex); confirm step 2's transaction prompt.
      Freighter was checked too (it signs the same message; see the finding above).
- Done when: with a wallet connected, the master steps are signed in the wallet and the demo
  completes on a new smart account owned by the wallet's G address. Met with the test wallets.
- Limits: the delegate's key is held by the demo unless a passkey is used (WP5). The wallet's own steps
  show as `Authorize <account> payload <hash>`, so the dashboard's summary is the readable
  description. `npm audit` reports advisories from wallet integrations the kit depends on
  (WalletConnect, Ledger, Trezor) that are not bundled here.

### WP5: Passkey delegate (goal 5) - done

- [x] Contract: `SignerId::Passkey(BytesN<65>)`, `set_passkey(public_key, rp_id_hash, valid_until,
      rules)`, `AccSignature::Passkey` and strict WebAuthn checks (authenticator data length, rp id
      hash from the stored policy, user-present and user-verified flags, `clientDataJSON` starting
      exactly with `{"type":"webauthn.get","challenge":"<payload>"`, then `secp256r1_verify`).
      54 contract tests, including 32 real browser assertions (`test-fixtures/webauthn-assertions.json`)
      and synthetic negatives; 8 deliberate breaks of the checks were all caught.
- [x] Registration: **Create passkey** in the dashboard (`navigator.credentials.create`, ES256, user
      verification required, rp id = page host). The server keeps the credential id and public key in
      `wallet-session.json`; the first step of the demo registers it with `set_passkey`.
- [x] Signing: `navigator.credentials.get` with the signature payload as the challenge. The browser
      sends the raw authenticator data, `clientDataJSON` and DER signature; the **server** converts
      to compact low-S and checks the assertion (as the contract would) before accepting, so a bad
      answer is refused early and can be retried. (The plan said the browser would normalize; moving
      it server-side keeps one tested implementation in `packages/core/src/passkey.ts`.)
- [x] Delegate selector (demo key or passkey) in the dashboard; the signer dropdown, policy editor
      and call builder show the passkey. A passkey always signs in the browser. The CLI runner and the
      recorded run keep the ed25519 delegate.
- [x] Origin binding: the rp id hash is stored on-chain with the signer. `localhost` works for dev; a
      hosted demo needs HTTPS and a new passkey on that domain.
- Verified in the dashboard with a Chrome **virtual authenticator** on a fresh account: passkey-signed
  `claim` succeeded, passkey-signed `withdraw` was refused (`NotAllowed #3`), the master withdrew, and
  after the expiry demo the passkey `claim` was refused (`SignerExpired #5`).
- Cost: the passkey check uses about 3.4M CPU instructions (0.8% of the 400M limit).
- Limits: only a virtual authenticator has been tried here; a real device (Touch ID, Windows Hello or a
  security key) is still a manual check. The passkey is a delegate only; the master stays ed25519. Half of
  real signatures are high-S; the server normalizes them before submission, and the contract refuses
  any that are not.

### WP6: Integration, docs and recorded run - done, except the manual checks

- [x] End-to-end checks over HTTP on testnet: `npm run e2e:wallet` (a software wallet plays xBull) and
      the new `npm run e2e:passkey` (a software P-256 authenticator, random high/low-S DER signatures).
      The passkey one also checks that a wrong challenge, a wrong relying party, a missing
      user-verification flag and a payload answer are refused and the request stays pending, that a
      passkey for another site is refused at registration, then runs the full demo and the expiry demo
      (claim succeeds, withdraw is refused with `NotAllowed`, the expired passkey with `SignerExpired`).
      The passkey flow was also driven by hand in the dashboard with a Chrome virtual authenticator (WP5).
- [x] `.readme` updated (command reference, passkey section, limitations); `docs/recorded-run.md`
      re-recorded on the current contract with all 9 steps (`npm run poc -- --fresh --extended`).
- [x] Typecheck, 54 contract tests, 70 core tests and 10 web tests green; the CLI run still passes with
      the ed25519 delegate.
- [ ] **Manual checklist (needs a real wallet or device; cannot be automated here):**
  - [x] xBull (done by hand, all as expected): connect; **Use this wallet as master** (fund first if needed); run the full demo. Check the
    message shown is `Authorize C… payload <hash>`, that each master step is accepted, and that step 2
    shows a transaction prompt. Switch the wallet to mainnet once and check the dashboard refuses.
  - [x] Freighter (done by hand, all as expected): the same, but through `signMessage`; its prompt shows
    `Stellar Signed Message:` then `Authorize C… payload <hash>`.
  - [x] Passkey from a **password-manager extension** in a real browser: created, full demo and expiry
    demo as expected (claim succeeded, withdraw refused with `NotAllowed`, expired passkey refused with
    `SignerExpired`). The extension's own client data and user-verification flag satisfy the contract's
    strict checks.
  - [ ] Passkey on a hardware key (YubiKey, needs its FIDO2 PIN), Touch ID or Windows Hello: **Create
    passkey**, switch the delegate to Passkey, run the full demo, then the expiry demo. If registration
    fails, note which authenticator; it must support ES256 (P-256).
  - Both together: a wallet master and a passkey delegate in one run.

### Addendum: reusing wallet smart accounts (after WP6)

- [x] **Load an existing smart account** for the connected wallet (`POST /api/wallet-load`): the picker lists
      accounts recorded on chain plus ones this dashboard remembers (`known` in `wallet-session.json`,
      gitignored), or takes a pasted contract id. `loadWalletAccount` reads `master()` (a raw 32-byte key, not an
      address, which the first version got wrong and the e2e caught) and refuses another owner, a contract that is
      not a smart account, and anything that is not a contract id. Loading clears the previous account's results.
      A **Run steps 1–7 on this account** button reuses it.
- [x] **Record accounts on the wallet's own account** as classic data entries, one per account
      (`smart_account_1`…`smart_account_32`, value = contract id; `packages/core/src/registry.ts`). Stellar RPC
      reads data entries by exact key, so keys are numbered and the range is read in one request. The write is a
      `manage_data` transaction the wallet signs with `signTransaction` (the same path as step 2); it costs
      0.5 XLM of the wallet's reserve per entry. It is asked right after an account is created (declining only
      logs a line) and with **Record on my wallet** later; recording an account twice does nothing.
- Verified: 81 core tests (new registry and session tests; 9 of 9 deliberate breaks caught after adding the
  last-slot case); `npm run e2e:wallet` now also covers the record prompt, a declined record, recording later,
  reading the entries back from chain, loading the first account again, four refused loads, and a master action
  on the loaded account. Checked by hand in the dashboard with a test wallet (the refusal message shows).
- Done by hand with the real xBull extension on testnet (all as expected): **Record on my wallet** for an
  existing account (`smart_account_1`), then **Run full demo** with the automatic record prompt (6 prompts; the
  new account became `smart_account_2`; both entries read back from chain and shown in the picker as "on your
  account"), then loading the other account from the picker. xBull signs the `manage_data` transaction like any
  transaction of its own account. Not tried with Freighter. The master was topped up first by merging a funded
  throwaway account into it.

- UI polish: the wallet panel's account picker is a dropdown that shows the active account (plus the others and
  a "paste a contract id" option); the policy editor and call builder sit above the demo steps; the create
  buttons show a spinner while an account is being created. Finding: the deploy shelled out synchronously, which
  froze the dev server for about 5 seconds (no state, no "Deploying…" label), so `deploySmartAccount` is now
  async and the dashboard stays responsive.

- Two pages: `/demo` is the full guided demo (the original page), and `/` is the plain policy and call tester: no
  **Run full demo**, no demo-key options (master mode switch, delegate "Demo key", "Sign with demo keys") and no
  demo steps. One `App` component takes a `variant`, so nothing is duplicated; `/api/signers?demo=0` leaves out
  the demo's own delegate key. The plain page needs a wallet account before it shows the policy editor and call
  builder, switches back to wallet mode and the passkey delegate if the shared session was left otherwise, and
  signs everything in the browser. Checked by hand with a test wallet and a virtual authenticator: create and record
  an account, create a passkey, register it in the policy editor (wallet signs as master) and send a call as it.

## Suggested cut line

About 12 hours in total. If time is short, the value order is:
**WP1 (expiry) → WP2 (policy editor and call builder) → WP3 and WP4 (wallet) → WP5 (passkey)**.
WP3 is cheap and unlocks both wallet and passkey, so do it right after WP2.

## Risks and open items

- **Wallet support differs**: xBull cannot `signAuthEntry`; it uses `signMessage` (above).
  Freighter exposes `signAuthEntry` but blocks it for a contract address, so it uses `signMessage` too.
  The message path is verified with mocks, on-chain and by hand with the real xBull and Freighter
  extensions. Other wallets that claim `signAuthEntry` are untested and may block it the same way.
- **Blind signing**: a wallet shows `Authorize <account> payload <hash>`, so the user cannot
  see which call they approve; the dashboard's call summary is the only readable description.
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

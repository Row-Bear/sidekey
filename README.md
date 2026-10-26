# Sidekey

> Your hardware wallet keeps control. Sidekeys handle routine calls.

Hardware wallets protect your funds, but can make even routine, low-risk
transactions cumbersome. Sidekey keeps your hardware wallet in
control while adding "sidekeys" for routine actions. A Stellar `G...` address
remains the unrestricted master signer, while sidekeys are limited to
specific functions on specific contracts. The smart account checks those
rules on-chain and rejects calls outside them.

**The demo:** a sidekey can claim yield from a testnet protocol, but cannot
withdraw the account's funds. The master signer can do both.

## Why it matters

Everyday interactions should not require exposing a hardware wallet to every
routine contract call. Sidekey explores delegation without handing over
unrestricted control: the hardware wallet's Stellar address stays the master,
and Soroban custom account authorization enforces an understandable,
on-chain allowlist for sidekeys.

## See it work

The guided demo on Stellar testnet demonstrates:

1. Set a policy allowing a delegate to call `claim()` on the yield simulator
   for this account.
2. Send 9,500 XLM to the smart account and deposit it into the simulator.
3. Claim with the master, then successfully claim with the delegate.
4. Attempt `withdraw()` with the delegate; the account rejects it.
5. Withdraw with the master.

The demo also has an optional signer-expiry step. Expected failures are checked
against the account's specific error, not just treated as any transaction
failure.

## What the account enforces

- **Master:** a Stellar G address can authorize any invocation and is required
  for policy administration.
- **Delegate:** each rule specifies a contract, function, and a constraint for
  every argument. Constraints include any value, this account, an exact value,
  or an integer below a limit. A signer can also have an expiry ledger.
- **Fail closed:** every invocation in the authorization tree must match a
  rule. Unlisted functions and contracts, unmatched arguments, and
  unauthorized nested calls are rejected.
- **Lifetime extension:** authorized use extends the account's stored policy
  lifetime. An account idle for about 30 days still needs restoration.

The web app has a policy editor and call tester at `/`, and a guided scenario
at `/demo`. The demo server pays fees with a separate sponsor account. The
static build uses OpenZeppelin Channels for relaying and a wallet-signed
transaction to create an account through the factory.

## Testnet contracts

- Yield simulator: `CDGOE4WK2MAL2U2VFIFPVGIAWNZU5A2KJ5FJTJ7GMXVNS2GGWK4N33DL`
- Sidekey factory: `CAXEX3UHU7VQBWVPO7XVWSVQBOFNJO4HA7VUML2WWI6IH7H43WSCXXSB`

These are testnet deployments. The smart-account address is created for a
master address and is not one shared account for all users.

## Try it locally

Requirements: Node.js 24+, Rust with the `wasm32v1-none` target, and Stellar
CLI 28+.

```sh
npm install
npm run setup:accounts
npm run web
```

Open `http://localhost:5173/demo` for the guided demo or
`http://localhost:5173/` for the policy editor and call tester. Account setup
creates testnet credentials and writes them to `.env`; keep that file private.
Only use testnet funds.

For the browser-only static build:

```sh
npm run web:build:static
```

The GitHub Pages workflow is in `.github/workflows/pages.yml`. Hosting and the
workflow have not yet been verified, so no live website link is claimed here.

## Verification

The project has automated contract, factory, core, and web tests, TypeScript
typechecking, and testnet end-to-end checks. The latest recorded counts and
verification details are in [DESIGN.md](./DESIGN.md).

## Scope and limitations

This is a hackathon proof of concept for testnet, **not audited and not for
real funds**. The master has no rotation or recovery flow, policies have no
cumulative spending or rate limits, and the factory administrator controls
the WASM used for future accounts. Passkey verification is custom code and has
not been audited. See [DESIGN.md](./DESIGN.md) for architecture, security
findings, and what remains unverified.

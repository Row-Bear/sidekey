extern crate std;

use ed25519_dalek::{Signer, SigningKey};
use sha2::{Digest, Sha256};
use soroban_sdk::{
    auth::{Context, ContractContext, ContractExecutable, CreateContractHostFnContext},
    symbol_short,
    testutils::{Address as _, Ledger as _},
    vec,
    xdr::ToXdr,
    Address, BytesN, Env, IntoVal, InvokeError, Symbol, Val, Vec,
};

use crate::{
    AccError, AccSignature, ArgConstraint, Ed25519Signature, Rule, SignerId, SignerPolicy, SmartAccount,
    SmartAccountClient,
};

type CheckResult = Result<(), Result<AccError, InvokeError>>;

struct Fixture<'a> {
    env: Env,
    client: SmartAccountClient<'a>,
    master: SigningKey,
    delegate: SigningKey,
    sim: Address,
}

fn key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn pubkey(env: &Env, key: &SigningKey) -> BytesN<32> {
    BytesN::from_array(env, key.verifying_key().as_bytes())
}

fn setup<'a>() -> Fixture<'a> {
    let env = Env::default();
    env.ledger().set_sequence_number(100);
    let master = key(1);
    let delegate = key(2);
    let id = env.register(SmartAccount, (pubkey(&env, &master),));
    let client = SmartAccountClient::new(&env, &id);
    let sim = Address::generate(&env);
    Fixture { env, client, master, delegate, sim }
}

fn signer_id(f: &Fixture, key: &SigningKey) -> SignerId {
    SignerId::Ed25519(pubkey(&f.env, key))
}

fn delegate_id(f: &Fixture) -> SignerId {
    signer_id(f, &f.delegate)
}

/// `claim(user)` on the simulator, only for the account itself.
fn claim_rule(f: &Fixture) -> Rule {
    Rule {
        contract: f.sim.clone(),
        function: symbol_short!("claim"),
        args: vec![&f.env, ArgConstraint::SelfAddress],
    }
}

fn set_delegate(f: &Fixture, valid_until: Option<u32>, rules: Vec<Rule>) {
    f.env.mock_all_auths();
    f.client.set_signer(&delegate_id(f), &valid_until, &rules);
}

fn allow_delegate_claim(f: &Fixture) {
    set_delegate(f, None, vec![&f.env, claim_rule(f)]);
}

fn call_with(contract: &Address, function: Symbol, args: Vec<Val>) -> Context {
    Context::Contract(ContractContext { contract: contract.clone(), fn_name: function, args })
}

fn call(env: &Env, contract: &Address, function: Symbol, first_arg: &Address) -> Context {
    call_with(contract, function, vec![env, first_arg.into_val(env)])
}

fn signature_for(f: &Fixture, signer: &SigningKey, payload: &BytesN<32>) -> AccSignature {
    AccSignature::Ed25519(Ed25519Signature {
        signer: pubkey(&f.env, signer),
        sig: BytesN::from_array(&f.env, &signer.sign(&payload.to_array()).to_bytes()),
    })
}

fn check(f: &Fixture, signer: &SigningKey, contexts: Vec<Context>) -> CheckResult {
    let payload = BytesN::from_array(&f.env, &[7u8; 32]);
    let signature = signature_for(f, signer, &payload);
    f.env.try_invoke_contract_check_auth::<AccError>(
        &f.client.address,
        &payload,
        signature.into_val(&f.env),
        &contexts,
    )
}

fn delegate_claims(f: &Fixture) -> CheckResult {
    let ctx = vec![&f.env, call(&f.env, &f.sim, symbol_short!("claim"), &f.client.address)];
    check(f, &f.delegate, ctx)
}

// ---- Master ----

#[test]
fn master_authorizes_any_call() {
    let f = setup();
    let other = Address::generate(&f.env);
    let ctx = vec![&f.env, call(&f.env, &other, symbol_short!("withdraw"), &other)];
    assert_eq!(check(&f, &f.master, ctx), Ok(()));
}

#[test]
fn master_is_unaffected_by_expiry_of_other_signers() {
    let f = setup();
    set_delegate(&f, Some(110), vec![&f.env, claim_rule(&f)]);
    f.env.ledger().set_sequence_number(10_000);
    let ctx = vec![&f.env, call(&f.env, &f.sim, symbol_short!("withdraw"), &f.client.address)];
    assert_eq!(check(&f, &f.master, ctx), Ok(()));
}

// ---- Delegate rules ----

#[test]
fn delegate_may_claim_for_the_account() {
    let f = setup();
    allow_delegate_claim(&f);
    assert_eq!(delegate_claims(&f), Ok(()));
}

#[test]
fn delegate_cannot_claim_for_another_user() {
    let f = setup();
    allow_delegate_claim(&f);
    let stranger = Address::generate(&f.env);
    let ctx = vec![&f.env, call(&f.env, &f.sim, symbol_short!("claim"), &stranger)];
    assert_eq!(check(&f, &f.delegate, ctx), Err(Ok(AccError::NotAllowed)));
}

#[test]
fn delegate_cannot_withdraw() {
    let f = setup();
    allow_delegate_claim(&f);
    let ctx = vec![&f.env, call(&f.env, &f.sim, symbol_short!("withdraw"), &f.client.address)];
    assert_eq!(check(&f, &f.delegate, ctx), Err(Ok(AccError::NotAllowed)));
}

#[test]
fn delegate_cannot_call_another_contract() {
    let f = setup();
    allow_delegate_claim(&f);
    let other = Address::generate(&f.env);
    let ctx = vec![&f.env, call(&f.env, &other, symbol_short!("claim"), &f.client.address)];
    assert_eq!(check(&f, &f.delegate, ctx), Err(Ok(AccError::NotAllowed)));
}

#[test]
fn allowed_call_cannot_smuggle_a_forbidden_sub_invocation() {
    let f = setup();
    allow_delegate_claim(&f);
    let ctx = vec![
        &f.env,
        call(&f.env, &f.sim, symbol_short!("claim"), &f.client.address),
        call(&f.env, &f.sim, symbol_short!("withdraw"), &f.client.address),
    ];
    assert_eq!(check(&f, &f.delegate, ctx), Err(Ok(AccError::NotAllowed)));
}

#[test]
fn delegate_cannot_authorize_calls_on_the_account_itself() {
    let f = setup();
    allow_delegate_claim(&f);
    let me = f.client.address.clone();
    let ctx = vec![&f.env, call(&f.env, &me, Symbol::new(&f.env, "set_signer"), &me)];
    assert_eq!(check(&f, &f.delegate, ctx), Err(Ok(AccError::NotAllowed)));
}

#[test]
fn delegate_cannot_authorize_contract_deployments() {
    let f = setup();
    allow_delegate_claim(&f);
    let deploy = Context::CreateContractHostFn(CreateContractHostFnContext {
        executable: ContractExecutable::Wasm(BytesN::from_array(&f.env, &[0; 32])),
        salt: BytesN::from_array(&f.env, &[0; 32]),
    });
    assert_eq!(check(&f, &f.delegate, vec![&f.env, deploy]), Err(Ok(AccError::NotAllowed)));
}

#[test]
fn signer_without_policy_is_rejected() {
    let f = setup();
    assert_eq!(delegate_claims(&f), Err(Ok(AccError::UnknownSigner)));
}

#[test]
fn signer_with_an_empty_rule_list_authorizes_nothing() {
    let f = setup();
    set_delegate(&f, None, Vec::new(&f.env));
    assert_eq!(delegate_claims(&f), Err(Ok(AccError::NotAllowed)));
}

#[test]
fn removing_the_rule_authorizes_nothing() {
    let f = setup();
    allow_delegate_claim(&f);
    f.client.remove_rule(&delegate_id(&f), &f.sim, &symbol_short!("claim"));
    assert_eq!(delegate_claims(&f), Err(Ok(AccError::NotAllowed)));
}

// ---- Argument constraints ----

#[test]
fn any_constraint_accepts_any_value_but_arity_must_match() {
    let f = setup();
    let rule = Rule {
        contract: f.sim.clone(),
        function: symbol_short!("withdraw"),
        args: vec![&f.env, ArgConstraint::SelfAddress, ArgConstraint::Any],
    };
    set_delegate(&f, None, vec![&f.env, rule]);
    let me = f.client.address.clone();

    let two_args = |amount: i128| call_with(&f.sim, symbol_short!("withdraw"), vec![&f.env, me.into_val(&f.env), amount.into_val(&f.env)]);
    assert_eq!(check(&f, &f.delegate, vec![&f.env, two_args(5)]), Ok(()));
    assert_eq!(check(&f, &f.delegate, vec![&f.env, two_args(i128::MAX)]), Ok(()));

    let one_arg = call(&f.env, &f.sim, symbol_short!("withdraw"), &me);
    assert_eq!(check(&f, &f.delegate, vec![&f.env, one_arg]), Err(Ok(AccError::NotAllowed)));
    let three_args = call_with(
        &f.sim,
        symbol_short!("withdraw"),
        vec![&f.env, me.into_val(&f.env), 1i128.into_val(&f.env), 2i128.into_val(&f.env)],
    );
    assert_eq!(check(&f, &f.delegate, vec![&f.env, three_args]), Err(Ok(AccError::NotAllowed)));
}

#[test]
fn exact_constraint_requires_the_same_value() {
    let f = setup();
    let allowed: i128 = 100;
    let rule = Rule {
        contract: f.sim.clone(),
        function: symbol_short!("withdraw"),
        args: vec![&f.env, ArgConstraint::SelfAddress, ArgConstraint::Exact(allowed.to_xdr(&f.env))],
    };
    set_delegate(&f, None, vec![&f.env, rule]);
    let me = f.client.address.clone();
    let withdraw = |amount: i128| {
        vec![
            &f.env,
            call_with(&f.sim, symbol_short!("withdraw"), vec![&f.env, me.into_val(&f.env), amount.into_val(&f.env)]),
        ]
    };
    assert_eq!(check(&f, &f.delegate, withdraw(100)), Ok(()));
    assert_eq!(check(&f, &f.delegate, withdraw(101)), Err(Ok(AccError::NotAllowed)));
    assert_eq!(check(&f, &f.delegate, withdraw(-100)), Err(Ok(AccError::NotAllowed)));
}

#[test]
fn exact_constraint_does_not_confuse_value_types() {
    let f = setup();
    // The XDR of u32 100 differs from the XDR of i128 100, so the types cannot be swapped.
    let rule = Rule {
        contract: f.sim.clone(),
        function: symbol_short!("poke"),
        args: vec![&f.env, ArgConstraint::Exact(100i128.to_xdr(&f.env))],
    };
    set_delegate(&f, None, vec![&f.env, rule]);
    let with = |value: Val| vec![&f.env, call_with(&f.sim, symbol_short!("poke"), vec![&f.env, value])];
    assert_eq!(check(&f, &f.delegate, with(100i128.into_val(&f.env))), Ok(()));
    assert_eq!(check(&f, &f.delegate, with(100u32.into_val(&f.env))), Err(Ok(AccError::NotAllowed)));
}

#[test]
fn zero_argument_functions_can_be_allowed() {
    let f = setup();
    let rule = Rule { contract: f.sim.clone(), function: symbol_short!("ping"), args: Vec::new(&f.env) };
    set_delegate(&f, None, vec![&f.env, rule]);
    let ping = call_with(&f.sim, symbol_short!("ping"), Vec::new(&f.env));
    assert_eq!(check(&f, &f.delegate, vec![&f.env, ping]), Ok(()));
    assert_eq!(delegate_claims(&f), Err(Ok(AccError::NotAllowed)));
}

// ---- Expiry ----

#[test]
fn delegate_is_accepted_up_to_and_including_the_expiry_ledger() {
    let f = setup();
    set_delegate(&f, Some(200), vec![&f.env, claim_rule(&f)]);
    f.env.ledger().set_sequence_number(199);
    assert_eq!(delegate_claims(&f), Ok(()));
    f.env.ledger().set_sequence_number(200);
    assert_eq!(delegate_claims(&f), Ok(()));
}

#[test]
fn delegate_is_refused_after_the_expiry_ledger() {
    let f = setup();
    set_delegate(&f, Some(200), vec![&f.env, claim_rule(&f)]);
    f.env.ledger().set_sequence_number(201);
    assert_eq!(delegate_claims(&f), Err(Ok(AccError::SignerExpired)));
}

#[test]
fn an_expired_delegate_is_refused_even_for_calls_its_rules_allow() {
    let f = setup();
    set_delegate(&f, Some(150), vec![&f.env, claim_rule(&f)]);
    f.env.ledger().set_sequence_number(5_000);
    assert_eq!(delegate_claims(&f), Err(Ok(AccError::SignerExpired)));
}

#[test]
fn set_expiry_extends_an_expired_delegate() {
    let f = setup();
    set_delegate(&f, Some(150), vec![&f.env, claim_rule(&f)]);
    f.env.ledger().set_sequence_number(300);
    assert_eq!(delegate_claims(&f), Err(Ok(AccError::SignerExpired)));
    f.client.set_expiry(&delegate_id(&f), &Some(400));
    assert_eq!(delegate_claims(&f), Ok(()));
}

#[test]
fn set_expiry_can_shorten_and_remove_the_expiry() {
    let f = setup();
    set_delegate(&f, Some(1_000), vec![&f.env, claim_rule(&f)]);
    f.client.set_expiry(&delegate_id(&f), &Some(120));
    f.env.ledger().set_sequence_number(121);
    assert_eq!(delegate_claims(&f), Err(Ok(AccError::SignerExpired)));
    f.client.set_expiry(&delegate_id(&f), &None);
    assert_eq!(delegate_claims(&f), Ok(()));
}

#[test]
fn an_expiry_in_the_past_or_now_is_invalid() {
    let f = setup();
    f.env.mock_all_auths();
    for ledger in [0u32, 99, 100] {
        let res = f.client.try_set_signer(&delegate_id(&f), &Some(ledger), &vec![&f.env, claim_rule(&f)]);
        assert_eq!(res, Err(Ok(AccError::InvalidPolicy)));
    }
    assert!(f.client.try_set_signer(&delegate_id(&f), &Some(101), &vec![&f.env, claim_rule(&f)]).is_ok());
    assert_eq!(f.client.try_set_expiry(&delegate_id(&f), &Some(100)), Err(Ok(AccError::InvalidPolicy)));
}

// ---- Signature checks ----

#[test]
fn invalid_signature_is_rejected() {
    let f = setup();
    let payload = BytesN::from_array(&f.env, &[7u8; 32]);
    let forged = AccSignature::Ed25519(Ed25519Signature {
        signer: pubkey(&f.env, &f.master),
        sig: BytesN::from_array(&f.env, &f.delegate.sign(&payload.to_array()).to_bytes()),
    });
    let ctx = vec![&f.env, call(&f.env, &f.sim, symbol_short!("claim"), &f.client.address)];
    let res = f.env.try_invoke_contract_check_auth::<AccError>(&f.client.address, &payload, forged.into_val(&f.env), &ctx);
    assert!(res.is_err());
}

#[test]
fn delegate_cannot_borrow_the_master_signature() {
    let f = setup();
    allow_delegate_claim(&f);
    let payload = BytesN::from_array(&f.env, &[7u8; 32]);
    let mismatched = AccSignature::Ed25519(Ed25519Signature {
        signer: pubkey(&f.env, &f.delegate),
        sig: BytesN::from_array(&f.env, &f.master.sign(&payload.to_array()).to_bytes()),
    });
    let ctx = vec![&f.env, call(&f.env, &f.sim, symbol_short!("claim"), &f.client.address)];
    assert!(f
        .env
        .try_invoke_contract_check_auth::<AccError>(&f.client.address, &payload, mismatched.into_val(&f.env), &ctx)
        .is_err());
}

// ---- Admin ----

#[test]
fn admin_calls_require_the_account_auth() {
    let f = setup();
    allow_delegate_claim(&f);
    let auths = f.env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, f.client.address);
}

#[test]
fn admin_calls_fail_without_auth() {
    let f = setup();
    let id = delegate_id(&f);
    let rules = vec![&f.env, claim_rule(&f)];
    assert!(f.client.try_set_signer(&id, &None, &rules).is_err());
    assert!(f.client.try_add_rule(&id, &claim_rule(&f)).is_err());
    assert!(f.client.try_set_expiry(&id, &Some(500)).is_err());
    assert!(f.client.try_revoke_signer(&id).is_err());
}

#[test]
fn master_cannot_be_given_a_delegate_policy() {
    let f = setup();
    f.env.mock_all_auths();
    let res = f.client.try_set_signer(&signer_id(&f, &f.master), &None, &vec![&f.env, claim_rule(&f)]);
    assert_eq!(res, Err(Ok(AccError::InvalidPolicy)));
}

#[test]
fn rules_on_the_account_itself_are_invalid() {
    let f = setup();
    f.env.mock_all_auths();
    let rule = Rule {
        contract: f.client.address.clone(),
        function: Symbol::new(&f.env, "set_signer"),
        args: Vec::new(&f.env),
    };
    let res = f.client.try_set_signer(&delegate_id(&f), &None, &vec![&f.env, rule]);
    assert_eq!(res, Err(Ok(AccError::InvalidPolicy)));
}

#[test]
fn too_many_rules_or_arguments_are_invalid() {
    let f = setup();
    f.env.mock_all_auths();
    let mut rules = Vec::new(&f.env);
    for _ in 0..33 {
        rules.push_back(claim_rule(&f));
    }
    assert_eq!(f.client.try_set_signer(&delegate_id(&f), &None, &rules), Err(Ok(AccError::InvalidPolicy)));

    let mut args = Vec::new(&f.env);
    for _ in 0..17 {
        args.push_back(ArgConstraint::Any);
    }
    let wide = Rule { contract: f.sim.clone(), function: symbol_short!("wide"), args };
    assert_eq!(
        f.client.try_set_signer(&delegate_id(&f), &None, &vec![&f.env, wide]),
        Err(Ok(AccError::InvalidPolicy))
    );
}

#[test]
fn set_signer_replaces_the_whole_policy() {
    let f = setup();
    allow_delegate_claim(&f);
    let other = Rule { contract: f.sim.clone(), function: symbol_short!("ping"), args: Vec::new(&f.env) };
    f.client.set_signer(&delegate_id(&f), &Some(500), &vec![&f.env, other.clone()]);

    let policy = f.client.get_signer(&delegate_id(&f)).unwrap();
    assert_eq!(policy, SignerPolicy { valid_until_ledger: Some(500), rules: vec![&f.env, other] });
    assert_eq!(delegate_claims(&f), Err(Ok(AccError::NotAllowed)));
    assert_eq!(f.client.list_signers().len(), 1);
}

#[test]
fn add_rule_is_idempotent_and_needs_a_registered_signer() {
    let f = setup();
    f.env.mock_all_auths();
    assert_eq!(f.client.try_add_rule(&delegate_id(&f), &claim_rule(&f)), Err(Ok(AccError::UnknownSigner)));

    set_delegate(&f, None, Vec::new(&f.env));
    f.client.add_rule(&delegate_id(&f), &claim_rule(&f));
    f.client.add_rule(&delegate_id(&f), &claim_rule(&f));
    assert_eq!(f.client.get_signer(&delegate_id(&f)).unwrap().rules.len(), 1);
    assert_eq!(delegate_claims(&f), Ok(()));
}

#[test]
fn revoked_signer_is_unknown_and_unlisted() {
    let f = setup();
    allow_delegate_claim(&f);
    assert_eq!(f.client.list_signers(), vec![&f.env, delegate_id(&f)]);

    f.client.revoke_signer(&delegate_id(&f));
    assert_eq!(f.client.list_signers().len(), 0);
    assert_eq!(f.client.get_signer(&delegate_id(&f)), None);
    assert_eq!(delegate_claims(&f), Err(Ok(AccError::UnknownSigner)));
    assert_eq!(f.client.try_revoke_signer(&delegate_id(&f)), Err(Ok(AccError::UnknownSigner)));
}

#[test]
fn list_signers_has_no_duplicates_and_tracks_each_signer() {
    let f = setup();
    allow_delegate_claim(&f);
    allow_delegate_claim(&f);
    let second = key(3);
    f.client.set_signer(&signer_id(&f, &second), &None, &Vec::new(&f.env));
    assert_eq!(f.client.list_signers(), vec![&f.env, delegate_id(&f), signer_id(&f, &second)]);
}

#[test]
fn the_master_is_exposed_by_master() {
    let f = setup();
    assert_eq!(f.client.master(), pubkey(&f.env, &f.master));
}

// ---- SEP-53 message signatures (wallets that cannot sign auth entries) ----

/// What a wallet signs for `payload` on `account`, built with ordinary strings (not the contract's code).
fn wallet_message(account: &str, payload: &[u8; 32]) -> std::string::String {
    let hex: std::string::String = payload.iter().map(|b| std::format!("{b:02x}")).collect();
    std::format!("Stellar Signed Message:\nAuthorize {account} payload {hex}")
}

fn message_signature(f: &Fixture, signer: &SigningKey, account: &str, payload: &BytesN<32>) -> AccSignature {
    let digest = Sha256::digest(wallet_message(account, &payload.to_array()).as_bytes());
    AccSignature::Message(Ed25519Signature {
        signer: pubkey(&f.env, signer),
        sig: BytesN::from_array(&f.env, &signer.sign(&digest).to_bytes()),
    })
}

fn check_with(f: &Fixture, signature: AccSignature, payload: &BytesN<32>, contexts: Vec<Context>) -> CheckResult {
    f.env.try_invoke_contract_check_auth::<AccError>(&f.client.address, payload, signature.into_val(&f.env), &contexts)
}

fn claim_ctx(f: &Fixture) -> Vec<Context> {
    vec![&f.env, call(&f.env, &f.sim, symbol_short!("claim"), &f.client.address)]
}

fn account_text(f: &Fixture) -> std::string::String {
    let text = f.client.address.to_string();
    let mut buf = [0u8; 56];
    text.copy_into_slice(&mut buf);
    std::string::String::from_utf8(buf.to_vec()).unwrap()
}

#[test]
fn master_message_signature_authorizes_any_call() {
    let f = setup();
    let payload = BytesN::from_array(&f.env, &[7u8; 32]);
    let other = Address::generate(&f.env);
    let ctx = vec![&f.env, call(&f.env, &other, symbol_short!("withdraw"), &other)];
    let sig = message_signature(&f, &f.master, &account_text(&f), &payload);
    assert_eq!(check_with(&f, sig, &payload, ctx), Ok(()));
}

#[test]
fn message_signature_is_for_one_payload_only() {
    let f = setup();
    let signed_for = BytesN::from_array(&f.env, &[7u8; 32]);
    let presented_with = BytesN::from_array(&f.env, &[8u8; 32]);
    let sig = message_signature(&f, &f.master, &account_text(&f), &signed_for);
    assert!(check_with(&f, sig, &presented_with, claim_ctx(&f)).is_err());
}

#[test]
fn message_signature_is_for_one_account_only() {
    let f = setup();
    let payload = BytesN::from_array(&f.env, &[7u8; 32]);
    // The master signed the same payload, but for a different account's message.
    let elsewhere = Address::generate(&f.env).to_string();
    let mut buf = [0u8; 56];
    elsewhere.copy_into_slice(&mut buf);
    let other_account = std::string::String::from_utf8(buf.to_vec()).unwrap();
    assert_ne!(other_account, account_text(&f));
    let sig = message_signature(&f, &f.master, &other_account, &payload);
    assert!(check_with(&f, sig, &payload, claim_ctx(&f)).is_err());
}

#[test]
fn message_must_have_the_exact_text() {
    let f = setup();
    let payload = BytesN::from_array(&f.env, &[0xabu8; 32]);
    let account = account_text(&f);
    let hex: std::string::String = payload.to_array().iter().map(|b| std::format!("{b:02x}")).collect();
    let variants = [
        std::format!("Stellar Signed Message:\nAuthorize {account} payload {}", hex.to_uppercase()),
        std::format!("Authorize {account} payload {hex}"),
        std::format!("Stellar Signed Message:\nAuthorize {account} payload {hex}\n"),
        std::format!("Stellar Signed Message:\nauthorize {account} payload {hex}"),
    ];
    // The uppercase variant must differ from the correct text, or this case would prove nothing.
    assert_ne!(variants[0], wallet_message(&account, &payload.to_array()));
    for text in variants {
        let digest = Sha256::digest(text.as_bytes());
        let sig = AccSignature::Message(Ed25519Signature {
            signer: pubkey(&f.env, &f.master),
            sig: BytesN::from_array(&f.env, &f.master.sign(&digest).to_bytes()),
        });
        assert!(check_with(&f, sig, &payload, claim_ctx(&f)).is_err(), "accepted: {text:?}");
    }
}

#[test]
fn the_two_signature_kinds_are_not_interchangeable() {
    let f = setup();
    let payload = BytesN::from_array(&f.env, &[7u8; 32]);

    // A raw signature over the payload, presented as a message signature.
    let raw = f.master.sign(&payload.to_array()).to_bytes();
    let as_message = AccSignature::Message(Ed25519Signature { signer: pubkey(&f.env, &f.master), sig: BytesN::from_array(&f.env, &raw) });
    assert!(check_with(&f, as_message, &payload, claim_ctx(&f)).is_err());

    // A message signature, presented as a raw payload signature.
    let digest = Sha256::digest(wallet_message(&account_text(&f), &payload.to_array()).as_bytes());
    let msg_sig = f.master.sign(&digest).to_bytes();
    let as_raw = AccSignature::Ed25519(Ed25519Signature { signer: pubkey(&f.env, &f.master), sig: BytesN::from_array(&f.env, &msg_sig) });
    assert!(check_with(&f, as_raw, &payload, claim_ctx(&f)).is_err());
}

#[test]
fn delegate_message_signatures_still_go_through_the_policy() {
    let f = setup();
    allow_delegate_claim(&f);
    let payload = BytesN::from_array(&f.env, &[7u8; 32]);
    let account = account_text(&f);

    let allowed = message_signature(&f, &f.delegate, &account, &payload);
    assert_eq!(check_with(&f, allowed, &payload, claim_ctx(&f)), Ok(()));

    let withdraw = vec![&f.env, call(&f.env, &f.sim, symbol_short!("withdraw"), &f.client.address)];
    let refused = message_signature(&f, &f.delegate, &account, &payload);
    assert_eq!(check_with(&f, refused, &payload, withdraw), Err(Ok(AccError::NotAllowed)));
}

#[test]
fn an_expired_delegate_is_refused_with_a_message_signature_too() {
    let f = setup();
    set_delegate(&f, Some(150), vec![&f.env, claim_rule(&f)]);
    f.env.ledger().set_sequence_number(500);
    let payload = BytesN::from_array(&f.env, &[7u8; 32]);
    let sig = message_signature(&f, &f.delegate, &account_text(&f), &payload);
    assert_eq!(check_with(&f, sig, &payload, claim_ctx(&f)), Err(Ok(AccError::SignerExpired)));
}

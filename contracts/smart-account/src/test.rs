extern crate std;

use std::string::ToString;

use ed25519_dalek::{Signer, SigningKey};
use sha2::{Digest, Sha256};
use soroban_sdk::{
    auth::{Context, ContractContext, ContractExecutable, CreateContractHostFnContext},
    symbol_short,
    testutils::{Address as _, storage::Instance as _, Ledger as _},
    vec,
    xdr::ToXdr,
    Address, BytesN, Env, IntoVal, InvokeError, Symbol, Val, Vec,
};

use crate::{
    AccError, AccSignature, ArgConstraint, Ed25519Signature, PasskeySignature, Rule, SignerId, SignerPolicy,
    SmartAccount, SmartAccountClient, TTL_EXTEND_TO,
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

// ---- LessThan ----

#[test]
fn version_tells_clients_that_less_than_is_supported() {
    let f = setup();
    assert_eq!(f.client.version(), 4);
}

// ---- Lifetime ----

fn instance_ttl(f: &Fixture) -> u32 {
    f.env.as_contract(&f.client.address, || f.env.storage().instance().get_ttl())
}

fn advance_until_ttl_is(f: &Fixture, remaining: u32) {
    let sequence = f.env.ledger().sequence();
    f.env.ledger().set_sequence_number(sequence + instance_ttl(f) - remaining);
    assert_eq!(instance_ttl(f), remaining);
}

#[test]
fn a_master_call_extends_the_accounts_lifetime() {
    let f = setup();
    advance_until_ttl_is(&f, 1_000);
    let other = Address::generate(&f.env);
    let ctx = vec![&f.env, call(&f.env, &other, symbol_short!("withdraw"), &other)];
    assert_eq!(check(&f, &f.master, ctx), Ok(()));
    assert_eq!(instance_ttl(&f), TTL_EXTEND_TO);
}

#[test]
fn a_delegate_call_extends_the_accounts_lifetime() {
    let f = setup();
    allow_delegate_claim(&f);
    advance_until_ttl_is(&f, 1_000);
    assert_eq!(delegate_claims(&f), Ok(()));
    assert_eq!(instance_ttl(&f), TTL_EXTEND_TO);
}

#[test]
fn a_rejected_call_does_not_extend_the_lifetime() {
    let f = setup();
    advance_until_ttl_is(&f, 1_000);
    // The delegate has no policy, so the check fails and its effects (including the extension) are dropped.
    assert!(delegate_claims(&f).is_err());
    assert_eq!(instance_ttl(&f), 1_000);
}

/// `poke(value)` on the simulator, allowed only for integers below `limit`.
fn allow_poke_below(f: &Fixture, limit: i128) {
    let rule = Rule {
        contract: f.sim.clone(),
        function: symbol_short!("poke"),
        args: vec![&f.env, ArgConstraint::LessThan(limit)],
    };
    set_delegate(f, None, vec![&f.env, rule]);
}

fn poke(f: &Fixture, value: Val) -> CheckResult {
    check(f, &f.delegate, vec![&f.env, call_with(&f.sim, symbol_short!("poke"), vec![&f.env, value])])
}

#[test]
fn less_than_is_strict() {
    let f = setup();
    allow_poke_below(&f, 100);
    assert_eq!(poke(&f, 99i128.into_val(&f.env)), Ok(()));
    assert_eq!(poke(&f, 100i128.into_val(&f.env)), Err(Ok(AccError::NotAllowed)));
    assert_eq!(poke(&f, 101i128.into_val(&f.env)), Err(Ok(AccError::NotAllowed)));
    assert_eq!(poke(&f, i128::MAX.into_val(&f.env)), Err(Ok(AccError::NotAllowed)));
}

#[test]
fn less_than_sets_no_lower_bound() {
    let f = setup();
    allow_poke_below(&f, 100);
    assert_eq!(poke(&f, 0i128.into_val(&f.env)), Ok(()));
    assert_eq!(poke(&f, (-1i128).into_val(&f.env)), Ok(()));
    assert_eq!(poke(&f, i128::MIN.into_val(&f.env)), Ok(()));
}

#[test]
fn less_than_works_with_a_negative_limit_and_the_extremes() {
    let f = setup();
    allow_poke_below(&f, -5);
    assert_eq!(poke(&f, (-6i128).into_val(&f.env)), Ok(()));
    assert_eq!(poke(&f, (-5i128).into_val(&f.env)), Err(Ok(AccError::NotAllowed)));
    assert_eq!(poke(&f, 0i128.into_val(&f.env)), Err(Ok(AccError::NotAllowed)));

    allow_poke_below(&f, i128::MIN);
    assert_eq!(poke(&f, i128::MIN.into_val(&f.env)), Err(Ok(AccError::NotAllowed)));

    allow_poke_below(&f, i128::MAX);
    assert_eq!(poke(&f, (i128::MAX - 1).into_val(&f.env)), Ok(()));
    assert_eq!(poke(&f, i128::MAX.into_val(&f.env)), Err(Ok(AccError::NotAllowed)));
}

#[test]
fn less_than_compares_every_integer_type() {
    let f = setup();
    allow_poke_below(&f, 100);
    assert_eq!(poke(&f, 99u32.into_val(&f.env)), Ok(()));
    assert_eq!(poke(&f, 100u32.into_val(&f.env)), Err(Ok(AccError::NotAllowed)));
    assert_eq!(poke(&f, 99i32.into_val(&f.env)), Ok(()));
    assert_eq!(poke(&f, (-7i32).into_val(&f.env)), Ok(()));
    assert_eq!(poke(&f, 100i32.into_val(&f.env)), Err(Ok(AccError::NotAllowed)));
    assert_eq!(poke(&f, 99u64.into_val(&f.env)), Ok(()));
    assert_eq!(poke(&f, 100u64.into_val(&f.env)), Err(Ok(AccError::NotAllowed)));
    assert_eq!(poke(&f, u64::MAX.into_val(&f.env)), Err(Ok(AccError::NotAllowed)));
    assert_eq!(poke(&f, 99i64.into_val(&f.env)), Ok(()));
    assert_eq!(poke(&f, i64::MIN.into_val(&f.env)), Ok(()));
    assert_eq!(poke(&f, 100i64.into_val(&f.env)), Err(Ok(AccError::NotAllowed)));
    assert_eq!(poke(&f, 99u128.into_val(&f.env)), Ok(()));
    assert_eq!(poke(&f, 100u128.into_val(&f.env)), Err(Ok(AccError::NotAllowed)));
}

#[test]
fn less_than_refuses_a_u128_that_does_not_fit() {
    let f = setup();
    allow_poke_below(&f, i128::MAX);
    // Above i128::MAX, so not below the limit, and it must not wrap around to a small or negative number.
    assert_eq!(poke(&f, u128::MAX.into_val(&f.env)), Err(Ok(AccError::NotAllowed)));
    assert_eq!(poke(&f, (i128::MAX as u128 + 1).into_val(&f.env)), Err(Ok(AccError::NotAllowed)));
}

#[test]
fn less_than_refuses_arguments_that_are_not_integers() {
    let f = setup();
    allow_poke_below(&f, 100);
    let me = f.client.address.clone();
    assert_eq!(poke(&f, me.into_val(&f.env)), Err(Ok(AccError::NotAllowed)));
    assert_eq!(poke(&f, symbol_short!("small").into_val(&f.env)), Err(Ok(AccError::NotAllowed)));
    assert_eq!(poke(&f, true.into_val(&f.env)), Err(Ok(AccError::NotAllowed)));
    assert_eq!(poke(&f, ().into_val(&f.env)), Err(Ok(AccError::NotAllowed)));
    assert_eq!(poke(&f, soroban_sdk::Bytes::from_array(&f.env, &[1, 2]).into_val(&f.env)), Err(Ok(AccError::NotAllowed)));
    assert_eq!(poke(&f, soroban_sdk::String::from_str(&f.env, "5").into_val(&f.env)), Err(Ok(AccError::NotAllowed)));
}

#[test]
fn less_than_combines_with_other_constraints() {
    let f = setup();
    let rule = Rule {
        contract: f.sim.clone(),
        function: symbol_short!("transfer"),
        args: vec![&f.env, ArgConstraint::SelfAddress, ArgConstraint::Any, ArgConstraint::LessThan(1_000)],
    };
    set_delegate(&f, None, vec![&f.env, rule]);
    let me = f.client.address.clone();
    let other = Address::generate(&f.env);
    let transfer = |from: &Address, amount: i128| {
        vec![
            &f.env,
            call_with(
                &f.sim,
                symbol_short!("transfer"),
                vec![&f.env, from.into_val(&f.env), other.into_val(&f.env), amount.into_val(&f.env)],
            ),
        ]
    };
    assert_eq!(check(&f, &f.delegate, transfer(&me, 999)), Ok(()));
    assert_eq!(check(&f, &f.delegate, transfer(&me, 1_000)), Err(Ok(AccError::NotAllowed)));
    // A small amount from someone else's account is still refused by the other constraint.
    assert_eq!(check(&f, &f.delegate, transfer(&other, 1)), Err(Ok(AccError::NotAllowed)));
}

#[test]
fn less_than_applies_to_every_call_in_one_authorization() {
    let f = setup();
    allow_poke_below(&f, 100);
    let ok = call_with(&f.sim, symbol_short!("poke"), vec![&f.env, 5i128.into_val(&f.env)]);
    let too_big = call_with(&f.sim, symbol_short!("poke"), vec![&f.env, 500i128.into_val(&f.env)]);
    assert_eq!(check(&f, &f.delegate, vec![&f.env, ok.clone(), ok.clone()]), Ok(()));
    assert_eq!(check(&f, &f.delegate, vec![&f.env, ok, too_big]), Err(Ok(AccError::NotAllowed)));
}

#[test]
fn less_than_is_stored_and_rules_for_one_function_are_alternatives() {
    let f = setup();
    allow_poke_below(&f, 100);
    let stored = f.client.get_signer(&delegate_id(&f)).unwrap();
    assert_eq!(stored.rules.get(0).unwrap().args.get(0).unwrap(), ArgConstraint::LessThan(100));

    // A second rule for the same function is an alternative: either one allows the call, so a tighter
    // limit only takes effect once the looser rule is removed.
    let tighter = Rule { contract: f.sim.clone(), function: symbol_short!("poke"), args: vec![&f.env, ArgConstraint::LessThan(10)] };
    f.env.mock_all_auths();
    f.client.add_rule(&delegate_id(&f), &tighter);
    assert_eq!(f.client.get_signer(&delegate_id(&f)).unwrap().rules.len(), 2);
    assert_eq!(poke(&f, 50i128.into_val(&f.env)), Ok(()));

    f.client.remove_rule(&delegate_id(&f), &f.sim, &symbol_short!("poke"));
    f.client.add_rule(&delegate_id(&f), &tighter);
    assert_eq!(poke(&f, 50i128.into_val(&f.env)), Err(Ok(AccError::NotAllowed)));
    assert_eq!(poke(&f, 9i128.into_val(&f.env)), Ok(()));
}

#[test]
fn less_than_does_not_limit_the_master() {
    let f = setup();
    allow_poke_below(&f, 1);
    let huge = vec![&f.env, call_with(&f.sim, symbol_short!("poke"), vec![&f.env, i128::MAX.into_val(&f.env)])];
    assert_eq!(check(&f, &f.master, huge), Ok(()));
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
    assert_eq!(policy, SignerPolicy { valid_until_ledger: Some(500), rp_id_hash: None, rules: vec![&f.env, other] });
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

// ---- Passkey delegates (WebAuthn) ----

use base64::{engine::general_purpose::STANDARD, Engine};
use p256::ecdsa::{signature::hazmat::PrehashSigner, Signature as P256Signature, SigningKey as P256Key};
use serde::Deserialize;

/// Real output of a Chrome virtual authenticator (ES256, user verification), one fixture per assertion.
#[derive(Deserialize)]
struct WebAuthnFixture {
    spki: std::string::String,
    assertions: std::vec::Vec<RealAssertion>,
}

#[derive(Deserialize, Clone)]
struct RealAssertion {
    challenge: std::string::String,
    #[serde(rename = "authenticatorData")]
    authenticator_data: std::string::String,
    #[serde(rename = "clientDataJSON")]
    client_data_json: std::string::String,
    signature: std::string::String,
}

fn webauthn_fixture() -> WebAuthnFixture {
    serde_json::from_str(include_str!("../test-fixtures/webauthn-assertions.json")).unwrap()
}

fn b64(text: &str) -> std::vec::Vec<u8> {
    STANDARD.decode(text).unwrap()
}

/// DER (what WebAuthn returns) to 64-byte r||s, normalized to low-S as Soroban requires.
fn low_s(der: &[u8]) -> [u8; 64] {
    let sig = P256Signature::from_der(der).unwrap();
    sig.normalize_s().unwrap_or(sig).to_bytes().into()
}

/// The same signature with s replaced by n - s: valid ECDSA, but high-S.
fn high_s(der: &[u8]) -> [u8; 64] {
    let sig = P256Signature::from_slice(&low_s(der)).unwrap();
    let (r, s) = sig.split_scalars();
    P256Signature::from_scalars(r.to_bytes(), (-*s).to_bytes()).unwrap().to_bytes().into()
}

fn rp_hash(env: &Env, rp_id: &str) -> BytesN<32> {
    env.crypto().sha256(&soroban_sdk::Bytes::from_slice(env, rp_id.as_bytes())).to_bytes()
}

/// Everything needed to present one assertion to `__check_auth`.
#[derive(Clone)]
struct Assertion {
    payload: [u8; 32],
    public_key: [u8; 65],
    authenticator_data: std::vec::Vec<u8>,
    client_data_json: std::vec::Vec<u8>,
    sig: [u8; 64],
}

fn real_assertions() -> std::vec::Vec<Assertion> {
    let fx = webauthn_fixture();
    let spki = b64(&fx.spki);
    let public_key: [u8; 65] = spki[spki.len() - 65..].try_into().unwrap();
    fx.assertions
        .iter()
        .map(|a| Assertion {
            payload: b64(&a.challenge).try_into().unwrap(),
            public_key,
            authenticator_data: b64(&a.authenticator_data),
            client_data_json: b64(&a.client_data_json),
            sig: low_s(&b64(&a.signature)),
        })
        .collect()
}

fn passkey_signature(f: &Fixture, a: &Assertion) -> AccSignature {
    AccSignature::Passkey(PasskeySignature {
        public_key: BytesN::from_array(&f.env, &a.public_key),
        authenticator_data: soroban_sdk::Bytes::from_slice(&f.env, &a.authenticator_data),
        client_data_json: soroban_sdk::Bytes::from_slice(&f.env, &a.client_data_json),
        sig: BytesN::from_array(&f.env, &a.sig),
    })
}

fn register_passkey(f: &Fixture, a: &Assertion, rp_id: &str, valid_until: Option<u32>) {
    f.env.mock_all_auths();
    f.client.set_passkey(
        &BytesN::from_array(&f.env, &a.public_key),
        &rp_hash(&f.env, rp_id),
        &valid_until,
        &vec![&f.env, claim_rule(f)],
    );
}

fn passkey_check(f: &Fixture, a: &Assertion, contexts: Vec<Context>) -> CheckResult {
    check_with(f, passkey_signature(f, a), &BytesN::from_array(&f.env, &a.payload), contexts)
}

fn passkey_id(f: &Fixture, a: &Assertion) -> SignerId {
    SignerId::Passkey(BytesN::from_array(&f.env, &a.public_key))
}

fn first_real() -> Assertion {
    real_assertions().remove(0)
}

fn with_client_data(a: &Assertion, edit: impl Fn(std::string::String) -> std::string::String) -> Assertion {
    let text = std::string::String::from_utf8(a.client_data_json.clone()).unwrap();
    Assertion { client_data_json: edit(text).into_bytes(), ..a.clone() }
}

#[test]
fn real_browser_assertions_authorize_an_allowed_claim() {
    let f = setup();
    let all = real_assertions();
    register_passkey(&f, &all[0], "localhost", None);
    for a in &all {
        assert_eq!(passkey_check(&f, a, claim_ctx(&f)), Ok(()));
    }
    assert_eq!(all.len(), 32);
}

#[test]
fn a_passkey_goes_through_the_same_policy_as_any_delegate() {
    let f = setup();
    let a = first_real();
    register_passkey(&f, &a, "localhost", None);
    let withdraw = vec![&f.env, call(&f.env, &f.sim, symbol_short!("withdraw"), &f.client.address)];
    assert_eq!(passkey_check(&f, &a, withdraw), Err(Ok(AccError::NotAllowed)));
    let other = Address::generate(&f.env);
    let stranger = vec![&f.env, call(&f.env, &f.sim, symbol_short!("claim"), &other)];
    assert_eq!(passkey_check(&f, &a, stranger), Err(Ok(AccError::NotAllowed)));
    let me = f.client.address.clone();
    let on_self = vec![&f.env, call(&f.env, &me, Symbol::new(&f.env, "set_signer"), &me)];
    assert_eq!(passkey_check(&f, &a, on_self), Err(Ok(AccError::NotAllowed)));
}

#[test]
fn a_passkey_expires_like_any_delegate() {
    let f = setup();
    let a = first_real();
    register_passkey(&f, &a, "localhost", Some(200));
    f.env.ledger().set_sequence_number(200);
    assert_eq!(passkey_check(&f, &a, claim_ctx(&f)), Ok(()));
    f.env.ledger().set_sequence_number(201);
    assert_eq!(passkey_check(&f, &a, claim_ctx(&f)), Err(Ok(AccError::SignerExpired)));
}

#[test]
fn an_unregistered_passkey_is_refused() {
    let f = setup();
    assert_eq!(passkey_check(&f, &first_real(), claim_ctx(&f)), Err(Ok(AccError::UnknownSigner)));
}

#[test]
fn a_passkey_is_bound_to_its_relying_party() {
    let f = setup();
    let a = first_real();
    // Registered for another site: an assertion made for localhost must not authorize anything.
    register_passkey(&f, &a, "example.com", None);
    assert_eq!(passkey_check(&f, &a, claim_ctx(&f)), Err(Ok(AccError::RpMismatch)));
}

#[test]
fn an_assertion_is_for_one_payload_only() {
    let f = setup();
    let all = real_assertions();
    register_passkey(&f, &all[0], "localhost", None);
    // Another assertion's payload presented with this assertion's signature.
    let replay = Assertion { payload: all[1].payload, ..all[0].clone() };
    assert_eq!(passkey_check(&f, &replay, claim_ctx(&f)), Err(Ok(AccError::ChallengeMismatch)));
}

#[test]
fn user_presence_and_verification_are_required() {
    let f = setup();
    let a = first_real();
    register_passkey(&f, &a, "localhost", None);
    let flags = |mask: u8| {
        let mut data = a.authenticator_data.clone();
        data[32] &= !mask;
        Assertion { authenticator_data: data, ..a.clone() }
    };
    assert_eq!(passkey_check(&f, &flags(0x01), claim_ctx(&f)), Err(Ok(AccError::UserNotPresent)));
    assert_eq!(passkey_check(&f, &flags(0x04), claim_ctx(&f)), Err(Ok(AccError::UserNotVerified)));
    let short = Assertion { authenticator_data: a.authenticator_data[..36].to_vec(), ..a.clone() };
    assert_eq!(passkey_check(&f, &short, claim_ctx(&f)), Err(Ok(AccError::BadAuthenticatorData)));
    let long = Assertion { authenticator_data: std::vec![0u8; 513], ..a.clone() };
    assert_eq!(passkey_check(&f, &long, claim_ctx(&f)), Err(Ok(AccError::BadAuthenticatorData)));
}

#[test]
fn the_challenge_must_be_in_its_fixed_place_and_exact() {
    let f = setup();
    let a = first_real();
    register_passkey(&f, &a, "localhost", None);
    let challenge = std::string::String::from_utf8(a.client_data_json.clone())
        .unwrap()
        .split("\"challenge\":\"")
        .nth(1)
        .unwrap()
        .split('"')
        .next()
        .unwrap()
        .to_string();
    assert_eq!(challenge.len(), 43);
    let wrong = "A".repeat(43);

    // Fields in another order, so the real challenge is not where the contract looks.
    let reordered = with_client_data(&a, |_| std::format!("{{\"challenge\":\"{challenge}\",\"type\":\"webauthn.get\"}}"));
    assert_eq!(passkey_check(&f, &reordered, claim_ctx(&f)), Err(Ok(AccError::BadClientData)));

    // A look-alike: the real challenge appears, but later, behind a wrong one in the real position.
    let lookalike = with_client_data(&a, |_| {
        std::format!("{{\"type\":\"webauthn.get\",\"challenge\":\"{wrong}\",\"origin\":\"x\",\"challenge\":\"{challenge}\"}}")
    });
    assert_eq!(passkey_check(&f, &lookalike, claim_ctx(&f)), Err(Ok(AccError::ChallengeMismatch)));

    // A longer challenge that starts with the right one.
    let longer = with_client_data(&a, |_| std::format!("{{\"type\":\"webauthn.get\",\"challenge\":\"{challenge}A\",\"origin\":\"x\"}}"));
    assert_eq!(passkey_check(&f, &longer, claim_ctx(&f)), Err(Ok(AccError::ChallengeMismatch)));

    // A registration ceremony is not an assertion.
    let create = with_client_data(&a, |t| t.replace("webauthn.get", "webauthn.cret"));
    assert_eq!(passkey_check(&f, &create, claim_ctx(&f)), Err(Ok(AccError::BadClientData)));

    assert_eq!(passkey_check(&f, &Assertion { client_data_json: std::vec::Vec::new(), ..a.clone() }, claim_ctx(&f)), Err(Ok(AccError::BadClientData)));
    let huge = with_client_data(&a, |t| t + &" ".repeat(600));
    assert_eq!(passkey_check(&f, &huge, claim_ctx(&f)), Err(Ok(AccError::BadClientData)));
}

#[test]
fn any_change_to_the_signed_bytes_breaks_the_signature() {
    let f = setup();
    let a = first_real();
    register_passkey(&f, &a, "localhost", None);
    // The checks pass (challenge and flags intact) but the signature no longer matches, so it traps.
    let tampered = with_client_data(&a, |t| t.replace("localhost", "localhosx"));
    let result = passkey_check(&f, &tampered, claim_ctx(&f));
    assert!(result.is_err() && !matches!(result, Err(Ok(_))), "expected a signature trap, got {result:?}");
}

#[test]
fn a_high_s_signature_is_refused() {
    let f = setup();
    let a = first_real();
    register_passkey(&f, &a, "localhost", None);
    let fixture = webauthn_fixture();
    let mirrored = Assertion { sig: high_s(&b64(&fixture.assertions[0].signature)), ..a.clone() };
    assert!(passkey_check(&f, &mirrored, claim_ctx(&f)).is_err());
}

#[test]
fn another_key_cannot_sign_for_a_registered_passkey() {
    let f = setup();
    let a = first_real();
    register_passkey(&f, &a, "localhost", None);

    // An attacker builds a perfectly valid assertion with their own key, but presents the victim's public key.
    let attacker = P256Key::from_slice(&[9u8; 32]).unwrap();
    let rp = rp_hash(&f.env, "localhost").to_array();
    let mut auth = std::vec::Vec::from(rp);
    auth.extend([0x05, 0, 0, 0, 1]);
    let challenge = STANDARD.encode(a.payload).replace('+', "-").replace('/', "_").trim_end_matches('=').to_string();
    let client = std::format!("{{\"type\":\"webauthn.get\",\"challenge\":\"{challenge}\",\"origin\":\"http://localhost\"}}").into_bytes();
    let digest = {
        let mut signed = auth.clone();
        signed.extend(Sha256::digest(&client));
        Sha256::digest(&signed)
    };
    let sig: P256Signature = attacker.sign_prehash(&digest).unwrap();
    let forged = Assertion { authenticator_data: auth, client_data_json: client, sig: sig.normalize_s().unwrap_or(sig).to_bytes().into(), ..a };
    let result = passkey_check(&f, &forged, claim_ctx(&f));
    assert!(result.is_err() && !matches!(result, Err(Ok(_))), "expected a signature trap, got {result:?}");
}

#[test]
fn passkey_policy_admin() {
    let f = setup();
    let a = first_real();
    let key = BytesN::from_array(&f.env, &a.public_key);

    // Master-only.
    let rules = vec![&f.env, claim_rule(&f)];
    assert!(f.client.try_set_passkey(&key, &rp_hash(&f.env, "localhost"), &None, &rules).is_err());

    // A passkey cannot be registered through set_signer, which has no relying party to bind it to.
    f.env.mock_all_auths();
    assert_eq!(f.client.try_set_signer(&passkey_id(&f, &a), &None, &rules), Err(Ok(AccError::InvalidPolicy)));

    f.client.set_passkey(&key, &rp_hash(&f.env, "localhost"), &Some(500), &rules);
    let policy = f.client.get_signer(&passkey_id(&f, &a)).unwrap();
    assert_eq!(policy.rp_id_hash, Some(rp_hash(&f.env, "localhost")));
    assert_eq!(policy.valid_until_ledger, Some(500));
    assert_eq!(f.client.list_signers(), vec![&f.env, passkey_id(&f, &a)]);

    // Editing the rules or the expiry keeps the relying party binding.
    f.client.set_expiry(&passkey_id(&f, &a), &Some(900));
    f.client.add_rule(
        &passkey_id(&f, &a),
        &Rule { contract: f.sim.clone(), function: symbol_short!("ping"), args: Vec::new(&f.env) },
    );
    let edited = f.client.get_signer(&passkey_id(&f, &a)).unwrap();
    assert_eq!(edited.rp_id_hash, Some(rp_hash(&f.env, "localhost")));
    assert_eq!(edited.valid_until_ledger, Some(900));
    assert_eq!(edited.rules.len(), 2);

    // Rules on the account itself are refused here too, and a passkey can be revoked.
    let on_self = Rule { contract: f.client.address.clone(), function: symbol_short!("x"), args: Vec::new(&f.env) };
    assert_eq!(
        f.client.try_set_passkey(&key, &rp_hash(&f.env, "localhost"), &None, &vec![&f.env, on_self]),
        Err(Ok(AccError::InvalidPolicy))
    );
    f.client.revoke_signer(&passkey_id(&f, &a));
    assert_eq!(passkey_check(&f, &a, claim_ctx(&f)), Err(Ok(AccError::UnknownSigner)));
}

#[test]
fn an_ed25519_delegate_and_a_passkey_do_not_share_a_policy() {
    let f = setup();
    let a = first_real();
    allow_delegate_claim(&f);
    // The passkey is not registered, whatever the ed25519 delegate may do.
    assert_eq!(delegate_claims(&f), Ok(()));
    assert_eq!(passkey_check(&f, &a, claim_ctx(&f)), Err(Ok(AccError::UnknownSigner)));
}

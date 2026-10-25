extern crate std;

use ed25519_dalek::{Signer, SigningKey};
use soroban_sdk::{
    auth::{Context, ContractContext, CreateContractHostFnContext, ContractExecutable},
    symbol_short,
    testutils::Address as _,
    vec, Address, BytesN, Env, IntoVal, InvokeError, Symbol, Val, Vec,
};

use crate::{AccError, AccSignature, SmartAccount, SmartAccountClient};

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
    let master = key(1);
    let delegate = key(2);
    let id = env.register(SmartAccount, (pubkey(&env, &master),));
    let client = SmartAccountClient::new(&env, &id);
    let sim = Address::generate(&env);
    Fixture { env, client, master, delegate, sim }
}

/// Authorizes the delegate to call `claim` on the simulator for itself only.
fn allow_delegate_claim(f: &Fixture) {
    f.env.mock_all_auths();
    f.client
        .add_policy(&pubkey(&f.env, &f.delegate), &f.sim, &symbol_short!("claim"), &true);
}

fn call(env: &Env, contract: &Address, function: Symbol, first_arg: &Address) -> Context {
    let args: Vec<Val> = vec![env, first_arg.into_val(env)];
    Context::Contract(ContractContext {
        contract: contract.clone(),
        fn_name: function,
        args,
    })
}

fn check(
    f: &Fixture,
    signer: &SigningKey,
    contexts: Vec<Context>,
) -> Result<(), Result<AccError, InvokeError>> {
    let payload = BytesN::from_array(&f.env, &[7u8; 32]);
    let sig = AccSignature {
        signer: pubkey(&f.env, signer),
        sig: BytesN::from_array(&f.env, &signer.sign(&payload.to_array()).to_bytes()),
    };
    f.env.try_invoke_contract_check_auth::<AccError>(
        &f.client.address,
        &payload,
        sig.into_val(&f.env),
        &contexts,
    )
}

#[test]
fn master_authorizes_any_call() {
    let f = setup();
    let other = Address::generate(&f.env);
    let ctx = vec![&f.env, call(&f.env, &other, symbol_short!("withdraw"), &other)];
    assert_eq!(check(&f, &f.master, ctx), Ok(()));
}

#[test]
fn delegate_may_claim_for_the_account() {
    let f = setup();
    allow_delegate_claim(&f);
    let ctx = vec![&f.env, call(&f.env, &f.sim, symbol_short!("claim"), &f.client.address)];
    assert_eq!(check(&f, &f.delegate, ctx), Ok(()));
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
    let ctx = vec![&f.env, call(&f.env, &me, Symbol::new(&f.env, "add_policy"), &me)];
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
    assert_eq!(
        check(&f, &f.delegate, vec![&f.env, deploy]),
        Err(Ok(AccError::NotAllowed))
    );
}

#[test]
fn signer_without_policy_is_rejected() {
    let f = setup();
    let ctx = vec![&f.env, call(&f.env, &f.sim, symbol_short!("claim"), &f.client.address)];
    assert_eq!(check(&f, &f.delegate, ctx), Err(Ok(AccError::UnknownSigner)));
}

#[test]
fn emptied_policy_authorizes_nothing() {
    let f = setup();
    allow_delegate_claim(&f);
    f.client
        .remove_policy(&pubkey(&f.env, &f.delegate), &f.sim, &symbol_short!("claim"));
    let ctx = vec![&f.env, call(&f.env, &f.sim, symbol_short!("claim"), &f.client.address)];
    assert_eq!(check(&f, &f.delegate, ctx), Err(Ok(AccError::NotAllowed)));
}

#[test]
fn invalid_signature_is_rejected() {
    let f = setup();
    let payload = BytesN::from_array(&f.env, &[7u8; 32]);
    let forged = AccSignature {
        signer: pubkey(&f.env, &f.master),
        sig: BytesN::from_array(&f.env, &f.delegate.sign(&payload.to_array()).to_bytes()),
    };
    let ctx = vec![&f.env, call(&f.env, &f.sim, symbol_short!("claim"), &f.client.address)];
    let res = f.env.try_invoke_contract_check_auth::<AccError>(
        &f.client.address,
        &payload,
        forged.into_val(&f.env),
        &ctx,
    );
    assert!(res.is_err());
}

#[test]
fn delegate_signing_as_master_key_fails() {
    let f = setup();
    allow_delegate_claim(&f);
    let payload = BytesN::from_array(&f.env, &[7u8; 32]);
    let sig = AccSignature {
        signer: pubkey(&f.env, &f.delegate),
        sig: BytesN::from_array(&f.env, &f.master.sign(&payload.to_array()).to_bytes()),
    };
    let ctx = vec![&f.env, call(&f.env, &f.sim, symbol_short!("claim"), &f.client.address)];
    assert!(f
        .env
        .try_invoke_contract_check_auth::<AccError>(
            &f.client.address,
            &payload,
            sig.into_val(&f.env),
            &ctx,
        )
        .is_err());
}

#[test]
fn policy_changes_require_the_account_auth() {
    let f = setup();
    allow_delegate_claim(&f);
    let auths = f.env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, f.client.address);
}

#[test]
fn policy_changes_fail_without_auth() {
    let f = setup();
    let res = f
        .client
        .try_add_policy(&pubkey(&f.env, &f.delegate), &f.sim, &symbol_short!("claim"), &true);
    assert!(res.is_err());
}

#[test]
fn master_cannot_be_given_a_policy() {
    let f = setup();
    f.env.mock_all_auths();
    let res = f
        .client
        .try_add_policy(&pubkey(&f.env, &f.master), &f.sim, &symbol_short!("claim"), &true);
    assert_eq!(res, Err(Ok(AccError::InvalidPolicy)));
}

#[test]
fn adding_the_same_rule_twice_is_idempotent() {
    let f = setup();
    allow_delegate_claim(&f);
    allow_delegate_claim(&f);
    assert_eq!(f.client.get_policy(&pubkey(&f.env, &f.delegate)).len(), 1);
}

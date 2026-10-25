#![no_std]

use soroban_sdk::{
    auth::{Context, ContractContext, CustomAccountInterface},
    contract, contracterror, contractimpl, contracttype,
    crypto::Hash,
    Address, BytesN, Env, Symbol, TryFromVal, Vec,
};

// About 30 days of ledgers at ~5s each.
const TTL_THRESHOLD: u32 = 518_400;
const TTL_EXTEND_TO: u32 = 535_680;

#[contracttype]
enum DataKey {
    Master,
    Policy(BytesN<32>),
}

/// One permitted call for a delegate. When `self_arg` is set, the first call
/// argument must be this account's own address (e.g. `claim(user)` only for itself).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Rule {
    pub contract: Address,
    pub function: Symbol,
    pub self_arg: bool,
}

#[contracttype]
#[derive(Clone)]
pub struct AccSignature {
    pub signer: BytesN<32>,
    pub sig: BytesN<64>,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum AccError {
    NotInitialized = 1,
    UnknownSigner = 2,
    NotAllowed = 3,
    InvalidPolicy = 4,
}

#[contract]
pub struct SmartAccount;

#[contractimpl]
impl SmartAccount {
    /// `master` is the raw ed25519 public key of the default G-address signer.
    pub fn __constructor(env: Env, master: BytesN<32>) {
        env.storage().instance().set(&DataKey::Master, &master);
        Self::bump(&env);
    }

    pub fn master(env: Env) -> BytesN<32> {
        env.storage().instance().get(&DataKey::Master).unwrap()
    }

    /// Allow `signer` to call `function` on `contract`. Master-only: authorizing
    /// the account's own address is satisfied only by the master's signature.
    pub fn add_policy(
        env: Env,
        signer: BytesN<32>,
        contract: Address,
        function: Symbol,
        self_arg: bool,
    ) -> Result<(), AccError> {
        env.current_contract_address().require_auth();
        if signer == Self::master(env.clone()) || contract == env.current_contract_address() {
            return Err(AccError::InvalidPolicy);
        }
        let rule = Rule { contract, function, self_arg };
        let mut rules = Self::get_policy(env.clone(), signer.clone());
        if !rules.contains(&rule) {
            rules.push_back(rule);
        }
        env.storage().instance().set(&DataKey::Policy(signer), &rules);
        Self::bump(&env);
        Ok(())
    }

    pub fn remove_policy(env: Env, signer: BytesN<32>, contract: Address, function: Symbol) {
        env.current_contract_address().require_auth();
        let mut kept = Vec::new(&env);
        for rule in Self::get_policy(env.clone(), signer.clone()).iter() {
            if !(rule.contract == contract && rule.function == function) {
                kept.push_back(rule);
            }
        }
        env.storage().instance().set(&DataKey::Policy(signer), &kept);
    }

    pub fn get_policy(env: Env, signer: BytesN<32>) -> Vec<Rule> {
        env.storage()
            .instance()
            .get(&DataKey::Policy(signer))
            .unwrap_or_else(|| Vec::new(&env))
    }

    fn bump(env: &Env) {
        env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
    }
}

fn rule_allows(env: &Env, me: &Address, rule: &Rule, call: &ContractContext) -> bool {
    if rule.contract != call.contract || rule.function != call.fn_name {
        return false;
    }
    if !rule.self_arg {
        return true;
    }
    match call.args.get(0) {
        Some(first) => Address::try_from_val(env, &first).map_or(false, |a| a == *me),
        None => false,
    }
}

#[contractimpl]
impl CustomAccountInterface for SmartAccount {
    type Signature = AccSignature;
    type Error = AccError;

    #[allow(non_snake_case)]
    fn __check_auth(
        env: Env,
        signature_payload: Hash<32>,
        signature: AccSignature,
        auth_contexts: Vec<Context>,
    ) -> Result<(), AccError> {
        // Traps on an invalid signature.
        env.crypto().ed25519_verify(
            &signature.signer,
            &signature_payload.to_bytes().into(),
            &signature.sig,
        );

        let master: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::Master)
            .ok_or(AccError::NotInitialized)?;
        if signature.signer == master {
            return Ok(());
        }

        let rules: Vec<Rule> = env
            .storage()
            .instance()
            .get(&DataKey::Policy(signature.signer))
            .ok_or(AccError::UnknownSigner)?;
        let me = env.current_contract_address();

        // Every invocation in the authorized tree (root and sub-invocations)
        // must match a rule; anything else fails closed.
        for context in auth_contexts.iter() {
            let call = match context {
                Context::Contract(call) => call,
                _ => return Err(AccError::NotAllowed),
            };
            if call.contract == me {
                return Err(AccError::NotAllowed);
            }
            if !rules.iter().any(|rule| rule_allows(&env, &me, &rule, &call)) {
                return Err(AccError::NotAllowed);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod test;

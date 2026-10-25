#![no_std]

use soroban_sdk::{
    auth::{Context, ContractContext, CustomAccountInterface},
    contract, contracterror, contractimpl, contracttype,
    crypto::Hash,
    xdr::ToXdr,
    Address, Bytes, BytesN, Env, Symbol, TryFromVal, Vec,
};

// About 30 days of ledgers at ~5s each.
const TTL_THRESHOLD: u32 = 518_400;
const TTL_EXTEND_TO: u32 = 535_680;

// Bounds keep the work done in `__check_auth` small and predictable.
const MAX_RULES: u32 = 32;
const MAX_ARGS: u32 = 16;

#[contracttype]
enum DataKey {
    Master,
    Signers,
    Signer(SignerId),
}

/// Identifies a signer. More key types (for example passkeys) can be added as variants.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SignerId {
    Ed25519(BytesN<32>),
}

/// What a rule requires of one call argument.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ArgConstraint {
    /// Any value.
    Any,
    /// The argument must be this account's own address.
    SelfAddress,
    /// The argument must equal this XDR-encoded value.
    Exact(Bytes),
}

/// One permitted call. `args` has one constraint per call argument: a call with a
/// different number of arguments never matches.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Rule {
    pub contract: Address,
    pub function: Symbol,
    pub args: Vec<ArgConstraint>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignerPolicy {
    /// Last ledger (inclusive) in which this signer is accepted; `None` means no expiry.
    /// Separate from the host's per-signature `signatureExpirationLedger`.
    pub valid_until_ledger: Option<u32>,
    pub rules: Vec<Rule>,
}

#[contracttype]
#[derive(Clone)]
pub struct Ed25519Signature {
    pub signer: BytesN<32>,
    pub sig: BytesN<64>,
}

#[contracttype]
#[derive(Clone)]
pub enum AccSignature {
    /// A signature over the 32-byte authorization payload itself (what `signAuthEntry` produces).
    Ed25519(Ed25519Signature),
    /// A SEP-53 message signature, for wallets that cannot sign auth entries but can sign messages:
    /// the signed text is `"Stellar Signed Message:\nAuthorize <this account> payload <hex payload>"`.
    Message(Ed25519Signature),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum AccError {
    NotInitialized = 1,
    UnknownSigner = 2,
    NotAllowed = 3,
    InvalidPolicy = 4,
    SignerExpired = 5,
}

#[contract]
pub struct SmartAccount;

#[contractimpl]
impl SmartAccount {
    /// `master` is the raw ed25519 public key of the default G-address signer. The master
    /// never expires and is never subject to rules.
    pub fn __constructor(env: Env, master: BytesN<32>) {
        env.storage().instance().set(&DataKey::Master, &master);
        env.storage().instance().set(&DataKey::Signers, &Vec::<SignerId>::new(&env));
        Self::bump(&env);
    }

    pub fn master(env: Env) -> BytesN<32> {
        env.storage().instance().get(&DataKey::Master).unwrap()
    }

    // The admin functions below authorize the account's own address, which only the master can satisfy.

    /// Creates or replaces a signer's whole policy: its expiry and its rules.
    pub fn set_signer(
        env: Env,
        signer: SignerId,
        valid_until_ledger: Option<u32>,
        rules: Vec<Rule>,
    ) -> Result<(), AccError> {
        env.current_contract_address().require_auth();
        Self::ensure_not_master(&env, &signer)?;
        Self::validate_expiry(&env, valid_until_ledger)?;
        Self::validate_rules(&env, &rules)?;
        Self::store(&env, &signer, &SignerPolicy { valid_until_ledger, rules });
        Ok(())
    }

    pub fn add_rule(env: Env, signer: SignerId, rule: Rule) -> Result<(), AccError> {
        env.current_contract_address().require_auth();
        let mut policy = Self::policy_of(&env, &signer).ok_or(AccError::UnknownSigner)?;
        if !policy.rules.contains(&rule) {
            policy.rules.push_back(rule);
        }
        Self::validate_rules(&env, &policy.rules)?;
        Self::store(&env, &signer, &policy);
        Ok(())
    }

    /// Removes every rule for `function` on `contract`.
    pub fn remove_rule(env: Env, signer: SignerId, contract: Address, function: Symbol) -> Result<(), AccError> {
        env.current_contract_address().require_auth();
        let mut policy = Self::policy_of(&env, &signer).ok_or(AccError::UnknownSigner)?;
        let mut kept = Vec::new(&env);
        for rule in policy.rules.iter() {
            if !(rule.contract == contract && rule.function == function) {
                kept.push_back(rule);
            }
        }
        policy.rules = kept;
        Self::store(&env, &signer, &policy);
        Ok(())
    }

    /// Sets, extends or removes (`None`) a signer's expiry.
    pub fn set_expiry(env: Env, signer: SignerId, valid_until_ledger: Option<u32>) -> Result<(), AccError> {
        env.current_contract_address().require_auth();
        Self::validate_expiry(&env, valid_until_ledger)?;
        let mut policy = Self::policy_of(&env, &signer).ok_or(AccError::UnknownSigner)?;
        policy.valid_until_ledger = valid_until_ledger;
        Self::store(&env, &signer, &policy);
        Ok(())
    }

    pub fn revoke_signer(env: Env, signer: SignerId) -> Result<(), AccError> {
        env.current_contract_address().require_auth();
        if Self::policy_of(&env, &signer).is_none() {
            return Err(AccError::UnknownSigner);
        }
        env.storage().instance().remove(&DataKey::Signer(signer.clone()));
        let mut kept = Vec::new(&env);
        for id in Self::list_signers(env.clone()).iter() {
            if id != signer {
                kept.push_back(id);
            }
        }
        env.storage().instance().set(&DataKey::Signers, &kept);
        Ok(())
    }

    pub fn get_signer(env: Env, signer: SignerId) -> Option<SignerPolicy> {
        Self::policy_of(&env, &signer)
    }

    pub fn list_signers(env: Env) -> Vec<SignerId> {
        env.storage()
            .instance()
            .get(&DataKey::Signers)
            .unwrap_or_else(|| Vec::new(&env))
    }

    fn policy_of(env: &Env, signer: &SignerId) -> Option<SignerPolicy> {
        env.storage().instance().get(&DataKey::Signer(signer.clone()))
    }

    fn store(env: &Env, signer: &SignerId, policy: &SignerPolicy) {
        env.storage().instance().set(&DataKey::Signer(signer.clone()), policy);
        let mut signers = Self::list_signers(env.clone());
        if !signers.contains(signer) {
            signers.push_back(signer.clone());
            env.storage().instance().set(&DataKey::Signers, &signers);
        }
        Self::bump(env);
    }

    fn ensure_not_master(env: &Env, signer: &SignerId) -> Result<(), AccError> {
        let SignerId::Ed25519(key) = signer;
        if *key == Self::master(env.clone()) {
            return Err(AccError::InvalidPolicy);
        }
        Ok(())
    }

    fn validate_expiry(env: &Env, valid_until_ledger: Option<u32>) -> Result<(), AccError> {
        match valid_until_ledger {
            Some(ledger) if ledger <= env.ledger().sequence() => Err(AccError::InvalidPolicy),
            _ => Ok(()),
        }
    }

    fn validate_rules(env: &Env, rules: &Vec<Rule>) -> Result<(), AccError> {
        if rules.len() > MAX_RULES {
            return Err(AccError::InvalidPolicy);
        }
        let me = env.current_contract_address();
        for rule in rules.iter() {
            // A delegate must never be able to authorize calls on the account itself.
            if rule.contract == me || rule.args.len() > MAX_ARGS {
                return Err(AccError::InvalidPolicy);
            }
        }
        Ok(())
    }

    fn bump(env: &Env) {
        env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
    }
}

// The exact SEP-53 text a wallet signs for a payload. It deliberately contains spaces: some wallets
// treat a message as base64 when it looks like base64, and spaces keep it plain text everywhere.
const MESSAGE_PREFIX: &[u8] = b"Stellar Signed Message:\nAuthorize ";
const MESSAGE_MIDDLE: &[u8] = b" payload ";
const ACCOUNT_LEN: usize = 56;
const MESSAGE_LEN: usize = 34 + ACCOUNT_LEN + 9 + 64;

/// SHA-256 of the SEP-53 message that authorizes `payload` on this account.
fn message_digest(env: &Env, payload: &BytesN<32>) -> BytesN<32> {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut text = [0u8; MESSAGE_LEN];
    let mut at = 0;
    text[at..at + MESSAGE_PREFIX.len()].copy_from_slice(MESSAGE_PREFIX);
    at += MESSAGE_PREFIX.len();

    let account = env.current_contract_address().to_string();
    // A contract address is always 56 characters; anything else cannot be authorized.
    if account.len() as usize != ACCOUNT_LEN {
        panic!("unexpected account address length");
    }
    account.copy_into_slice(&mut text[at..at + ACCOUNT_LEN]);
    at += ACCOUNT_LEN;

    text[at..at + MESSAGE_MIDDLE.len()].copy_from_slice(MESSAGE_MIDDLE);
    at += MESSAGE_MIDDLE.len();
    for byte in payload.to_array() {
        text[at] = HEX[(byte >> 4) as usize];
        text[at + 1] = HEX[(byte & 15) as usize];
        at += 2;
    }
    env.crypto().sha256(&Bytes::from_slice(env, &text)).to_bytes()
}

fn rule_allows(env: &Env, me: &Address, rule: &Rule, call: &ContractContext) -> bool {
    if rule.contract != call.contract || rule.function != call.fn_name || rule.args.len() != call.args.len() {
        return false;
    }
    for (constraint, arg) in rule.args.iter().zip(call.args.iter()) {
        let satisfied = match constraint {
            ArgConstraint::Any => true,
            ArgConstraint::SelfAddress => Address::try_from_val(env, &arg).map_or(false, |a| a == *me),
            ArgConstraint::Exact(expected) => arg.to_xdr(env) == expected,
        };
        if !satisfied {
            return false;
        }
    }
    true
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
        let signature = match signature {
            AccSignature::Ed25519(signature) => {
                env.crypto().ed25519_verify(
                    &signature.signer,
                    &signature_payload.to_bytes().into(),
                    &signature.sig,
                );
                signature
            }
            AccSignature::Message(signature) => {
                let digest = message_digest(&env, &signature_payload.to_bytes());
                env.crypto().ed25519_verify(&signature.signer, &digest.into(), &signature.sig);
                signature
            }
        };

        let master: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::Master)
            .ok_or(AccError::NotInitialized)?;
        if signature.signer == master {
            return Ok(());
        }

        let policy = Self::policy_of(&env, &SignerId::Ed25519(signature.signer)).ok_or(AccError::UnknownSigner)?;
        if let Some(last_valid_ledger) = policy.valid_until_ledger {
            if env.ledger().sequence() > last_valid_ledger {
                return Err(AccError::SignerExpired);
            }
        }
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
            if !policy.rules.iter().any(|rule| rule_allows(&env, &me, &rule, &call)) {
                return Err(AccError::NotAllowed);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod test;

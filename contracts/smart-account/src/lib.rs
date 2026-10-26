#![no_std]

use soroban_sdk::{
    auth::{Context, ContractContext, CustomAccountInterface},
    contract, contracterror, contractimpl, contracttype,
    crypto::Hash,
    xdr::ToXdr,
    Address, Bytes, BytesN, Env, Symbol, TryFromVal, Val, Vec,
};

// About 30 days of ledgers at ~5s each.
const TTL_THRESHOLD: u32 = 518_400;
const TTL_EXTEND_TO: u32 = 535_680;

// Bounds keep the work done in `__check_auth` small and predictable.
const MAX_RULES: u32 = 32;
const MAX_ARGS: u32 = 16;

/// What this contract supports, so a client can tell an older account from this one (older ones have no
/// `version` function at all). 3 adds the `LessThan` argument constraint.
const CONTRACT_VERSION: u32 = 3;

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
    /// A WebAuthn passkey: the uncompressed secp256r1 public key (0x04 || x || y).
    Passkey(BytesN<65>),
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
    /// The argument must be an integer (of any integer type) strictly less than this value.
    /// Arguments of any other type never match. It sets no lower bound, so negative values match.
    LessThan(i128),
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
    /// SHA-256 of the WebAuthn relying party id this passkey is bound to; always set for passkeys.
    pub rp_id_hash: Option<BytesN<32>>,
    pub rules: Vec<Rule>,
}

#[contracttype]
#[derive(Clone)]
pub struct Ed25519Signature {
    pub signer: BytesN<32>,
    pub sig: BytesN<64>,
}

/// A WebAuthn assertion: what `navigator.credentials.get` returns, with the signature as 64-byte
/// `r || s` in low-S form (the host rejects high-S).
#[contracttype]
#[derive(Clone)]
pub struct PasskeySignature {
    pub public_key: BytesN<65>,
    pub authenticator_data: Bytes,
    pub client_data_json: Bytes,
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
    /// A passkey assertion over the authorization payload, for a delegate registered with `set_passkey`.
    Passkey(PasskeySignature),
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
    BadAuthenticatorData = 6,
    RpMismatch = 7,
    UserNotPresent = 8,
    UserNotVerified = 9,
    BadClientData = 10,
    ChallengeMismatch = 11,
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

    pub fn version(_env: Env) -> u32 {
        CONTRACT_VERSION
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
        // A passkey must be bound to a relying party, which only `set_passkey` records.
        if matches!(signer, SignerId::Passkey(_)) {
            return Err(AccError::InvalidPolicy);
        }
        Self::ensure_not_master(&env, &signer)?;
        Self::validate_expiry(&env, valid_until_ledger)?;
        Self::validate_rules(&env, &rules)?;
        Self::store(&env, &signer, &SignerPolicy { valid_until_ledger, rp_id_hash: None, rules });
        Ok(())
    }

    /// Creates or replaces a passkey delegate: its public key, the relying party it is bound to
    /// (sha256 of the rp id, e.g. "localhost"), its expiry and its rules. Master-only.
    pub fn set_passkey(
        env: Env,
        public_key: BytesN<65>,
        rp_id_hash: BytesN<32>,
        valid_until_ledger: Option<u32>,
        rules: Vec<Rule>,
    ) -> Result<(), AccError> {
        env.current_contract_address().require_auth();
        Self::validate_expiry(&env, valid_until_ledger)?;
        Self::validate_rules(&env, &rules)?;
        let policy = SignerPolicy { valid_until_ledger, rp_id_hash: Some(rp_id_hash), rules };
        Self::store(&env, &SignerId::Passkey(public_key), &policy);
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
        // The master is an ed25519 key; a passkey can never be it.
        if let SignerId::Ed25519(key) = signer {
            if *key == Self::master(env.clone()) {
                return Err(AccError::InvalidPolicy);
            }
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

// ---- WebAuthn assertion checks ----

const MAX_AUTHENTICATOR_DATA: u32 = 512;
const MAX_CLIENT_DATA: usize = 512;
const AUTH_DATA_MIN: u32 = 37;
const FLAG_USER_PRESENT: u8 = 0x01;
const FLAG_USER_VERIFIED: u8 = 0x04;
// The WebAuthn spec fixes the serialization of clientDataJSON: `type` first, then `challenge`.
const CLIENT_DATA_HEAD: &[u8] = b"{\"type\":\"webauthn.get\",\"challenge\":\"";
const CHALLENGE_LEN: usize = 43;

const B64URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Unpadded base64url of 32 bytes (43 characters).
fn base64url_32(input: &[u8; 32]) -> [u8; CHALLENGE_LEN] {
    let mut out = [0u8; CHALLENGE_LEN];
    let mut at = 0;
    for chunk in input.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        let chars = match chunk.len() {
            3 => 4,
            2 => 3,
            _ => 2,
        };
        for i in 0..chars {
            out[at] = B64URL[((n >> (18 - 6 * i)) & 63) as usize];
            at += 1;
        }
    }
    out
}

/// Checks a WebAuthn assertion against the passkey's relying party and the payload being authorized,
/// then verifies its signature. Traps on an invalid or high-S signature.
fn verify_passkey(env: &Env, rp_id_hash: &BytesN<32>, payload: &BytesN<32>, sig: &PasskeySignature) -> Result<(), AccError> {
    let auth = &sig.authenticator_data;
    if auth.len() < AUTH_DATA_MIN || auth.len() > MAX_AUTHENTICATOR_DATA {
        return Err(AccError::BadAuthenticatorData);
    }
    let mut rp = [0u8; 32];
    auth.slice(0..32).copy_into_slice(&mut rp);
    if rp != rp_id_hash.to_array() {
        return Err(AccError::RpMismatch);
    }
    let flags = auth.get(32).unwrap();
    if flags & FLAG_USER_PRESENT == 0 {
        return Err(AccError::UserNotPresent);
    }
    if flags & FLAG_USER_VERIFIED == 0 {
        return Err(AccError::UserNotVerified);
    }

    let len = sig.client_data_json.len() as usize;
    if len < CLIENT_DATA_HEAD.len() + CHALLENGE_LEN + 1 || len > MAX_CLIENT_DATA {
        return Err(AccError::BadClientData);
    }
    let mut json = [0u8; MAX_CLIENT_DATA];
    sig.client_data_json.copy_into_slice(&mut json[..len]);
    // The challenge must be right after the type, so no other field can carry a look-alike.
    let head = CLIENT_DATA_HEAD.len();
    if json[..head] != *CLIENT_DATA_HEAD {
        return Err(AccError::BadClientData);
    }
    if json[head..head + CHALLENGE_LEN] != base64url_32(&payload.to_array()) || json[head + CHALLENGE_LEN] != b'"' {
        return Err(AccError::ChallengeMismatch);
    }

    let client_hash = env.crypto().sha256(&sig.client_data_json);
    let mut signed = sig.authenticator_data.clone();
    signed.append(&Bytes::from(client_hash.to_bytes()));
    let digest = env.crypto().sha256(&signed);
    env.crypto().secp256r1_verify(&sig.public_key, &digest, &sig.sig);
    Ok(())
}

/// A call argument of any integer type as an `i128`; `None` for other types, and for a `u128` too big to fit.
fn integer_arg(env: &Env, arg: &Val) -> Option<i128> {
    if let Ok(value) = i128::try_from_val(env, arg) {
        return Some(value);
    }
    if let Ok(value) = u128::try_from_val(env, arg) {
        return i128::try_from(value).ok();
    }
    if let Ok(value) = i64::try_from_val(env, arg) {
        return Some(value.into());
    }
    if let Ok(value) = u64::try_from_val(env, arg) {
        return Some(value.into());
    }
    if let Ok(value) = i32::try_from_val(env, arg) {
        return Some(value.into());
    }
    u32::try_from_val(env, arg).ok().map(Into::into)
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
            ArgConstraint::LessThan(limit) => integer_arg(env, &arg).map_or(false, |value| value < limit),
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
        // Authenticate first; each arm yields who signed. Invalid signatures trap.
        let signer = match signature {
            AccSignature::Ed25519(signature) => {
                env.crypto().ed25519_verify(&signature.signer, &signature_payload.to_bytes().into(), &signature.sig);
                signature.signer
            }
            AccSignature::Message(signature) => {
                let digest = message_digest(&env, &signature_payload.to_bytes());
                env.crypto().ed25519_verify(&signature.signer, &digest.into(), &signature.sig);
                signature.signer
            }
            AccSignature::Passkey(signature) => {
                // A passkey is only ever a delegate: its policy says which relying party it belongs to.
                let id = SignerId::Passkey(signature.public_key.clone());
                let policy = Self::policy_of(&env, &id).ok_or(AccError::UnknownSigner)?;
                let rp_id_hash = policy.rp_id_hash.clone().ok_or(AccError::InvalidPolicy)?;
                verify_passkey(&env, &rp_id_hash, &signature_payload.to_bytes(), &signature)?;
                return Self::authorize(&env, policy, auth_contexts);
            }
        };

        let master: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::Master)
            .ok_or(AccError::NotInitialized)?;
        if signer == master {
            return Ok(());
        }
        let policy = Self::policy_of(&env, &SignerId::Ed25519(signer)).ok_or(AccError::UnknownSigner)?;
        Self::authorize(&env, policy, auth_contexts)
    }
}

impl SmartAccount {
    /// A delegate's policy: not expired, and every invocation in the authorized tree (root and
    /// sub-invocations) matches one of its rules. Anything else fails closed.
    fn authorize(env: &Env, policy: SignerPolicy, auth_contexts: Vec<Context>) -> Result<(), AccError> {
        if let Some(last_valid_ledger) = policy.valid_until_ledger {
            if env.ledger().sequence() > last_valid_ledger {
                return Err(AccError::SignerExpired);
            }
        }
        let me = env.current_contract_address();
        for context in auth_contexts.iter() {
            let call = match context {
                Context::Contract(call) => call,
                _ => return Err(AccError::NotAllowed),
            };
            if call.contract == me {
                return Err(AccError::NotAllowed);
            }
            if !policy.rules.iter().any(|rule| rule_allows(env, &me, &rule, &call)) {
                return Err(AccError::NotAllowed);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod test;

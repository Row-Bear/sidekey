#![no_std]

//! WP0 spike: verifying a WebAuthn (passkey) assertion inside a Soroban contract.
//!
//! The account's `__check_auth` receives a 32-byte `signature_payload`. A passkey signs
//! `authenticatorData || sha256(clientDataJSON)` where `clientDataJSON` contains the payload as its
//! base64url `challenge`. This contract does the same checks the real account will need, so the
//! tests can measure that they work on real browser output and what they cost.

use soroban_sdk::{contract, contracterror, contractimpl, Bytes, BytesN, Env};

/// Largest `clientDataJSON` accepted; real browsers produce about 120 bytes.
const MAX_CLIENT_DATA: usize = 512;
const AUTH_DATA_MIN: u32 = 37;
const FLAG_USER_PRESENT: u8 = 0x01;
const FLAG_USER_VERIFIED: u8 = 0x04;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum PasskeyError {
    BadAuthenticatorData = 1,
    RpMismatch = 2,
    UserNotPresent = 3,
    UserNotVerified = 4,
    BadClientData = 5,
    ChallengeMismatch = 6,
}

const B64URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Unpadded base64url of 32 bytes (43 characters).
fn base64url_32(input: &[u8; 32]) -> [u8; 43] {
    let mut out = [0u8; 43];
    let mut at = 0;
    for chunk in input.chunks(3) {
        let n = (chunk[0] as u32) << 16
            | (*chunk.get(1).unwrap_or(&0) as u32) << 8
            | *chunk.get(2).unwrap_or(&0) as u32;
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

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|window| window == needle)
}

/// Everything except the signature: binds the assertion to this rp, requires user presence and
/// verification, and requires the challenge to be exactly `payload`.
fn check_assertion(
    rp_id_hash: &BytesN<32>,
    payload: &BytesN<32>,
    authenticator_data: &Bytes,
    client_data_json: &Bytes,
) -> Result<(), PasskeyError> {
    if authenticator_data.len() < AUTH_DATA_MIN {
        return Err(PasskeyError::BadAuthenticatorData);
    }
    let mut rp = [0u8; 32];
    authenticator_data.slice(0..32).copy_into_slice(&mut rp);
    if rp != rp_id_hash.to_array() {
        return Err(PasskeyError::RpMismatch);
    }
    let flags = authenticator_data.get(32).unwrap();
    if flags & FLAG_USER_PRESENT == 0 {
        return Err(PasskeyError::UserNotPresent);
    }
    if flags & FLAG_USER_VERIFIED == 0 {
        return Err(PasskeyError::UserNotVerified);
    }

    let len = client_data_json.len() as usize;
    if len == 0 || len > MAX_CLIENT_DATA {
        return Err(PasskeyError::BadClientData);
    }
    let mut json = [0u8; MAX_CLIENT_DATA];
    client_data_json.copy_into_slice(&mut json[..len]);
    let json = &json[..len];
    if !contains(json, b"\"type\":\"webauthn.get\"") {
        return Err(PasskeyError::BadClientData);
    }

    // `"challenge":"<43 characters>"`
    let mut needle = [0u8; 13 + 43 + 1];
    needle[..13].copy_from_slice(b"\"challenge\":\"");
    needle[13..56].copy_from_slice(&base64url_32(&payload.to_array()));
    needle[56] = b'"';
    if !contains(json, &needle) {
        return Err(PasskeyError::ChallengeMismatch);
    }
    Ok(())
}

#[contract]
pub struct PasskeyVerifier;

#[contractimpl]
impl PasskeyVerifier {
    /// The complete check: assertion checks, then the secp256r1 signature over
    /// `sha256(authenticatorData || sha256(clientDataJSON))`. Traps if the signature is invalid.
    pub fn verify(
        env: Env,
        public_key: BytesN<65>,
        rp_id_hash: BytesN<32>,
        payload: BytesN<32>,
        authenticator_data: Bytes,
        client_data_json: Bytes,
        signature: BytesN<64>,
    ) -> Result<(), PasskeyError> {
        check_assertion(&rp_id_hash, &payload, &authenticator_data, &client_data_json)?;

        let client_data_hash = env.crypto().sha256(&client_data_json);
        let mut signed = authenticator_data;
        signed.append(&Bytes::from(client_data_hash.to_bytes()));
        let digest = env.crypto().sha256(&signed);
        env.crypto().secp256r1_verify(&public_key, &digest, &signature);
        Ok(())
    }

    /// Cost baseline: hashing plus the secp256r1 host call only.
    pub fn crypto_only(env: Env, public_key: BytesN<65>, message: Bytes, signature: BytesN<64>) {
        let digest = env.crypto().sha256(&message);
        env.crypto().secp256r1_verify(&public_key, &digest, &signature);
    }

    /// Cost baseline: the ed25519 check the account does today.
    pub fn ed25519_only(env: Env, public_key: BytesN<32>, message: Bytes, signature: BytesN<64>) {
        env.crypto().ed25519_verify(&public_key, &message, &signature);
    }
}

#[cfg(test)]
mod test;

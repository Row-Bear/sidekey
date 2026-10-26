#![no_std]

use soroban_sdk::{
    address_payload::AddressPayload, contract, contractimpl, contracttype, xdr::ToXdr, Address, Bytes, BytesN, ContractExecutable, Env,
};

const TTL_THRESHOLD: u32 = 518_400;
const TTL_EXTEND_TO: u32 = 535_680;

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    WasmHash,
}

/// Deploys smart accounts for G addresses. Whoever holds the master key signs one invocation of `create`, so no
/// deploy tooling (and no fee payer that holds a secret) is needed on the client.
///
/// The account's address depends only on the master and an index, so it can be computed before it exists and found
/// again later from the master alone.
#[contract]
pub struct Factory;

#[contractimpl]
impl Factory {
    /// `wasm_hash` is the hash of the uploaded smart-account WASM that new accounts are made from.
    pub fn __constructor(env: Env, admin: Address, wasm_hash: BytesN<32>) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::WasmHash, &wasm_hash);
        Self::bump(&env);
    }

    pub fn wasm_hash(env: Env) -> BytesN<32> {
        env.storage().instance().get(&DataKey::WasmHash).unwrap()
    }

    /// Points new accounts at another version of the smart-account WASM. Existing accounts are not touched.
    pub fn set_wasm_hash(env: Env, wasm_hash: BytesN<32>) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        env.storage().instance().set(&DataKey::WasmHash, &wasm_hash);
        Self::bump(&env);
    }

    /// Where the master's `index`-th account is (or will be) deployed.
    pub fn account_address(env: Env, master: Address, index: u32) -> Address {
        env.deployer().with_current_contract(Self::salt(&env, &master, index)).deployed_address()
    }

    /// Deploys the master's `index`-th smart account with `master` as its default signer. Only the master can ask
    /// for it, so nobody can take an address on someone else's behalf.
    pub fn create(env: Env, master: Address, index: u32) -> Address {
        master.require_auth();
        let raw = match AddressPayload::from_address(&master) {
            Some(AddressPayload::AccountIdPublicKeyEd25519(key)) => key,
            _ => panic!("the master must be a G address"),
        };
        let wasm_hash: BytesN<32> = env.storage().instance().get(&DataKey::WasmHash).unwrap();
        let address = env
            .deployer()
            .with_current_contract(Self::salt(&env, &master, index))
            .deploy_contract(ContractExecutable::Wasm(wasm_hash), (raw,));
        Self::bump(&env);
        address
    }
}

impl Factory {
    fn salt(env: &Env, master: &Address, index: u32) -> BytesN<32> {
        let mut bytes: Bytes = master.clone().to_xdr(env);
        bytes.extend_from_array(&index.to_be_bytes());
        env.crypto().sha256(&bytes).into()
    }

    fn bump(env: &Env) {
        env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
    }
}

#[cfg(test)]
mod test {
    use super::*;

    // The smart-account WASM is built by `stellar contract build`; the test only runs when it exists.
    const WASM: &[u8] = include_bytes!("../../../target/wasm32v1-none/release/smart_account.wasm");

    fn setup() -> (Env, FactoryClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let hash = env.deployer().upload_contract_wasm(WASM);
        let id = env.register(Factory, (g_address(&env, 99), hash));
        (env.clone(), FactoryClient::new(&env, &id))
    }

    fn g_address(env: &Env, seed: u8) -> Address {
        AddressPayload::AccountIdPublicKeyEd25519(BytesN::from_array(env, &[seed; 32])).to_address(env)
    }

    #[test]
    fn creates_the_account_at_the_predicted_address() {
        let (env, factory) = setup();
        let master = g_address(&env, 7);
        let predicted = factory.account_address(&master, &0);
        assert_eq!(factory.create(&master, &0), predicted);
        // The new account has the master as its default signer.
        let raw = BytesN::from_array(&env, &[7; 32]);
        let master_of: BytesN<32> = env.invoke_contract(&predicted, &soroban_sdk::symbol_short!("master"), soroban_sdk::vec![&env]);
        assert_eq!(master_of, raw);
    }

    #[test]
    fn accounts_differ_by_master_and_index() {
        let (env, factory) = setup();
        let a = g_address(&env, 1);
        let b = g_address(&env, 2);
        assert_ne!(factory.account_address(&a, &0), factory.account_address(&b, &0));
        assert_ne!(factory.account_address(&a, &0), factory.account_address(&a, &1));
        assert_eq!(factory.account_address(&a, &1), factory.account_address(&a, &1));
    }

    #[test]
    #[should_panic(expected = "G address")]
    fn the_master_must_be_a_g_address() {
        let (_env, factory) = setup();
        factory.create(&factory.address, &0);
    }
}

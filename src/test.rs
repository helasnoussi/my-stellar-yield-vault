#![cfg(test)]
extern crate std;

use super::*;
use crate::blend::{Positions, Reserve, ReserveConfig, ReserveData};
use soroban_sdk::{
    contract, contractimpl,
    testutils::{storage::Persistent as _, Address as _, Events as _, MockAuth, MockAuthInvoke},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, Event, IntoVal, Map, Vec,
};

// ---------- Faux pool Blend ----------
// Reproduit la conversion b_tokens <-> actif de Blend v2 et ses contrôles d'auth.

#[contracttype]
enum MockKey {
    Token,
    BRate,
    Supply(Address),
}

#[contract]
struct MockPool;

#[contractimpl]
impl MockPool {
    pub fn __constructor(env: Env, token: Address) {
        env.storage().instance().set(&MockKey::Token, &token);
        env.storage().instance().set(&MockKey::BRate, &SCALAR_12);
    }

    // Simule l'accumulation d'intérêts
    pub fn set_b_rate(env: Env, b_rate: i128) {
        env.storage().instance().set(&MockKey::BRate, &b_rate);
    }

    pub fn get_reserve(env: Env, asset: Address) -> Reserve {
        Reserve {
            asset,
            config: ReserveConfig {
                c_factor: 0,
                decimals: 7,
                enabled: true,
                index: 0,
                l_factor: 0,
                max_util: 9_500_000,
                r_base: 0,
                r_one: 0,
                r_three: 0,
                r_two: 0,
                reactivity: 0,
                supply_cap: i128::MAX,
                util: 5_000_000,
            },
            data: ReserveData {
                b_rate: Self::b_rate(&env),
                b_supply: 0,
                backstop_credit: 0,
                d_rate: SCALAR_12,
                d_supply: 0,
                ir_mod: 10_000_000,
                last_time: 0,
            },
            scalar: 10_000_000,
        }
    }

    pub fn get_positions(env: Env, address: Address) -> Positions {
        let mut supply = Map::new(&env);
        let b_tokens = Self::supply(&env, &address);
        if b_tokens > 0 {
            supply.set(0, b_tokens);
        }
        Positions { collateral: Map::new(&env), liabilities: Map::new(&env), supply }
    }

    pub fn submit(
        env: Env,
        from: Address,
        spender: Address,
        to: Address,
        requests: Vec<Request>,
    ) -> Positions {
        from.require_auth();
        if spender != from {
            spender.require_auth();
        }
        let token: Address = env.storage().instance().get(&MockKey::Token).unwrap();
        let token_client = TokenClient::new(&env, &token);
        let b_rate = Self::b_rate(&env);
        let key = MockKey::Supply(from.clone());

        for request in requests.iter() {
            let held = Self::supply(&env, &from);
            match request.request_type {
                REQUEST_SUPPLY => {
                    token_client.transfer(&spender, &env.current_contract_address(), &request.amount);
                    let minted = request.amount * SCALAR_12 / b_rate;
                    env.storage().persistent().set(&key, &(held + minted));
                }
                REQUEST_WITHDRAW => {
                    let mut to_burn = (request.amount * SCALAR_12 + b_rate - 1) / b_rate;
                    let mut out = request.amount;
                    if to_burn > held {
                        to_burn = held;
                        out = held * b_rate / SCALAR_12;
                    }
                    env.storage().persistent().set(&key, &(held - to_burn));
                    token_client.transfer(&env.current_contract_address(), &to, &out);
                }
                _ => panic!("unsupported request"),
            }
        }
        Self::get_positions(env, from)
    }

    fn b_rate(env: &Env) -> i128 {
        env.storage().instance().get(&MockKey::BRate).unwrap()
    }

    fn supply(env: &Env, address: &Address) -> i128 {
        env.storage().persistent().get(&MockKey::Supply(address.clone())).unwrap_or(0)
    }
}

// ---------- Mise en place ----------

struct Setup {
    env: Env,
    vault: YieldVaultClient<'static>,
    token: TokenClient<'static>,
    token_admin: StellarAssetClient<'static>,
    pool: MockPoolClient<'static>,
    agent: Address,
    user: Address,
}

fn setup() -> Setup {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let agent = Address::generate(&env);

    let token_id = env.register_stellar_asset_contract_v2(admin.clone()).address();
    let token_admin = StellarAssetClient::new(&env, &token_id);
    token_admin.mint(&user, &5_000_000_000);
    let token = TokenClient::new(&env, &token_id);

    let vault_id = env.register(YieldVault, (&admin, &token_id));
    let vault = YieldVaultClient::new(&env, &vault_id);

    let pool_id = env.register(MockPool, (&token_id,));
    let pool = MockPoolClient::new(&env, &pool_id);

    vault.set_agent(&agent);
    vault.add_pool(&1, &pool_id);

    Setup { env, vault, token, token_admin, pool, agent, user }
}

// ---------- Dépôts et retraits ----------

#[test]
fn deposit_and_withdraw() {
    let s = setup();

    s.vault.deposit(&s.user, &300_000_000);
    assert_eq!(s.vault.shares_of(&s.user), 300_000_000);
    assert_eq!(s.token.balance(&s.vault.address), 300_000_000);

    s.vault.withdraw(&s.user, &100_000_000);
    assert_eq!(s.vault.shares_of(&s.user), 200_000_000);
    assert_eq!(s.token.balance(&s.vault.address), 200_000_000);
    assert_eq!(s.token.balance(&s.user), 4_800_000_000);
}

#[test]
fn deposit_emits_event() {
    let s = setup();
    s.vault.deposit(&s.user, &100_000_000);

    let expected = Deposit { from: s.user.clone(), amount: 100_000_000 };
    let last = s.env.events().all().events().last().unwrap().clone();
    assert_eq!(last, expected.to_xdr(&s.env, &s.vault.address));
}

#[test]
#[should_panic(expected = "Insufficient shares")]
fn withdraw_more_than_shares_panics() {
    let s = setup();
    s.vault.deposit(&s.user, &100_000_000);
    s.vault.withdraw(&s.user, &100_000_001);
}

#[test]
#[should_panic(expected = "exceeds 100 XLM limit")]
fn deposit_over_cap_panics() {
    let s = setup();
    s.vault.deposit(&s.user, &(MAX_OPERATION_STROOPS + 1));
}

#[test]
#[should_panic(expected = "must be positive")]
fn deposit_zero_panics() {
    let s = setup();
    s.vault.deposit(&s.user, &0);
}

#[test]
fn deposit_extends_user_share_ttl() {
    let s = setup();
    s.vault.deposit(&s.user, &100_000_000);
    let ttl = s.env.as_contract(&s.vault.address, || {
        s.env.storage().persistent().get_ttl(&DataKey::UserShare(s.user.clone()))
    });
    assert!(ttl >= TTL_EXTEND_TO - 1);
}

// ---------- Allocation vers Blend ----------

#[test]
fn allocate_and_deallocate() {
    let s = setup();
    s.vault.deposit(&s.user, &500_000_000);

    s.vault.allocate(&1, &300_000_000);
    assert_eq!(s.token.balance(&s.vault.address), 200_000_000);
    assert_eq!(s.token.balance(&s.pool.address), 300_000_000);
    assert_eq!(s.vault.pool_assets(&1), 300_000_000);
    assert_eq!(s.vault.total_assets(), 500_000_000);

    s.vault.deallocate(&1, &100_000_000);
    assert_eq!(s.token.balance(&s.vault.address), 300_000_000);
    assert_eq!(s.vault.pool_assets(&1), 200_000_000);
}

#[test]
fn allocate_authorizes_nested_transfer() {
    let s = setup();
    s.vault.deposit(&s.user, &500_000_000);

    // Seule l'auth de l'agent est fournie : le transfert imbriqué depuis
    // le vault doit être couvert par authorize_as_current_contract.
    s.env.mock_auths(&[MockAuth {
        address: &s.agent,
        invoke: &MockAuthInvoke {
            contract: &s.vault.address,
            fn_name: "allocate",
            args: (1u32, 300_000_000i128).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    s.vault.allocate(&1, &300_000_000);
    assert_eq!(s.vault.pool_assets(&1), 300_000_000);
}

#[test]
fn allocate_requires_agent() {
    let s = setup();
    s.vault.deposit(&s.user, &500_000_000);

    let stranger = Address::generate(&s.env);
    s.env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &s.vault.address,
            fn_name: "allocate",
            args: (1u32, 300_000_000i128).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    assert!(s.vault.try_allocate(&1, &300_000_000).is_err());
}

#[test]
#[should_panic(expected = "Unknown pool")]
fn allocate_to_unknown_pool_panics() {
    let s = setup();
    s.vault.deposit(&s.user, &500_000_000);
    s.vault.allocate(&2, &100_000_000);
}

#[test]
#[should_panic(expected = "Not enough idle funds")]
fn allocate_more_than_idle_panics() {
    let s = setup();
    s.vault.deposit(&s.user, &100_000_000);
    s.vault.allocate(&1, &100_000_001);
}

#[test]
fn yield_increases_share_value() {
    let s = setup();
    s.vault.deposit(&s.user, &1_000_000_000);
    s.vault.allocate(&1, &1_000_000_000);

    // +10 % d'intérêts dans le pool
    s.token_admin.mint(&s.pool.address, &100_000_000);
    s.pool.set_b_rate(&(SCALAR_12 * 11 / 10));

    assert_eq!(s.vault.total_assets(), 1_100_000_000);
    assert_eq!(s.vault.balance_of(&s.user), 1_099_999_999);

    // Un nouveau déposant paie le prix courant : il ne capte pas le rendement passé
    let late = Address::generate(&s.env);
    s.token_admin.mint(&late, &110_000_000);
    s.vault.deposit(&late, &110_000_000);
    assert_eq!(s.vault.shares_of(&late), 100_000_000);
}

#[test]
fn withdraw_pulls_from_pool_when_idle_is_short() {
    let s = setup();
    s.vault.deposit(&s.user, &500_000_000);
    s.vault.allocate(&1, &400_000_000);

    s.vault.withdraw(&s.user, &300_000_000);
    assert_eq!(s.token.balance(&s.user), 4_800_000_000);
    assert_eq!(s.token.balance(&s.vault.address), 0);
    assert_eq!(s.vault.pool_assets(&1), 200_000_000);
    assert_eq!(s.vault.total_assets(), 200_000_000);
}

// ---------- Pause d'urgence ----------

#[test]
#[should_panic(expected = "Vault is paused")]
fn paused_vault_rejects_deposits() {
    let s = setup();
    s.vault.pause();
    s.vault.deposit(&s.user, &100_000_000);
}

#[test]
#[should_panic(expected = "Vault is paused")]
fn paused_vault_rejects_allocations() {
    let s = setup();
    s.vault.deposit(&s.user, &500_000_000);
    s.vault.pause();
    s.vault.allocate(&1, &100_000_000);
}

#[test]
fn paused_vault_still_allows_withdrawals_and_deallocations() {
    let s = setup();
    s.vault.deposit(&s.user, &500_000_000);
    s.vault.allocate(&1, &400_000_000);
    s.vault.pause();

    s.vault.deallocate(&1, &100_000_000);
    s.vault.withdraw(&s.user, &300_000_000);
    assert_eq!(s.token.balance(&s.user), 4_800_000_000);
}

#[test]
fn unpause_reopens_deposits() {
    let s = setup();
    s.vault.pause();
    assert!(s.vault.is_paused());
    s.vault.unpause();
    assert!(!s.vault.is_paused());
    s.vault.deposit(&s.user, &100_000_000);
}

#[test]
fn pause_requires_admin() {
    let s = setup();
    let stranger = Address::generate(&s.env);
    s.env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &s.vault.address,
            fn_name: "pause",
            args: ().into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    assert!(s.vault.try_pause().is_err());
    assert!(!s.vault.is_paused());
}

#[test]
fn emergency_withdraw_brings_everything_back_and_pauses() {
    let s = setup();
    // Plusieurs allocations : la position dépasse le plafond de 100 XLM
    let whale = Address::generate(&s.env);
    s.token_admin.mint(&whale, &3_000_000_000);
    for _ in 0..3 {
        s.vault.deposit(&whale, &1_000_000_000);
        s.vault.allocate(&1, &1_000_000_000);
    }
    s.token_admin.mint(&s.pool.address, &300_000_000);
    s.pool.set_b_rate(&(SCALAR_12 * 11 / 10));
    assert_eq!(s.vault.pool_assets(&1), 3_300_000_000);

    let withdrawn = s.vault.emergency_withdraw(&1);
    assert_eq!(withdrawn, 3_300_000_000);
    assert_eq!(s.vault.pool_assets(&1), 0);
    assert_eq!(s.token.balance(&s.vault.address), 3_300_000_000);
    assert!(s.vault.is_paused());
}

#[test]
fn emergency_withdraw_requires_admin() {
    let s = setup();
    s.vault.deposit(&s.user, &500_000_000);
    s.vault.allocate(&1, &400_000_000);
    s.env.mock_auths(&[MockAuth {
        address: &s.agent,
        invoke: &MockAuthInvoke {
            contract: &s.vault.address,
            fn_name: "emergency_withdraw",
            args: (1u32,).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    assert!(s.vault.try_emergency_withdraw(&1).is_err());
    assert_eq!(s.vault.pool_assets(&1), 400_000_000);
}

// ---------- Gestion des pools ----------

#[test]
#[should_panic(expected = "Pool id already used")]
fn add_pool_twice_panics() {
    let s = setup();
    s.vault.add_pool(&1, &s.pool.address);
}

#[test]
#[should_panic(expected = "Pool still holds vault funds")]
fn remove_pool_with_funds_panics() {
    let s = setup();
    s.vault.deposit(&s.user, &500_000_000);
    s.vault.allocate(&1, &100_000_000);
    s.vault.remove_pool(&1);
}

#[test]
fn remove_empty_pool() {
    let s = setup();
    s.vault.remove_pool(&1);
    assert_eq!(s.vault.pools().len(), 0);
}

// ---------- Vrai pool Blend (copie locale du testnet) ----------
// stellar snapshot create --network testnet --out blend_snapshot.json \
//   --address <pool> --address <XLM SAC> --address <backstop> --address <oracle> --address <emitter>
// L'hôte de soroban-sdk 28 n'accepte que protocol_version <= 28 dans le snapshot :
// si le testnet est plus récent, ramener ce champ à 28 dans le fichier JSON.
// Le snapshot n'inclut pas le code des contrats : les wasm Blend
// (stellar contract fetch --wasm-hash <hash> --out-file <hash>.wasm) sont lus
// dans BLEND_WASM_DIR.
// BLEND_SNAPSHOT=blend_snapshot.json BLEND_WASM_DIR=. cargo test blend_testnet_fork -- --ignored

const BLEND_TESTNET_POOL: &str = "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF";
const TESTNET_XLM: &str = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

#[test]
#[ignore = "needs a Blend testnet snapshot in BLEND_SNAPSHOT"]
fn blend_testnet_fork() {
    use soroban_sdk::testutils::Ledger as _;

    let path = std::env::var("BLEND_SNAPSHOT").expect("BLEND_SNAPSHOT not set");
    let mut env = Env::from_ledger_snapshot_file(path);
    // L'état copié du testnet ferait une capture de test de plusieurs dizaines de Mo
    env.set_config(soroban_sdk::testutils::EnvTestConfig { capture_snapshot_at_drop: false });
    env.mock_all_auths();

    let wasm_dir = std::env::var("BLEND_WASM_DIR").expect("BLEND_WASM_DIR not set");
    for entry in std::fs::read_dir(wasm_dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|ext| ext == "wasm") {
            let wasm = std::fs::read(path).unwrap();
            env.deployer().upload_contract_wasm(soroban_sdk::Bytes::from_slice(&env, &wasm));
        }
    }

    let pool = Address::from_str(&env, BLEND_TESTNET_POOL);
    let token_id = Address::from_str(&env, TESTNET_XLM);
    let token = TokenClient::new(&env, &token_id);

    let admin = Address::generate(&env);
    let agent = Address::generate(&env);
    let user = Address::generate(&env);
    // Le natif ne se mint pas : on prend des XLM au pool lui-même
    token.transfer(&pool, &user, &1_000_000_000);

    let vault_id = env.register(YieldVault, (&admin, &token_id));
    let vault = YieldVaultClient::new(&env, &vault_id);
    vault.set_agent(&agent);
    vault.add_pool(&1, &pool);
    vault.deposit(&user, &1_000_000_000);

    // Seule l'auth de l'agent est fournie, comme en vrai
    env.mock_auths(&[MockAuth {
        address: &agent,
        invoke: &MockAuthInvoke {
            contract: &vault.address,
            fn_name: "allocate",
            args: (1u32, 700_000_000i128).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    vault.allocate(&1, &700_000_000);
    assert_eq!(token.balance(&vault.address), 300_000_000);
    let allocated = vault.pool_assets(&1);
    std::println!("position after allocate: {allocated}");
    assert!(allocated >= 699_999_990 && allocated <= 700_000_000);

    // Une semaine plus tard, les intérêts ont augmenté la valeur des parts
    env.ledger().with_mut(|l| l.timestamp += 7 * 24 * 3600);
    let after_week = vault.pool_assets(&1);
    std::println!("position after one week: {after_week}");
    assert!(after_week > allocated);

    // Le retrait complet (en deux fois, plafond de 100 XLM) puise dans Blend
    env.mock_all_auths();
    let value = vault.balance_of(&user);
    std::println!("user value after one week: {value}");
    vault.withdraw(&user, &MAX_OPERATION_STROOPS);
    vault.withdraw(&user, &vault.balance_of(&user));
    let received = token.balance(&user);
    std::println!("user received: {received}, left in pool: {}", vault.pool_assets(&1));
    assert!(received > 1_000_000_000 && received <= value);
}

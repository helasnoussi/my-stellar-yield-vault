#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{storage::Persistent as _, Address as _, Events as _},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, Event,
};

fn setup() -> (Env, YieldVaultClient<'static>, TokenClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);

    let token_id = env.register_stellar_asset_contract_v2(admin.clone()).address();
    StellarAssetClient::new(&env, &token_id).mint(&user, &5_000_000_000);
    let token = TokenClient::new(&env, &token_id);

    let vault_id = env.register(YieldVault, (&admin, &token_id));
    let vault = YieldVaultClient::new(&env, &vault_id);

    (env, vault, token, admin, user)
}

#[test]
fn deposit_and_withdraw() {
    let (_env, vault, token, _admin, user) = setup();

    vault.deposit(&user, &300_000_000);
    assert_eq!(vault.shares_of(&user), 300_000_000);
    assert_eq!(token.balance(&vault.address), 300_000_000);

    vault.withdraw(&user, &100_000_000);
    assert_eq!(vault.shares_of(&user), 200_000_000);
    assert_eq!(token.balance(&vault.address), 200_000_000);
    assert_eq!(token.balance(&user), 4_800_000_000);
}

#[test]
fn deposit_emits_event() {
    let (env, vault, _token, _admin, user) = setup();
    vault.deposit(&user, &100_000_000);

    let expected = Deposit { from: user.clone(), amount: 100_000_000 };
    let last = env.events().all().events().last().unwrap().clone();
    assert_eq!(last, expected.to_xdr(&env, &vault.address));
}

#[test]
#[should_panic(expected = "Insufficient shares")]
fn withdraw_more_than_shares_panics() {
    let (_env, vault, _token, _admin, user) = setup();
    vault.deposit(&user, &100_000_000);
    vault.withdraw(&user, &100_000_001);
}

#[test]
#[should_panic(expected = "exceeds 100 XLM limit")]
fn deposit_over_cap_panics() {
    let (_env, vault, _token, _admin, user) = setup();
    vault.deposit(&user, &(MAX_OPERATION_STROOPS + 1));
}

#[test]
#[should_panic(expected = "must be positive")]
fn deposit_zero_panics() {
    let (_env, vault, _token, _admin, user) = setup();
    vault.deposit(&user, &0);
}

#[test]
fn deposit_extends_user_share_ttl() {
    let (env, vault, _token, _admin, user) = setup();
    vault.deposit(&user, &100_000_000);
    let ttl = env.as_contract(&vault.address, || {
        env.storage().persistent().get_ttl(&DataKey::UserShare(user.clone()))
    });
    assert!(ttl >= TTL_EXTEND_TO - 1);
}

#[test]
fn execute_strategy_requires_configured_agent() {
    let (env, vault, _token, _admin, _user) = setup();
    assert!(vault.try_execute_strategy(&1).is_err());

    let agent = Address::generate(&env);
    vault.set_agent(&agent);
    vault.execute_strategy(&1);
}

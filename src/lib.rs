#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env};

#[contracttype]
pub enum DataKey {
    Admin,
    Token,
    TotalShares,
    UserShare(Address),
}

#[contract]
pub struct YieldVault;

#[contractimpl]
impl YieldVault {
    // 1. Fonction d'initialisation
    pub fn initialize(env: Env, admin: Address, token: Address) {
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::TotalShares, &0i128);
    }

    // 2. Fonction deposit
    pub fn deposit(env: Env, from: Address, amount: i128) {
        from.require_auth();

        // Récupération de l'adresse du jeton
        let token_address: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let token_client = soroban_sdk::token::Client::new(&env, &token_address);

        // Transfert des jetons vers le coffre
        token_client.transfer(&from, &env.current_contract_address(), &amount);

        // Gestion des parts (parts utilisateur)
        let mut user_shares: i128 = env.storage().persistent().get(&DataKey::UserShare(from.clone())).unwrap_or(0);
        user_shares += amount;
        env.storage().persistent().set(&DataKey::UserShare(from.clone()), &user_shares);

        let mut total_shares: i128 = env.storage().instance().get(&DataKey::TotalShares).unwrap_or(0);
        total_shares += amount;
        env.storage().instance().set(&DataKey::TotalShares, &total_shares);
    }
} 
#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env};

const MAX_OPERATION_STROOPS: i128 = 1_000_000_000;

#[contracttype]
pub enum DataKey {
    Admin,
    Token,
    TotalShares,
    UserShare(Address),
    Agent, // Nouvelle clé pour stocker l'adresse de l'agent IA
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

    // 2. Définir ou mettre à jour l'adresse de l'agent IA (réservé à l'admin)
    pub fn set_agent(env: Env, agent: Address) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        env.storage().instance().set(&DataKey::Agent, &agent);
    }

    // 3. Fonction deposit
    pub fn deposit(env: Env, from: Address, amount: i128) {
        from.require_auth();
        Self::validate_operation_amount(amount);

        let token_address: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let token_client = soroban_sdk::token::Client::new(&env, &token_address);

        token_client.transfer(&from, &env.current_contract_address(), &amount);

        let mut user_shares: i128 = env.storage().persistent().get(&DataKey::UserShare(from.clone())).unwrap_or(0);
        user_shares += amount;
        env.storage().persistent().set(&DataKey::UserShare(from.clone()), &user_shares);

        let mut total_shares: i128 = env.storage().instance().get(&DataKey::TotalShares).unwrap_or(0);
        total_shares += amount;
        env.storage().instance().set(&DataKey::TotalShares, &total_shares);
    }

    // 4. Fonction de retrait
    pub fn withdraw(env: Env, to: Address, amount: i128) {
        to.require_auth();
        Self::validate_operation_amount(amount);

        let mut user_shares: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::UserShare(to.clone()))
            .unwrap_or(0);

        if user_shares < amount {
            panic!("Insufficient shares");
        }

        let token_address: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let token_client = soroban_sdk::token::Client::new(&env, &token_address);

        token_client.transfer(&env.current_contract_address(), &to, &amount);

        user_shares -= amount;
        env.storage()
            .persistent()
            .set(&DataKey::UserShare(to), &user_shares);

        let mut total_shares: i128 = env.storage().instance().get(&DataKey::TotalShares).unwrap_or(0);
        total_shares -= amount;
        env.storage().instance().set(&DataKey::TotalShares, &total_shares);
    }

    fn validate_operation_amount(amount: i128) {
        if amount <= 0 {
            panic!("Operation amount must be positive");
        }
        if amount > MAX_OPERATION_STROOPS {
            panic!("Operation amount exceeds 100 XLM limit");
        }
    }

    pub fn shares_of(env: Env, owner: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::UserShare(owner))
            .unwrap_or(0)
    }

    // 6. Fonction exécutée par l'agent IA pour la stratégie / rééquilibrage
    pub fn execute_strategy(env: Env, strategy_id: u32) {
        let agent: Address = env.storage().instance().get(&DataKey::Agent).expect("Agent not configured");
        agent.require_auth();

        // Logique de stratégie (ex: interaction avec un pool ou réaffectation interne)
        // Pour le hackathon, vous pouvez émettre un événement pour notifier le script off-chain
        env.events().publish(
            (soroban_sdk::Symbol::new(&env, "strategy_executed"), agent),
            strategy_id,
        );
    }
}
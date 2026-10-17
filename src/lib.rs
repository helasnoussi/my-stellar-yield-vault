#![no_std]
use soroban_sdk::{contract, contractevent, contractimpl, contracttype, Address, Env};

const MAX_OPERATION_STROOPS: i128 = 1_000_000_000;

// ~5 s par ledger : 17 280 ledgers ≈ 1 jour
const DAY_IN_LEDGERS: u32 = 17_280;
const TTL_THRESHOLD: u32 = 7 * DAY_IN_LEDGERS;
const TTL_EXTEND_TO: u32 = 30 * DAY_IN_LEDGERS;

#[contracttype]
pub enum DataKey {
    Admin,
    Token,
    TotalShares,
    UserShare(Address),
    Agent, // Nouvelle clé pour stocker l'adresse de l'agent IA
}

#[contractevent(data_format = "single-value")]
pub struct Deposit {
    #[topic]
    pub from: Address,
    pub amount: i128,
}

#[contractevent(data_format = "single-value")]
pub struct Withdraw {
    #[topic]
    pub to: Address,
    pub amount: i128,
}

#[contractevent(data_format = "single-value")]
pub struct StrategyExecuted {
    #[topic]
    pub agent: Address,
    pub strategy_id: u32,
}

#[contract]
pub struct YieldVault;

#[contractimpl]
impl YieldVault {
    // 1. Constructeur : exécuté une seule fois, au déploiement
    pub fn __constructor(env: Env, admin: Address, token: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::TotalShares, &0i128);
        Self::extend_instance(&env);
    }

    // 2. Définir ou mettre à jour l'adresse de l'agent IA (réservé à l'admin)
    pub fn set_agent(env: Env, agent: Address) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        env.storage().instance().set(&DataKey::Agent, &agent);
        Self::extend_instance(&env);
    }

    // 3. Fonction deposit
    pub fn deposit(env: Env, from: Address, amount: i128) {
        from.require_auth();
        Self::validate_operation_amount(amount);

        let token_address: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let token_client = soroban_sdk::token::Client::new(&env, &token_address);

        token_client.transfer(&from, &env.current_contract_address(), &amount);

        let key = DataKey::UserShare(from.clone());
        let mut user_shares: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        user_shares += amount;
        env.storage().persistent().set(&key, &user_shares);
        Self::extend_persistent(&env, &key);

        let mut total_shares: i128 = env.storage().instance().get(&DataKey::TotalShares).unwrap_or(0);
        total_shares += amount;
        env.storage().instance().set(&DataKey::TotalShares, &total_shares);
        Self::extend_instance(&env);

        Deposit { from, amount }.publish(&env);
    }

    // 4. Fonction de retrait
    pub fn withdraw(env: Env, to: Address, amount: i128) {
        to.require_auth();
        Self::validate_operation_amount(amount);

        let key = DataKey::UserShare(to.clone());
        let mut user_shares: i128 = env.storage().persistent().get(&key).unwrap_or(0);

        if user_shares < amount {
            panic!("Insufficient shares");
        }

        // Mise à jour de l'état avant le transfert sortant
        user_shares -= amount;
        env.storage().persistent().set(&key, &user_shares);
        Self::extend_persistent(&env, &key);

        let mut total_shares: i128 = env.storage().instance().get(&DataKey::TotalShares).unwrap_or(0);
        total_shares -= amount;
        env.storage().instance().set(&DataKey::TotalShares, &total_shares);
        Self::extend_instance(&env);

        let token_address: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let token_client = soroban_sdk::token::Client::new(&env, &token_address);
        token_client.transfer(&env.current_contract_address(), &to, &amount);

        Withdraw { to, amount }.publish(&env);
    }

    fn extend_instance(env: &Env) {
        env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
    }

    fn extend_persistent(env: &Env, key: &DataKey) {
        env.storage().persistent().extend_ttl(key, TTL_THRESHOLD, TTL_EXTEND_TO);
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
        let key = DataKey::UserShare(owner);
        let shares = env.storage().persistent().get(&key).unwrap_or(0);
        if shares > 0 {
            Self::extend_persistent(&env, &key);
        }
        shares
    }

    // 6. Fonction exécutée par l'agent IA pour la stratégie / rééquilibrage
    pub fn execute_strategy(env: Env, strategy_id: u32) {
        let agent: Address = env.storage().instance().get(&DataKey::Agent).expect("Agent not configured");
        agent.require_auth();
        Self::extend_instance(&env);

        // Logique de stratégie (ex: interaction avec un pool ou réaffectation interne)
        // Pour le hackathon, vous pouvez émettre un événement pour notifier le script off-chain
        StrategyExecuted { agent, strategy_id }.publish(&env);
    }
}

#[cfg(test)]
mod test;

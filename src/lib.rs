#![no_std]
use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractevent, contractimpl, contracttype, symbol_short, token::TokenInterface, vec,
    Address, Env, IntoVal, Map, MuxedAddress, String, Vec,
};

mod blend;
use blend::{PoolClient, Request, REQUEST_SUPPLY, REQUEST_WITHDRAW, SCALAR_12};

const MAX_OPERATION_STROOPS: i128 = 1_000_000_000;
// Chaque pool coûte deux appels inter-contrats dans total_assets
const MAX_POOLS: u32 = 5;

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
    Agent,
    Pools, // Map<u32, Address> des pools Blend autorisés par l'admin
    Paused,
    Allowance(AllowanceKey),
}

#[contracttype]
pub struct AllowanceKey {
    pub from: Address,
    pub spender: Address,
}

#[contracttype]
pub struct AllowanceValue {
    pub amount: i128,
    pub live_until_ledger: u32,
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
pub struct Allocated {
    #[topic]
    pub pool_id: u32,
    pub amount: i128,
}

#[contractevent(data_format = "single-value")]
pub struct Deallocated {
    #[topic]
    pub pool_id: u32,
    pub amount: i128,
}

#[contractevent(data_format = "single-value")]
pub struct Paused {
    pub paused: bool,
}

// Événements standard SEP-41 : les montants sont des parts svXLM
#[contractevent(data_format = "single-value")]
pub struct Transfer {
    #[topic]
    pub from: Address,
    #[topic]
    pub to: Address,
    pub amount: i128,
}

#[contractevent(topics = ["transfer"])]
pub struct TransferMuxed {
    #[topic]
    pub from: Address,
    #[topic]
    pub to: Address,
    pub to_muxed_id: u64,
    pub amount: i128,
}

#[contractevent(data_format = "vec")]
pub struct Approve {
    #[topic]
    pub from: Address,
    #[topic]
    pub spender: Address,
    pub amount: i128,
    pub live_until_ledger: u32,
}

#[contractevent(data_format = "single-value")]
pub struct Mint {
    #[topic]
    pub to: Address,
    pub amount: i128,
}

#[contractevent(data_format = "single-value")]
pub struct Burn {
    #[topic]
    pub from: Address,
    pub amount: i128,
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
        env.storage().instance().set(&DataKey::Pools, &Map::<u32, Address>::new(&env));
        Self::extend_instance(&env);
    }

    // 2. Définir ou mettre à jour l'adresse de l'agent IA (réservé à l'admin)
    pub fn set_agent(env: Env, agent: Address) {
        Self::require_admin(&env);
        env.storage().instance().set(&DataKey::Agent, &agent);
        Self::extend_instance(&env);
    }

    // 3. Autoriser un pool Blend (réservé à l'admin). L'agent ne peut placer
    //    les fonds que dans les pools de cette liste.
    pub fn add_pool(env: Env, pool_id: u32, pool: Address) {
        Self::require_admin(&env);
        let mut pools = Self::pools(env.clone());
        if pools.contains_key(pool_id) {
            panic!("Pool id already used");
        }
        if pools.len() >= MAX_POOLS {
            panic!("Too many pools");
        }
        pools.set(pool_id, pool);
        env.storage().instance().set(&DataKey::Pools, &pools);
        Self::extend_instance(&env);
    }

    // 4. Retirer un pool vide de la liste (réservé à l'admin)
    pub fn remove_pool(env: Env, pool_id: u32) {
        Self::require_admin(&env);
        if Self::pool_assets(env.clone(), pool_id) > 0 {
            panic!("Pool still holds vault funds");
        }
        let mut pools = Self::pools(env.clone());
        pools.remove(pool_id);
        env.storage().instance().set(&DataKey::Pools, &pools);
        Self::extend_instance(&env);
    }

    // 5. Pause d'urgence (réservée à l'admin) : bloque les dépôts et les
    //    placements. Les retraits restent ouverts, ainsi que deallocate qui
    //    ne fait que rapatrier des fonds vers le vault.
    pub fn pause(env: Env) {
        Self::require_admin(&env);
        Self::set_paused(&env, true);
    }

    pub fn unpause(env: Env) {
        Self::require_admin(&env);
        Self::set_paused(&env, false);
    }

    // 6. Rapatrie toute la position d'un pool vers le vault, sans plafond, et met
    //    le vault en pause. Les fonds restent dans le vault : l'admin ne peut
    //    pas les recevoir.
    pub fn emergency_withdraw(env: Env, pool_id: u32) -> i128 {
        Self::require_admin(&env);
        let position = Self::pool_assets(env.clone(), pool_id);
        let mut withdrawn = 0;
        if position > 0 {
            let pool = Self::pool_address(&env, pool_id);
            withdrawn = Self::withdraw_from_pool(&env, &pool, position);
            Deallocated { pool_id, amount: withdrawn }.publish(&env);
        }
        if !Self::is_paused(env.clone()) {
            Self::set_paused(&env, true);
        }
        Self::extend_instance(&env);
        withdrawn
    }

    // 7. Dépôt : `amount` XLM contre des parts au prix courant du vault
    pub fn deposit(env: Env, from: Address, amount: i128) {
        from.require_auth();
        Self::require_not_paused(&env);
        Self::validate_operation_amount(amount);

        // Prix calculé avant le transfert entrant
        let total_assets = Self::total_assets(env.clone());
        let total_shares = Self::total_shares(&env);
        let minted = amount * (total_shares + 1) / (total_assets + 1);
        if minted <= 0 {
            panic!("Deposit too small");
        }

        Self::token_client(&env).transfer(&from, &env.current_contract_address(), &amount);

        Self::write_shares(&env, &from, Self::read_shares(&env, &from) + minted);
        env.storage().instance().set(&DataKey::TotalShares, &(total_shares + minted));
        Self::extend_instance(&env);

        Mint { to: from.clone(), amount: minted }.publish(&env);
        Deposit { from, amount }.publish(&env);
    }

    // 8. Retrait : `amount` XLM, en brûlant les parts correspondantes
    //    (arrondi en faveur du vault)
    pub fn withdraw(env: Env, to: Address, amount: i128) {
        to.require_auth();
        Self::validate_operation_amount(amount);

        let total_assets = Self::total_assets(env.clone());
        let total_shares = Self::total_shares(&env);
        let burned = Self::div_ceil(amount * (total_shares + 1), total_assets + 1);

        let user_shares = Self::read_shares(&env, &to);
        if user_shares < burned {
            panic!("Insufficient shares");
        }

        // Mise à jour de l'état avant tout appel externe
        Self::write_shares(&env, &to, user_shares - burned);
        env.storage().instance().set(&DataKey::TotalShares, &(total_shares - burned));
        Self::extend_instance(&env);

        Self::ensure_liquidity(&env, amount);
        Self::token_client(&env).transfer(&env.current_contract_address(), &to, &amount);

        Burn { from: to.clone(), amount: burned }.publish(&env);
        Withdraw { to, amount }.publish(&env);
    }

    // 9. L'agent place des XLM du vault dans un pool autorisé (prêt simple)
    pub fn allocate(env: Env, pool_id: u32, amount: i128) {
        Self::require_agent(&env);
        Self::require_not_paused(&env);
        Self::validate_operation_amount(amount);
        let pool = Self::pool_address(&env, pool_id);
        let token = Self::token_address(&env);
        let vault = env.current_contract_address();

        if Self::token_client(&env).balance(&vault) < amount {
            panic!("Not enough idle funds");
        }

        // Le pool appelle token.transfer(vault, pool, amount) : le vault doit
        // autoriser explicitement cet appel imbriqué.
        env.authorize_as_current_contract(vec![
            &env,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: token.clone(),
                    fn_name: symbol_short!("transfer"),
                    args: (vault.clone(), pool.clone(), amount).into_val(&env),
                },
                sub_invocations: Vec::new(&env),
            }),
        ]);
        Self::submit(&env, &pool, &token, amount, REQUEST_SUPPLY);
        Self::extend_instance(&env);

        Allocated { pool_id, amount }.publish(&env);
    }

    // 10. L'agent récupère des XLM d'un pool autorisé
    pub fn deallocate(env: Env, pool_id: u32, amount: i128) {
        Self::require_agent(&env);
        Self::validate_operation_amount(amount);
        let pool = Self::pool_address(&env, pool_id);
        let withdrawn = Self::withdraw_from_pool(&env, &pool, amount);
        Self::extend_instance(&env);

        Deallocated { pool_id, amount: withdrawn }.publish(&env);
    }

    // ---------- Lectures ----------

    pub fn shares_of(env: Env, owner: Address) -> i128 {
        let key = DataKey::UserShare(owner);
        let shares = env.storage().persistent().get(&key).unwrap_or(0);
        if shares > 0 {
            Self::extend_persistent(&env, &key);
        }
        shares
    }

    // Valeur en XLM des parts d'un déposant (balance renvoie les parts)
    pub fn value_of(env: Env, owner: Address) -> i128 {
        let shares = Self::shares_of(env.clone(), owner);
        shares * (Self::total_assets(env.clone()) + 1) / (Self::total_shares(&env) + 1)
    }

    // XLM disponibles dans le vault + XLM placés dans les pools (intérêts compris)
    pub fn total_assets(env: Env) -> i128 {
        let mut total = Self::token_client(&env).balance(&env.current_contract_address());
        for pool_id in Self::pools(env.clone()).keys() {
            total += Self::pool_assets(env.clone(), pool_id);
        }
        total
    }

    // Valeur en XLM de la position du vault dans un pool
    pub fn pool_assets(env: Env, pool_id: u32) -> i128 {
        let pool = PoolClient::new(&env, &Self::pool_address(&env, pool_id));
        let reserve = pool.get_reserve(&Self::token_address(&env));
        let positions = pool.get_positions(&env.current_contract_address());
        let b_tokens = positions.supply.get(reserve.config.index).unwrap_or(0);
        b_tokens * reserve.data.b_rate / SCALAR_12
    }

    pub fn token(env: Env) -> Address {
        Self::token_address(&env)
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage().instance().get(&DataKey::Paused).unwrap_or(false)
    }

    pub fn pools(env: Env) -> Map<u32, Address> {
        env.storage()
            .instance()
            .get(&DataKey::Pools)
            .unwrap_or(Map::new(&env))
    }

    // ---------- Fonctions internes ----------

    fn require_not_paused(env: &Env) {
        if Self::is_paused(env.clone()) {
            panic!("Vault is paused");
        }
    }

    fn set_paused(env: &Env, paused: bool) {
        env.storage().instance().set(&DataKey::Paused, &paused);
        Self::extend_instance(env);
        Paused { paused }.publish(env);
    }

    fn require_admin(env: &Env) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
    }

    fn require_agent(env: &Env) {
        let agent: Address = env
            .storage()
            .instance()
            .get(&DataKey::Agent)
            .expect("Agent not configured");
        agent.require_auth();
    }

    fn token_address(env: &Env) -> Address {
        env.storage().instance().get(&DataKey::Token).unwrap()
    }

    fn token_client(env: &Env) -> soroban_sdk::token::Client<'_> {
        soroban_sdk::token::Client::new(env, &Self::token_address(env))
    }

    fn total_shares(env: &Env) -> i128 {
        env.storage().instance().get(&DataKey::TotalShares).unwrap_or(0)
    }

    fn read_shares(env: &Env, owner: &Address) -> i128 {
        env.storage().persistent().get(&DataKey::UserShare(owner.clone())).unwrap_or(0)
    }

    // Prolonge le TTL de chaque compte modifié, destinataire compris
    fn write_shares(env: &Env, owner: &Address, shares: i128) {
        let key = DataKey::UserShare(owner.clone());
        env.storage().persistent().set(&key, &shares);
        Self::extend_persistent(env, &key);
    }

    fn move_shares(env: &Env, from: &Address, to: &Address, amount: i128) {
        Self::require_nonnegative(amount);
        let from_shares = Self::read_shares(env, from);
        if from_shares < amount {
            panic!("Insufficient shares");
        }
        Self::write_shares(env, from, from_shares - amount);
        Self::write_shares(env, to, Self::read_shares(env, to) + amount);
        Self::extend_instance(env);
    }

    // Brûler des parts sans retirer les XLM donne leur valeur aux autres déposants
    fn burn_shares(env: &Env, from: &Address, amount: i128) {
        Self::require_nonnegative(amount);
        let from_shares = Self::read_shares(env, from);
        if from_shares < amount {
            panic!("Insufficient shares");
        }
        Self::write_shares(env, from, from_shares - amount);
        let total_shares = Self::total_shares(env);
        env.storage().instance().set(&DataKey::TotalShares, &(total_shares - amount));
        Self::extend_instance(env);
        Burn { from: from.clone(), amount }.publish(env);
    }

    fn read_allowance(env: &Env, from: &Address, spender: &Address) -> AllowanceValue {
        let key = DataKey::Allowance(AllowanceKey { from: from.clone(), spender: spender.clone() });
        match env.storage().temporary().get::<_, AllowanceValue>(&key) {
            Some(allowance) if allowance.live_until_ledger >= env.ledger().sequence() => allowance,
            _ => AllowanceValue { amount: 0, live_until_ledger: 0 },
        }
    }

    fn write_allowance(env: &Env, from: &Address, spender: &Address, amount: i128, live_until_ledger: u32) {
        let ledger = env.ledger().sequence();
        if amount > 0 && live_until_ledger < ledger {
            panic!("Allowance expiration is in the past");
        }
        let key = DataKey::Allowance(AllowanceKey { from: from.clone(), spender: spender.clone() });
        env.storage().temporary().set(&key, &AllowanceValue { amount, live_until_ledger });
        if amount > 0 {
            let live_for = live_until_ledger - ledger;
            env.storage().temporary().extend_ttl(&key, live_for, live_for);
        }
    }

    fn spend_allowance(env: &Env, from: &Address, spender: &Address, amount: i128) {
        Self::require_nonnegative(amount);
        let allowance = Self::read_allowance(env, from, spender);
        if allowance.amount < amount {
            panic!("Insufficient allowance");
        }
        if amount > 0 {
            Self::write_allowance(env, from, spender, allowance.amount - amount, allowance.live_until_ledger);
        }
    }

    fn pool_address(env: &Env, pool_id: u32) -> Address {
        Self::pools(env.clone()).get(pool_id).expect("Unknown pool")
    }

    fn submit(env: &Env, pool: &Address, token: &Address, amount: i128, request_type: u32) {
        let vault = env.current_contract_address();
        let requests = vec![
            env,
            Request {
                address: token.clone(),
                amount,
                request_type,
            },
        ];
        PoolClient::new(env, pool).submit(&vault, &vault, &vault, &requests);
    }

    // Retire jusqu'à `amount` XLM d'un pool et renvoie le montant reçu
    fn withdraw_from_pool(env: &Env, pool: &Address, amount: i128) -> i128 {
        let token = Self::token_address(env);
        let vault = env.current_contract_address();
        let before = Self::token_client(env).balance(&vault);
        Self::submit(env, pool, &token, amount, REQUEST_WITHDRAW);
        Self::token_client(env).balance(&vault) - before
    }

    // Complète les XLM disponibles en puisant dans les pools si nécessaire
    fn ensure_liquidity(env: &Env, amount: i128) {
        let vault = env.current_contract_address();
        let mut idle = Self::token_client(env).balance(&vault);
        if idle >= amount {
            return;
        }
        for pool_id in Self::pools(env.clone()).keys() {
            if Self::pool_assets(env.clone(), pool_id) == 0 {
                continue;
            }
            let pool = Self::pool_address(env, pool_id);
            let withdrawn = Self::withdraw_from_pool(env, &pool, amount - idle);
            Deallocated { pool_id, amount: withdrawn }.publish(env);
            idle += withdrawn;
            if idle >= amount {
                return;
            }
        }
        panic!("Not enough liquidity");
    }

    fn div_ceil(numerator: i128, denominator: i128) -> i128 {
        (numerator + denominator - 1) / denominator
    }

    fn extend_instance(env: &Env) {
        env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
    }

    fn extend_persistent(env: &Env, key: &DataKey) {
        env.storage().persistent().extend_ttl(key, TTL_THRESHOLD, TTL_EXTEND_TO);
    }

    fn require_nonnegative(amount: i128) {
        if amount < 0 {
            panic!("Amount must not be negative");
        }
    }

    fn validate_operation_amount(amount: i128) {
        if amount <= 0 {
            panic!("Operation amount must be positive");
        }
        if amount > MAX_OPERATION_STROOPS {
            panic!("Operation amount exceeds 100 XLM limit");
        }
    }
}

// Les parts du vault sont un token SEP-41, svXLM. Le rendement fait monter
// la valeur de chaque part, pas leur nombre. Les transferts restent ouverts
// pendant une pause, comme les retraits, et ne sont pas plafonnés à 100 XLM :
// ils ne font sortir aucun XLM du vault.
#[contractimpl]
impl TokenInterface for YieldVault {
    fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        Self::read_allowance(&env, &from, &spender).amount
    }

    fn approve(env: Env, from: Address, spender: Address, amount: i128, live_until_ledger: u32) {
        from.require_auth();
        Self::require_nonnegative(amount);
        Self::write_allowance(&env, &from, &spender, amount, live_until_ledger);
        Self::extend_instance(&env);
        Approve { from, spender, amount, live_until_ledger }.publish(&env);
    }

    fn balance(env: Env, id: Address) -> i128 {
        Self::shares_of(env, id)
    }

    fn transfer(env: Env, from: Address, to: MuxedAddress, amount: i128) {
        from.require_auth();
        let to_address = to.address();
        Self::move_shares(&env, &from, &to_address, amount);
        match to.id() {
            Some(to_muxed_id) => {
                TransferMuxed { from, to: to_address, to_muxed_id, amount }.publish(&env)
            }
            None => Transfer { from, to: to_address, amount }.publish(&env),
        }
    }

    fn transfer_from(env: Env, spender: Address, from: Address, to: Address, amount: i128) {
        spender.require_auth();
        Self::spend_allowance(&env, &from, &spender, amount);
        Self::move_shares(&env, &from, &to, amount);
        Transfer { from, to, amount }.publish(&env);
    }

    fn burn(env: Env, from: Address, amount: i128) {
        from.require_auth();
        Self::burn_shares(&env, &from, amount);
    }

    fn burn_from(env: Env, spender: Address, from: Address, amount: i128) {
        spender.require_auth();
        Self::spend_allowance(&env, &from, &spender, amount);
        Self::burn_shares(&env, &from, amount);
    }

    fn decimals(_env: Env) -> u32 {
        7
    }

    fn name(env: Env) -> String {
        String::from_str(&env, "Stellar Yield Vault XLM")
    }

    fn symbol(env: Env) -> String {
        String::from_str(&env, "svXLM")
    }
}

#[cfg(test)]
mod test;

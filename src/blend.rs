// Interface minimale d'un pool Blend v2 (blend-capital/blend-contracts-v2).
// Les types reprennent exactement ceux exposés par le contrat du pool.
use soroban_sdk::{contractclient, contracttype, Address, Env, Map, Vec};

// Types de requêtes `submit` utilisés par le vault (pool/src/pool/actions.rs)
pub const REQUEST_SUPPLY: u32 = 0;
pub const REQUEST_WITHDRAW: u32 = 1;

// b_rate est exprimé avec 12 décimales
pub const SCALAR_12: i128 = 1_000_000_000_000;

#[contracttype]
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct Request {
    pub address: Address,
    pub amount: i128,
    pub request_type: u32,
}

#[contracttype]
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct Positions {
    pub collateral: Map<u32, i128>,
    pub liabilities: Map<u32, i128>,
    pub supply: Map<u32, i128>,
}

#[contracttype]
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct ReserveConfig {
    pub c_factor: u32,
    pub decimals: u32,
    pub enabled: bool,
    pub index: u32,
    pub l_factor: u32,
    pub max_util: u32,
    pub r_base: u32,
    pub r_one: u32,
    pub r_three: u32,
    pub r_two: u32,
    pub reactivity: u32,
    pub supply_cap: i128,
    pub util: u32,
}

#[contracttype]
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct ReserveData {
    pub b_rate: i128,
    pub b_supply: i128,
    pub backstop_credit: i128,
    pub d_rate: i128,
    pub d_supply: i128,
    pub ir_mod: i128,
    pub last_time: u64,
}

#[contracttype]
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct Reserve {
    pub asset: Address,
    pub config: ReserveConfig,
    pub data: ReserveData,
    pub scalar: i128,
}

#[allow(dead_code)]
#[contractclient(name = "PoolClient")]
pub trait Pool {
    fn get_reserve(env: Env, asset: Address) -> Reserve;
    fn get_positions(env: Env, address: Address) -> Positions;
    fn submit(
        env: Env,
        from: Address,
        spender: Address,
        to: Address,
        requests: Vec<Request>,
    ) -> Positions;
}

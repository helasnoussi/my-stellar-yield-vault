# 🌾 Stellar Smart Yield Vault

A yield vault on Stellar, written as a Soroban smart contract. Users deposit XLM
and receive shares; an autonomous agent lends the vault's idle XLM to
[Blend](https://github.com/blend-capital/blend-contracts-v2) v2 lending pools,
and the interest earned raises the value of every share. The contract confines
the agent: it can only move funds between the vault and pools the admin has
approved, never to an arbitrary address.

## 🚀 Features

- **Deposits and shares:** deposits go through the Stellar Asset Contract (SAC). A share is worth `total_assets / total_shares`, so interest accrues to depositors, and new depositors buy at the current price.
- **Withdrawals:** users withdraw XLM up to the value of their shares; if the vault's idle XLM is short, it pulls the difference back from Blend automatically.
- **Blend allocation:** the agent lends idle XLM to admin-approved Blend pools as a plain supply (no collateral, no borrowing, so no liquidation risk).
- **Guardrails in the contract:** only the configured agent can allocate, only to approved pools, at most 100 XLM per operation.
- **Yield measured, not just estimated:** the agent reports the pool's instant rate and the yield a Blend position actually earned over the last 7 days, and decides on the latter.
- **Web app:** depositors connect Freighter, deposit and withdraw, and follow the funds lent on Blend, both yield figures and the agent's moves.
- **Testnet verified:** deployed on Stellar Testnet, with unit tests and a test against a local copy of the real Blend testnet pool.

---

## Deployment Details (Stellar Testnet)

- **Vault Contract ID:** `CDYRFTVVJNU25W54E2H42I2YLCR3SATYLWFON6LSBFGS5GHIB4QIXSGY`
- **Underlying Token (Native XLM):** `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`
- **Admin Account:** `GBRHOUDYVMYERRSFYOELPSZMKSIAFAXHEGGGTLQ5YUZ7GXPQZ5I5R5WH`
- **Agent Account:** `GAXWJXQG7LIZNU3HNLAEK5QA3T47I6TQELCOI6UOMIUMHJCHL2BOQIPJ`
- **Approved Blend Pool (id 1):** `CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF`

## Smart contract

| Function | Who | What it does |
|---|---|---|
| `__constructor(admin, token)` | deployer | Sets the admin and the vault token, once, at deployment |
| `set_agent(agent)` | admin | Sets the account allowed to allocate funds |
| `add_pool(pool_id, pool)` / `remove_pool(pool_id)` | admin | Approves a Blend pool; a pool can only be removed once the vault's position in it is empty |
| `deposit(from, amount)` | user | Deposits `amount` XLM and mints shares at the current price |
| `withdraw(to, amount)` | user | Withdraws `amount` XLM, burns the matching shares, pulls from Blend if needed |
| `allocate(pool_id, amount)` / `deallocate(pool_id, amount)` | agent | Lends idle XLM to an approved pool / takes it back |
| `total_assets()`, `pool_assets(pool_id)` | anyone | Idle XLM plus pool positions including interest / one pool's position |
| `shares_of(owner)`, `balance_of(owner)` | anyone | A depositor's shares / their value in XLM |
| `pools()`, `token()` | anyone | Approved pools / the vault token |

Every deposit, withdrawal, allocation and deallocation is capped at 100 XLM
(`MAX_OPERATION_STROOPS`). Amounts are in stroops: `1000000000` stroops is
`100 XLM`.

## Autonomous agent (`src/agent.ts`)

Each cycle the agent reads the approved pools on-chain and reports two rates:

- **Instant annualized rate (estimate):** computed from the pool's current
  parameters with Blend's interest rate model, as if utilization and the rate
  modifier stayed the same for a year. It is a snapshot, not a forecast: it
  moves as soon as borrowers repay or suppliers arrive.
- **Realized yield:** how much a Blend supply position actually grew over the
  last `REALIZED_WINDOW_SECONDS` (7 days by default), measured from the pool's
  `b_rate` (the value of one supplied b_token). Past `b_rate` values come from
  Blend's `supply`/`withdraw` events, which Stellar RPC keeps for about 7 days,
  and from the agent's local history in `AGENT_STATE_FILE`.

Decisions and the `MIN_APY_BPS` filter use the realized yield. When less than
`REALIZED_MIN_SECONDS` of history exists, the agent falls back to the instant
rate and says so in its log. The agent then takes one action:

1. exit a pool that no longer passes the filters (disabled reserve, yield below
   `MIN_APY_BPS`, or available liquidity below `MINIMUM_LIQUIDITY_STROOPS`);
2. otherwise refill the idle reserve (`VAULT_IDLE_RESERVE_STROOPS`, 30 XLM by
   default) from the lowest-yield pool;
3. otherwise lend the excess above the reserve to the best eligible pool.

Moves smaller than `MIN_ACTION_STROOPS` are skipped. The agent signs with
`AGENT_SECRET_KEY` (falling back to `ADMIN_SECRET_KEY`), which must be the
account configured with `set_agent`.

Build it, then run one cycle in dry-run mode (the default: the transaction is
simulated, not sent):

```bash
npm install
npm run build
AGENT_EXECUTE=false AGENT_ONCE=true npm start
```

After checking the proposed action, send it for real:

```bash
AGENT_EXECUTE=true AGENT_ONCE=true npm start
```

Set `AGENT_ONCE=false` to run a cycle every `AGENT_INTERVAL_MS` (1 hour by
default). To keep it running in the background:

```bash
tmux new -d -s agent 'AGENT_EXECUTE=true AGENT_ONCE=false npm start 2>&1 | tee -a agent.log'
tmux attach -t agent        # watch it (Ctrl+B then D to detach)
tmux kill-session -t agent  # stop it
```

> Neither rate is a guarantee: the realized yield describes the past, and the
> testnet pool's rates are unusually high because it is almost fully borrowed.
> A Blend pool can be misconfigured or exploited (for example the YieldBlox
> pool drain of February 2026), so only approve pools you have reviewed.

Never commit `.env` or expose `ADMIN_SECRET_KEY` or `AGENT_SECRET_KEY`.

---

## 🛠️ Getting Started & Testing

### Prerequisites

- Rust toolchain (configured for `wasm32v1-none`)
- Stellar CLI (`stellar`) v25.2.0 or newer (required by `soroban-sdk` 28)
- Node.js 20 or newer

Copy the configuration template and fill in the keys and the contract ID:

```bash
cp .env.example .env
```

### Build and test the contract

```bash
stellar contract build
cargo test
```

The unit tests use a mock Blend pool. `blend_testnet_fork` (ignored by
default) runs the vault against a local copy of the real Blend testnet pool;
the steps to create that copy are in the comment above the test in
`src/test.rs`.

### Deploy the contract

The deploy command requires a funded Testnet account to pay and sign the
transaction. Configure a Stellar CLI identity first, then deploy the compiled
WASM. The vault is configured by its constructor during deployment, so the
admin and token are passed after the `--` separator:

```bash
stellar contract deploy \
  --wasm target/wasm32v1-none/release/yield_vault.wasm \
  --source-account <TESTNET_ACCOUNT_ALIAS> \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015" \
  -- \
  --admin <ADMIN_PUBLIC_KEY> \
  --token CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
```

The constructor runs exactly once, atomically with deployment, so there is no
separate initialization step and no window in which another account could
initialize the vault first. List the available CLI identities with
`stellar keys ls`. The command returns the new contract ID: set it as
`CONTRACT_ID` in `.env` once the deployment succeeded.

### Configure the agent and the Blend pool

With `ADMIN_SECRET_KEY` and `AGENT_SECRET_KEY` in `.env`, run once:

```bash
node init.js
```

It calls `set_agent` with the `AGENT_SECRET_KEY` account and approves
`BLEND_POOL_ID` (the Blend testnet pool by default) as pool id `1`. Without
the admin key in `.env`, the same configuration works with the admin's CLI
identity:

```bash
NET='--rpc-url https://soroban-testnet.stellar.org --network-passphrase "Test SDF Network ; September 2015"'
eval stellar contract invoke --id <CONTRACT_ID> --source-account <ADMIN_ALIAS> $NET \
  -- set_agent --agent <AGENT_PUBLIC_KEY>
eval stellar contract invoke --id <CONTRACT_ID> --source-account <ADMIN_ALIAS> $NET \
  -- add_pool --pool_id 1 --pool CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF
```

### Use the vault

```bash
# Deposit 100 XLM
eval stellar contract invoke --id <CONTRACT_ID> --source-account <USER_ALIAS> $NET \
  -- deposit --from <USER_PUBLIC_KEY> --amount 1000000000

# Value of a depositor's shares, in stroops
eval stellar contract invoke --id <CONTRACT_ID> --source-account <USER_ALIAS> $NET --send=no \
  -- balance_of --owner <USER_PUBLIC_KEY>

# Withdraw 50 XLM
eval stellar contract invoke --id <CONTRACT_ID> --source-account <USER_ALIAS> $NET \
  -- withdraw --to <USER_PUBLIC_KEY> --amount 500000000
```

## Web app (`web/`)

A React page for depositors: connect [Freighter](https://www.freighter.app) on
Testnet, deposit and withdraw XLM, and follow the vault's total assets, the
funds lent on Blend, both yield figures (computed with the same code as the
agent, `src/blend-rates.ts`) and the last 3 days of vault activity. Reading
works without a wallet.

```bash
npm run web:dev     # development server
npm run web:build   # production build in dist-web/
```

`VITE_CONTRACT_ID` and `VITE_RPC_URL` override the deployed testnet vault and
RPC endpoint.

To deposit from the page, Freighter needs a funded Testnet account:

1. Install the [Freighter](https://www.freighter.app) extension and create a
   wallet, in the browser where you open the page.
2. Select **Testnet** with the network (globe) button at the top of Freighter.
3. Fund the account with **Friendbot** (10,000 test XLM), then click
   **Connect Freighter** on the page.

Use a regular account rather than the admin's: depositing and withdrawing need
no special rights.

## Built with

Built with [Claude Code](https://claude.com/claude-code) and
[Raven](https://raven.stellar.org), the Stellar ecosystem context server.
Raven was used to pick Blend as the yield source, find its v2 contracts and
interface, and review its risks (audits and the YieldBlox incident).

## License

This project is open-source and built for the Stellar/Soroban hackathon.

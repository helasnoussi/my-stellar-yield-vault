# 🌾 Stellar Smart Yield Vault

A decentralized yield vault smart contract built on Stellar using Soroban. The project demonstrates an autonomous agent that manages deposits and withdrawals on the Stellar Testnet under strict local risk limits.

## 🚀 Features

- **Secure Deposits:** Interacts cleanly with the Stellar Asset Contract (SAC) to handle token transfers.
- **Withdrawals:** Users can withdraw tokens up to their recorded share balance.
- **Soroban Powered:** Written in Rust and optimized for the `wasm32v1-none` target.
- **Autonomous Agent:** Rebalances the wallet and vault position while preserving a liquidity reserve.
- **Testnet Verified:** Deployed, initialized, and tested on Stellar Testnet.

---

## Deployment Details (Stellar Testnet)

- **Vault Contract ID:** `CA74TR35JB5FA5BICITT7SEZ3S4QRIZBQUCDUXZ7GWUNIPOQVWN7OOFX`
- **Underlying Token (Native XLM):** `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`
- **Admin Account:** `GBRHOUDYVMYERRSFYOELPSZMKSIAFAXHEGGGTLQ5YUZ7GXPQZ5I5R5WH`

## Autonomous agent

`agent.js` is the recommended production/demo entry point. It implements a
conservative hybrid rebalancer:

- keeps at least 30 XLM liquid;
- targets at most 70% of total assets in the vault;
- caps each operation at 100 XLM in both the agent and the smart contract;
- checks the vault position through `shares_of`;
- runs once by default (`AGENT_ONCE=true`);
- uses dry-run mode by default (`AGENT_EXECUTE=false`).

Copy `.env.example` to `.env`, provide `ADMIN_SECRET_KEY`, and run:

```bash
cp .env.example .env
node agent.js
```

The safe default is a dry run executed once:

```bash
AGENT_EXECUTE=false AGENT_ONCE=true node agent.js
```

After validating the proposed action, enable one real execution:

```bash
AGENT_EXECUTE=true AGENT_ONCE=true node agent.js
```

Set `AGENT_ONCE=false` to run the hourly loop:

```bash
AGENT_EXECUTE=true AGENT_ONCE=false node agent.js
```

The agent keeps at least 30 XLM liquid, targets at most 70% invested in the
vault, and caps each operation at 100 XLM. The smart contract enforces the
same cap for direct CLI and API calls. Raven MCP and x402 are optional
signal/payment integrations; neither receives the Stellar signing key.

### Strategy selection

The agent selects strategies deterministically after applying local safety
filters. Configure `YIELD_API_URL` to load a JSON array of strategies from an
external yield API:

```env
YIELD_API_URL=https://example.com/api/strategies
```

The response must contain entries with fields such as:

```json
[
  {
    "id": 1,
    "name": "Example XLM Vault",
    "asset": "XLM",
    "estimatedApy": 8.5,
    "riskScore": 2,
    "liquidityStroops": "5000000000",
    "feesBps": 20
  }
]
```

Strategies are filtered locally by `asset`, `MAX_RISK_SCORE`, `MIN_APY_BPS`,
and available liquidity. The selected strategy maximizes estimated APY minus
fees. If `YIELD_API_URL` is empty, `RAVEN_STRATEGIES_JSON` is used as the
offline/demo source.

The repository also contains a TypeScript runner in `src/agent.ts`. Compile it
with `npm run build` to produce `dist/agent.js`. It uses `AGENT_SECRET_KEY`
(falling back to `ADMIN_SECRET_KEY`) and the `CONTRACT_ID` from `.env`.
The signing account must first be configured on-chain with `set_agent`.

The demo strategy metadata uses:

```json
{
  "estimatedApy": 8.5,
  "riskScore": 2,
  "liquidityStroops": "2000000000",
  "feesBps": 20
}
```

These values mean 8.5% estimated APY, risk score 2, 200 XLM declared
liquidity, and 0.20% estimated fees. They are simulated demo data, not an
audit, financial rating, or guarantee.

### Strategy discovery

When `RAVEN_ENABLED=true` and `RAVEN_OAUTH_TOKEN` is configured, the agent
queries `RAVEN_MCP_URL` for strategy context, normalizes candidate strategies,
and filters them locally by asset, risk, APY, fees, and liquidity. Raven can
inform the comparison but cannot sign transactions or switch to an unsupported
contract. For a demo without OAuth, `RAVEN_STRATEGIES_JSON` can provide a
machine-readable strategy list.

> **Demo disclaimer:** the risk score used in the hackathon demo is simulated
> metadata. It is not an audit, a financial rating, or a guarantee of safety.

Never commit `.env` or expose `ADMIN_SECRET_KEY`. Use a separate wallet for
optional x402 payments and keep the vault signing key local.

---

## 🛠️ Getting Started & Testing

### Prerequisites

- Rust toolchain (configured for `wasm32v1-none`)
- Stellar CLI (`stellar`) v25.2.0 or newer (required by `soroban-sdk` 28)
- Node.js 20 or newer

### Build Contract

```bash
stellar contract build
```

Run the contract tests with:

```bash
cargo test
```

### Deploy Contract

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
  --alias yield-vault \
  -- \
  --admin <ADMIN_PUBLIC_KEY> \
  --token CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
```

The constructor runs exactly once, atomically with deployment, so there is no
separate initialization step and no window in which another account could
initialize the vault first.

`<TESTNET_ACCOUNT_ALIAS>` must be an existing Stellar CLI identity, or you can
use a public/secret key supported by the CLI. Do not commit a secret key or
place it in the README. For a configured identity, verify the available
accounts with:

```bash
stellar keys ls
```

The command returns the new contract ID. Update the deployment details and
`.env` `CONTRACT_ID` only after confirming that the deployment succeeded.

Interact with the Vault (example):

```bash
stellar contract invoke \
  --contract-id CA74TR35JB5FA5BICITT7SEZ3S4QRIZBQUCDUXZ7GWUNIPOQVWN7OOFX \
  --source moi \
  --network testnet \
  -- deposit \
  --from GBRHOUDYVMYERRSFYOELPSZMKSIAFAXHEGGGTLQ5YUZ7GXPQZ5I5R5WH \
  --amount 1000000000
```

Amounts are expressed in stroops: `1000000000` stroops equals `100 XLM`.

### TypeScript build

To compile the TypeScript prototype:

```bash
npm install
npm run build
```

## License

This project is open-source and built for the Stellar/Soroban hackathon.

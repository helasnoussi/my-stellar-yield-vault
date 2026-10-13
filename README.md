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

- **Vault Contract ID:** `CBQNINP25MA4GE45V4CY42UFBEAZ24O2U2MBR53NBA25DV5EERYAB3SO`
- **Underlying Token (Native XLM):** `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`
- **Admin Account:** `GBRHOUDYVMYERRSFYOELPSZMKSIAFAXHEGGGTLQ5YUZ7GXPQZ5I5R5WH`

## Autonomous agent

`agent.js` implements a conservative hybrid rebalancer:

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
- Stellar CLI (`stellar`)

### Build Contract

```bash
cargo build --target wasm32v1-none --release
```

Interact with the Vault (example):

```bash
stellar contract invoke \
  --contract-id CBQNINP25MA4GE45V4CY42UFBEAZ24O2U2MBR53NBA25DV5EERYAB3SO \
  --source moi \
  --network testnet \
  -- deposit \
  --from GBRHOUDYVMYERRSFYOELPSZMKSIAFAXHEGGGTLQ5YUZ7GXPQZ5I5R5WH \
  --amount 1000000000
```

Amounts are expressed in stroops: `1000000000` stroops equals `100 XLM`.

## License

This project is open-source and built for the Stellar/Soroban hackathon.

# 🌾 Stellar Smart Yield Vault

A decentralized yield vault smart contract built on Stellar using the Soroban SDK (v28.1.0). This project allows users to securely deposit assets into a yield-generating strategy on the Stellar Testnet.

## 🚀 Features
- **Secure Deposits:** Interacts cleanly with the Stellar Asset Contract (SAC) to handle token transfers.
- **Soroban Powered:** Written in Rust and optimized for the `wasm32v1-none` target.
- **Testnet Verified:** Fully deployed, initialized, and tested on Stellar Testnet.

---

## 📂 Deployment Details (Stellar Testnet)

- **Vault Contract ID:** `CBQTRKGTNZGQC7GCBCHDLR6R63DAYNCYL5OKUTVM2IZGBVTRXHMDU2KB`
- **Underlying Token (Native XLM):** `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`
- **Admin Account:** `GBRHOUDYVMYERRSFYOELPSZMKSIAFAXHEGGGTLQ5YUZ7GXPQZ5I5R5WH`

---

## 🛠️ Getting Started & Testing

### Prerequisites
- Rust toolchain (configured for `wasm32v1-none`)
- Stellar CLI (`soroban-cli`)

### Build Contract
```bash
cargo build --target wasm32v1-none --release

Interact with the Vault (Example: Deposit)

stellar contract invoke \
  --id CBQTRKGTNZGQC7GCBCHDLR6R63DAYNCYL5OKUTVM2IZGBVTRXHMDU2KB \
  --source mon_compte \
  --network testnet \
  -- deposit \
  --from GBRHOUDYVMYERRSFYOELPSZMKSIAFAXHEGGGTLQ5YUZ7GXPQZ5I5R5WH \
  --amount 100
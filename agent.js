import {
  Keypair,
  rpc,
  Horizon,
  Contract,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  Address,
  nativeToScVal,
  scValToNative,
} from "@stellar/stellar-sdk";
import dotenv from "dotenv";

dotenv.config();

// Global configuration
const rpcUrl = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
const horizonUrl = process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const networkPassphrase = Networks.TESTNET;
const contractId = process.env.CONTRACT_ID;
const minimumLiquidity = BigInt(process.env.MINIMUM_LIQUIDITY_STROOPS ?? "3000000000");
const maxInvestedBps = 7000n;
const maxOperation = BigInt(process.env.MAX_OPERATION_STROOPS ?? "1000000000");
const intervalMs = Number(process.env.AGENT_INTERVAL_MS ?? 3600000);
const executeTransactions = process.env.AGENT_EXECUTE === "true";
const ravenEnabled = process.env.RAVEN_ENABLED === "true";
const ravenUrl = process.env.RAVEN_MCP_URL ?? "https://raven.stellar.org/mcp";
const maxRiskScore = Number(process.env.MAX_RISK_SCORE ?? 3);
const minApyBps = Number(process.env.MIN_APY_BPS ?? 0);
let ravenSessionId;
let ravenRequestId = 1;

function parseStrategies(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const strategy = item.strategy ?? item;
    if (!strategy || typeof strategy !== "object") return [];
    const normalized = {
      name: String(strategy.name ?? strategy.protocol ?? "Unknown strategy"),
      contractId: strategy.contractId ?? strategy.contract_id,
      asset: String(strategy.asset ?? "XLM"),
      estimatedApyBps: Number(
        strategy.estimatedApyBps ?? Number(strategy.estimatedApy ?? 0) * 100,
      ),
      riskScore: Number(strategy.riskScore ?? strategy.risk ?? 99),
      liquidityStroops: BigInt(strategy.liquidityStroops ?? 0),
      feesBps: Number(strategy.feesBps ?? 0),
      source: String(strategy.source ?? "raven"),
    };
    return Number.isFinite(normalized.estimatedApyBps)
      && Number.isFinite(normalized.riskScore)
      && normalized.contractId
      ? [normalized]
      : [];
  });
}

async function ravenCall(method, params) {
  const token = process.env.RAVEN_OAUTH_TOKEN;
  if (!token) throw new Error("RAVEN_OAUTH_TOKEN missing");
  if (!ravenSessionId && method !== "initialize") {
    await ravenCall("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "stellar-yield-vault-agent", version: "0.1.0" },
    });
  }
  const id = ravenRequestId++;
  const response = await fetch(ravenUrl, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(ravenSessionId ? { "Mcp-Session-Id": ravenSessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  if (!response.ok) throw new Error(`Raven MCP HTTP ${response.status}`);
  ravenSessionId ??= response.headers.get("mcp-session-id");
  const text = await response.text();
  if (!text) return {};
  const jsonLine = text.split("\n").find((line) => line.startsWith("data:"));
  const payload = JSON.parse(jsonLine ? jsonLine.slice(5).trim() : text);
  if (payload.error) throw new Error(`Raven MCP error: ${payload.error.message}`);
  return payload.result;
}

async function discoverStrategies() {
  const configured = process.env.RAVEN_STRATEGIES_JSON;
  if (configured) return parseStrategies(JSON.parse(configured));
  if (!ravenEnabled) return [];

  const tools = await ravenCall("tools/list", {});
  const searchTool = tools.tools?.find((tool) => tool.name === "search");
  if (!searchTool) throw new Error("Raven MCP search tool unavailable");
  const result = await ravenCall("tools/call", {
    name: searchTool.name,
    arguments: {
      query: "Stellar XLM Soroban yield vault strategies APY risk liquidity",
    },
  });
  const content = result.content?.map((item) => item.text).filter(Boolean).join("\n");
  if (!content) return [];
  try {
    return parseStrategies(JSON.parse(content));
  } catch {
    console.warn("Raven returned context without machine-readable strategies");
    return [];
  }
}

function selectStrategy(strategies) {
  const eligible = strategies.filter((strategy) =>
    strategy.asset === "XLM"
    && strategy.riskScore <= maxRiskScore
    && strategy.estimatedApyBps >= minApyBps
    && strategy.liquidityStroops >= maxOperation,
  );
  return eligible.sort((a, b) =>
    (b.estimatedApyBps - b.feesBps) - (a.estimatedApyBps - a.feesBps)
  )[0];
}

async function getAuthenticatedServerAndAccount() {
  const secretKey = process.env.ADMIN_SECRET_KEY;
  if (!secretKey) throw new Error("ADMIN_SECRET_KEY missing in .env!");
  if (!contractId) throw new Error("CONTRACT_ID missing in .env!");

  const keypair = Keypair.fromSecret(secretKey);
  const server = new rpc.Server(rpcUrl, { allowHttp: true });
  const account = await server.getAccount(keypair.publicKey());

  return { server, keypair, account };
}

function assertAmount(amount) {
  const value = BigInt(amount);
  if (value <= 0n || value > maxOperation) {
    throw new Error(`Invalid operation amount: ${value} stroops`);
  }
  return value;
}

async function getPosition(server, keypair) {
  const account = await server.getAccount(keypair.publicKey());
  const horizon = new Horizon.Server(horizonUrl);
  const horizonAccount = await horizon.loadAccount(keypair.publicKey());
  const nativeBalance = horizonAccount.balances.find(
    (balance) => balance.asset_type === "native",
  );
  if (!nativeBalance) throw new Error("Native XLM balance not found");

  const walletStroops = BigInt(Math.round(Number(nativeBalance.balance) * 10_000_000));
  const contract = new Contract(contractId);
  const owner = new Address(keypair.publicKey()).toScVal();
  const simulation = await server.simulateTransaction(
    new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(contract.call("shares_of", owner))
      .setTimeout(30)
      .build(),
  );
  if (simulation.error) throw new Error(`shares_of simulation failed: ${simulation.error}`);

  const shares = BigInt(scValToNative(simulation.result.retval).toString());
  return { account, walletStroops, shares };
}

async function depositToVault(amount) {
  const { server, keypair, account } = await getAuthenticatedServerAndAccount();
  const contract = new Contract(contractId);
  const value = assertAmount(amount);

  console.log(`\n--- Depositing ${amount} tokens into YieldVault ---`);

  // Use Address class for the account public key
  const fromVal = new Address(keypair.publicKey()).toScVal();
  const amountVal = nativeToScVal(value, { type: "i128" });

  let transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call("deposit", fromVal, amountVal))
    .setTimeout(30)
    .build();

  transaction = await server.prepareTransaction(transaction);
  transaction.sign(keypair);

  if (!executeTransactions) {
    console.log("DRY RUN: deposit not submitted");
    return;
  }
  const response = await server.sendTransaction(transaction);
  console.log("Deposit transaction status:", response.status);
  if (response.hash) console.log("Hash:", response.hash);
}

async function withdrawFromVault(amount) {
  const { server, keypair, account } = await getAuthenticatedServerAndAccount();
  const contract = new Contract(contractId);
  const value = assertAmount(amount);

  console.log(`\n--- Withdrawing ${amount} tokens from YieldVault ---`);

  const toVal = new Address(keypair.publicKey()).toScVal();
  const amountVal = nativeToScVal(value, { type: "i128" });

  let transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call("withdraw", toVal, amountVal))
    .setTimeout(30)
    .build();

  transaction = await server.prepareTransaction(transaction);
  transaction.sign(keypair);

  if (!executeTransactions) {
    console.log("DRY RUN: withdrawal not submitted");
    return;
  }
  const response = await server.sendTransaction(transaction);
  console.log("Withdrawal transaction status:", response.status);
  if (response.hash) console.log("Hash:", response.hash);
}

async function rebalance() {
  const { server, keypair } = await getAuthenticatedServerAndAccount();
  const { walletStroops, shares } = await getPosition(server, keypair);
  const strategies = await discoverStrategies();
  const selected = selectStrategy(strategies);
  if (selected) {
    console.warn(
      "WARNING: risk score is simulated metadata and is not an audit or a guarantee of safety.",
    );
    console.log(
      `Strategy: ${selected.name} APY=${selected.estimatedApyBps / 100}% `
      + `risk=${selected.riskScore} liquidity=${selected.liquidityStroops} `
      + `source=${selected.source}`,
    );
    if (selected.contractId !== contractId) {
      console.log("Best strategy is informational only; no unsupported vault switch is executed");
    }
  } else if (ravenEnabled || process.env.RAVEN_STRATEGIES_JSON) {
    console.log("No Raven strategy passed the local safety filters");
  }
  const totalAssets = walletStroops + shares;
  const targetInvested = (totalAssets * maxInvestedBps) / 10_000n;
  const maxSafeWithdrawal = walletStroops > minimumLiquidity
    ? walletStroops - minimumLiquidity
    : 0n;
  const depositAmount = targetInvested > shares ? targetInvested - shares : 0n;
  const withdrawalAmount = shares > targetInvested ? shares - targetInvested : 0n;

  console.log(`Position: wallet=${walletStroops} shares=${shares}`);
  if (depositAmount > 0n && walletStroops - depositAmount >= minimumLiquidity) {
    await depositToVault(depositAmount > maxOperation ? maxOperation : depositAmount);
  } else if (withdrawalAmount > 0n && maxSafeWithdrawal > 0n) {
    const amount = withdrawalAmount > maxSafeWithdrawal ? maxSafeWithdrawal : withdrawalAmount;
    await withdrawFromVault(amount > maxOperation ? maxOperation : amount);
  } else {
    console.log("No rebalance required");
  }
}

async function main() {
  await rebalance();
  if (process.env.AGENT_ONCE === "true") return;
  setInterval(() => rebalance().catch((error) => console.error("Rebalance failed:", error)), intervalMs);
}

main().catch(console.error);
import {
    Keypair,
    Networks,
    rpc,
    TransactionBuilder,
    nativeToScVal,
    scValToNative,
    Contract,
    BASE_FEE,
    type xdr,
} from "@stellar/stellar-sdk";
import * as dotenv from "dotenv";
import { readFileSync, writeFileSync } from "node:fs";
import {
    estimateReserve,
    formatDuration,
    formatPercent,
    formatXlm,
    loadEventSamples,
    measureRealizedYield,
    mergeSamples,
    type BlendReserve,
    type RateSample,
    type RealizedYield,
} from "./blend-rates.js";

dotenv.config();

// Network and Soroban RPC server configuration (Testnet)
const RPC_URL = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = Networks.TESTNET;
const server = new rpc.Server(RPC_URL);

// The signing account must be the agent configured on the contract.
const BOT_SECRET = process.env.AGENT_SECRET_KEY ?? process.env.ADMIN_SECRET_KEY;
const configuredContractId = process.env.CONTRACT_ID;
const AGENT_ONCE = process.env.AGENT_ONCE !== "false";
// Dry-run by default: only AGENT_EXECUTE=true sends transactions.
const AGENT_EXECUTE = process.env.AGENT_EXECUTE === "true";
const AGENT_INTERVAL_MS = Number(process.env.AGENT_INTERVAL_MS ?? "3600000");

// Local safety limits
const MIN_APY_BPS = Number(process.env.MIN_APY_BPS ?? "0");
const MINIMUM_LIQUIDITY = BigInt(process.env.MINIMUM_LIQUIDITY_STROOPS ?? "3000000000");
const MAX_OPERATION = BigInt(process.env.MAX_OPERATION_STROOPS ?? "1000000000");
const IDLE_RESERVE = BigInt(process.env.VAULT_IDLE_RESERVE_STROOPS ?? "300000000");
const MIN_ACTION = BigInt(process.env.MIN_ACTION_STROOPS ?? "10000000");

// Realized yield measurement
const REALIZED_WINDOW_SECONDS = Number(process.env.REALIZED_WINDOW_SECONDS ?? "604800");
const REALIZED_MIN_SECONDS = Number(process.env.REALIZED_MIN_SECONDS ?? "3600");
const AGENT_STATE_FILE = process.env.AGENT_STATE_FILE ?? ".agent-state.json";

if (!BOT_SECRET) {
    throw new Error("AGENT_SECRET_KEY or ADMIN_SECRET_KEY must be configured");
}
if (!configuredContractId) {
    throw new Error("CONTRACT_ID must be configured");
}
if (!Number.isInteger(AGENT_INTERVAL_MS) || AGENT_INTERVAL_MS <= 0) {
    throw new Error("AGENT_INTERVAL_MS must be a positive integer");
}

const botKeypair = Keypair.fromSecret(BOT_SECRET);
const vault = new Contract(configuredContractId);

// Lock to prevent overlapping execution loops
let isExecuting = false;

type PoolState = {
    id: number;
    address: string;
    // Annualized from the pool's current parameters: assumes nothing changes for a year
    instantAprBps: number;
    // Measured from the b_rate's past growth, when enough history exists
    realized: RealizedYield | undefined;
    // Rate used for decisions: realized when available, instant otherwise
    decisionAprBps: number;
    availableLiquidity: bigint;
    enabled: boolean;
    position: bigint;
};

type Action =
    | { kind: "allocate" | "deallocate"; poolId: number; amount: bigint; reason: string }
    | { kind: "hold"; reason: string };

async function runAIAgentLoop() {
    if (isExecuting) {
        console.log("⏳ [AI Agent] An analysis is already in progress, skipping this cycle...");
        return;
    }

    isExecuting = true;
    try {
        console.log("\n--------------------------------------------------");
        console.log("🤖 [AI Agent] Starting a new analysis cycle");

        const token = String(await simulate(vault, "token"));
        const idle = BigInt(
            (await simulate(new Contract(token), "balance", addressArg(vault.contractId()))) as bigint,
        );
        const pools = await loadPools(token);

        console.log(`💰 Idle in vault: ${formatXlm(idle)}`);
        for (const pool of pools) {
            const realized = pool.realized
                ? `realized ${formatPercent(pool.realized.periodReturn * 10_000)} over ` +
                  `${formatDuration(pool.realized.periodSeconds)} ` +
                  `(≈ ${formatPercent(pool.realized.annualizedBps)}/yr)`
                : "realized yield: not enough history, deciding on the instant rate";
            console.log(
                `📊 Pool ${pool.id} (${pool.address.slice(0, 8)}…)` +
                (pool.enabled ? "" : " [disabled]") + "\n" +
                `   instant annualized rate (estimate): ${formatPercent(pool.instantAprBps)}/yr\n` +
                `   ${realized}\n` +
                `   available ${formatXlm(pool.availableLiquidity)}, vault position ${formatXlm(pool.position)}`,
            );
        }

        const action = decideAction(idle, pools);
        if (action.kind === "hold") {
            console.log(`💤 Hold: ${action.reason}`);
            return;
        }

        console.log(`💡 ${action.kind} ${formatXlm(action.amount)} on pool ${action.poolId}: ${action.reason}`);
        await invokeVault(
            action.kind,
            nativeToScVal(action.poolId, { type: "u32" }),
            nativeToScVal(action.amount, { type: "i128" }),
        );
    } catch (error) {
        console.error("❌ [AI Agent] Error in cycle:", error);
    } finally {
        isExecuting = false;
        console.log("💤 [AI Agent] Cycle finished.");
    }
}

function isEligible(pool: PoolState): boolean {
    return (
        pool.enabled &&
        pool.decisionAprBps >= MIN_APY_BPS &&
        pool.availableLiquidity >= MINIMUM_LIQUIDITY
    );
}

function decideAction(idle: bigint, pools: PoolState[]): Action {
    const capped = (amount: bigint) => (amount > MAX_OPERATION ? MAX_OPERATION : amount);

    // 1. Exit pools that no longer pass the safety filters
    const unsafe = pools.find((pool) => pool.position >= MIN_ACTION && !isEligible(pool));
    if (unsafe) {
        return {
            kind: "deallocate",
            poolId: unsafe.id,
            amount: capped(unsafe.position),
            reason: "pool no longer passes the safety filters",
        };
    }

    // 2. Refill the idle reserve used for withdrawals, from the lowest-yield pool
    if (idle < IDLE_RESERVE) {
        const source = pools
            .filter((pool) => pool.position >= MIN_ACTION)
            .sort((a, b) => a.decisionAprBps - b.decisionAprBps)[0];
        const missing = IDLE_RESERVE - idle;
        if (source && missing >= MIN_ACTION) {
            const amount = missing < source.position ? missing : source.position;
            return {
                kind: "deallocate",
                poolId: source.id,
                amount: capped(amount),
                reason: `refill the ${formatXlm(IDLE_RESERVE)} idle reserve`,
            };
        }
        return { kind: "hold", reason: "idle reserve below target and nothing to withdraw" };
    }

    // 3. Put the excess above the reserve to work in the best eligible pool
    const excess = idle - IDLE_RESERVE;
    if (excess < MIN_ACTION) {
        return { kind: "hold", reason: "no excess above the idle reserve" };
    }
    const best = pools.filter(isEligible).sort((a, b) => b.decisionAprBps - a.decisionAprBps)[0];
    if (!best) {
        return { kind: "hold", reason: "no pool passes the safety filters" };
    }
    return {
        kind: "allocate",
        poolId: best.id,
        amount: capped(excess),
        reason: best.realized
            ? `best realized yield (≈ ${formatPercent(best.decisionAprBps)}/yr over ${formatDuration(best.realized.periodSeconds)})`
            : `best instant rate (${formatPercent(best.decisionAprBps)}/yr, no history yet)`,
    };
}

async function loadPools(token: string): Promise<PoolState[]> {
    const registry = (await simulate(vault, "pools")) as Record<string, string>;
    const history = loadHistory();
    const states: PoolState[] = [];

    for (const [id, address] of Object.entries(registry)) {
        const pool = new Contract(address);
        const [reserve, config, position, eventSamples] = await Promise.all([
            simulate(pool, "get_reserve", addressArg(token)) as Promise<BlendReserve>,
            simulate(pool, "get_config") as Promise<{ bstop_rate: number }>,
            simulate(vault, "pool_assets", nativeToScVal(Number(id), { type: "u32" })),
            loadEventSamples(server, address, token, REALIZED_WINDOW_SECONDS),
        ]);

        // get_reserve accrues interest up to now, so (last_time, b_rate) is a current sample
        const current: RateSample = {
            time: Number(reserve.data.last_time),
            bRate: BigInt(reserve.data.b_rate),
        };
        const samples = mergeSamples(history[address] ?? [], eventSamples, [current]);
        history[address] = samples;

        const estimate = estimateReserve(reserve, Number(config.bstop_rate));
        const realized = measureRealizedYield(samples, current, REALIZED_WINDOW_SECONDS, REALIZED_MIN_SECONDS);
        states.push({
            id: Number(id),
            address,
            instantAprBps: estimate.supplyAprBps,
            realized,
            decisionAprBps: realized?.annualizedBps ?? estimate.supplyAprBps,
            availableLiquidity: estimate.availableLiquidity,
            enabled: estimate.enabled,
            position: BigInt(position as bigint),
        });
    }

    saveHistory(history);
    return states;
}

type History = Record<string, RateSample[]>;

// Local b_rate history, kept beyond the RPC's event retention
function loadHistory(): History {
    try {
        const raw = JSON.parse(readFileSync(AGENT_STATE_FILE, "utf8")) as Record<string, { time: number; bRate: string }[]>;
        return Object.fromEntries(
            Object.entries(raw).map(([pool, samples]) => [
                pool,
                samples.map((sample) => ({ time: sample.time, bRate: BigInt(sample.bRate) })),
            ]),
        );
    } catch {
        return {};
    }
}

function saveHistory(history: History) {
    const serialized = Object.fromEntries(
        Object.entries(history).map(([pool, samples]) => [
            pool,
            samples.map((sample) => ({ time: sample.time, bRate: sample.bRate.toString() })),
        ]),
    );
    writeFileSync(AGENT_STATE_FILE, JSON.stringify(serialized, null, 2));
}

function addressArg(address: string): xdr.ScVal {
    return nativeToScVal(address, { type: "address" });
}

// Read-only call through simulation: nothing is signed or sent
async function simulate(contract: Contract, method: string, ...args: xdr.ScVal[]): Promise<unknown> {
    const account = await server.getAccount(botKeypair.publicKey());
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
        .addOperation(contract.call(method, ...args))
        .setTimeout(30)
        .build();

    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
        throw new Error(`${method} simulation failed: ${sim.error}`);
    }
    if (!sim.result) {
        throw new Error(`${method} simulation returned no result`);
    }
    return scValToNative(sim.result.retval);
}

async function invokeVault(method: string, ...args: xdr.ScVal[]) {
    const account = await server.getAccount(botKeypair.publicKey());
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
        .addOperation(vault.call(method, ...args))
        .setTimeout(60)
        .build();

    // Simulates and adds the Soroban footprint/resources; fails if the contract would reject it
    console.log("🔍 Simulating and preparing transaction");
    const preparedTx = await server.prepareTransaction(tx);

    if (!AGENT_EXECUTE) {
        console.log(`🧪 Dry run: ${method} simulated, not sent (set AGENT_EXECUTE=true to send).`);
        return;
    }

    preparedTx.sign(botKeypair);
    console.log("🚀 Sending transaction to the Soroban network");
    const response = await server.sendTransaction(preparedTx);
    if (response.status !== "PENDING") {
        throw new Error(`Transaction rejected (${response.status}): ${JSON.stringify(response.errorResult ?? response)}`);
    }

    const result = await server.pollTransaction(response.hash, { attempts: 30 });
    if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
        throw new Error(`${method} failed (${result.status}), hash: ${response.hash}`);
    }
    console.log(`✅ ${method} confirmed. Hash: ${response.hash}`);
}

// ==========================================
// AGENT LAUNCH
// ==========================================
void runAIAgentLoop();

if (!AGENT_ONCE) {
    setInterval(() => void runAIAgentLoop(), AGENT_INTERVAL_MS);
}

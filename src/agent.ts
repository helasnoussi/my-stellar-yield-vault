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

// Blend v2 fixed-point scales (pool/src/constants.rs)
const SCALAR_7 = 10_000_000;
const SCALAR_12 = 1_000_000_000_000n;
const SECONDS_PER_YEAR = 31_536_000;
// Below this size, an event's b_tokens rounding makes its implied b_rate too noisy
const MIN_EVENT_B_TOKENS = 1_000_000n;
const MAX_EVENT_PAGES = 50;

// Lock to prevent overlapping execution loops
let isExecuting = false;

// One observation of a pool's b_rate (value of one supplied b_token, 12 decimals)
type RateSample = { time: number; bRate: bigint };

type RealizedYield = {
    periodReturn: number; // e.g. 0.035 for +3.5 % over the period
    periodSeconds: number;
    annualizedBps: number;
};

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
            loadEventSamples(address, token),
        ]);

        // get_reserve accrues interest up to now, so (last_time, b_rate) is a current sample
        const current: RateSample = {
            time: Number(reserve.data.last_time),
            bRate: BigInt(reserve.data.b_rate),
        };
        const samples = mergeSamples(history[address] ?? [], eventSamples, [current]);
        history[address] = samples;

        const estimate = estimateReserve(reserve, Number(config.bstop_rate));
        const realized = measureRealizedYield(samples, current);
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

// Realized yield: growth of the b_rate between the oldest sample in the window and now.
// It is what suppliers actually earned over that period, not a projection.
function measureRealizedYield(samples: RateSample[], current: RateSample): RealizedYield | undefined {
    const start = samples.find((sample) => sample.time >= current.time - REALIZED_WINDOW_SECONDS);
    if (!start) return undefined;
    const periodSeconds = current.time - start.time;
    if (periodSeconds < REALIZED_MIN_SECONDS) return undefined;

    const periodReturn = Number(current.bRate) / Number(start.bRate) - 1;
    return {
        periodReturn,
        periodSeconds,
        annualizedBps: Math.round(periodReturn * (SECONDS_PER_YEAR / periodSeconds) * 10_000),
    };
}

// Past b_rates implied by Blend's supply/withdraw events (tokens / b_tokens).
// Stellar RPC keeps about 7 days of events.
async function loadEventSamples(poolAddress: string, token: string): Promise<RateSample[]> {
    const topics = ["supply", "withdraw"].map((name) => [
        nativeToScVal(name, { type: "symbol" }).toXDR("base64"),
        addressArg(token).toXDR("base64"),
        "*",
    ]);
    const filters = [{ type: "contract" as const, contractIds: [poolAddress], topics }];
    const samples: RateSample[] = [];

    try {
        const { oldestLedger } = await server.getHealth();
        let page = await server.getEvents({ startLedger: oldestLedger + 1, filters, limit: 200 });
        for (let i = 0; i < MAX_EVENT_PAGES; i++) {
            for (const event of page.events) {
                const [tokens, bTokens] = (scValToNative(event.value) as bigint[]).map(BigInt);
                if (tokens === undefined || bTokens === undefined || bTokens < MIN_EVENT_B_TOKENS) continue;
                samples.push({
                    time: Math.floor(Date.parse(event.ledgerClosedAt) / 1000),
                    bRate: (tokens * SCALAR_12) / bTokens,
                });
            }
            if (page.events.length === 0 || page.latestLedger <= (page.events.at(-1)?.ledger ?? 0)) break;
            page = await server.getEvents({ cursor: page.cursor, filters, limit: 200 });
        }
    } catch (error) {
        console.warn(`⚠️ Could not read Blend events for ${poolAddress.slice(0, 8)}…:`, error);
    }
    return samples;
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

// Sorted by time, one sample per second, limited to the last 30 days
function mergeSamples(...lists: RateSample[][]): RateSample[] {
    const byTime = new Map<number, RateSample>();
    for (const sample of lists.flat()) byTime.set(sample.time, sample);
    const newest = Math.max(...byTime.keys());
    return [...byTime.values()]
        .filter((sample) => sample.time >= newest - 30 * 24 * 3600)
        .sort((a, b) => a.time - b.time);
}

type BlendReserve = {
    config: {
        enabled: boolean;
        util: number;
        r_base: number;
        r_one: number;
        r_two: number;
        r_three: number;
    };
    data: {
        b_rate: bigint;
        b_supply: bigint;
        d_rate: bigint;
        d_supply: bigint;
        ir_mod: bigint;
        last_time: bigint;
    };
};

// Instant supply rate from Blend v2's interest rate model (pool/src/pool/interest.rs),
// annualized as if the pool's utilization and rate modifier stayed the same for a year.
// It moves as soon as borrowers repay or suppliers arrive: an estimate, not a forecast.
function estimateReserve(reserve: BlendReserve, bstopRate: number) {
    const { config, data } = reserve;
    const totalSupply = (BigInt(data.b_supply) * BigInt(data.b_rate)) / SCALAR_12;
    const totalLiabilities = (BigInt(data.d_supply) * BigInt(data.d_rate)) / SCALAR_12;
    const availableLiquidity = totalSupply > totalLiabilities ? totalSupply - totalLiabilities : 0n;

    const util = totalSupply === 0n ? 0 : Math.min(Number(totalLiabilities) / Number(totalSupply), 1);
    const target = config.util / SCALAR_7;
    const irMod = Number(data.ir_mod) / SCALAR_7;
    const rBase = config.r_base / SCALAR_7;
    const rOne = config.r_one / SCALAR_7;
    const rTwo = config.r_two / SCALAR_7;
    const rThree = config.r_three / SCALAR_7;

    let borrowApr: number;
    if (util <= target) {
        borrowApr = (rBase + rOne * (util / target)) * irMod;
    } else if (util <= 0.95) {
        borrowApr = (rBase + rOne + rTwo * ((util - target) / (0.95 - target))) * irMod;
    } else {
        borrowApr = (rBase + rOne + rTwo) * irMod + rThree * ((util - 0.95) / 0.05);
    }

    const supplyApr = borrowApr * util * (1 - bstopRate / SCALAR_7);
    return {
        supplyAprBps: Math.round(supplyApr * 10_000),
        availableLiquidity,
        enabled: config.enabled,
    };
}

function addressArg(address: string): xdr.ScVal {
    return nativeToScVal(address, { type: "address" });
}

function formatPercent(bps: number): string {
    return `${(bps / 100).toFixed(2)}%`;
}

function formatDuration(seconds: number): string {
    if (seconds >= 2 * 86_400) return `${(seconds / 86_400).toFixed(1)} days`;
    return `${(seconds / 3600).toFixed(1)} h`;
}

function formatXlm(stroops: bigint): string {
    return `${(Number(stroops) / 1e7).toFixed(2)} XLM`;
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

// Blend v2 yield measurement shared by the agent and the web app.
// Pure computations plus read-only RPC calls: nothing here signs or sends.
import { nativeToScVal, scValToNative, type rpc } from "@stellar/stellar-sdk";

// Blend v2 fixed-point scales (pool/src/constants.rs)
export const SCALAR_7 = 10_000_000;
export const SCALAR_12 = 1_000_000_000_000n;
export const SECONDS_PER_YEAR = 31_536_000;
// Below this size, an event's b_tokens rounding makes its implied b_rate too noisy
const MIN_EVENT_B_TOKENS = 1_000_000n;
const MAX_EVENT_PAGES = 50;

// One observation of a pool's b_rate (value of one supplied b_token, 12 decimals)
export type RateSample = { time: number; bRate: bigint };

export type RealizedYield = {
    periodReturn: number; // e.g. 0.035 for +3.5 % over the period
    periodSeconds: number;
    annualizedBps: number;
};

export type BlendReserve = {
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
export function estimateReserve(reserve: BlendReserve, bstopRate: number) {
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

// Realized yield: growth of the b_rate between the oldest sample in the window and now.
// It is what suppliers actually earned over that period, not a projection.
export function measureRealizedYield(
    samples: RateSample[],
    current: RateSample,
    windowSeconds: number,
    minSeconds: number,
): RealizedYield | undefined {
    const start = samples.find((sample) => sample.time >= current.time - windowSeconds);
    if (!start) return undefined;
    const periodSeconds = current.time - start.time;
    if (periodSeconds < minSeconds) return undefined;

    const periodReturn = Number(current.bRate) / Number(start.bRate) - 1;
    return {
        periodReturn,
        periodSeconds,
        annualizedBps: Math.round(periodReturn * (SECONDS_PER_YEAR / periodSeconds) * 10_000),
    };
}

// ~5 s per ledger
export const LEDGERS_PER_DAY = 17_280;
// ~5 min of ledgers
const OLDEST_LEDGER_MARGIN = 60;

// Events matching `filters` from `sinceSeconds` ago (capped to what the RPC keeps,
// about 7 days). The RPC scans the ledger range in chunks: an empty page does not
// mean the end, so pages are followed until the cursor reaches the latest ledger.
// With `firstPageOnly`, it stops at the first page holding events (the oldest ones).
export async function fetchEvents(
    server: rpc.Server,
    filters: rpc.Api.EventFilter[],
    sinceSeconds: number,
    firstPageOnly = false,
): Promise<rpc.Api.EventResponse[]> {
    const { oldestLedger, latestLedger } = await server.getHealth();
    const wanted = latestLedger - Math.ceil((sinceSeconds / 86_400) * LEDGERS_PER_DAY);
    // The RPC prunes old ledgers continuously: a margin keeps startLedger in range
    // by the time getEvents runs
    const startLedger = Math.max(oldestLedger + OLDEST_LEDGER_MARGIN, wanted);
    const events: rpc.Api.EventResponse[] = [];
    let page = await server.getEvents({ startLedger, filters, limit: 200 });
    for (let i = 0; i < MAX_EVENT_PAGES; i++) {
        events.push(...page.events);
        if (firstPageOnly && events.length > 0) break;
        // The cursor is a TOID: its high 32 bits are the ledger sequence
        const cursorLedger = Number(BigInt(page.cursor.split("-")[0] ?? "0") >> 32n);
        if (!page.cursor || cursorLedger >= page.latestLedger) break;
        page = await server.getEvents({ cursor: page.cursor, filters, limit: 200 });
    }
    return events;
}

// Oldest b_rates in the window, implied by Blend's supply/withdraw events
// (tokens / b_tokens). The realized yield only needs the oldest sample.
export async function loadEventSamples(
    server: rpc.Server,
    poolAddress: string,
    token: string,
    windowSeconds: number,
): Promise<RateSample[]> {
    const topics = ["supply", "withdraw"].map((name) => [
        nativeToScVal(name, { type: "symbol" }).toXDR("base64"),
        nativeToScVal(token, { type: "address" }).toXDR("base64"),
        "*",
    ]);
    const samples: RateSample[] = [];

    try {
        const filters = [{ type: "contract" as const, contractIds: [poolAddress], topics }];
        const events = await fetchEvents(server, filters, windowSeconds, true);
        for (const event of events) {
            const [tokens, bTokens] = (scValToNative(event.value) as bigint[]).map(BigInt);
            if (tokens === undefined || bTokens === undefined || bTokens < MIN_EVENT_B_TOKENS) continue;
            samples.push({
                time: Math.floor(Date.parse(event.ledgerClosedAt) / 1000),
                bRate: (tokens * SCALAR_12) / bTokens,
            });
        }
    } catch (error) {
        console.warn(`⚠️ Could not read Blend events for ${poolAddress.slice(0, 8)}…:`, error);
    }
    return samples;
}

// Sorted by time, one sample per second, limited to the last 30 days
export function mergeSamples(...lists: RateSample[][]): RateSample[] {
    const byTime = new Map<number, RateSample>();
    for (const sample of lists.flat()) byTime.set(sample.time, sample);
    const newest = Math.max(...byTime.keys());
    return [...byTime.values()]
        .filter((sample) => sample.time >= newest - 30 * 24 * 3600)
        .sort((a, b) => a.time - b.time);
}

export function formatPercent(bps: number): string {
    return `${(bps / 100).toFixed(2)}%`;
}

export function formatDuration(seconds: number): string {
    if (seconds >= 2 * 86_400) return `${(seconds / 86_400).toFixed(1)} days`;
    return `${(seconds / 3600).toFixed(1)} h`;
}

export function formatXlm(stroops: bigint): string {
    return `${(Number(stroops) / 1e7).toFixed(2)} XLM`;
}

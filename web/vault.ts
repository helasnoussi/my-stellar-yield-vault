// Reads the vault and its Blend pools, and sends user transactions signed by Freighter.
import {
    Account,
    Contract,
    Keypair,
    TransactionBuilder,
    BASE_FEE,
    Networks,
    nativeToScVal,
    rpc,
    scValToNative,
    type xdr,
} from "@stellar/stellar-sdk";
import { signTransaction } from "@stellar/freighter-api";
import {
    estimateReserve,
    fetchEvents,
    loadEventSamples,
    measureRealizedYield,
    type BlendReserve,
    type RealizedYield,
} from "../src/blend-rates.js";

export const CONTRACT_ID =
    import.meta.env.VITE_CONTRACT_ID ?? "CDYRFTVVJNU25W54E2H42I2YLCR3SATYLWFON6LSBFGS5GHIB4QIXSGY";
export const RPC_URL = import.meta.env.VITE_RPC_URL ?? "https://soroban-testnet.stellar.org";
export const NETWORK_PASSPHRASE = Networks.TESTNET;
export const MAX_OPERATION_STROOPS = 1_000_000_000n;
export const EXPLORER = "https://stellar.expert/explorer/testnet";

const REALIZED_WINDOW_SECONDS = 7 * 86_400;
const REALIZED_MIN_SECONDS = 3_600;
const ACTIVITY_WINDOW_SECONDS = 3 * 86_400;

const server = new rpc.Server(RPC_URL);
const vault = new Contract(CONTRACT_ID);
// Read-only simulations do not need a funded source account
const readSource = Keypair.random().publicKey();

export type PoolView = {
    id: number;
    address: string;
    instantAprBps: number;
    realized: RealizedYield | undefined;
    availableLiquidity: bigint;
    enabled: boolean;
    position: bigint;
};

export type VaultView = {
    token: string;
    totalAssets: bigint;
    idle: bigint;
    pools: PoolView[];
};

export type UserView = {
    walletBalance: bigint;
    shares: bigint;
    value: bigint;
};

export type Activity = {
    kind: "deposit" | "withdraw" | "allocated" | "deallocated";
    account?: string;
    poolId?: number;
    amount: bigint;
    time: Date;
    txHash: string;
};

async function simulate(contract: Contract, method: string, ...args: xdr.ScVal[]): Promise<unknown> {
    const tx = new TransactionBuilder(new Account(readSource, "0"), {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
    })
        .addOperation(contract.call(method, ...args))
        .setTimeout(30)
        .build();
    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw new Error(`${method} failed: ${sim.error}`);
    if (!sim.result) throw new Error(`${method} returned no result`);
    return scValToNative(sim.result.retval);
}

const address = (value: string) => nativeToScVal(value, { type: "address" });

export async function loadVault(): Promise<VaultView> {
    const token = String(await simulate(vault, "token"));
    const [totalAssets, idle, registry] = await Promise.all([
        simulate(vault, "total_assets"),
        simulate(new Contract(token), "balance", address(CONTRACT_ID)),
        simulate(vault, "pools") as Promise<Record<string, string>>,
    ]);

    const pools = await Promise.all(
        Object.entries(registry).map(async ([id, poolAddress]): Promise<PoolView> => {
            const pool = new Contract(poolAddress);
            const [reserve, config, position, samples] = await Promise.all([
                simulate(pool, "get_reserve", address(token)) as Promise<BlendReserve>,
                simulate(pool, "get_config") as Promise<{ bstop_rate: number }>,
                simulate(vault, "pool_assets", nativeToScVal(Number(id), { type: "u32" })),
                loadEventSamples(server, poolAddress, token, REALIZED_WINDOW_SECONDS),
            ]);
            const current = { time: Number(reserve.data.last_time), bRate: BigInt(reserve.data.b_rate) };
            const estimate = estimateReserve(reserve, Number(config.bstop_rate));
            return {
                id: Number(id),
                address: poolAddress,
                instantAprBps: estimate.supplyAprBps,
                realized: measureRealizedYield(
                    [...samples, current],
                    current,
                    REALIZED_WINDOW_SECONDS,
                    REALIZED_MIN_SECONDS,
                ),
                availableLiquidity: estimate.availableLiquidity,
                enabled: estimate.enabled,
                position: BigInt(position as bigint),
            };
        }),
    );

    return { token, totalAssets: BigInt(totalAssets as bigint), idle: BigInt(idle as bigint), pools };
}

export async function loadUser(token: string, user: string): Promise<UserView> {
    const [walletBalance, shares, value] = await Promise.all([
        simulate(new Contract(token), "balance", address(user)),
        simulate(vault, "shares_of", address(user)),
        simulate(vault, "balance_of", address(user)),
    ]);
    return {
        walletBalance: BigInt(walletBalance as bigint),
        shares: BigInt(shares as bigint),
        value: BigInt(value as bigint),
    };
}

// Deposit, Withdraw, Allocated and Deallocated events of the last few days
export async function loadActivity(): Promise<Activity[]> {
    const events = await fetchEvents(
        server,
        [{ type: "contract", contractIds: [CONTRACT_ID] }],
        ACTIVITY_WINDOW_SECONDS,
    );
    return events
        .flatMap((event): Activity[] => {
            const [name, topic] = event.topic.map((part) => scValToNative(part) as unknown);
            const kind = String(name);
            if (kind !== "deposit" && kind !== "withdraw" && kind !== "allocated" && kind !== "deallocated") {
                return [];
            }
            const base = {
                kind,
                amount: BigInt(scValToNative(event.value) as bigint),
                time: new Date(event.ledgerClosedAt),
                txHash: event.txHash,
            } as const;
            return kind === "deposit" || kind === "withdraw"
                ? [{ ...base, account: String(topic) }]
                : [{ ...base, poolId: Number(topic) }];
        })
        .reverse();
}

// Builds, simulates, has Freighter sign, sends, and waits for confirmation
export async function sendVaultCall(user: string, method: "deposit" | "withdraw", amount: bigint) {
    const account = await server.getAccount(user);
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
        .addOperation(vault.call(method, address(user), nativeToScVal(amount, { type: "i128" })))
        .setTimeout(120)
        .build();
    const prepared = await server.prepareTransaction(tx);

    const signed = await signTransaction(prepared.toXDR(), {
        networkPassphrase: NETWORK_PASSPHRASE,
        address: user,
    });
    if (signed.error) throw new Error(signed.error.message ?? "Signature refused");

    const response = await server.sendTransaction(
        TransactionBuilder.fromXDR(signed.signedTxXdr, NETWORK_PASSPHRASE),
    );
    if (response.status !== "PENDING") {
        throw new Error(`Transaction rejected (${response.status})`);
    }
    const result = await server.pollTransaction(response.hash, { attempts: 30 });
    if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
        throw new Error(`Transaction failed (${result.status})`);
    }
    return response.hash;
}

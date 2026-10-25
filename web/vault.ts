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
    type Operation,
    type Transaction,
    scValToNative,
    xdr,
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
    import.meta.env.VITE_CONTRACT_ID ?? "CCFMO6ZSC3ENVKDCNXLYSUTLGPVLWAKCM6CZPCYXTBRHIQVI3KMWYOHM";
export const RPC_URL = import.meta.env.VITE_RPC_URL ?? "https://soroban-testnet.stellar.org";
export const NETWORK_PASSPHRASE = Networks.TESTNET;
export const MAX_OPERATION_STROOPS = 1_000_000_000n;
export const EXPLORER = "https://stellar.expert/explorer/testnet";

const REALIZED_WINDOW_SECONDS = 7 * 86_400;
const REALIZED_MIN_SECONDS = 3_600;
const ACTIVITY_WINDOW_SECONDS = 7 * 86_400;

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
    admin: string;
    paused: boolean;
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
    kind: "deposit" | "withdraw" | "allocated" | "deallocated" | "paused" | "unpaused" | "transfer";
    account?: string;
    // Recipient of a svXLM transfer; its amount is in shares, not XLM
    to?: string;
    poolId?: number;
    amount?: bigint;
    // Who triggered a deallocation: the agent, the admin's emergency withdraw,
    // or a user withdrawal that needed more than the idle funds
    by?: "agent" | "admin" | "withdrawal";
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
const poolIdVal = (poolId: number) => nativeToScVal(poolId, { type: "u32" });

// The contract has no admin() getter: read DataKey::Admin from its instance storage
async function readAdmin(): Promise<string> {
    const entry = await server.getContractData(
        CONTRACT_ID,
        xdr.ScVal.scvLedgerKeyContractInstance(),
        rpc.Durability.Persistent,
    );
    const data = entry.val;
    if (data.type !== "contractData" || data.contractData.val.type !== "scvContractInstance") {
        throw new Error("Unexpected vault instance entry");
    }
    const admin = (data.contractData.val.instance.storage ?? []).find((item) => {
        const key = scValToNative(item.key) as unknown;
        return Array.isArray(key) && key[0] === "Admin";
    });
    if (!admin) throw new Error("Admin not found in the vault storage");
    return String(scValToNative(admin.val));
}

export async function loadVault(): Promise<VaultView> {
    const [tokenId, admin] = await Promise.all([simulate(vault, "token"), readAdmin()]);
    const token = String(tokenId);
    const [totalAssets, idle, registry, paused] = await Promise.all([
        simulate(vault, "total_assets"),
        simulate(new Contract(token), "balance", address(CONTRACT_ID)),
        simulate(vault, "pools") as Promise<Record<string, string>>,
        simulate(vault, "is_paused"),
    ]);

    const pools = await Promise.all(
        Object.entries(registry).map(async ([id, poolAddress]): Promise<PoolView> => {
            const pool = new Contract(poolAddress);
            const [reserve, config, position, samples] = await Promise.all([
                simulate(pool, "get_reserve", address(token)) as Promise<BlendReserve>,
                simulate(pool, "get_config") as Promise<{ bstop_rate: number }>,
                simulate(vault, "pool_assets", poolIdVal(Number(id))),
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

    return {
        token,
        admin,
        paused: Boolean(paused),
        totalAssets: BigInt(totalAssets as bigint),
        idle: BigInt(idle as bigint),
        pools,
    };
}

export async function loadUser(token: string, user: string): Promise<UserView> {
    const [walletBalance, shares, value] = await Promise.all([
        simulate(new Contract(token), "balance", address(user)),
        simulate(vault, "balance", address(user)),
        simulate(vault, "value_of", address(user)),
    ]);
    return {
        walletBalance: BigInt(walletBalance as bigint),
        shares: BigInt(shares as bigint),
        value: BigInt(value as bigint),
    };
}

// Deposit, Withdraw, Allocated, Deallocated and svXLM Transfer events of the last few days
export async function loadActivity(): Promise<Activity[]> {
    const events = await fetchEvents(
        server,
        [{ type: "contract", contractIds: [CONTRACT_ID] }],
        ACTIVITY_WINDOW_SECONDS,
    );
    const activity = events
        .flatMap((event): Activity[] => {
            const [name, topic, to] = event.topic.map((part) => scValToNative(part) as unknown);
            const kind = String(name);
            const when = { time: new Date(event.ledgerClosedAt), txHash: event.txHash };
            if (kind === "paused") {
                return [{ kind: scValToNative(event.value) ? "paused" : "unpaused", ...when }];
            }
            if (kind === "transfer") {
                // A transfer to a muxed address carries { amount, to_muxed_id }
                const value = scValToNative(event.value) as bigint | { amount: bigint };
                const amount = BigInt(typeof value === "object" ? value.amount : value);
                return [{ kind, account: String(topic), to: String(to), amount, ...when }];
            }
            if (kind !== "deposit" && kind !== "withdraw" && kind !== "allocated" && kind !== "deallocated") {
                return [];
            }
            const base = { kind, amount: BigInt(scValToNative(event.value) as bigint), ...when } as const;
            return kind === "deposit" || kind === "withdraw"
                ? [{ ...base, account: String(topic) }]
                : [{ ...base, poolId: Number(topic) }];
        })
        .reverse();

    // deallocate, emergency_withdraw and withdraw all emit Deallocated: the
    // other events of the same transaction usually tell them apart
    const kindsByTx = new Map<string, Set<Activity["kind"]>>();
    for (const item of activity) {
        kindsByTx.set(item.txHash, (kindsByTx.get(item.txHash) ?? new Set()).add(item.kind));
    }
    await Promise.all(
        activity
            .filter((item) => item.kind === "deallocated")
            .map(async (item) => {
                const kinds = kindsByTx.get(item.txHash)!;
                if (kinds.has("withdraw")) item.by = "withdrawal";
                else if (kinds.has("paused")) item.by = "admin";
                // An emergency withdraw on an already paused vault emits no Paused event
                else item.by = (await calledFunction(item.txHash)) === "emergency_withdraw" ? "admin" : "agent";
            }),
    );
    return activity;
}

// Name of the contract function a transaction invoked, if the RPC still has it
async function calledFunction(txHash: string): Promise<string | undefined> {
    try {
        const tx = await server.getTransaction(txHash);
        if (tx.status === rpc.Api.GetTransactionStatus.NOT_FOUND) return undefined;
        const { func } = (TransactionBuilder.fromXDR(tx.envelopeXdr, NETWORK_PASSPHRASE) as Transaction)
            .operations[0] as Operation.InvokeHostFunction;
        return func.type === "hostFunctionTypeInvokeContract" ? func.invokeContract.functionName.toString() : undefined;
    } catch {
        return undefined;
    }
}

// Builds, simulates, has Freighter sign, sends, and waits for confirmation
async function signAndSend(source: string, operation: xdr.Operation) {
    const account = await server.getAccount(source);
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
        .addOperation(operation)
        .setTimeout(120)
        .build();
    const prepared = await server.prepareTransaction(tx);

    const signed = await signTransaction(prepared.toXDR(), {
        networkPassphrase: NETWORK_PASSPHRASE,
        address: source,
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

export function sendVaultCall(user: string, method: "deposit" | "withdraw", amount: bigint) {
    return signAndSend(user, vault.call(method, address(user), nativeToScVal(amount, { type: "i128" })));
}

// Sends svXLM shares to another account; their yield keeps accruing to the recipient
export function sendShares(user: string, to: string, shares: bigint) {
    return signAndSend(user, vault.call("transfer", address(user), address(to), nativeToScVal(shares, { type: "i128" })));
}

export type AdminAction = { method: "pause" | "unpause" } | { method: "emergency_withdraw"; poolId: number };

// Admin-only calls: the contract rejects them unless `admin` signs
export function sendAdminCall(admin: string, action: AdminAction) {
    return action.method === "emergency_withdraw"
        ? signAndSend(admin, vault.call(action.method, poolIdVal(action.poolId)))
        : signAndSend(admin, vault.call(action.method));
}

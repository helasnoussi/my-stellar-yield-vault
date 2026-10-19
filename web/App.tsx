import { useCallback, useEffect, useState } from "react";
import {
    WatchWalletChanges,
    getAddress,
    getNetworkDetails,
    isAllowed,
    isConnected,
    requestAccess,
} from "@stellar/freighter-api";
import { formatDuration, formatPercent } from "../src/blend-rates.js";
import {
    CONTRACT_ID,
    EXPLORER,
    MAX_OPERATION_STROOPS,
    NETWORK_PASSPHRASE,
    loadActivity,
    loadUser,
    loadVault,
    sendAdminCall,
    sendVaultCall,
    type Activity,
    type AdminAction,
    type PoolView,
    type UserView,
    type VaultView,
} from "./vault.js";

const REFRESH_MS = 30_000;

// ---------- Formatting ----------

function xlm(stroops: bigint, digits = 2): string {
    const value = Number(stroops) / 1e7;
    return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function short(address: string): string {
    return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

// "12.5" -> 125000000n stroops; undefined if not a positive amount with at most 7 decimals
function parseXlm(input: string): bigint | undefined {
    const match = /^(\d+)(?:\.(\d{0,7}))?$/.exec(input.trim());
    if (!match) return undefined;
    const stroops = BigInt(match[1] ?? "0") * 10_000_000n + BigInt((match[2] ?? "").padEnd(7, "0"));
    return stroops > 0n ? stroops : undefined;
}

function timeAgo(date: Date): string {
    const seconds = Math.round((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
    if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
    // Past a day, count calendar days: the 17th seen on the 19th is "2 d ago"
    const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((midnight(new Date()) - midnight(date)) / 86_400_000);
    return days === 1 ? "yesterday" : `${days} d ago`;
}

// ---------- App ----------

export function App() {
    const [vault, setVault] = useState<VaultView>();
    const [activity, setActivity] = useState<Activity[]>();
    const [user, setUser] = useState<string>();
    const [position, setPosition] = useState<UserView>();
    const [walletIssue, setWalletIssue] = useState<string>();
    const [connecting, setConnecting] = useState(false);
    const [loadError, setLoadError] = useState<string>();

    const refresh = useCallback(async () => {
        try {
            const [nextVault, nextActivity] = await Promise.all([loadVault(), loadActivity()]);
            setVault(nextVault);
            setActivity(nextActivity);
            setLoadError(undefined);
            if (user) setPosition(await loadUser(nextVault.token, user));
        } catch (error) {
            setLoadError(error instanceof Error ? error.message : String(error));
        }
    }, [user]);

    useEffect(() => {
        void refresh();
        const timer = setInterval(() => void refresh(), REFRESH_MS);
        return () => clearInterval(timer);
    }, [refresh]);

    // Reconnect silently if this site was already allowed in Freighter
    useEffect(() => {
        void (async () => {
            try {
                if ((await isConnected()).isConnected && (await isAllowed()).isAllowed) {
                    const { address } = await getAddress();
                    if (address) await adoptWallet(address);
                }
            } catch (error) {
                console.warn("Freighter auto-reconnect skipped", error);
            }
        })();
    }, []);

    // Follow account and network switches made in Freighter
    useEffect(() => {
        if (!user) return;
        const watcher = new WatchWalletChanges(3000);
        watcher.watch(({ address, networkPassphrase, error }) => {
            if (error || !address) return;
            if (networkPassphrase !== NETWORK_PASSPHRASE) {
                setWalletIssue("Freighter is on another network: switch it to Testnet.");
                return;
            }
            setWalletIssue(undefined);
            if (address !== user) {
                setPosition(undefined);
                setUser(address);
            }
        });
        return () => watcher.stop();
    }, [user]);

    function disconnect() {
        setUser(undefined);
        setPosition(undefined);
    }

    async function adoptWallet(address: string) {
        const network = await getNetworkDetails();
        if (network.error) throw new Error(network.error.message ?? "Could not read the Freighter network");
        if (network.networkPassphrase !== NETWORK_PASSPHRASE) {
            setWalletIssue(`Freighter is on ${network.network || "another network"}: switch it to Testnet.`);
            return;
        }
        setWalletIssue(undefined);
        setUser(address);
    }

    async function connect() {
        setConnecting(true);
        setWalletIssue(undefined);
        try {
            const detected = await isConnected();
            if (!detected.isConnected) {
                setWalletIssue("Freighter was not detected in this browser.");
                return;
            }
            const access = await requestAccess();
            if (access.error || !access.address) {
                setWalletIssue(access.error?.message ?? "Connection refused in Freighter.");
                return;
            }
            await adoptWallet(access.address);
        } catch (error) {
            console.error("Freighter connection failed", error);
            setWalletIssue(`Freighter connection failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setConnecting(false);
        }
    }

    const lent = vault?.pools.reduce((sum, pool) => sum + pool.position, 0n) ?? 0n;

    return (
        <div className="page">
            <header className="header">
                <div className="brand">
                    <span className="logo" aria-hidden>◆</span>
                    <span>Yield Vault</span>
                    <span className="pill">Testnet</span>
                </div>
                {user ? (
                    <WalletMenu user={user} admin={vault?.admin} onDisconnect={disconnect} />
                ) : (
                    <button className="button" onClick={() => void connect()} disabled={connecting}>
                        {connecting ? "Check Freighter…" : "Connect Freighter"}
                    </button>
                )}
            </header>

            <section className="intro">
                <h1>Deposit XLM. Earn Blend yield. Withdraw any time.</h1>
                <p>
                    An autonomous agent lends the vault's idle XLM to approved{" "}
                    <a href="https://www.blend.capital" target="_blank" rel="noreferrer">Blend</a> pools.
                    The smart contract limits what it can do: approved pools only, 100 XLM per operation,
                    and never to another address.
                </p>
            </section>

            {walletIssue && (
                <p className="notice">
                    {walletIssue}{" "}
                    {walletIssue.includes("not detected") && (
                        <a href="https://www.freighter.app" target="_blank" rel="noreferrer">Get Freighter</a>
                    )}
                </p>
            )}
            {loadError && <p className="notice">Could not read the vault: {loadError}</p>}
            {vault?.paused && (
                <p className="notice">
                    The vault is paused by its admin: deposits and new Blend allocations are disabled.
                    Withdrawals stay open.
                </p>
            )}

            <section className="stats">
                <Stat label="Total managed" value={vault && `${xlm(vault.totalAssets)} XLM`} />
                <Stat label="Lent on Blend" value={vault && `${xlm(lent)} XLM`} />
                <Stat label="Idle reserve" value={vault && `${xlm(vault.idle)} XLM`} hint="Kept liquid for withdrawals" />
            </section>

            <div className="columns">
                <section className="card">
                    <h2>Your position</h2>
                    {user ? (
                        <PositionPanel user={user} position={position} paused={vault?.paused ?? false} onDone={refresh} />
                    ) : (
                        <p className="muted">Connect Freighter on Testnet to deposit and withdraw.</p>
                    )}
                </section>

                <section className="card">
                    <h2>Where the funds earn</h2>
                    {vault ? vault.pools.map((pool) => <PoolCard key={pool.id} pool={pool} />) : <Loading />}
                </section>
            </div>

            {user && vault && user === vault.admin && <AdminPanel admin={user} vault={vault} onDone={refresh} />}

            <section className="card">
                <h2>Recent activity</h2>
                {activity ? <ActivityList items={activity} /> : <Loading />}
            </section>

            <footer className="footer">
                Vault contract{" "}
                <a href={`${EXPLORER}/contract/${CONTRACT_ID}`} target="_blank" rel="noreferrer">
                    {short(CONTRACT_ID)}
                </a>{" "}
                · Rates are estimates from on-chain data, not guarantees.
            </footer>
        </div>
    );
}

function WalletMenu({ user, admin, onDisconnect }: { user: string; admin?: string; onDisconnect: () => void }) {
    const [open, setOpen] = useState(false);
    const isAdmin = user === admin;
    const [copied, setCopied] = useState(false);

    async function copy() {
        await navigator.clipboard.writeText(user);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    }

    return (
        <div className="wallet-menu">
            <button className="wallet" title={user} aria-expanded={open} onClick={() => setOpen(!open)}>
                {short(user)}
                {isAdmin && <span className="pill">admin</span>} ▾
            </button>
            {open && (
                <div className="menu" role="menu">
                    <span className="menu-address">{user}</span>
                    <button role="menuitem" onClick={() => void copy()}>
                        {copied ? "Copied" : "Copy address"}
                    </button>
                    <a role="menuitem" href={`${EXPLORER}/account/${user}`} target="_blank" rel="noreferrer">
                        View on Stellar Expert
                    </a>
                    {isAdmin ? (
                        <a role="menuitem" href="#admin" onClick={() => setOpen(false)}>
                            Go to admin panel
                        </a>
                    ) : (
                        admin && <span className="menu-hint">Admin panel: select {short(admin)} in Freighter.</span>
                    )}
                    <span className="menu-hint">Switch accounts in Freighter: this page follows.</span>
                    <button
                        role="menuitem"
                        onClick={() => {
                            setOpen(false);
                            onDisconnect();
                        }}
                    >
                        Disconnect
                    </button>
                </div>
            )}
        </div>
    );
}

function Stat({ label, value, hint }: { label: string; value: string | undefined; hint?: string }) {
    return (
        <div className="stat">
            <span className="stat-label">{label}</span>
            <span className="stat-value">{value ?? "…"}</span>
            {hint && <span className="stat-hint">{hint}</span>}
        </div>
    );
}

function Loading() {
    return <p className="muted">Loading from Stellar Testnet…</p>;
}

function PoolCard({ pool }: { pool: PoolView }) {
    return (
        <div className="pool">
            <div className="pool-head">
                <span>Blend pool #{pool.id}</span>
                <a href={`${EXPLORER}/contract/${pool.address}`} target="_blank" rel="noreferrer">
                    {short(pool.address)}
                </a>
                {!pool.enabled && <span className="pill warn">disabled</span>}
            </div>
            <dl className="rates">
                <div>
                    <dt>Realized yield</dt>
                    <dd>
                        {pool.realized ? (
                            <>
                                +{formatPercent(pool.realized.periodReturn * 10_000)}
                                <small> over {formatDuration(pool.realized.periodSeconds)}</small>
                            </>
                        ) : (
                            "not enough history"
                        )}
                    </dd>
                    <span className="explain">What a Blend deposit actually earned. The agent decides on this.</span>
                </div>
                <div>
                    <dt>Instant rate</dt>
                    <dd>
                        {formatPercent(pool.instantAprBps)}
                        <small> /yr, estimate</small>
                    </dd>
                    <span className="explain">Today's rate if nothing changed for a year. Not a forecast.</span>
                </div>
            </dl>
            <p className="pool-foot">
                Vault position <strong>{xlm(pool.position)} XLM</strong> · Pool liquidity{" "}
                {xlm(pool.availableLiquidity, 0)} XLM
            </p>
        </div>
    );
}

function PositionPanel({
    user,
    position,
    paused,
    onDone,
}: {
    user: string;
    position: UserView | undefined;
    paused: boolean;
    onDone: () => Promise<void>;
}) {
    const [chosenMode, setMode] = useState<"deposit" | "withdraw">("deposit");
    const mode = paused ? "withdraw" : chosenMode;
    const [input, setInput] = useState("");
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string; hash?: string }>();

    if (!position) return <Loading />;

    // Keep 2 XLM in the wallet for fees and the account reserve
    const available = mode === "deposit" ? position.walletBalance - 20_000_000n : position.value;
    const max = available < MAX_OPERATION_STROOPS ? (available > 0n ? available : 0n) : MAX_OPERATION_STROOPS;
    const amount = parseXlm(input);
    const invalid = amount === undefined || amount > max;
    const sharePrice = position.shares > 0n ? Number(position.value) / Number(position.shares) : undefined;

    async function submit() {
        if (amount === undefined) return;
        setBusy(true);
        setMessage(undefined);
        try {
            const hash = await sendVaultCall(user, mode, amount);
            setMessage({ kind: "ok", text: `${mode === "deposit" ? "Deposited" : "Withdrew"} ${xlm(amount)} XLM.`, hash });
            setInput("");
            await onDone();
        } catch (error) {
            setMessage({ kind: "error", text: error instanceof Error ? error.message : String(error) });
        } finally {
            setBusy(false);
        }
    }

    return (
        <>
            <div className="position">
                <span className="position-value">{xlm(position.value, 4)} XLM</span>
                <span className="muted">
                    {position.shares.toLocaleString("en-US")} shares
                    {sharePrice !== undefined && ` · 1 share = ${sharePrice.toFixed(7)} XLM`}
                </span>
                <span className="muted">Wallet: {xlm(position.walletBalance)} XLM</span>
            </div>

            <div className="tabs" role="tablist">
                {(["deposit", "withdraw"] as const).map((tab) => (
                    <button
                        key={tab}
                        role="tab"
                        aria-selected={mode === tab}
                        className={mode === tab ? "tab active" : "tab"}
                        disabled={paused && tab === "deposit"}
                        onClick={() => {
                            setMode(tab);
                            setMessage(undefined);
                        }}
                    >
                        {tab === "deposit" ? "Deposit" : "Withdraw"}
                    </button>
                ))}
            </div>

            <div className="amount">
                <input
                    inputMode="decimal"
                    placeholder="0.00"
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    disabled={busy}
                    aria-label="Amount in XLM"
                />
                <span>XLM</span>
                <button className="link" onClick={() => setInput(String(Number(max) / 1e7))} disabled={busy}>
                    Max
                </button>
            </div>
            <p className="muted small">
                Up to {xlm(max)} XLM per operation.
                {mode === "withdraw" && " If the reserve is short, the vault pulls the rest from Blend."}
            </p>

            <button className="button wide" onClick={() => void submit()} disabled={busy || invalid}>
                {busy ? "Confirm in Freighter…" : mode === "deposit" ? "Deposit" : "Withdraw"}
            </button>

            {message && (
                <p className={message.kind === "ok" ? "result ok" : "result error"}>
                    {message.text}{" "}
                    {message.hash && (
                        <a href={`${EXPLORER}/tx/${message.hash}`} target="_blank" rel="noreferrer">
                            View transaction
                        </a>
                    )}
                </p>
            )}
        </>
    );
}

function AdminPanel({ admin, vault, onDone }: { admin: string; vault: VaultView; onDone: () => Promise<void> }) {
    const [busy, setBusy] = useState<string>();
    const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string; hash?: string }>();

    async function run(label: string, action: AdminAction, confirmText?: string) {
        if (confirmText && !window.confirm(confirmText)) return;
        setBusy(label);
        setMessage(undefined);
        try {
            const hash = await sendAdminCall(admin, action);
            setMessage({ kind: "ok", text: `${label}: done.`, hash });
            await onDone();
        } catch (error) {
            setMessage({ kind: "error", text: `${label}: ${error instanceof Error ? error.message : String(error)}` });
        } finally {
            setBusy(undefined);
        }
    }

    return (
        <section className="card admin" id="admin">
            <h2>
                Admin <span className="pill">{short(admin)}</span>
            </h2>

            <div className="admin-row">
                <div>
                    <strong>{vault.paused ? "Vault paused" : "Vault open"}</strong>
                    <p className="muted small">
                        Pausing blocks deposits and new Blend allocations. Withdrawals stay open.
                    </p>
                </div>
                <button
                    className={vault.paused ? "button" : "button danger"}
                    disabled={busy !== undefined}
                    onClick={() =>
                        void (vault.paused
                            ? run("Resume", { method: "unpause" })
                            : run("Pause", { method: "pause" }, "Pause the vault? Deposits and allocations will be blocked."))
                    }
                >
                    {busy === "Pause" || busy === "Resume" ? "Confirm in Freighter…" : vault.paused ? "Resume" : "Pause"}
                </button>
            </div>

            <h3>Emergency withdraw</h3>
            {vault.pools.length === 0 && <p className="muted small">No approved pool.</p>}
            {vault.pools.map((pool) => (
                <div className="admin-row" key={pool.id}>
                    <div>
                        <strong>Pool #{pool.id}</strong>{" "}
                        <a href={`${EXPLORER}/contract/${pool.address}`} target="_blank" rel="noreferrer">
                            {short(pool.address)}
                        </a>
                        <p className="muted small">Vault position {xlm(pool.position)} XLM</p>
                    </div>
                    <button
                        className="button danger"
                        disabled={busy !== undefined}
                        onClick={() =>
                            void run(
                                `Emergency withdraw #${pool.id}`,
                                { method: "emergency_withdraw", poolId: pool.id },
                                `Pull the whole position of pool #${pool.id} back into the vault and pause it?`,
                            )
                        }
                    >
                        {busy === `Emergency withdraw #${pool.id}` ? "Confirm in Freighter…" : "Emergency withdraw"}
                    </button>
                </div>
            ))}

            {message && (
                <p className={message.kind === "ok" ? "result ok" : "result error"}>
                    {message.text}{" "}
                    {message.hash && (
                        <a href={`${EXPLORER}/tx/${message.hash}`} target="_blank" rel="noreferrer">
                            View transaction
                        </a>
                    )}
                </p>
            )}
        </section>
    );
}

function ActivityList({ items }: { items: Activity[] }) {
    if (items.length === 0) return <p className="muted">No activity in the last 3 days.</p>;
    const describe = (item: Activity) => {
        switch (item.kind) {
            case "deposit":
                return `${short(item.account ?? "")} deposited`;
            case "withdraw":
                return `${short(item.account ?? "")} withdrew`;
            case "allocated":
                return `Agent lent to Blend pool #${item.poolId}`;
            case "deallocated":
                return `Vault took back from Blend pool #${item.poolId}`;
            case "paused":
                return "Admin paused the vault";
            case "unpaused":
                return "Admin reopened the vault";
        }
    };
    return (
        <ul className="activity">
            {items.map((item) => (
                <li key={`${item.txHash}-${item.kind}-${item.poolId ?? item.account}`}>
                    <span className={`dot ${item.kind}`} aria-hidden />
                    <span className="activity-text">{describe(item)}</span>
                    <span className="activity-amount">{item.amount === undefined ? "" : `${xlm(item.amount)} XLM`}</span>
                    <a href={`${EXPLORER}/tx/${item.txHash}`} target="_blank" rel="noreferrer" title={item.time.toLocaleString()}>
                        {timeAgo(item.time)}
                    </a>
                </li>
            ))}
        </ul>
    );
}

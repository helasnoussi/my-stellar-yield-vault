import { Claimant as XdrClaimant, ClaimPredicate } from "../xdr/index.js";
/**
 * Claimant class represents an xdr.Claimant
 *
 * The claim predicate is optional, it defaults to unconditional if none is specified.
 *
 * To build a predicate from a plain object rather than the `predicate*`
 * helpers below, use the SEP-0051 dialect, which RPC serves:
 *
 * ```ts
 * const predicate = xdr.ClaimPredicate.fromJson({
 *   not: { before_absolute_time: "1788443399" },
 * });
 * ```
 *
 * Horizon serves a different dialect, and it does not map key for key.
 * `{ unconditional: true }` becomes the string `"unconditional"`,
 * `abs_before_epoch` and `rel_before` become `before_absolute_time` and
 * `before_relative_time`, and Horizon's ISO-8601 `abs_before` has no
 * SEP-0051 counterpart. `and`, `or` and `not` carry over unchanged.
 *
 * Two of stellar-core's limits go unchecked here: at most 4 levels of
 * nesting, and non-negative times. A predicate that breaks either is built
 * without complaint and rejected at submit time — see
 * [#1727](https://github.com/stellar/js-stellar-sdk/issues/1727).
 */
export declare class Claimant {
    private _destination;
    private _predicate;
    /**
     * @param destination - The destination account ID.
     * @param predicate - The claim predicate.
     */
    constructor(destination: string, predicate?: ClaimPredicate);
    /**
     * Returns an unconditional claim predicate
     */
    static predicateUnconditional(): ClaimPredicate;
    /**
     * Returns an `and` claim predicate
     * @param left - an xdr.ClaimPredicate
     * @param right - an xdr.ClaimPredicate
     */
    static predicateAnd(left: ClaimPredicate, right: ClaimPredicate): ClaimPredicate;
    /**
     * Returns an `or` claim predicate
     * @param left - an xdr.ClaimPredicate
     * @param right - an xdr.ClaimPredicate
     */
    static predicateOr(left: ClaimPredicate, right: ClaimPredicate): ClaimPredicate;
    /**
     * Returns a `not` claim predicate
     * @param predicate - an xdr.ClaimPredicate
     */
    static predicateNot(predicate: ClaimPredicate): ClaimPredicate;
    /**
     * Returns a `BeforeAbsoluteTime` claim predicate
     *
     * This predicate will be fulfilled if the closing time of the ledger in
     * which the balance is claimed is less than this (absolute) Unix timestamp
     * (expressed in seconds).
     *
     * @param absBefore - Unix epoch (in seconds) as a string
     */
    static predicateBeforeAbsoluteTime(absBefore: string): ClaimPredicate;
    /**
     * Returns a `BeforeRelativeTime` claim predicate
     *
     * When the balance is created, this is converted to a `BeforeAbsoluteTime`
     * predicate by adding this relative time delta (in seconds) to the closing
     * time of the ledger that includes the CreateClaimableBalance operation. The
     * predicate is then fulfilled while the closing time of the ledger in which
     * the balance is claimed is less than that sum.
     *
     * @param seconds - seconds since closeTime of the ledger in which the ClaimableBalanceEntry was created (as string)
     */
    static predicateBeforeRelativeTime(seconds: string): ClaimPredicate;
    /**
     * Returns a claimant object from its XDR object representation.
     * @param claimantXdr - The claimant xdr object.
     */
    static fromXdr(claimantXdr: XdrClaimant): Claimant;
    /**
     * @deprecated Use {@link Claimant.fromXdr} instead.
     * Deprecated in version v17.0.0
     */
    static fromXDR(claimantXdr: XdrClaimant): Claimant;
    /**
     * Returns the xdr object for this claimant.
     */
    toXdrObject(): XdrClaimant;
    /**
     * @deprecated Use {@link toXdrObject} instead.
     * Deprecated in version v17.0.0
     */
    toXDRObject(): XdrClaimant;
    /**
     * The destination account ID.
     */
    get destination(): string;
    set destination(_value: string);
    /**
     * The claim predicate.
     */
    get predicate(): ClaimPredicate;
    set predicate(_value: ClaimPredicate);
}

import { TransactionResult } from "../xdr/index.js";
/**
 * Read the claimable balance ID out of a submitted transaction's result.
 *
 * Use this after submission. To derive the ID beforehand, use
 * {@link Transaction.getClaimableBalanceId} instead. Both return the balance
 * ID in its 72-character hex form.
 *
 * Horizon returns the result as base64 in `result_xdr`, so decode it first
 * with `xdr.TransactionResult.fromXdr(result_xdr, "base64")`. RPC's
 * `getTransaction` already returns a parsed `resultXdr`.
 *
 * @param result - the result of the transaction that ran the
 *    `CreateClaimableBalance` op
 * @param opIndex - the index of the `CreateClaimableBalance` op
 *
 * @throws `RangeError` for an `opIndex` that is not an index into the
 *    transaction's operation results
 * @throws `TypeError` if `result` is not a transaction result, if the
 *    transaction did not succeed, or if the operation at `opIndex` is not a
 *    successful `CreateClaimableBalance`
 *
 * @see https://developers.stellar.org/docs/learn/encyclopedia/transactions-specialized/claimable-balances
 */
export declare function getClaimableBalanceIdFromResult(result: TransactionResult, opIndex: number): string;

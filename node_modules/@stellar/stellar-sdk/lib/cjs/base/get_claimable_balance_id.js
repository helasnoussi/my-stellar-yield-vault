'use strict';

require('../xdr/index.js');
var transactionResult = require('../xdr/generated/transaction-result.js');

function isTransactionResult(value) {
  if (value instanceof transactionResult.TransactionResult) return true;
  if (typeof value !== "object" || value === null) return false;
  const ctor = value.constructor;
  return ctor?.schema?.name === transactionResult.TransactionResult.schema.name;
}
function successfulOperationResults(result) {
  const txResult = result.result;
  switch (txResult.type) {
    case "txSuccess":
      return txResult.results;
    case "txFeeBumpInnerSuccess": {
      const innerResult = txResult.innerResultPair.result.result;
      if (innerResult.type !== "txSuccess") {
        throw new TypeError(
          `expected a successful inner transaction result, got ${innerResult.type}`
        );
      }
      return innerResult.results;
    }
    default:
      throw new TypeError(
        `expected a successful transaction result, got ${txResult.type}`
      );
  }
}
function getClaimableBalanceIdFromResult(result, opIndex) {
  if (!isTransactionResult(result)) {
    throw new TypeError(
      'expected an xdr.TransactionResult; decode a base64 `result_xdr` with xdr.TransactionResult.fromXdr(result_xdr, "base64") first'
    );
  }
  const opResults = successfulOperationResults(result);
  if (!Array.isArray(opResults)) {
    throw new TypeError(
      "expected an xdr.TransactionResult; its operation results are missing"
    );
  }
  if (!Number.isInteger(opIndex) || opIndex < 0 || opIndex >= opResults.length) {
    throw new RangeError(
      `invalid operation index ${opIndex}; the transaction has ${opResults.length} operation result(s)`
    );
  }
  const opResult = opResults[opIndex];
  if (opResult.type !== "opInner") {
    throw new TypeError(
      `expected opInner at index ${opIndex}, got ${opResult.type}`
    );
  }
  const opTypeResult = opResult.tr;
  if (opTypeResult.type !== "createClaimableBalance") {
    throw new TypeError(
      `expected createClaimableBalance at index ${opIndex}, got ${opTypeResult.type}`
    );
  }
  const balanceResult = opTypeResult.createClaimableBalanceResult;
  if (balanceResult.type !== "createClaimableBalanceSuccess") {
    throw new TypeError(
      `expected createClaimableBalanceSuccess at index ${opIndex}, got ${balanceResult.type}`
    );
  }
  return balanceResult.balanceId.toXdr("hex");
}

exports.getClaimableBalanceIdFromResult = getClaimableBalanceIdFromResult;
//# sourceMappingURL=get_claimable_balance_id.js.map

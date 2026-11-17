import { compareSettlement } from './settlement-comparison.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const nonnegative = value => finite(value) && value >= 0;
const sum = values => values.reduce((total, value) => total + value, 0);
const fail = (reason, validationCode, comparison = null) => ({
  valid: false, kind: null, rows: [], assetBridgeSum: null, btcBridgeSum: null,
  balanceVerified: false, reason, validationCode, comparison,
});

/**
 * Exact attribution for the existing common-funding, common-strike/expiry and
 * common-currency simulation. Quote eligibility/freshness belongs to the
 * upstream platform comparator. No reserved amount is charged as an expense.
 * All signed effects mean SELL PUT minus dual investment.
 */
export function buildSettlementBreakdown(put, dual) {
  const comparison = compareSettlement(put, dual);
  if (!comparison.valid) return fail(comparison.reason, 'comparison_invalid', comparison);

  const A = put.amount, B = dual.amount, I = dual.income;
  const K = put.strike, S = put.expiryPrice, q = put.q, capital = put.capital;
  const P = put.gross, O = put.openFee, D = put.deliveryFee, F = put.spotFee, basis = put.basisCost;
  const payout = put.payout, afterSettlementCash = put.afterSettlementCash;
  const purchaseCash = put.purchaseCash, purchasePrice = put.purchasePrice, leftover = dual.leftover;
  if (!finite(A) || A <= 0 || !finite(q) || q <= 0 ||
      ![B, I, capital, P, O, D, F, payout, afterSettlementCash, purchaseCash, purchasePrice, leftover].every(nonnegative) || !finite(basis)) {
    return fail('收益、实际费用或资金流水缺少有效数值，暂不能拆分到期结果', 'flow_values_invalid', comparison);
  }
  const scale = Math.max(A, B, I, capital, P, O, D, F, payout, afterSettlementCash, purchaseCash);
  const tolerance = Math.max(1e-8, scale * Number.EPSILON * 64);
  const close = (a, b) => finite(a) && finite(b) && Math.abs(a - b) <= tolerance;
  const requireBalance = (condition, reason, code) => condition ? null : fail(reason, code, comparison);
  const checks = [
    [B <= A + tolerance && close(B + leftover, A), '双币申购金额与未申购现金不等于当次资金，不能归因', 'funding_mismatch'],
    [capital <= A + tolerance && close(capital, q * K), 'PUT 名义本金与数量或当次资金不一致，不能归因', 'put_capital_mismatch'],
    [close(put.netIncome, P - O), 'PUT 净权利金与毛权利金及开仓费不一致，不能归因', 'premium_mismatch'],
    [close(payout, q * Math.max(K - S, 0)), '期权到期赔付与数量、执行价或结算价不一致，不能归因', 'payout_mismatch'],
    [close(afterSettlementCash, A + P - O - payout - D), 'PUT 到期结算现金流水不一致，不能归因', 'settlement_cash_mismatch'],
    [close(put.cash + purchaseCash, afterSettlementCash), '现货买入支出与最终余款不等于结算现金，不能归因', 'purchase_cash_mismatch'],
    [close(put.assets, A + P - O - payout - D - F - basis), '实际费用及成交价差不能对上 PUT 最终资产，不能归因', 'put_asset_mismatch'],
  ];
  if (put.totalFee != null) checks.push([nonnegative(put.totalFee) && close(put.totalFee, O + D + F), '实际总费用与逐项费用不一致，不能归因', 'total_fee_mismatch']);

  const triggered = comparison.triggered;
  if (triggered) {
    checks.push(
      [close(dual.dualBtc * K, B + I), '双币换币数量与本金加收益不一致；需要另列交币取整或扣费后才能归因', 'dual_conversion_mismatch'],
      [close(dual.dualCash, leftover), '双币触发后的现金不等于未申购余款，不能归因', 'dual_cash_mismatch'],
    );
  } else {
    checks.push(
      [close(D, 0) && close(F, 0) && close(basis, 0) && close(payout, 0), '未触发情景不应扣除交割、现货费用或成交价差', 'untriggered_cost_mismatch'],
      [close(dual.dualCash, A + I), '双币未触发后的现金与本金加收益不一致，不能归因', 'dual_cash_mismatch'],
    );
  }
  const btcAttributionAvailable = triggered && put.purchaseExecuted === true && S > 0;
  if (put.purchaseExecuted === true) {
    checks.push(
      [btcAttributionAvailable && purchasePrice > 0, '接币状态与有效结算价或买入价不一致，不能归因', 'purchase_state_mismatch'],
      [close(purchaseCash, put.btcReceived * purchasePrice + F), '现货净币量、实际手续费与买入支出不一致，不能归因', 'spot_fee_mismatch'],
      [close(basis, put.btcReceived * (purchasePrice - S)), '成交价差与净币量或价格不一致，不能归因', 'execution_gap_mismatch'],
    );
  } else {
    checks.push([close(purchaseCash, 0) && close(put.btcReceived, 0) && close(F, 0) && close(basis, 0), '未完成买币却存在已成交币量或现货费用，不能归因', 'pending_purchase_mismatch']);
  }
  for (const [condition, reason, code] of checks) {
    const problem = requireBalance(condition, reason, code);
    if (problem) return problem;
  }

  const conversion = triggered ? (B + I - capital) * (1 - S / K) : 0;
  const rows = [
    { id: 'gross_income', label: '毛权利金与双币收益之差', value: P - I,
      note: 'PUT 毛权利金减双币本期收益，尚未扣除 PUT 费用。' },
    { id: 'open_fee', label: '期权开仓费', value: -O,
      note: '本情景按公开费率估算的开仓费；费用预留不在这里重复扣除。' },
    { id: 'delivery_fee', label: '到期交割费', value: -D,
      note: '本情景预计计入的交割费，不是期权现金赔付。' },
    { id: 'spot_fee', label: '现货买入费', value: -F,
      note: '以成交价计价的现货手续费；收到 BTC 中扣费也只计算一次。' },
    { id: 'execution_gap', label: '现货买价偏差（假设）', value: -basis,
      note: '净 BTC 数量乘情景买入价与结算价的差；买价更低时这一项增加资产。' },
    { id: 'conversion', label: '本金及收益换币方式的影响', value: conversion,
      note: '双币将申购本金加收益按接币价换币；PUT 的跌幅赔付只对应期权名义本金。这是结构差，不是额外收费，不能再扣一次赔付。' },
  ].map(row => ({ ...row, includeInAssetBridge: true, btcImpact: btcAttributionAvailable ? row.value / S : null }));
  const assetBridgeSum = sum(rows.map(row => row.value));
  const cashAdjustment = comparison.dualCash - comparison.putCash;
  rows.push({ id: 'cash_adjustment', label: '现金与 BTC 分配调整', value: cashAdjustment,
    btcImpact: btcAttributionAvailable ? cashAdjustment / S : null, includeInAssetBridge: false,
    note: '双币现金减 PUT 现金，仅用于把资产差换成币量差；这是保留现金的形态差，不是成本，不进入上面六项资产归因合计。' });
  const btcBridgeSum = btcAttributionAvailable ? sum(rows.map(row => row.btcImpact)) : null;
  if (!finite(assetBridgeSum) || !close(assetBridgeSum, comparison.assetDifference)) return fail('逐项归因与最终总资产差不能对账，暂不显示完整归因', 'asset_bridge_mismatch', comparison);
  const btcTolerance = btcAttributionAvailable ? Math.max(1e-12, tolerance / S, Math.abs(comparison.btcDifference) * Number.EPSILON * 64) : null;
  if (btcAttributionAvailable && (!finite(btcBridgeSum) || rows.some(row => !finite(row.btcImpact)) || Math.abs(btcBridgeSum - comparison.btcDifference) > btcTolerance)) {
    return fail('逐项归因与最终净 BTC 差不能对账，暂不显示币量归因', 'btc_bridge_mismatch', comparison);
  }
  const result = {
    valid: true, kind: comparison.kind, rows, assetBridgeSum, btcBridgeSum,
    assetBridgeResidual: assetBridgeSum - comparison.assetDifference,
    btcBridgeResidual: btcAttributionAvailable ? btcBridgeSum - comparison.btcDifference : null,
    balanceVerified: true, btcAttributionAvailable, triggered, valuationPrice: S,
    put, dual, comparison,
    putFlow: { initialCash: A, notional: capital, grossPremium: P, openFee: O, payout,
      payoutIsFee: false, deliveryFee: D, afterSettlementCash, purchaseCash, purchasePrice,
      spotFee: F, executionGap: basis, netBtc: put.btcReceived, endingCash: put.cash, endingAssets: put.assets,
      feeReserve: nonnegative(put.feeReserve) ? put.feeReserve : null, feeReserveIsCost: false },
    dualFlow: { initialCash: A, subscribedCash: B, uninvestedCash: leftover, periodIncome: I,
      conversionAmount: triggered ? B + I : 0, conversionPrice: triggered ? K : null,
      netBtc: dual.dualBtc, endingCash: dual.dualCash, endingAssets: dual.dualAssets },
  };
  if (rows.some(row => !finite(row.value))) return fail('归因金额超出可计算范围', 'attribution_overflow', comparison);
  return result;
}

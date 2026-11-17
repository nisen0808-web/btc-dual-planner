const invalid = reason => ({ valid: false, reason });
const finite = value => typeof value === 'number' && Number.isFinite(value);
const nonnegative = value => finite(value) && value >= 0;
const close = (a, b) => Math.abs(a - b) <= Math.max(1e-8, Math.abs(a) * Number.EPSILON * 32, Math.abs(b) * Number.EPSILON * 32);

/**
 * Compare one simulated fixing after the platform comparator has validated its
 * quote, strike, expiry, currency, investment limits, and freshness.
 * Differences always mean SELL PUT minus dual investment. Income difference
 * keeps the unconverted net-premium convention; triggered outcomes use BTC.
 * This module performs no network, account, or order operations.
 */
export function compareSettlement(put, dual) {
  if (put?.valid !== true) return invalid('请先获得有效的 SELL PUT 到期模拟');
  if (dual?.valid !== true) return invalid(dual?.reason || '暂未读取到同条件双币报价，无法比较到期结果');
  if (!nonnegative(put.expiryPrice) || !finite(put.strike) || put.strike <= 0) return invalid('到期结算价或接币价无效，无法比较到期结果');
  const triggered = put.expiryPrice <= put.strike;
  if (put.triggered !== triggered || dual.settledAsBTC !== triggered) return invalid('双币与 SELL PUT 的到期触发分支不一致，无法比较');
  if (put.purchaseExecuted != null && typeof put.purchaseExecuted !== 'boolean') return invalid('SELL PUT 的接币状态无效，无法比较');
  const putCurrency = put.currency ?? put.settleCoin;
  const dualCurrency = dual.currency ?? dual.settleCoin;
  if (putCurrency && dualCurrency && String(putCurrency).toUpperCase() !== String(dualCurrency).toUpperCase()) return invalid('双币与 SELL PUT 的结算币种不同，不能按 1:1 比较');

  const putBtc = put.btcReceived, dualBtc = dual.dualBtc;
  const putCash = put.cash, dualCash = dual.dualCash;
  const putAssets = put.assets, dualAssets = dual.dualAssets;
  if (![putBtc, dualBtc, putCash, dualCash, putAssets, dualAssets].every(nonnegative)) return invalid('到期币量、现金或总资产缺少有效数值，无法比较');
  if (!finite(put.netIncome) || !finite(dual.income)) return invalid('净收益数值无效，无法比较到期结果');
  const putValue = putCash + putBtc * put.expiryPrice;
  const dualValue = dualCash + dualBtc * put.expiryPrice;
  if (![putValue, dualValue].every(finite) || !close(putAssets, putValue) || !close(dualAssets, dualValue)) return invalid('到期资产与现金及 BTC 估值不一致，无法比较');
  if (!triggered && (putBtc !== 0 || dualBtc !== 0 || put.purchaseExecuted === true)) return invalid('未触发情景包含不一致的买币结果，无法比较');
  if (triggered && put.purchaseExecuted === true && putBtc <= 0) return invalid('接币结果缺少有效的净 BTC 数量，无法比较');

  const btcDifference = putBtc - dualBtc;
  const cashDifference = putCash - dualCash;
  const assetDifference = putAssets - dualAssets;
  const incomeDifference = put.netIncome - dual.income;
  const kind = !triggered ? 'income' : put.purchaseExecuted === true ? 'btc' : 'pending';
  const difference = kind === 'btc' ? btcDifference : kind === 'income' ? incomeDifference : null;
  const result = { valid: true, triggered, putBtc, dualBtc, putCash, dualCash, putAssets, dualAssets,
    btcDifference, cashDifference, assetDifference, incomeDifference, kind, difference };
  if (Object.values(result).some(value => typeof value === 'number' && !finite(value))) return invalid('到期结果超出可计算范围，无法比较');
  return result;
}

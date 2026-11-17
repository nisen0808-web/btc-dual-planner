import { buildSettlementBreakdown } from './settlement-breakdown.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const nonnegative = value => finite(value) && value >= 0;
const failure = reason => ({ valid: false, kind: null, reason, budgetGross: null,
  currentCosts: null, currentUse: null, headroom: null, actualFees: null, gapImpact: null,
  cashOccupancy: null, extraFeeHeadroom: null, requiredGrossAtCurrentPrice: null,
  maxPurchasePrice: null, maxGapRate: null, atLimitBtc: null, aboveLimitBtc: null,
  probePrice: null, probeFee: null, atFeeLimitBtc: null, aboveFeeLimitBtc: null,
  roundingKnown: false });
const places = value => {
  const [mantissa, exponent = '0'] = String(value).toLowerCase().split('e');
  return Math.max(0, (mantissa.split('.')[1] || '').length - Number(exponent));
};
function decimal(value) {
  const [mantissa, exponent = '0'] = String(value).toLowerCase().split('e');
  const digits = BigInt(mantissa.replace('.', ''));
  const scale = (mantissa.split('.')[1] || '').length - Number(exponent);
  return scale >= 0 ? [digits, 10n ** BigInt(scale)] : [digits * 10n ** BigInt(-scale), 1n];
}
function product(values) {
  return values.reduce(([n, d], value) => {
    const [vn, vd] = decimal(value); return [n * vn, d * vd];
  }, [1n, 1n]);
}
function compareProducts(left, right) {
  const [ln, ld] = product(left), [rn, rd] = product(right);
  return ln * rd < rn * ld ? -1 : ln * rd > rn * ld ? 1 : 0;
}
function ceilRatio(numerators, denominators) {
  const [nn, nd] = product(numerators), [dn, dd] = product(denominators);
  const n = nn * dd, d = nd * dn;
  if (d <= 0n) throw new Error('invalid_ratio');
  const units = Number((n + d - 1n) / d);
  if (!Number.isSafeInteger(units)) throw new Error('unsafe_quantity');
  return units;
}
function adjacent(value, up) {
  if (!finite(value) || value <= 0) return up ? Number.MIN_VALUE : 0;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  view.setBigUint64(0, view.getBigUint64(0) + (up ? 1n : -1n));
  return view.getFloat64(0);
}
function rulesFor(contract) {
  if (!contract || typeof contract !== 'object' || !nonnegative(contract.spot) || contract.spot > 1) throw new Error('rules_invalid');
  if (contract.spotDeductBase != null && typeof contract.spotDeductBase !== 'boolean') throw new Error('rules_invalid');
  const fee = contract.spot, base = contract.spotDeductBase === true;
  if (base && fee >= 1) throw new Error('rules_invalid');
  const beta = base ? 1 - fee : 1, a = base ? 1 : 1 + fee;
  const step = contract.spotStep == null ? null : contract.spotStep;
  const minimum = contract.spotMin == null ? 0 : contract.spotMin;
  const minNotional = contract.spotMinNotional == null ? 0 : contract.spotMinNotional;
  if ((step !== null && (!finite(step) || step <= 0 || step > 1 || places(step) > 14)) ||
      !nonnegative(minimum) || !nonnegative(minNotional)) throw new Error('rules_invalid');
  return { fee, base, beta, a, step, minimum, minNotional };
}
function grossNeeded(target, price, rules, withNotional) {
  const { beta, step, minimum, minNotional } = rules;
  const qualifies = gross => compareProducts([beta, gross], [target]) >= 0 && gross >= minimum &&
    (!withNotional || compareProducts([price, gross], [minNotional]) >= 0);
  if (step !== null) {
    let units = Math.max(ceilRatio([target], [beta, step]), ceilRatio([minimum], [step]));
    if (withNotional) units = Math.max(units, ceilRatio([minNotional], [price, step]));
    const quantity = count => Number((count * step).toFixed(places(step)));
    const gross = quantity(units);
    // Independent decimal inequalities certify both sufficiency and minimality.
    if (!qualifies(gross) || (units > 0 && qualifies(quantity(units - 1)))) throw new Error('quantity_boundary_unverified');
    return gross;
  }
  let gross = Math.max(target / beta, minimum, withNotional ? minNotional / price : 0);
  for (let i = 0; i < 8 && !qualifies(gross); i++) gross = adjacent(gross, true);
  if (!finite(gross) || gross <= 0 || !qualifies(gross)) throw new Error('quantity_boundary_unverified');
  return gross;
}
function simulateSpot(cash, price, rules) {
  if (!nonnegative(cash) || !finite(price) || price <= 0 || price > 1e15) return { purchaseExecuted: false, netBtc: 0, grossBtc: 0, cash: nonnegative(cash) ? cash : 0 };
  const { fee, base, a, beta, step, minimum, minNotional } = rules;
  let gross = cash / (price * a);
  if (step !== null) {
    const units = Math.floor(gross / step + 1e-9);
    if (!Number.isSafeInteger(units)) throw new Error('unsafe_quantity');
    gross = Number((units * step).toFixed(places(step)));
  }
  if (!(gross > 0 && gross >= minimum && gross * price >= minNotional)) return { purchaseExecuted: false, netBtc: 0, grossBtc: 0, cash };
  const spotFee = gross * price * fee;
  const purchaseCash = gross * price + (base ? 0 : spotFee);
  const tolerance = Math.max(1e-8, cash * Number.EPSILON * 16);
  if (purchaseCash > cash + tolerance) throw new Error('spot_overspend');
  return { purchaseExecuted: true, netBtc: gross * beta, grossBtc: gross,
    spotFee, purchaseCash, cash: Math.max(0, cash - purchaseCash) };
}

/** Pure common-scenario limits for net BTC delivery, never an execution guarantee. */
export function computeSettlementLimits(put, dual, spotRules) {
  const breakdown = buildSettlementBreakdown(put, dual);
  if (!breakdown.valid) return failure(breakdown.reason);
  const P = put.gross, I = dual.income, O = put.openFee;
  if (!breakdown.triggered) {
    const budgetGross = P - I, headroom = budgetGross - O;
    return { ...failure(''), valid: true, kind: 'income', reason: null, budgetGross,
      currentCosts: O, currentUse: O, headroom, actualFees: O, gapImpact: 0, cashOccupancy: 0,
      extraFeeHeadroom: headroom, roundingKnown: spotRules?.spotStep != null,
      competitiveAtCurrentRules: headroom >= 0, feesAndGapShareHeadroom: true,
      note: '未触发时仅比较扣费后现金收入，不计算现货买价阈值。' };
  }
  if (!put.purchaseExecuted || put.expiryPrice <= 0) return failure('当前情景尚未模拟成功买入 BTC，无法计算可承受费用或买价阈值');
  try {
    const rules = rulesFor(spotRules);
    const { a, fee, base, step } = rules;
    const S = put.expiryPrice, X = put.purchasePrice, W = put.afterSettlementCash, target = dual.dualBtc;
    if (!(finite(target) && target > 0 && finite(W) && W > 0 && finite(X) && X > 0)) return failure('双币目标币量或现货买入现金无效，无法计算阈值');
    const actualFees = put.openFee + put.deliveryFee + put.spotFee;
    const scale = Math.max(put.amount, W, actualFees);
    const tolerance = Math.max(1e-8, scale * Number.EPSILON * 64);
    const close = (left, right) => finite(left) && finite(right) && Math.abs(left - right) <= tolerance;
    const current = simulateSpot(W, X, rules);
    const qtyTolerance = Math.max(Number.MIN_VALUE, Math.abs(put.btcReceived) * Number.EPSILON * 64, target * Number.EPSILON * 64);
    if (!current.purchaseExecuted || Math.abs(current.netBtc - put.btcReceived) > qtyTolerance ||
        !close(current.spotFee, put.spotFee) || !close(current.purchaseCash, put.purchaseCash) || !close(current.cash, put.cash)) {
      return failure('现货费率或数量规则与当前情景不一致，请刷新后计算阈值');
    }
    const gapImpact = put.basisCost, cashOccupancy = put.cash;
    const currentCosts = actualFees + gapImpact, currentUse = currentCosts + cashOccupancy;
    const budgetGross = put.amount + P - put.payout - target * S;
    const headroom = budgetGross - currentUse;
    if (!close(headroom, S * (put.btcReceived - target))) return failure('接币成本预算与最终净 BTC 差不能对账，暂不显示阈值');

    const requiredGrossAtCurrentPrice = grossNeeded(target, X, rules, true);
    const requiredNotional = requiredGrossAtCurrentPrice * X;
    let requiredCash = requiredNotional + (base ? 0 : requiredNotional * fee);
    const targetGross = grossNeeded(target, X, rules, false);
    if (W / a < rules.minNotional) return failure('买入现金不足以满足现货最小金额，无法达到双币目标币量');
    let maxPurchasePrice = W / (a * targetGross);
    if (!finite(maxPurchasePrice) || maxPurchasePrice <= 0 || maxPurchasePrice > 1e15) return failure('临界买价超出可验证的模拟范围');
    const meets = (result, price) => result.purchaseExecuted && result.netBtc >= target &&
      compareProducts([rules.beta, result.grossBtc], [target]) >= 0 &&
      result.grossBtc >= rules.minimum && compareProducts([price, result.grossBtc], [rules.minNotional]) >= 0;
    let atLimit = simulateSpot(W, maxPurchasePrice, rules);
    // A downward ULP adjustment only avoids overstating an unsafe float boundary.
    for (let n = 0; n < 12 && !meets(atLimit, maxPurchasePrice); n++) {
      maxPurchasePrice = adjacent(maxPurchasePrice, false);
      atLimit = simulateSpot(W, maxPurchasePrice, rules);
    }
    const probePrice = maxPurchasePrice * (1 + 1e-7);
    const aboveLimit = simulateSpot(W, probePrice, rules);
    let atFeeLimit = simulateSpot(requiredCash, X, rules);
    for (let n = 0; n < 12 && !meets(atFeeLimit, X); n++) {
      requiredCash = adjacent(requiredCash, true);
      atFeeLimit = simulateSpot(requiredCash, X, rules);
    }
    const extraFeeHeadroom = W - requiredCash;
    const feeProbeIncrement = Math.max(requiredCash * 1e-7, step === null ? 0 : a * X * step * 1e-7, Number.MIN_VALUE);
    const probeFee = extraFeeHeadroom + feeProbeIncrement;
    const aboveFeeLimit = simulateSpot(Math.max(0, requiredCash - feeProbeIncrement), X, rules);
    if (!meets(atLimit, maxPurchasePrice) || meets(aboveLimit, probePrice) || !meets(atFeeLimit, X) || meets(aboveFeeLimit, X)) return failure('临界值或略超临界值未能通过同一现货模型验证，暂不显示阈值');
    const maxGapRate = maxPurchasePrice / S - 1;
    const result = { valid: true, kind: 'btc', reason: null, budgetGross, currentCosts, currentUse, headroom,
      actualFees, gapImpact, cashOccupancy, extraFeeHeadroom, requiredGrossAtCurrentPrice,
      maxPurchasePrice, maxGapRate, roundingKnown: step !== null, quantityEstimateOnly: step === null,
      priceThresholdEstimateOnly: true, feesAndGapShareHeadroom: true,
      currentGapRate: X / S - 1, targetBtc: target, targetGrossAtPriceLimit: targetGross,
      atLimitBtc: atLimit.netBtc, aboveLimitBtc: aboveLimit.purchaseExecuted ? aboveLimit.netBtc : null,
      probePrice, probeFee, feeProbeIncrement, atFeeLimitBtc: atFeeLimit.netBtc,
      aboveFeeLimitBtc: aboveFeeLimit.purchaseExecuted ? aboveFeeLimit.netBtc : null,
      atPriceLimit: atLimit, abovePriceLimit: aboveLimit, atFeeLimit, aboveFeeLimit,
      competitiveAtCurrentRules: put.btcReceived >= target,
      note: '费用与买价上限共享同一余量，不能同时各自用满。这里只比较最终净 BTC；保留现金不是手续费，临界买价是连续价格情景，不代表可按该精确价格成交。' };
    if (Object.values(result).some(value => typeof value === 'number' && !finite(value))) return failure('阈值参数超出可计算范围');
    return result;
  } catch {
    return failure('现货费率、最小数量或步长无效，或临界值无法安全验证');
  }
}

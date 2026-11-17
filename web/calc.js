const fail = message => ({ valid: false, errors: [message] });
const isNumber = value => typeof value === 'number' && Number.isFinite(value);
const num = value => value === '' || value == null ? NaN : Number(value);

function decimals(value) {
  const [mantissa, exponent = '0'] = String(value).toLowerCase().split('e');
  return Math.max(0, (mantissa.split('.')[1] || '').length - Number(exponent));
}

function quoteFill(q, bids, index, taker, cap) {
  let remaining = q, gross = 0, fee = 0, levelsUsed = 0;
  for (const level of bids) {
    const take = Math.min(remaining, level.qty);
    if (take <= 0) continue;
    gross += take * level.price;
    fee += take * Math.min(taker * index, cap * level.price);
    remaining -= take;
    levelsUsed++;
    if (remaining <= Math.max(1e-12, q * 1e-10)) break;
  }
  if (remaining > Math.max(1e-12, q * 1e-10)) return null;
  return { gross, openFee: fee, averagePrice: gross / q, levelsUsed };
}

/**
 * Stablecoin-linear PUT, fully funded within the single supplied amount.
 * reserve = capital + feeReserve; unused = amount - capital includes reserved fees.
 * feeReserve is a conservative upper bound, not an extra charge at settlement.
 */
export function calculate(amount, contract, book, spot, serverTime, ST, buyBufferRate = 0) {
  const A = num(amount), S0 = num(spot), now = num(serverTime), price = num(ST);
  if (!isNumber(A) || A <= 0 || A > 1e15) return fail('请填写大于 0 且不超过 1,000 万亿的当次投入资金');
  if (!isNumber(S0) || S0 <= 0 || S0 > 1e15) return fail('BTC 指数价格无效，请刷新行情');
  if (!isNumber(now) || now <= 0) return fail('行情时间无效，请刷新行情');
  if (!isNumber(price) || price < 0 || price > 1e15) return fail('到期结算价须不小于 0，且在可计算范围内');
  if (!isNumber(buyBufferRate) || buyBufferRate < 0 || buyBufferRate > .05) return fail('接币价格缓冲须在 0% 至 5% 之间');
  if (!contract || typeof contract !== 'object') return fail('请先选择可交易的 PUT 合约');
  const K = num(contract.strike), expiry = num(contract.expires);
  const step = num(contract.step), minimum = num(contract.min);
  const taker = num(contract.taker), cap = num(contract.cap);
  const deliveryRate = num(contract.delivery), spotRate = num(contract.spot);
  if (!isNumber(K) || K <= 0 || K > 1e15) return fail('合约执行价无效，请重新选择合约');
  if (!isNumber(expiry) || expiry <= now) return fail('该合约已到期，请选择新的到期日');
  if (!isNumber(step) || step <= 0 || step > 1 || !isNumber(minimum) || minimum <= 0) return fail('合约最小数量或交易步长无效');
  if (![taker, cap, deliveryRate, spotRate].every(v => isNumber(v) && v >= 0 && v <= 1)) return fail('平台费率无效，请刷新合约数据');
  if (!book || !Array.isArray(book.bids)) return fail('暂未读取到买盘深度，请刷新报价');
  const bids = book.bids.map(x => ({ price: num(x.price), qty: num(x.qty) }))
    .filter(x => isNumber(x.price) && x.price > 0 && isNumber(x.qty) && x.qty > 0)
    .sort((a, b) => b.price - a.price);
  if (!bids.length) return fail('该合约暂无有效买盘，无法估算卖出权利金');
  const timestamp = num(book.time);
  if (isNumber(timestamp) && now - timestamp > 180000) return fail('买盘报价已超过 3 分钟，请刷新后重新计算');

  const precision = Math.min(14, decimals(step));
  const quantity = units => Number((units * step).toFixed(precision));
  const minUnits = Math.ceil(minimum / step - 1e-9);
  const upperUnits = Math.floor(A / K / step + 1e-9);
  if (!Number.isSafeInteger(upperUnits)) return fail('金额或合约步长超出可安全计算范围');
  if (upperUnits < minUnits) return fail(`当次资金不足以覆盖最小交易数量 ${quantity(minUnits)} BTC 及费用`);

  const perCoinUpper = K + taker * S0 + deliveryRate * K + spotRate * K + buyBufferRate * K;
  let units = Math.min(upperUnits, Math.floor(A / perCoinUpper / step + 1e-9));
  units = Math.max(units, minUnits);
  const evaluate = count => {
    const q = quantity(count), fill = quoteFill(q, bids, S0, taker, cap);
    if (!fill) return null;
    const capital = K * q;
    const feeReserve = fill.openFee + (deliveryRate + spotRate) * K * q;
    const buyBufferReserve = buyBufferRate * K * q;
    return { q, capital, feeReserve, buyBufferReserve, reserve: capital + feeReserve + buyBufferReserve, ...fill };
  };
  let sized = evaluate(units);
  if (!sized) return fail('当前买盘深度不足以承接本轮卖出数量，请减少当次投入或更换合约');
  const moneyTolerance = Math.max(1e-8, A * Number.EPSILON * 8);
  if (sized.reserve > A + moneyTolerance) return fail(`当次资金不足以覆盖最小交易数量 ${quantity(minUnits)} BTC 及费用`);

  // A capped opening fee can make one extra size increment affordable.
  // Stop at visible depth rather than inventing a price for unseen liquidity.
  if (units < upperUnits) {
    const next = evaluate(units + 1);
    if (next && next.reserve <= A + moneyTolerance) { units++; sized = next; }
  }
  const { q, capital, gross, openFee, averagePrice, levelsUsed, feeReserve, buyBufferReserve, reserve } = sized;
  const days = (expiry - now) / 86400000;
  const netIncome = gross - openFee, term = netIncome / A, annual = term * 365 / days;
  const payout = q * Math.max(K - price, 0);
  const willBuy = price <= K;
  const spotDeductBase = contract.spotDeductBase === true;
  const deliveryFee = price < K ? Math.min(deliveryRate * price, cap * (K - price)) * q : 0;
  const spotFee = willBuy ? spotRate * price * q : 0;
  const totalFee = openFee + deliveryFee + spotFee;
  const assets = A + gross - payout - totalFee;
  const netBuyQuantity = spotDeductBase ? q * (1 - spotRate) : q;
  const btcReceived = willBuy ? netBuyQuantity : 0;
  let cash = assets - btcReceived * price;
  if (cash < 0 && cash > -moneyTolerance) cash = 0;
  const pnl = assets - A;
  const cost = spotDeductBase
    ? (capital + openFee + deliveryRate * K * q - gross) / netBuyQuantity
    : K + (feeReserve - gross) / q;
  const actualCost = spotDeductBase
    ? (capital + openFee + deliveryFee - gross) / netBuyQuantity
    : K + (totalFee - gross) / q;
  const unused = A - capital;
  const freeCash = Math.max(0, A - reserve);
  const result = {
    valid: true, errors: [], amount: A, q, capital, unused, gross, openFee,
    reserve, feeReserve, buyBufferReserve, buyBufferRate, freeCash, averagePrice, levelsUsed, days, netIncome,
    term, annual, cost, actualCost, deliveryFee, spotFee, totalFee, payout,
    btcReceived, cash, assets, pnl, willBuy, spotDeductBase, zeroPriceStress: price === 0,
    strike: K, spot: S0, expiryPrice: price,
  };
  if (Object.values(result).some(v => typeof v === 'number' && !Number.isFinite(v))) return fail('参数超出可计算范围，请更换合约或减少资金');
  if (cash < -moneyTolerance || assets < -moneyTolerance) return fail('预留资金无法覆盖该情景，请刷新费率后重新计算');
  return result;
}

/**
 * Public-quote simulation only. The PUT stays fully cash funded; a triggered
 * strategy spends its entire settled cash balance on BTC, including premium
 * and unused reserves. This function never submits or schedules an order.
 *
 * `gap` changes the simulated spot execution price, not the settlement fixing.
 * spotStep/spotMin/spotMinNotional are optional actual spot-lot metadata; absent metadata means
 * continuous-quantity estimation, never an invented exchange quantity step.
 */
export function calculateSimulation(amount, contract, book, spot, serverTime, ST, buyBufferRate = 0, gap = 0) {
  const A = num(amount), S0 = num(spot), now = num(serverTime), price = num(ST), gapRate = num(gap);
  if (!isNumber(A) || A <= 0 || A > 1e15) return fail('请填写大于 0 且不超过 1,000 万亿的当次投入资金');
  if (!isNumber(S0) || S0 <= 0 || S0 > 1e15) return fail('BTC 指数价格无效，请刷新行情');
  if (!isNumber(now) || now <= 0) return fail('行情时间无效，请刷新行情');
  if (!isNumber(price) || price < 0 || price > 1e15) return fail('到期结算价须不小于 0，且在可计算范围内');
  if (!isNumber(buyBufferRate) || buyBufferRate < 0 || buyBufferRate > .05) return fail('接币价格缓冲须在 0% 至 5% 之间');
  if (!isNumber(gapRate) || gapRate <= -1) return fail('现货成交价差须为有限数值，且大于 -100%');
  if (!contract || typeof contract !== 'object') return fail('请先选择可交易的 PUT 合约');
  const K = num(contract.strike), expiry = num(contract.expires);
  const step = num(contract.step), minimum = num(contract.min);
  const taker = num(contract.taker), cap = num(contract.cap);
  const deliveryRate = num(contract.delivery), deliveryCap = num(contract.deliveryCap ?? .125), spotRate = num(contract.spot);
  const spotDeductBase = contract.spotDeductBase === true;
  if (!isNumber(K) || K <= 0 || K > 1e15) return fail('合约执行价无效，请重新选择合约');
  if (!isNumber(expiry) || expiry <= now) return fail('该合约已到期，请选择新的到期日');
  if (!isNumber(step) || step <= 0 || step > 1 || decimals(step) > 14 || !isNumber(minimum) || minimum <= 0) return fail('合约最小数量或交易步长无效');
  if (![taker, cap, deliveryRate, deliveryCap, spotRate].every(v => isNumber(v) && v >= 0 && v <= 1)) return fail('平台费率无效，请刷新合约数据');
  if (spotDeductBase && spotRate >= 1) return fail('从收到 BTC 扣除的现货费率须小于 100%');
  const roundingKnown = contract.spotStep != null;
  const spotStep = roundingKnown ? num(contract.spotStep) : null;
  const spotMinimum = contract.spotMin == null ? 0 : num(contract.spotMin);
  const spotMinNotional = contract.spotMinNotional == null ? 0 : num(contract.spotMinNotional);
  if (roundingKnown && (!isNumber(spotStep) || spotStep <= 0 || spotStep > 1 || decimals(spotStep) > 14)) return fail('现货交易步长无效');
  if (!isNumber(spotMinimum) || spotMinimum < 0) return fail('现货最小买入数量无效');
  if (!isNumber(spotMinNotional) || spotMinNotional < 0) return fail('现货最小买入金额无效');
  if (!book || !Array.isArray(book.bids)) return fail('暂未读取到买盘深度，请刷新报价');
  const bids = book.bids.map(x => ({ price: num(x.price), qty: num(x.qty) }))
    .filter(x => isNumber(x.price) && x.price > 0 && x.price <= 1e15 && isNumber(x.qty) && x.qty > 0)
    .sort((a, b) => b.price - a.price);
  if (!bids.length) return fail('该合约暂无有效买盘，无法估算卖出权利金');
  const timestamp = num(book.time);
  if (!isNumber(timestamp) || timestamp <= 0 || timestamp > now + 180000) return fail('买盘报价时间无效，请刷新报价');
  if (now - timestamp > 180000) return fail('买盘报价已超过 3 分钟，请刷新后重新计算');

  const precision = decimals(step);
  const quantity = units => Number((units * step).toFixed(precision));
  const minUnits = Math.ceil(minimum / step - 1e-9);
  const upperUnits = Math.floor(A / K / step + 1e-9);
  if (!Number.isSafeInteger(upperUnits) || !Number.isSafeInteger(minUnits)) return fail('金额或合约步长超出可安全计算范围');
  if (upperUnits < minUnits) return fail(`当次资金不足以覆盖最小交易数量 ${quantity(minUnits)} BTC 及费用`);

  // At settlement available cash cannot exceed A + premium. Reserving its
  // maximum fee never uses that premium to fund a larger PUT position.
  const feeFraction = spotDeductBase ? spotRate : spotRate / (1 + spotRate);
  const perCoinUpper = K + taker * S0 + deliveryRate * K + feeFraction * bids[0].price + buyBufferRate * K;
  let units = Math.max(minUnits, Math.min(upperUnits, Math.floor(A * (1 - feeFraction) / perCoinUpper / step + 1e-9)));
  const evaluate = count => {
    const q = quantity(count), fill = quoteFill(q, bids, S0, taker, cap);
    if (!fill) return null;
    const capital = K * q;
    const deliveryFeeReserve = deliveryRate * capital;
    const spotFeeReserve = feeFraction * (A + fill.gross);
    const feeReserve = fill.openFee + deliveryFeeReserve + spotFeeReserve;
    const buyBufferReserve = buyBufferRate * capital;
    return { q, capital, deliveryFeeReserve, spotFeeReserve, feeReserve, buyBufferReserve,
      reserve: capital + feeReserve + buyBufferReserve, ...fill };
  };
  let sized = evaluate(units);
  if (!sized) return fail('当前买盘深度不足以承接本轮卖出数量，请减少当次投入或更换合约');
  const moneyTolerance = Math.max(1e-8, A * Number.EPSILON * 8);
  if (sized.reserve > A + moneyTolerance) return fail(`当次资金不足以覆盖最小交易数量 ${quantity(minUnits)} BTC 及费用`);
  if (units < upperUnits) {
    const next = evaluate(units + 1);
    if (next && next.reserve <= A + moneyTolerance) { units++; sized = next; }
  }
  const { q, capital, gross, openFee, averagePrice, levelsUsed, deliveryFeeReserve, spotFeeReserve, feeReserve, buyBufferReserve, reserve } = sized;
  const days = (expiry - now) / 86400000;
  const netIncome = gross - openFee, term = netIncome / A, annual = term * 365 / days;
  const payout = q * Math.max(K - price, 0);
  const triggered = price <= K;
  const deliveryFee = price < K ? Math.min(deliveryRate * price, deliveryCap * (K - price)) * q : 0;
  const afterSettlementCash = A + gross - openFee - payout - deliveryFee;
  const purchasePrice = price * (1 + gapRate);
  if (!isNumber(purchasePrice) || purchasePrice < 0 || purchasePrice > 1e15) return fail('模拟现货成交价格超出可计算范围');
  if (afterSettlementCash < -moneyTolerance) return fail('预留资金无法覆盖该情景，请刷新费率后重新计算');

  let purchaseStatus = triggered ? 'zero_price' : 'not_triggered';
  let purchaseExecuted = false, grossBtc = 0, btcReceived = 0, purchaseCash = 0, spotFee = 0;
  let cash = Math.max(0, afterSettlementCash);
  if (triggered && purchasePrice > 0) {
    const availableQuantity = spotDeductBase
      ? cash / purchasePrice : cash / (purchasePrice * (1 + spotRate));
    grossBtc = availableQuantity;
    if (roundingKnown) {
      const spotUnits = Math.floor(availableQuantity / spotStep + 1e-9);
      if (!Number.isSafeInteger(spotUnits)) return fail('现货交易数量超出可安全计算范围');
      grossBtc = Number((spotUnits * spotStep).toFixed(decimals(spotStep)));
    }
    if (grossBtc > 0 && grossBtc >= spotMinimum && grossBtc * purchasePrice >= spotMinNotional) {
      btcReceived = spotDeductBase ? grossBtc * (1 - spotRate) : grossBtc;
      spotFee = grossBtc * purchasePrice * spotRate;
      purchaseCash = grossBtc * purchasePrice + (spotDeductBase ? 0 : spotFee);
      cash = afterSettlementCash - purchaseCash;
      if (cash < 0 && cash > -moneyTolerance) cash = 0;
      purchaseExecuted = true;
      purchaseStatus = 'filled_estimate';
    } else {
      grossBtc = 0;
      purchaseStatus = 'below_spot_minimum';
    }
  }
  const basisCost = btcReceived * (purchasePrice - price);
  const totalFee = openFee + deliveryFee + spotFee;
  const scenarioNetIncome = netIncome - deliveryFee - spotFee - basisCost;
  const scenarioTerm = scenarioNetIncome / A, scenarioAnnual = scenarioTerm * 365 / days;
  const assets = cash + btcReceived * price;
  const pnl = assets - A, portfolioTerm = pnl / A;
  const actualCost = btcReceived > 0 ? A / btcReceived : null;
  const result = {
    valid: true, errors: [], simulationOnly: true, amount: A, q, capital, unused: A - capital,
    gross, openFee, reserve, feeReserve, deliveryFeeReserve, spotFeeReserve,
    buyBufferReserve, buyBufferRate, freeCash: Math.max(0, A - reserve),
    averagePrice, levelsUsed, days, netIncome, term, annual,
    cost: K + (feeReserve - gross) / q, costBasis: 'put_notional_unit_upper_bound', actualCost,
    deliveryFee, spotFee, totalFee, payout, afterSettlementCash, purchaseCash, purchasePrice,
    grossBtc, btcReceived, cash, assets, pnl, portfolioTerm, basisCost,
    scenarioNetIncome, scenarioTerm, scenarioAnnual, triggered, willBuy: triggered, purchaseExecuted,
    purchaseStatus, roundingKnown, spotDeductBase, zeroPriceStress: price === 0,
    strike: K, spot: S0, expiryPrice: price, gap: gapRate, spotGapRate: gapRate, deliveryCap,
  };
  if (Object.values(result).some(v => typeof v === 'number' && !Number.isFinite(v))) return fail('参数超出可计算范围，请更换合约或减少资金');
  if (cash < -moneyTolerance || assets < -moneyTolerance || purchaseCash > afterSettlementCash + moneyTolerance) return fail('预留资金无法覆盖该情景，请刷新费率后重新计算');
  return result;
}

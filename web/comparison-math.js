const DAY = 86_400_000;
const MAX_AGE = 30_000;
const fail = reason => ({valid: false, reason});
const positive = value => Number.isFinite(value) && value > 0;
const validRate = value => Number.isFinite(value) && value >= 0 && value <= 1;

function fresh(time, now) {
  return Number.isSafeInteger(time) && time > 0 && time <= now + 2_000 && now - time < MAX_AGE;
}

function synchronized(times, now) {
  return times.every(time => fresh(time, now)) && Math.max(...times) - Math.min(...times) < MAX_AGE;
}

function validOption(contract, direction) {
  return contract?.optionType === direction && contract.settleCoin === 'USDT' &&
    contract.underlying === 'BTCUSDT' && contract.status === 'TRADING' &&
    positive(contract.strike) && Number.isSafeInteger(contract.expires) &&
    [contract.unit, contract.step, contract.min, contract.max].every(positive) &&
    contract.max >= contract.min &&
    [contract.taker, contract.cap, contract.delivery, contract.deliveryCap].every(validRate);
}

function symbolMatches(contract, direction) {
  if (!Number.isSafeInteger(contract?.expires)) return false;
  const date = new Date(contract.expires);
  if (!Number.isFinite(date.getTime())) return false;
  const [asset, expiry, strike, kind, extra] = String(contract.symbol).split('-');
  return asset === 'BTC' && !extra && expiry === date.toISOString().slice(2, 10).replaceAll('-', '') &&
    date.getTime() % DAY === 8 * 60 * 60 * 1_000 && Number(strike) === contract.strike &&
    kind === (direction === 'CALL' ? 'C' : 'P');
}

// Keep exact decimal lot boundaries such as (0.29 + 0.01) / 0.01.
function fraction(number) {
  const [mantissa, exponent = '0'] = String(number).toLowerCase().split('e');
  const scale = (mantissa.split('.')[1] || '').length - Number(exponent);
  const digits = BigInt(mantissa.replace('.', ''));
  return scale >= 0
    ? [digits, 10n ** BigInt(scale)]
    : [digits * 10n ** BigInt(-scale), 1n];
}

export function sizeProtection(amount, income, conversion, step, unit, multiple = 1) {
  const [principal, pd] = fraction(amount);
  const [interest, id] = fraction(income);
  const [strike, kd] = fraction(conversion);
  const [lot, ld] = fraction(step);
  const [btc, bd] = fraction(unit);
  const [factor, factorDenominator] = fraction(multiple);
  const total = (principal * id + interest * pd) * kd * factor;
  const divisor = pd * id * strike * factorDenominator;
  const lots = total * ld * bd / (divisor * lot * btc);
  if (lots > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const coveredNumerator = lots * lot * btc;
  const coveredDenominator = ld * bd;
  const uncoveredNumerator = total * coveredDenominator - coveredNumerator * divisor;
  return {
    targetBTC: Number(total) / Number(divisor),
    contracts: Number(lots * lot) / Number(ld),
    coveredBTC: Number(coveredNumerator) / Number(coveredDenominator),
    uncoveredBTC: Number(uncoveredNumerator) / Number(divisor * coveredDenominator)
  };
}

export {validOption, symbolMatches, synchronized};

export function askCost(book, contract, contracts, index) {
  const asks = book.asks;
  if (!Array.isArray(asks) || !asks.length) return fail('当前没有保护期权的卖盘报价');
  if (book.bids?.length && book.bids[0].price >= asks[0].price) {
    return fail('保护期权买卖盘交叉，请刷新');
  }
  let remaining = contracts;
  let premiumUSDT = 0;
  let openingFeeUSDT = 0;
  let levelsUsed = 0;
  let previous = 0;
  for (const {price, qty} of asks) {
    if (!positive(price) || price <= previous || !positive(qty)) return fail('保护期权卖盘档位无效');
    const fill = Math.min(remaining, qty);
    const fee = Math.min(contract.taker * index * contract.unit, contract.cap * price);
    premiumUSDT += fill * price;
    openingFeeUSDT += fill * fee;
    levelsUsed++;
    remaining -= fill;
    if (remaining <= contracts * Number.EPSILON * (levelsUsed + 1)) {
      return {premiumUSDT, openingFeeUSDT, levelsUsed, avgAsk: premiumUSDT / contracts};
    }
    previous = price;
  }
  return fail('卖盘深度不足以覆盖所需保护数量');
}

// A dual investment plus a separately purchased option, quoted from the ask side.
// Uses the dual product's verified interest including its official period-rate truncation.
export function calculateDualInsurance({direction, data, dual, now = Date.now()} = {}) {
  if (direction !== 'PUT' && direction !== 'CALL') return fail('请选择低买或高卖');
  if (!dual?.valid) return fail(dual?.reason || '缺少相同条件的双币产品');
  const contract = data?.row?.contract;
  const book = data?.row?.book;
  const market = data?.market;
  if (!contract || !book || !market) return fail('缺少同到期、同价位的保护期权或卖盘');
  const high = direction === 'CALL';
  const investment = high ? 'BTC' : 'USDT';
  const exchange = high ? 'USDT' : 'BTC';
  const product = dual.product;
  const strike = contract.strike;
  const expires = contract.expires;
  if (!validOption(contract, direction)) return fail('保护期权的合约规格或公开费率无法核实');
  if (contract.symbol !== book.symbol ||
      expires <= now || data.selectedExpiry !== expires || data.targetPrice !== strike ||
      !dual.ordinary || product?.optionType !== direction || product.investCoin !== investment ||
      product.exercisedCoin !== exchange || Number(product.strikePrice) !== strike ||
      Number(product.settleDate) !== expires || dual.productExpiry !== expires) {
    return fail('双币与保护期权的币种、方向、目标价或到期时刻不一致');
  }
  const stamps = [book.time, market.time, market.indexTime, dual.quoteTime];
  if (!synchronized(stamps, now) ||
      !fresh(market.receivedAt, now) || !fresh(data.row.receivedAt, now) ||
      !Number.isSafeInteger(dual.rateExpiry) || now >= dual.rateExpiry) return fail('保护期权、指数或双币报价已失效，请刷新');
  const index = market.spot;
  const {unit, step, min, max} = contract;
  if (!positive(index)) return fail('保护期权指数无法核实');
  const input = high ? data.quantity : data.amount;
  const amount = dual.amount;
  const interest = dual.income;
  if (!positive(input) || !positive(amount) || amount > input ||
      !Number.isFinite(interest) || interest < 0) return fail('双币投入金额或本期收益无法核实');
  const size = sizeProtection(amount, interest, high ? 1 : strike, step, unit);
  if (!size || size.contracts < min || size.contracts <= 0) return fail('双币本息对应的数量不足保护期权的最小张数');
  if (size.contracts > max) return fail('所需保护数量超过期权合约单笔上限');
  const cost = askCost(book, contract, size.contracts, index);
  if (cost.valid === false) return cost;

  const costUSDT = cost.premiumUSDT + cost.openingFeeUSDT;
  const valuation = high ? index : 1;
  const capitalUSDT = input * valuation;
  const capitalWithInsuranceUSDT = capitalUSDT + costUSDT;
  const dualIncomeUSDT = interest * valuation;
  const netIncomeUSDT = dualIncomeUSDT - costUSDT;
  const term = netIncomeUSDT / capitalWithInsuranceUSDT;
  const days = (expires - now) / DAY;
  const result = {
    valid: true, direction, symbol: contract.symbol, strike, expires, ...size, ...cost,
    costUSDT, dualIncomeUSDT, netIncomeUSDT, capitalUSDT, capitalWithInsuranceUSDT,
    term, annual: term * 365 / days, days, quoteTime: book.time,
    valuationSpot: index, valuationTime: market.indexTime, dualQuoteTime: dual.quoteTime,
    openingRate: contract.taker, openingCap: contract.cap,
    deliveryRate: contract.delivery, deliveryCap: contract.deliveryCap
  };
  return Object.values(result).every(value => typeof value !== 'number' || Number.isFinite(value))
    ? result : fail('保护报价超出可计算范围');
}

// A credit spread on two independently quoted contracts. The result describes the
// options alone. Cash settlement fees depend on the actual settlement price.
export function calculateOptionInsurance({direction, data, protectionContract, protectionBook, now = Date.now()} = {}) {
  const short = data?.row?.contract;
  const quote = data?.row?.quote;
  const market = data?.market;
  const long = protectionContract;
  const high = direction === 'CALL';
  if (!high && direction !== 'PUT') return fail('请选择低买或高卖');
  if (!validOption(short, direction) || short.expires <= now ||
      short.strike !== data?.targetPrice || short.expires !== data?.selectedExpiry) {
    return fail('缺少所选目标价、到期日的卖出合约');
  }
  if (!validOption(long, direction) || long.expires !== short.expires) {
    return fail('缺少同方向、同到期时刻的保护期权');
  }
  if (long.strike === short.strike) {
    return {...fail('同到期、同执行价的同种期权按相同数量买回，会抵消已有卖仓'), offsetting: true};
  }
  if (high ? long.strike < short.strike : long.strike > short.strike) {
    return fail(high ? '上涨保护的 CALL 执行价须高于卖出价' : '下跌保护的 PUT 执行价须低于卖出价');
  }
  if (!quote?.valid || !positive(quote.q) || !positive(quote.amount) ||
      !Number.isFinite(quote.netIncome) || !positive(market?.spot) ||
      quote.expires !== short.expires || quote.strike !== short.strike ||
      data.row.book?.symbol !== short.symbol || quote.quoteTime !== data.row.book.time) {
    return fail('卖出期权的真实报价或数量无效');
  }
  if (!protectionBook || protectionBook.symbol !== long.symbol) return fail('缺少所选保护合约的真实卖盘');
  const times = [market.time, market.indexTime, quote.quoteTime, protectionBook.time];
  if (!synchronized(times, now) || !fresh(data.row.receivedAt, now) || !fresh(market.receivedAt, now)) {
    return fail('两个期权盘口或指数时间已失效，请刷新');
  }
  const exposureBTC = quote.q * short.unit;
  const size = sizeProtection(exposureBTC, 0, 1, long.step, long.unit);
  if (!size || size.uncoveredBTC !== 0 || size.contracts < long.min || size.contracts > long.max) {
    return fail('保护期权的数量步长或数量限制无法覆盖整笔卖仓');
  }
  const cost = askCost(protectionBook, long, size.contracts, market.spot);
  if (cost.valid === false) return cost;

  const costUSDT = cost.premiumUSDT + cost.openingFeeUSDT;
  const netIncomeUSDT = quote.netIncome - costUSDT;
  const capitalUSDT = quote.amount;
  const capitalWithInsuranceUSDT = capitalUSDT + costUSDT;
  const term = netIncomeUSDT / capitalWithInsuranceUSDT;
  const days = (short.expires - now) / DAY;
  const strikeWidth = Math.abs(long.strike - short.strike);
  const result = {
    valid: true, direction, symbol: long.symbol, shortSymbol: short.symbol, strike: long.strike,
    shortStrike: short.strike, expires: short.expires, ...size, ...cost, costUSDT,
    shortNetIncomeUSDT: quote.netIncome, netIncomeUSDT, strikeWidth,
    maxExpiryLossUSDT: Math.max(0, exposureBTC * strikeWidth - netIncomeUSDT),
    maxExpiryPnlUSDT: netIncomeUSDT, capitalUSDT, capitalWithInsuranceUSDT, term,
    annual: term * 365 / days, days, quoteTime: protectionBook.time,
    conditional: quote.conditional === true, valuationSpot: market.spot,
    deliveryRate: long.delivery, deliveryCap: long.deliveryCap
  };
  return Object.values(result).every(value => typeof value !== 'number' || Number.isFinite(value))
    ? result : fail('期权价差报价超出可计算范围');
}

// Quote the remaining long option separately when its maturity outlasts the
// investment. Its market value at the first maturity cannot be known today.
export function calculateLaterInsurance({
  direction, data, dual, source, protectionContract: long, protectionBook: book, now = Date.now()
} = {}) {
  if (direction !== 'PUT' && direction !== 'CALL') return fail('请选择低买或高卖');
  if (source !== 'dual' && source !== 'option') return fail('请选择需要保护的双币或卖出期权');
  const high = direction === 'CALL';
  const market = data?.market;
  const strike = data?.targetPrice;
  const baseExpiry = data?.selectedExpiry;
  if (!positive(strike) || !Number.isSafeInteger(baseExpiry) || baseExpiry <= now ||
      !validOption(long, direction) || long.strike !== strike || long.expires <= baseExpiry) {
    return fail('跨期保护须使用同方向、同执行价、且晚于主策略到期的期权');
  }
  if (!book || book.symbol !== long.symbol || !symbolMatches(long, direction)) {
    return fail('跨期保护盘口与合约日期、方向或执行价不一致');
  }
  if (!positive(market?.spot) || !fresh(market.receivedAt, now)) return fail('缺少有效的 BTC 指数');
  const times = [market.time, market.indexTime, book.time];
  let size;
  let baseIncomeUSDT;
  let conditional = false;
  if (source === 'dual') {
    const product = dual?.product;
    if (!dual?.valid || !dual.ordinary || product?.optionType !== direction ||
        product.investCoin !== (high ? 'BTC' : 'USDT') || product.exercisedCoin !== (high ? 'USDT' : 'BTC') ||
        Number(product.strikePrice) !== strike || Number(product.settleDate) !== baseExpiry ||
        dual.productExpiry !== baseExpiry || !Number.isSafeInteger(dual.rateExpiry) || dual.rateExpiry <= now) {
      return fail('缺少当前目标价和主到期日的真实双币报价');
    }
    const input = high ? data.quantity : data.amount;
    if (!positive(input) || !positive(dual.amount) || dual.amount > input || !Number.isFinite(dual.income) || dual.income < 0) {
      return fail('双币投入金额或本期收益无法核实');
    }
    size = sizeProtection(dual.amount, dual.income, high ? 1 : strike, long.step, long.unit);
    baseIncomeUSDT = dual.income * (high ? market.spot : 1);
    times.push(dual.quoteTime);
  } else {
    const short = data?.row?.contract;
    const quote = data?.row?.quote;
    if (!validOption(short, direction) || !symbolMatches(short, direction) || short.expires !== baseExpiry || short.strike !== strike ||
        !quote?.valid || !positive(quote.q) || !positive(quote.amount) || !Number.isFinite(quote.netIncome) ||
        quote.expires !== baseExpiry || quote.strike !== strike || short.symbol !== data.row.book?.symbol ||
        quote.quoteTime !== data.row.book.time || !fresh(data.row.receivedAt, now)) {
      return fail('缺少当前主到期日的卖出期权报价或数量');
    }
    size = sizeProtection(quote.q * short.unit, 0, 1, long.step, long.unit);
    baseIncomeUSDT = quote.netIncome;
    conditional = quote.conditional === true;
    times.push(quote.quoteTime);
    if (size && size.uncoveredBTC !== 0) return fail('跨期保护合约的步长无法覆盖整笔卖仓');
  }
  if (!synchronized(times, now)) return fail('主策略、指数或跨期保护盘口已失效，请刷新');
  if (!size || size.contracts < long.min || size.contracts > long.max) return fail('跨期保护数量不符合合约限制');
  const cost = askCost(book, long, size.contracts, market.spot);
  if (cost.valid === false) return cost;
  const costUSDT = cost.premiumUSDT + cost.openingFeeUSDT;
  const result = {
    valid: true, source, direction, symbol: long.symbol, expires: long.expires, baseExpiry, strike,
    ...size, ...cost, costUSDT, baseIncomeUSDT, initialNetUSDT: baseIncomeUSDT - costUSDT,
    valuationSpot: market.spot, valuationTime: market.indexTime, quoteTime: book.time, conditional,
    deliveryRate: long.delivery, deliveryCap: long.deliveryCap
  };
  return Object.values(result).every(value => typeof value !== 'number' || Number.isFinite(value))
    ? result : fail('跨期保护报价超出可计算范围');
}

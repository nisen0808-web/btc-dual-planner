import { sizeProtection } from './comparison-math.js';

const DAY = 86_400_000;
const coins = {binance:'USDT', okx:'BTC', coinbase:'USDC', gate:'USDT'};
const positive = x => Number.isFinite(x) && x > 0;
const rate = x => Number.isFinite(x) && x >= 0 && x <= 1;
const fail = reason => ({valid:false, reason});
const fresh = (t, now) => Number.isSafeInteger(t) && t > 0 && t <= now + 2_000 && now - t < 30_000;
const synced = (stamps, now) => stamps.every(t => fresh(t, now)) && Math.max(...stamps) - Math.min(...stamps) < 30_000;
const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

export function sameInstrument(symbol, venue, direction, strike, expiry) {
  if (!Number.isSafeInteger(expiry) || !positive(strike) || typeof symbol !== 'string') return false;
  const date = new Date(expiry);
  if (!Number.isFinite(date.getTime()) || expiry % DAY !== 8 * 3_600_000) return false;
  const iso = date.toISOString(), yy = iso.slice(2,4);
  if (!Object.hasOwn(coins,venue)) return false;
  const dateCode = venue === 'gate' ? iso.slice(0,10).replaceAll('-','') :
    venue === 'coinbase' ? date.getUTCDate() + months[date.getUTCMonth()] + yy : yy + iso.slice(5,7) + iso.slice(8,10);
  const prefix = {binance:'BTC-',okx:'BTC-USD-',coinbase:'BTC_USDC-',gate:'BTC_USDT-'}[venue];
  const [k, kind, ...rest] = symbol.slice(prefix.length + dateCode.length + 1).split('-');
  return symbol.startsWith(prefix + dateCode + '-') && /^\d+(?:\.\d+)?$/.test(k) &&
    Number(k) === strike && kind === direction[0] && !rest.length;
}

function dualPrincipal(dual, venue, direction, strike, expiry, amount, now) {
  const investCoin = direction === 'CALL' ? 'BTC' : 'USDT';
  if (!dual?.valid || !Number.isFinite(dual.income) || dual.income < 0) return null;
  if (venue === 'binance') {
    const product = dual.product;
    if (!dual.ordinary || !positive(dual.amount) || dual.amount > amount || dual.productExpiry !== expiry ||
        !Number.isSafeInteger(dual.rateExpiry) || dual.rateExpiry <= now || product?.optionType !== direction ||
        product.investCoin !== investCoin || product.exercisedCoin !== (direction === 'CALL' ? 'USDT' : 'BTC') ||
        Number(product.settleDate) !== expiry || Number(product.strikePrice) !== strike) return null;
    return dual.amount;
  }
  if (venue === 'gate' || venue === 'bitget') {
    return dual.venue === venue && dual.coin === investCoin && dual.strikeCurrency === 'USDT' && dual.direction === direction &&
      dual.strike === strike && dual.expires === expiry && dual.productId != null && String(dual.productId) !== '' &&
      dual.principal === amount ? amount : null;
  }
  if (venue !== 'okx' || dual.coin !== investCoin || !dual.productId?.startsWith('BTC-USDT-') ||
      !sameInstrument(dual.productId.replace('BTC-USDT-', 'BTC-USD-'), 'okx', direction, strike, expiry)) return null;
  return amount;
}

// Prices are per BTC exposure. Book sizes and the lot limit are in contracts.
export function buyAsks(contract, book, quantity, feeBasis) {
  if (!book.asks?.length) return fail('所选保护期权暂无卖盘');
  if (book.bids?.length && book.bids[0].price >= book.asks[0].price) return fail('保护期权买卖盘交叉，请刷新');
  const knownFee = rate(contract.taker) && rate(contract.cap);
  let left = quantity, premium = 0, openingFee = knownFee ? 0 : null, levelsUsed = 0, prior = 0;
  for (const {price, qty} of book.asks) {
    if (!positive(price) || price <= prior || !positive(qty)) return fail('保护期权卖盘档位无效');
    const fill = Math.min(left, qty);
    const btc = fill * contract.unit;
    premium += btc * price;
    if (knownFee) openingFee += btc * Math.min(feeBasis * contract.taker, price * contract.cap);
    levelsUsed++;
    left -= fill;
    if (left <= quantity * Number.EPSILON * (levelsUsed + 1)) {
      return {premium, openingFee, cost:knownFee ? premium + openingFee : null, levelsUsed, avgAsk:premium / (quantity * contract.unit)};
    }
    prior = price;
  }
  return fail('所选保护期权的卖盘深度不足以覆盖整笔数量');
}

export function calculateVenueInsurance({
  optionVenue,dualVenue,direction,source,amount,strike,expires,hedgeStrike = strike,hedgeExpires = expires,
  market,contract,book,dual,short,fx,now = Date.now()
} = {}) {
  const coin = coins[optionVenue], high = direction === 'CALL', later = hedgeExpires > expires;
  if (optionVenue === 'bitget') return fail(market?.reason || 'Bitget 暂无可验证的公开 BTC 期权盘口');
  if (!coin || (!high && direction !== 'PUT') || !['option','dual'].includes(source) ||
      !positive(amount) || !positive(strike) || !Number.isSafeInteger(expires) || expires <= now) return fail('请选择有效的投入、方向、目标价和主到期日');
  if (!Number.isSafeInteger(hedgeExpires) || hedgeExpires < expires || !positive(hedgeStrike)) return fail('请选择有效的保护合约');
  if (later || source === 'dual') {
    if (hedgeStrike !== strike) return fail('双币或跨期保护须使用相同名义目标价');
  } else if (high ? hedgeStrike <= strike : hedgeStrike >= strike) {
    return fail(high ? '保护卖出 CALL 须选择更高执行价的同到期 CALL' : '保护卖出 PUT 须选择更低执行价的同到期 PUT');
  }
  if (market?.status !== 'ready' || market.platform !== optionVenue || !positive(market.spot)) {
    return fail(market?.reason || '所选保护平台指数或合约列表暂不可用');
  }
  if (!contract || contract.settleCoin !== coin || (contract.direction ?? contract.optionType) !== direction ||
      contract.strike !== hedgeStrike || contract.expires !== hedgeExpires ||
      !sameInstrument(contract.symbol,optionVenue,direction,hedgeStrike,hedgeExpires) ||
      ![contract.min,contract.step,contract.unit].every(positive)) return fail('该平台缺少匹配的保护合约或数量规则');
  if (book?.status !== 'ready' || book.platform !== optionVenue || book.symbol !== contract.symbol) {
    return fail(book?.reason || '所选保护合约的真实卖盘暂不可用');
  }
  if (optionVenue === 'gate' && (market.indexCoin !== 'USDT' || contract.coin !== coin || book.currency !== coin))
    return fail('Gate 保护合约或盘口的 USDT 币种未核实');
  const stamps = [market.time, market.indexTime, book.time, source === 'dual' ? dual?.quoteTime : short?.quoteTime];
  if (!synced(stamps, now)) return fail('主策略、保护盘口或指数报价缺失或已过期');
  let size, income, incomeCoin;
  const principalCoin = high ? 'BTC' : 'USDT';
  if (source === 'dual') {
    const principal = dualPrincipal(dual,dualVenue,direction,strike,expires,amount,now);
    if (!positive(principal)) return fail(dual?.reason || '所选双币未返回同价、同到期的有效收益');
    size = sizeProtection(principal,dual.income,high ? 1 : strike,contract.step,contract.unit);
    income = dual.income;
    incomeCoin = principalCoin;
  } else {
    if (!short?.valid || short.coin !== coin || !positive(short.coveredBTC) ||
        !sameInstrument(short.symbol,optionVenue,direction,strike,expires)) return fail(short?.reason || '所选平台卖出期权的数量或合约未核实');
    // The public seller quote computes BTC as contracts × unit, which can introduce sub-lot binary noise.
    size = sizeProtection(Number(short.coveredBTC.toPrecision(15)),0,1,contract.step,contract.unit);
    if (size?.uncoveredBTC > 0) return fail('保护合约数量步长无法覆盖整笔卖仓');
    income = short.income;
    incomeCoin = coin;
  }
  if (!size || !positive(size.contracts) || size.contracts < contract.min) return fail('投入不足该平台保护合约的最小张数');
  if (positive(contract.max) && size.contracts > contract.max) return fail('所需保护数量超过已公布的单笔限额');
  const inverse = coin === 'BTC';
  const fill = buyAsks(contract,book,size.contracts,inverse ? 1 : market.spot);
  if (fill.valid === false) return fill;

  // A CALL's BTC principal is already denominated in OKX premium currency. For a linear
  // venue its own live BTC index gives a native valuation without assuming USDT=USDC.
  const fxPrice = inverse ? fx?.btcUSDT : fx?.usdcUSDT;
  const fxTime = inverse ? fx?.btcTime : fx?.usdcTime;
  const nativeUSDT = coin === 'USDT' ? 1 : positive(fxPrice) && synced([...stamps, fxTime], now) ? fxPrice : null;
  const principalToNative = high ? (inverse ? 1 : market.spot) : nativeUSDT ? 1 / nativeUSDT : null;
  const nativeIncome = Number.isFinite(income) && (incomeCoin === coin || principalToNative !== null)
    ? income * (incomeCoin === coin ? 1 : principalToNative) : null;
  const cost = fill.cost;
  const netIncome = nativeIncome !== null && cost !== null ? nativeIncome - cost : null;
  const capital = principalToNative !== null ? amount * principalToNative : null;
  const term = !later && netIncome !== null && positive(capital) ? netIncome / (capital + cost) : null;
  const toUSDT = value => value !== null && nativeUSDT !== null ? value * nativeUSDT : null;
  // Inverse payoffs divide by the eventual BTC index. A fixed strike width is not a BTC loss cap.
  const maxExpiryLoss = source === 'option' && !later && !inverse && netIncome !== null
    ? Math.max(0, size.coveredBTC * Math.abs(hedgeStrike - strike) - netIncome) : null;
  const answer = {valid:true, optionVenue, dualVenue, direction, source, later, coin, netCoin:coin,
    symbol:contract.symbol, strike:hedgeStrike, expires:hedgeExpires, baseStrike:strike, baseExpiry:expires,
    ...size,...fill,netIncome,term,annual:term === null ? null : term * 365 * DAY / (expires - now),
    maxExpiryLoss,lossCoin:coin,maxExpiryLossUSDT:coin === 'USDT' ? maxExpiryLoss : null,
    costUSDT:toUSDT(cost),premiumUSDT:toUSDT(fill.premium),openingFeeUSDT:toUSDT(fill.openingFee),netIncomeUSDT:toUSDT(netIncome),
    conditional:source === 'option' && short.conditional === true, quoteTime:book.time, feeKnown:fill.openingFee !== null,
    valuationReason:netIncome === null ? (cost === null || !Number.isFinite(income) ? '公开费率或主策略净收益待核实' : '缺少同步汇率，暂不能合并两种币的收入与保费') : ''};
  return Object.values(answer).some(x => typeof x === 'number' && !Number.isFinite(x)) ? fail('金额超出可计算范围') : answer;
}

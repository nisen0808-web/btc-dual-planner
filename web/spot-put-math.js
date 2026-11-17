import {sizeProtection, symbolMatches, synchronized, validOption} from './comparison-math.js';
import {buyAsks, sameInstrument} from './venue-insurance.js';

const positive = value => Number.isFinite(value) && value > 0;
const rate = value => Number.isFinite(value) && value >= 0 && value <= 1;
const fail = reason => ({valid:false, reason});

// Under the displayed fixed cross-currency valuation, an OKX payoff of
// Q × (K - S) / S BTC converts into the same piecewise linear USDT value
// as a linear put. This expression also gives the right-hand limit at zero.
function usdtOutcome(quote, settlement) {
  const intrinsic = Math.max(0, quote.strike - settlement);
  const exerciseFee = quote.putBTC * Math.min(quote.deliveryRate * settlement, quote.deliveryCap * intrinsic);
  const spotPnl = quote.spotBTC * (settlement - quote.entryPrice);
  const putPnl = quote.putBTC * intrinsic - exerciseFee - quote.cost;
  const totalPnl = spotPnl + putPnl;
  const totalFromNow = quote.spotBTC * (settlement - quote.index) + putPnl;
  if (![spotPnl,putPnl,totalPnl,totalFromNow].every(Number.isFinite)) return fail('金额超出可计算范围');
  return {valid:true, settlement, spotPnl, putPnl, exerciseFee, totalPnl, totalFromNow};
}

export function spotPutOutcome(quote, settlement) {
  if (!quote?.valid || !Number.isFinite(settlement) || settlement < 0) return fail('请输入有效的到期结算价');
  if (!quote.valuationReady) return fail(quote.valuationReason);
  if (quote.venue === 'okx' && settlement === 0) return fail('OKX 反向 PUT 以结算价为除数，请输入大于零的到期价');
  const result = usdtOutcome(quote,settlement);
  if (!result.valid) return result;
  const nativeAtExpiry = quote.venue === 'okx' ? settlement : quote.fxRate;
  const nativePayoff = quote.putBTC * Math.max(0, quote.strike-settlement) / nativeAtExpiry;
  const nativeExerciseFee = result.exerciseFee / nativeAtExpiry;
  if (![nativePayoff,nativeExerciseFee].every(Number.isFinite)) return fail('原币结算金额超出可计算范围');
  return {...result,nativePayoff,nativeExerciseFee};
}

// At expiration the portfolio is piecewise linear. Exercise fees change branch
// at rate × S = cap × (K − S). Scan from zero up to today's index, stopping at
// the first loss: this finds the deep-downside break-even, not the upside one.
function downside(quote, metric) {
  const {strike, deliveryRate, deliveryCap, index} = quote;
  const feeSwitch = deliveryRate + deliveryCap > 0 ? strike * (deliveryCap / (deliveryRate + deliveryCap)) : strike;
  const points = [...new Set([0, Math.min(feeSwitch,index), Math.min(strike,index), index])].sort((a,b) => a-b);
  let price = 0;
  let pnl = usdtOutcome(quote,0)[metric];
  if (pnl < 0) return {price:null, status:'unreachable'};
  // Exactly offsetting spot and PUT, with a zero exercise rate, can sit at
  // break-even for a whole interval. A zero floor is not downside profit.
  if (pnl === 0) {
    const nextPnl = usdtOutcome(quote,points[1])[metric];
    if (nextPnl <= 0) return {price:null, status:nextPnl === 0 ? 'break_even_floor' : 'zero_only'};
  }
  for (const next of points.slice(1)) {
    const nextPnl = usdtOutcome(quote,next)[metric];
    if (nextPnl < 0) {
      const root = price + (next - price) * (pnl / (pnl - nextPnl));
      return {price:root, status:'threshold'};
    }
    price = next;
    pnl = nextPnl;
  }
  return {price:null, status:'already_profitable'};
}

function conversionFor(venue, market, fx, stamps, now) {
  if (venue === 'binance' || venue === 'gate') return {fxRate:1,strikeFx:1,fxTime:market.indexTime,
    fxSource:(venue === 'gate' ? 'Gate' : 'Binance')+' BTC/USDT 指数'};
  const btcMarket = venue === 'okx' && positive(market.spotUSDT) && synchronized([...stamps,market.indexUSDTTime],now);
  let price, time, source;
  if (btcMarket) {
    price = market.spotUSDT;
    time = market.indexUSDTTime;
    source = 'OKX BTC/USDT 指数';
  } else if (venue === 'okx') {
    price = fx?.btcUSDT;
    time = fx?.btcTime;
    source = fx?.btcSource;
  } else {
    price = fx?.usdcUSDT;
    time = fx?.usdcTime;
    source = fx?.usdcSource;
  }
  if (!positive(price) || !synchronized([...stamps,time],now)) return {fxRate:null,strikeFx:null,fxTime:null,fxSource:''};
  return {fxRate:price,strikeFx:venue === 'okx' ? price / market.spot : price,fxTime:time,fxSource:source || ''};
}

export function quoteSpotPut({market, contract, book, spotBTC, coverage, entryPrice, venue = market?.platform, fx, now = Date.now()} = {}) {
  if (![spotBTC,coverage,entryPrice].every(positive)) return fail('请输入大于零的现货数量、每枚买入成本和保护倍数');
  const nativeCoin = {binance:'USDT',okx:'BTC',coinbase:'USDC',gate:'USDT'}[venue];
  const strikeCoin = venue === 'okx' ? 'USD' : nativeCoin;
  if (!nativeCoin || market?.status !== 'ready' || market.platform !== venue || !positive(market.spot))
    return fail(market?.reason || '所选平台公开 PUT 行情暂不可用');
  const listed = market.contracts?.find(c => c.symbol === contract?.symbol);
  if (!listed || listed.expires <= now || !positive(listed.strike) || ![listed.unit,listed.step,listed.min].every(positive))
    return fail('该 PUT 合约不在当前有效挂牌清单中');
  contract = listed;
  const stamps = [market.time,market.indexTime,book?.time];
  if (book?.status !== 'ready' || book.platform !== venue || book.symbol !== contract.symbol)
    return fail(book?.reason || '保护合约的真实卖盘暂不可用');
  if (venue === 'binance') {
    if (market.currency !== nativeCoin || market.sourceType !== 'official_public_api' ||
        book.currency !== nativeCoin || book.sourceType !== 'official_public_api' ||
        !validOption(contract,'PUT') || contract.unit !== 1 || !symbolMatches(contract,'PUT'))
      return fail('所选 Binance PUT 合约、到期日或费率无效');
    stamps.push(market.metadataTime,market.receivedAt,book.receivedAt);
  } else {
    if (market.indexCoin !== strikeCoin || contract.coin !== nativeCoin || contract.settleCoin !== nativeCoin ||
        contract.direction !== 'PUT' || !sameInstrument(contract.symbol,venue,'PUT',contract.strike,contract.expires) ||
        (venue === 'okx' ? (book.quoteCoin !== nativeCoin || book.settleCoin !== nativeCoin || !positive(contract.max)) :
          (book.currency !== nativeCoin || (venue === 'coinbase' && contract.unit !== 1))))
      return fail('所选平台 PUT 的币种、合约标识或数量规则不符');
  }
  if (!synchronized(stamps,now)) return fail('PUT 盘口或指数已过期，请刷新');

  const size = sizeProtection(spotBTC,0,1,contract.step,contract.unit,coverage);
  if (!size || size.contracts < contract.min || (contract.max != null && (!positive(contract.max) || size.contracts > contract.max)))
    return fail('所需张数超出该 PUT 合约的最小或最大数量');
  const fill = buyAsks(contract,book,size.contracts,venue === 'okx' ? 1 : market.spot);
  if (fill.valid === false) return fill;
  const fxData = conversionFor(venue,market,fx,stamps,now);
  const asUSDT = value => value !== null && fxData.fxRate !== null ? value * fxData.fxRate : null;
  const strikeAsUSDT = value => fxData.strikeFx === null ? null : value * fxData.strikeFx;
  const daily = (venue === 'okx' || venue === 'coinbase') && new Date(contract.expires).getUTCDay() !== 5;
  let deliveryRate = contract.delivery, deliveryCap = contract.deliveryCap;
  if (daily) {
    deliveryRate = 0; deliveryCap = 0;
  } else if (venue === 'coinbase') {
    // Deribit standard USDC linear delivery fee, subject to the user's Coinbase terms.
    deliveryRate = 0.00015; deliveryCap = 0.125;
  } else if (venue === 'okx') {
    deliveryRate = rate(contract.delivery) && rate(contract.taker) ? Math.min(contract.delivery,contract.taker) : null;
  }
  const valuationReason = !fxData.fxRate ? '缺少同步换算行情，暂无法计算 USDT 收益或回本价' :
    fill.cost === null ? '公开开仓费率待核实，暂无法计算净收益' :
    !rate(deliveryRate) || !rate(deliveryCap) ? '公开到期行权费待核实，暂无法计算净收益' : '';
  const quote = {valid:true, venue, nativeCoin, strikeCoin, nativeStrike:contract.strike, nativeIndex:market.spot,
    symbol:contract.symbol, expires:contract.expires, strike:strikeAsUSDT(contract.strike),
    spotBTC, putBTC:size.coveredBTC, contracts:size.contracts, roundingTail:size.uncoveredBTC, entryPrice, index:strikeAsUSDT(market.spot),
    premium:asUSDT(fill.premium), openingFee:asUSDT(fill.openingFee), cost:asUSDT(fill.cost), averageAsk:asUSDT(fill.avgAsk),
    nativePremium:fill.premium, nativeOpeningFee:fill.openingFee, nativeCost:fill.cost, nativeAverageAsk:fill.avgAsk,
    levelsUsed:fill.levelsUsed, quoteTime:book.time, ...fxData, deliveryRate, deliveryCap,
    valuationReady:!valuationReason, valuationReason, lowerBreakEven:null, lowerBreakEvenFromNow:null};
  if (Object.values(quote).some(v => typeof v === 'number' && !Number.isFinite(v))) return fail('金额超出可计算范围');
  if (!quote.valuationReady) return quote;
  if (![0,quote.strike,quote.index].every(s => usdtOutcome(quote,s).valid)) return fail('金额超出可计算范围');
  const original = downside(quote,'totalPnl');
  const incremental = downside(quote,'totalFromNow');
  return {...quote, lowerBreakEven:original.price, downsideStatus:original.status,
    lowerBreakEvenFromNow:incremental.price, downsideStatusFromNow:incremental.status};
}

// Amounts use the venue's original premium currency. FX is a current valuation only.
const DAY = 86_400_000;
const fresh = (time, now) => Number.isSafeInteger(time) && time > 0 && time <= now + 2_000 && now - time < 30_000;
const positive = n => typeof n === 'number' && Number.isFinite(n) && n > 0;
const rate = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
const fail = reason => ({valid:false,reason});

function fxRate(coin, fx, now) {
  if (coin === 'USDT') return 1;
  const [price,time] = coin === 'BTC' ? [fx?.btcUSDT, fx?.btcTime] : [fx?.usdcUSDT, fx?.usdcTime];
  return positive(price) && fresh(time, now) ? price : null;
}

function sizeToStep(notionalBTC, unit, step) {
  const ratio = notionalBTC / (unit * step);
  // Ignore only binary noise at an exact exchange lot boundary.
  const lots = Math.floor(ratio + Math.min(1e-8, Math.abs(ratio) * Number.EPSILON * 3));
  if (!Number.isSafeInteger(lots)) return null;
  return Number((lots * step).toPrecision(15));
}

export function calculateVenueOption({direction, amount, strike, expires, quoteMode, market, contract:c, book, fx, now = Date.now()}) {
  if (!['PUT','CALL'].includes(direction) || !positive(amount) || !positive(strike)) return fail('请填写有效的金额和目标价');
  if (market?.status !== 'ready' || !fresh(market.time, now) || !positive(market.spot)) return fail(market?.reason || '平台指数或合约列表尚无有效报价');
  if (!c || c.direction !== direction || c.strike !== strike || c.expires !== expires || !Number.isSafeInteger(expires) || expires <= now)
    return fail('该平台没有相同目标价和到期时刻的合约');
  if (book?.status !== 'ready' || book.symbol !== c.symbol || !fresh(book.time, now) || Math.abs(book.time-market.time)>=30_000)
    return fail(book?.reason || '所选合约盘口缺失或已过期');
  const coin = c.coin, inverse = coin === 'BTC', high = direction === 'CALL';
  const gate = market.platform === 'gate';
  if (gate && (coin !== 'USDT' || c.settleCoin !== coin || book.platform !== 'gate' || book.currency !== coin ||
      !fresh(market.indexTime,now))) return fail('Gate 合约币种、指数或盘口来源未核实');
  if (!(inverse || coin === 'USDC' || (gate && coin === 'USDT')) || ![c.unit,c.step,c.min].every(positive) ||
      market.indexCoin !== (inverse ? 'USD' : coin)) return fail('平台合约面值或计价币种未核实');
  const conversion = fxRate(coin,fx,now);
  if (!high && !conversion) return fail('实时汇率缺失，无法按这笔 USDT 投入确定期权数量');
  const btcUSDT = fxRate('BTC',fx,now);
  const strikeUSDT = high ? null : inverse ? strike * conversion / market.spot : strike * conversion;
  const exposure = high ? amount : amount / strikeUSDT;
  const contracts = sizeToStep(exposure,c.unit,c.step);
  if (!positive(contracts) || contracts < c.min) return fail('投入金额不足平台最小合约数量');
  if (positive(c.max) && contracts > c.max) return fail('数量超过平台已公布的单笔限额');
  const coveredBTC = contracts * c.unit;
  const askLimit = quoteMode === 'ask_limit';
  if (!askLimit && quoteMode !== 'bid_taker') return fail('报价口径无效');
  const rows = askLimit ? book.asks : book.bids;
  if (!Array.isArray(rows) || !rows.length) return fail(askLimit ? '该合约暂无卖一报价' : '该合约暂无买盘深度');
  if (book.bids?.length && book.asks?.length && book.bids[0].price >= book.asks[0].price) return fail('盘口交叉，等待新报价');
  const feeRate = askLimit ? c.maker : c.taker;
  const feeKnown = rate(feeRate) && rate(c.cap);
  let remaining = contracts, gross = 0, fee = 0, levelsUsed = 0;
  for (const level of rows) {
    if (!positive(level.price) || !positive(level.qty)) return fail('盘口档位无效');
    const quantity = askLimit ? remaining : Math.min(remaining,level.qty);
    const sizeBTC = quantity * c.unit;
    gross += sizeBTC * level.price;
    if (feeKnown) fee += sizeBTC * Math.min((inverse ? 1 : market.spot) * feeRate, c.cap * level.price);
    remaining -= quantity;
    levelsUsed++;
    if (remaining <= contracts * 1e-12) break;
  }
  if (remaining > contracts * 1e-12) return fail('买盘深度不足，无法估算整笔权利金');
  const income = feeKnown ? gross - fee : null;
  const incomeUSDT = feeKnown && conversion ? income * conversion : null;
  // CALL basis is the BTC holding valued at this venue. PUT basis is the full input USDT converted to native premium currency.
  const capitalBasis = high ? amount * (inverse ? 1 : market.spot) : amount / conversion;
  const term = feeKnown ? income / capitalBasis : null;
  return {valid:true, symbol:c.symbol, coin, priceCurrency:coin, contracts, coveredBTC, gross, income, incomeUSDT,
    openFee:feeKnown ? fee : null, capitalBasis, term, annual:term === null ? null : term * 365 * DAY / (expires-now),
    averagePrice:gross/coveredBTC, bestAsk:book.asks?.[0]?.price ?? null, bestBid:book.bids?.[0]?.price ?? null,
    quoteTime:book.time, levelsUsed, conditional:askLimit, feeNote:c.feeBasis || '账户实际费率未核验',
    valuationNote:conversion ? coin+' 按当前汇率折合 USDT' : coin+' 为原币，当前缺少 USDT 折算报价',
    strikeCurrency:c.strikeCurrency || market.indexCoin, fxRate:conversion, btcUSDT,
    fxTime:coin === 'USDT' ? null : inverse ? fx?.btcTime : fx?.usdcTime, feeSource:c.feeSource};
}

const dualNames = {okx:'OKX', gate:'Gate', bitget:'Bitget'};

export function dualSubscriptionOpen(product, venue, now) {
  if (product.purchaseEnd != null) return Number.isSafeInteger(product.purchaseEnd) && now < product.purchaseEnd;
  return venue === 'bitget' && product.subscriptionOpen === true && Number.isSafeInteger(product.availabilityUntil) &&
    now < product.availabilityUntil && product.availabilityUntil <= product.time + 30_000 && product.availabilityUntil <= product.expires;
}

export function calculateVenueDual({venue, direction, amount, strike, expires, catalogue, fx, now=Date.now()}) {
  const name=dualNames[venue];
  if (!name || (catalogue?.platform != null && catalogue.platform !== venue) ||
      (venue !== 'okx' && catalogue?.status === 'ready' && catalogue.platform !== venue)) return fail('双币产品来源与所选平台不符');
  if (catalogue?.status !== 'ready' || !fresh(catalogue.time,now)) return fail(catalogue?.reason || name+' 双币产品报价缺失或过期');
  if (!['CALL','PUT'].includes(direction) || !positive(amount) || !positive(strike) || !Number.isSafeInteger(expires) || expires<=now) return fail('请输入有效的方向、本金、价格与到期日');
  const coin = direction === 'CALL' ? 'BTC' : 'USDT';
  const matching = (catalogue.products || []).filter(p=>p.direction===direction && p.coin===coin && p.strike===strike && p.expires===expires &&
    (venue === 'okx' || (p.id != null && String(p.id) !== '' && p.strikeCurrency === 'USDT')) &&
    (p.min == null || (Number.isFinite(p.min) && amount>=p.min)) && (p.max == null || (positive(p.max) && amount<=p.max)) &&
    fresh(p.time,now) && dualSubscriptionOpen(p,venue,now) &&
    Number.isFinite(p.term) && p.term>=0 && Number.isFinite(p.apr) && p.apr>=0);
  const product=matching.sort((a,b)=>b.term-a.term)[0];
  if (!product) return fail(name+' 暂无与该价格、到期及金额匹配的有效双币报价');
  const income=amount*product.term, conversion=fxRate(coin,fx,now);
  if (!Number.isFinite(income)) return fail('金额超出可计算范围');
  const estimateOnly=product.min==null || product.max==null || product.amountRulesVerified===false;
  const rateBasis=venue === 'bitget' ? '本期利息按 Bitget 参考 APR 及剩余完整小时估算。' :
    product.termEstimated ? '按 Gate 公布的年化和从当前到期的剩余时长估算本期利息。' :
    venue === 'okx' ? '本期率和 APR 取自 OKX 公开产品。' : '收益按'+name+'公开产品报价计算。';
  return {valid:true,coin,income,incomeUSDT:conversion ? income*conversion : null,term:product.term,apr:product.apr,
    quoteTime:product.time,productId:product.id,venue,direction,strike,expires,principal:amount,estimateOnly,
    termEstimated:product.termEstimated===true,note:rateBasis+(estimateOnly ? '实际可申购金额以平台为准。' : ''),strikeCurrency:product.strikeCurrency || 'USDT'};
}

export const calculateOkxDual = input => calculateVenueDual({...input,venue:'okx'});

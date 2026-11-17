import { calculateVenueOption, calculateVenueDual, dualSubscriptionOpen } from './venue-math.js';

export const venueNames = {binance:'Binance', okx:'OKX', coinbase:'Coinbase App · Deribit', gate:'Gate', bitget:'Bitget'};
export const optionVenues = ['okx','coinbase','gate'];
const dualVenues = ['okx','gate','bitget'];
const usable = (time, now) => Number.isSafeInteger(time) && time > 0 && time <= now + 2_000 && now - time < 30_000;
const positive = value => Number.isFinite(value) && value > 0;

async function readPublic(path) {
  try {
    const response = await fetch(path, {credentials:'omit', cache:'no-store', redirect:'error', signal:AbortSignal.timeout(15_000)});
    const payload = await response.json();
    if (!response.ok || payload?.status === 'unavailable') throw Error(payload?.reason || '公开报价返回 HTTP ' + response.status);
    return payload;
  } catch (error) {
    return {status:'unavailable', reason: ['AbortError','TimeoutError'].includes(error?.name) ? '平台公开报价读取超时' : error?.message || '平台公开报价读取失败'};
  }
}

export function venueSourceReads(direction, optionVenue, dualVenue) {
  const reads = {fx:readQuoteFx()};
  for (const venue of optionVenues) {
    if (venue === optionVenue || optionVenue === 'all') reads[venue] = readVenueMarket(venue,direction);
  }
  for (const venue of dualVenues) {
    if (venue === dualVenue || dualVenue === 'all') reads[venue + 'Dual'] = readPublic('/api/' + venue + '/dual?type=' + direction);
  }
  return reads;
}
export const readVenueMarket = (venue,direction) => readPublic('/api/' + venue + '/market?type=' + encodeURIComponent(direction));
export const readQuoteFx = () => readPublic('/api/quotes/fx');
export const readVenueBook = (venue,symbol) => readPublic('/api/' + venue + '/book?symbol=' + encodeURIComponent(symbol));

export function venueUniverse(sources, direction, amount, now) {
  const contracts = optionVenues.flatMap(key => {
    const market = sources[key];
    if (market?.status !== 'ready' || !usable(market.time,now)) return [];
    return (market.contracts || []).filter(c => c.direction === direction && c.expires > now && positive(c.strike)).map(c=>({...c,venue:key}));
  });
  const products = dualVenues.flatMap(venue => {
    const dual = sources[venue + 'Dual'];
    if (dual?.status !== 'ready' || !usable(dual.time,now)) return [];
    return (dual.products || []).filter(p =>
      p.direction === direction && p.expires > now && dualSubscriptionOpen(p,venue,now) && usable(p.time,now) &&
      positive(p.strike) && positive(amount) && (p.min == null || p.min <= amount) && (p.max == null || p.max >= amount)
    ).map(p=>({...p,venue}));
  });
  return {contracts, products};
}

// Each venue contributes at most one count to each side of a price/expiry pair.
export function rankSelections(contracts, products, spot, direction) {
  const pairs = new Map();
  for (const [group, rows] of [['options',contracts], ['duals',products]]) {
    for (const {strike, expires, venue = 'binance'} of rows) {
      const key = strike + '/' + expires;
      if (!pairs.has(key)) pairs.set(key,{strike,expires,options:new Set(),duals:new Set()});
      pairs.get(key)[group].add(venue);
    }
  }
  const score = item => {
    const a = item.options.size, b = item.duals.size;
    return (a && b ? 10 : 0) + (a >= 2 && b >= 2 ? 10 : 0) + a + b;
  };
  const eligibleSide = item => !positive(spot) || (direction === 'CALL' ? item.strike >= spot : item.strike <= spot);
  return [...pairs.values()].sort((a,b)=>score(b)-score(a) || Number(eligibleSide(b))-Number(eligibleSide(a)) ||
    (positive(spot) ? Math.abs(a.strike-spot) - Math.abs(b.strike-spot) : 0) || a.expires-b.expires || a.strike-b.strike);
}

export function currentFx(snapshot, now) {
  const fx = {...snapshot?.venues?.fx};
  if (!usable(fx.btcTime,now) || !positive(fx.btcUSDT)) {
    const market = snapshot?.market;
    const okx = snapshot?.venues?.okx;
    if (market && usable(market.indexTime,now) && positive(market.spot)) {
      fx.btcUSDT = market.spot;
      fx.btcTime = market.indexTime;
    } else if (okx && usable(okx.indexUSDTTime,now) && positive(okx.spotUSDT)) {
      fx.btcUSDT = okx.spotUSDT;
      fx.btcTime = okx.indexUSDTTime;
    }
  }
  return fx;
}

export function readVenueComparison({snapshot,books,direction,amount,strike,expires,quoteMode,now,optionVenue,dualVenue}) {
  const sources = snapshot?.venues || {};
  const fx = currentFx(snapshot,now);
  const common = {direction,amount,strike,expires,fx,now};
  const options = {};
  for (const venue of optionVenues.filter(key => optionVenue === 'all' || key === optionVenue)) {
    const market = sources[venue];
    const contract = market?.contracts?.find(c => c.strike === strike && c.expires === expires && c.direction === direction);
    const book = contract ? books.get(venue + '/' + contract.symbol) : null;
    options[venue] = market?.status === 'unavailable' ? {valid:false,reason:market.reason} :
      calculateVenueOption({...common, quoteMode, market, contract, book});
  }
  const duals = {};
  for (const venue of dualVenues.filter(key => dualVenue === 'all' || key === dualVenue)) {
    duals[venue] = calculateVenueDual({...common, venue, catalogue:sources[venue + 'Dual']});
  }
  return {options, duals, fx};
}

export function netDifference(option, dual, fx, now) {
  if (!option?.valid || !dual?.valid || !Number.isFinite(option.income) || !Number.isFinite(dual.income) ||
      !usable(option.quoteTime,now) || !usable(dual.quoteTime,now) || Math.abs(option.quoteTime-dual.quoteTime) >= 30_000) return null;
  if (option.coin === dual.coin) return {amount:option.income-dual.income,coin:option.coin};
  const usdt = (income, coin) => {
    if (coin === 'USDT') return income;
    const [price,time] = coin === 'BTC' ? [fx.btcUSDT,fx.btcTime] : coin === 'USDC' ? [fx.usdcUSDT,fx.usdcTime] : [];
    return positive(price) && usable(time,now) ? income*price : null;
  };
  const a = usdt(option.income,option.coin), b = usdt(dual.income,dual.coin);
  return Number.isFinite(a) && Number.isFinite(b) ? {amount:a-b,coin:'USDT',fx:true} : null;
}

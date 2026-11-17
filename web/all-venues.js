import { sameInstrument } from './venue-insurance.js';

const fresh = (t, now) => Number.isSafeInteger(t) && t > 0 && t <= now + 2_000 && now - t < 30_000;
const synced = (a,b) => Math.abs(a-b) < 30_000;
const comparableCoins = new Set(['USDT', 'USDC', 'BTC']);

function conversion(quote, fx, now, targetCoin) {
  if (quote.coin === targetCoin) return quote.income;
  function factor(coin) {
    if (coin === 'USDT') return 1;
    const [rate, time] = coin === 'BTC' ? [fx.btcUSDT,fx.btcTime] : [fx.usdcUSDT,fx.usdcTime];
    return Number.isFinite(rate) && rate > 0 && fresh(time,now) && synced(time,quote.quoteTime) ? rate : null;
  }
  const from = factor(quote.coin), to = factor(targetCoin);
  if (!from || !to) return null;
  if (quote.coin !== 'USDT' && targetCoin !== 'USDT' && !synced(fx.btcTime,fx.usdcTime)) return null;
  const value = quote.income * from / to;
  return Number.isFinite(value) ? value : null;
}

function makeRow(key,kind,q,selection) {
  const {direction,strike,expires,fx,now} = selection;
  let reason = '';
  if (!q?.valid) reason = q?.reason || '暂无有效报价';
  else if (!['CALL','PUT'].includes(direction) || !(strike > 0) || !Number.isSafeInteger(expires) || expires <= now) reason = '请选择有效的方向、目标价与到期日';
  else if ((q.venue != null && key !== q.venue) || (q.platform != null && key !== q.platform)) reason = '报价来源与所选平台不符';
  else if ((q.direction != null && q.direction !== direction) || (q.strike != null && q.strike !== strike) ||
      (q.expires != null && q.expires !== expires)) reason = '报价方向、目标价或到期时刻不匹配';
  else if (kind === 'options' && !sameInstrument(q.symbol,key,direction,strike,expires)) reason = '没有同目标价、同到期时刻的期权合约';
  else if (kind === 'duals') {
    const product = q.product;
    const ok = key === 'binance' ? q.ordinary === true && product?.optionType === direction &&
      Number(product.strikePrice) === strike && q.productExpiry === expires && q.rateExpiry > now :
      q.venue === key && q.direction === direction && q.strike === strike && q.expires === expires && q.productId != null;
    if (!ok || q.coin !== (direction==='CALL'?'BTC':'USDT')) reason = '没有同方向、同目标价和同到期时刻的双币产品';
  }
  if (!reason && !fresh(q.quoteTime,now)) reason = '报价已过期';
  if (!reason && (!comparableCoins.has(q.coin) || !Number.isFinite(q.income))) reason = '尚无可核实的本期净收入';
  const valid = !reason;
  return {key,valid,reason,coin:q?.coin,income:valid ? q.income : null,quoteTime:q?.quoteTime,
    fxTime:q?.coin==='BTC'?fx.btcTime:q?.coin==='USDC'?fx.usdcTime:null,
    incomeUSDT:valid ? conversion(q,fx,now,'USDT') : null,
    incomeBTC:valid ? conversion(q,fx,now,'BTC') : null,
    estimated:Boolean(q?.estimateOnly || q?.termEstimated || q?.conditional),
    best:false,delta:null};
}

function summarize(quotes,kind,selection) {
  const rows = Object.fromEntries(Object.entries(quotes).map(([key,q])=>[key,makeRow(key,kind,q,selection)]));
  const all = Object.values(rows), available = all.filter(row=>row.valid);
  // A homogeneous group can rank native proceeds even if the USDT valuation is unavailable.
  const coin = available.length && available.every(r=>r.coin === available[0].coin) ? available[0].coin : 'USDT';
  const value = r => r.coin === coin ? r.income : r.incomeUSDT;
  const valued = available.filter(r=>Number.isFinite(value(r)));
  const times = r => r.coin === coin ? [r.quoteTime] : [r.quoteTime,r.fxTime];
  const latest = Math.max(...valued.flatMap(times));
  const inWindow = r => times(r).every(stamp=>synced(stamp,latest));
  const ranked = valued.filter(inWindow);
  const top = Math.max(...ranked.map(value));
  const best = [];
  for (const r of available) {
    if (!Number.isFinite(value(r))) r.reason = '缺少同步汇率，无法与其他平台比较';
    else if (!inWindow(r)) r.reason = '平台报价或折算汇率的时间相差达到 30 秒';
    else if (Math.abs(value(r)-top) <= 4 * Number.EPSILON * Math.max(Math.abs(value(r)),Math.abs(top))) {
      r.best = true;
      best.push(r.key);
    }
  }
  return {rows,best,coin,available:available.length,comparable:ranked.length,total:all.length};
}

function compareAgainst(group, other) {
  for (const row of Object.values(group.rows)) {
    if (!row.valid) continue;
    for (const key of other.best) {
      const ref = other.rows[key];
      if (!synced(row.quoteTime,ref.quoteTime)) continue;
      const fx = row.coin !== ref.coin;
      if (fx) {
        if (![row.incomeUSDT,ref.incomeUSDT].every(Number.isFinite)) continue;
        const times = [row.quoteTime,ref.quoteTime,row.fxTime,ref.fxTime].filter(Number.isFinite);
        if (!synced(Math.min(...times),Math.max(...times))) continue;
      }
      const amount = fx ? row.incomeUSDT-ref.incomeUSDT : row.income-ref.income;
      if (!Number.isFinite(amount)) continue;
      row.delta = {amount,coin:fx?'USDT':row.coin,against:other.best,fx,estimated:fx || row.estimated || ref.estimated};
      break;
    }
  }
}

// Monetary rankings use the same requested account size and the same untriggered settlement scenario.
// Callers pass only the venues selected for each group, including their explicit unavailable statuses.
export function summarizeAllVenues({options={},duals={},direction,strike,expires,fx={},now=Date.now()}) {
  const selection = {direction,strike,expires,fx:fx || {},now};
  const result = {options:summarize(options,'options',selection),duals:summarize(duals,'duals',selection)};
  compareAgainst(result.options,result.duals);
  compareAgainst(result.duals,result.options);
  return result;
}

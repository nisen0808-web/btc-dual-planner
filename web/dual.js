const ROOT = 'https://api.bybit.com/v5/earn/advance/';
const META_TTL = 30000;
let metadata = null;
let metadataRequest = null;
const number = v => v === '' || v == null ? NaN : Number(v);
const positive = v => Number.isFinite(v) && v > 0;
const unavailable = (reason, serverTime = 0, receivedAt = Date.now()) => ({ status:'unavailable',reason,serverTime,receivedAt });

/** Only the platform's exact 07:59:59.000 UTC boundary is canonicalized. */
export function normalizeSettlement(value) {
  const t = number(value);
  if (!positive(t) || !Number.isInteger(t)) return NaN;
  return t % 86400000 === 28799000 ? t + 1000 : t;
}

function decimalParts(value) {
  const s = String(value).trim();
  if (s.length > 120) return null;
  const m = /^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(s);
  if (!m) return null;
  const scale = (m[3] || '').length - Number(m[4] || 0);
  if (!Number.isInteger(scale) || Math.abs(scale) > 100) return null;
  return { digits:BigInt((m[1] === '-' ? '-' : '') + (m[2] + (m[3] || ''))),scale };
}
function sameDecimal(a,b) {
  const x=decimalParts(a),y=decimalParts(b);
  if (!x || !y) return false;
  const scale=Math.max(x.scale,y.scale);
  return x.digits*10n**BigInt(scale-x.scale) === y.digits*10n**BigInt(scale-y.scale);
}
function floorAmount(value,precision) {
  const p=decimalParts(value);
  if (!p || p.digits < 0n || !Number.isInteger(precision) || precision < 0 || precision > 18) return NaN;
  const shift=precision-p.scale;
  const digits=shift>=0?p.digits*10n**BigInt(shift):p.digits/10n**BigInt(-shift);
  return Number(digits)/10**precision;
}
function durationDays(value) {
  const m=/^(\d+(?:\.\d+)?)\s*(d|h)$/i.exec(String(value || '').trim());
  if (!m) return NaN;
  const days=Number(m[1])/(m[2].toLowerCase()==='h'?24:1);
  return positive(days)&&days<=3650?days:NaN;
}
function vip(value) { return value === true || value === 'true' || value === 1 || value === '1'; }
function currentServerTime(data,now=Date.now()) {
  const serverTime=number(data?.serverTime),receivedAt=number(data?.receivedAt),localNow=number(now);
  if (!positive(serverTime)||!positive(receivedAt)||!positive(localNow)) return NaN;
  return serverTime+Math.max(0,localNow-receivedAt);
}
function productProblem(product,currency,now) {
  if (!product || product.baseCoin !== 'BTC' || product.quoteCoin !== currency) return '双币产品的币种与当前期权不一致';
  if (product.status !== 'Available') return '该双币产品当前不可申购';
  if (vip(product.isVipProduct)) return '该双币报价属于 VIP 专属产品，未用于普通账户比较';
  const start=number(product.subscribeStartAt),end=number(product.subscribeEndAt);
  if (!positive(start)||!positive(end)) return '双币产品未返回完整申购窗口';
  if (now < start || now >= end) return '该双币产品不在有效申购窗口内';
  if (!positive(number(product.remainingAmountQuote))) return '该双币产品当前没有剩余申购额度';
  if (!positive(normalizeSettlement(product.settlementTime)) || normalizeSettlement(product.settlementTime)<=now) return '该双币产品已到期';
  if (!positive(durationDays(product.duration))) return '双币产品计息期限尚未确认，暂不计算收益差';
  return null;
}
async function getJSON(url) {
  const response=await fetch(url,{signal:AbortSignal.timeout(18000),credentials:'omit',cache:'no-store'});
  if (!response.ok) throw Error(`公开接口返回 ${response.status}`);
  const data=await response.json();
  if (Number(data.retCode)!==0) throw Error(data.retMsg || '双币公开接口返回错误');
  if (!Array.isArray(data.result?.list)||!positive(number(data.time))) throw Error('双币公开接口返回了无效数据');
  return { list:data.result.list,serverTime:number(data.time),receivedAt:Date.now() };
}
async function getMetadata() {
  if (metadata && Date.now()-metadata.receivedAt>=0 && Date.now()-metadata.receivedAt<META_TTL) return metadata;
  if (metadataRequest) return metadataRequest;
  metadataRequest=getJSON(ROOT+'product?category=DualAssets&coin=BTC').then(data=>(metadata=data));
  try { return await metadataRequest; } finally { metadataRequest=null; }
}

/** Public product metadata is briefly cached; every rate quote is fetched afresh. */
export async function loadDual(contract,currency) {
  const coin=String(currency || '').toUpperCase();
  if (!contract || !positive(number(contract.expires)) || !positive(number(contract.strike))) return unavailable('请先选择有效的期权合约');
  if (!['USDT','USDC'].includes(coin)) return unavailable('该结算币种暂无可核验的同条件双币产品');
  try {
    const meta=await getMetadata(),metaNow=currentServerTime(meta);
    const pairProducts=meta.list.filter(p=>p.baseCoin==='BTC'&&p.quoteCoin===coin);
    if (!pairProducts.length) return unavailable(`Bybit 当前未返回 BTC/${coin} 双币低买产品；不能用其他稳定币报价按 1:1 比较`,meta.serverTime,meta.receivedAt);
    const expiry=number(contract.expires);
    const matched=pairProducts.filter(p=>normalizeSettlement(p.settlementTime)===expiry);
    if (!matched.length) return unavailable('未找到执行同一到期时刻的双币产品，不用相邻期限替代',meta.serverTime,meta.receivedAt);
    const eligible=matched.filter(p=>!productProblem(p,coin,metaNow)).sort((a,b)=>number(a.minPurchaseQuoteAmount)-number(b.minPurchaseQuoteAmount));
    if (!eligible.length) return unavailable(productProblem(matched[0],coin,metaNow)||'没有可申购的同条件双币产品',meta.serverTime,meta.receivedAt);
    const attempts=await Promise.all(eligible.map(async product=>{
      try {
        const result=await getJSON(ROOT+'product-extra-info?category=DualAssets&productId='+encodeURIComponent(product.productId));
        const now=currentServerTime(result),problem=productProblem(product,coin,now);
        if (problem) return unavailable(problem,result.serverTime,result.receivedAt);
        const entry=result.list.find(x=>String(x.productId)===String(product.productId));
        const quotes=Array.isArray(entry?.buyLowPrice)?entry.buyLowPrice.filter(q=>sameDecimal(q.selectPrice,contract.strike)):[];
        if (!quotes.length) return unavailable('同一期限下没有相同接币价的双币低买报价，不用相邻价格替代',result.serverTime,result.receivedAt);
        const fresh=quotes.filter(q=>positive(number(q.expiredAt))&&number(q.expiredAt)>now).sort((a,b)=>number(b.expiredAt)-number(a.expiredAt));
        if (!fresh.length) return unavailable('同条件双币报价已失效，请刷新后重试',result.serverTime,result.receivedAt);
        const selected=fresh[0],aprE8=number(selected.apyE8);
        if (!Number.isFinite(aprE8)||aprE8<0) return unavailable('双币报价缺少有效年化收益率，暂不计算收益差',result.serverTime,result.receivedAt);
        return { status:'ready',product:{...product},quote:{...selected,productId:product.productId,source:'Bybit Dual Asset',apr:aprE8/1e8},serverTime:result.serverTime,receivedAt:result.receivedAt,currency:coin,contract:{symbol:contract.symbol,strike:contract.strike,expires:expiry} };
      } catch(error) {
        return {status:'error',reason:'读取 Bybit 双币报价失败：'+String(error?.message||'网络异常'),serverTime:meta.serverTime,receivedAt:meta.receivedAt};
      }
    }));
    const ready=attempts.find(x=>x.status==='ready');
    if (ready) return ready;
    return attempts.find(x=>x.status==='unavailable')||attempts[0]||unavailable('暂未读取到同条件双币报价',meta.serverTime,meta.receivedAt);
  } catch(error) {
    return { status:'error',reason:'读取 Bybit 双币产品失败：'+String(error?.message||'网络异常'),serverTime:0,receivedAt:Date.now() };
  }
}

/** Read each matching maturity once, then expand its exact Buy Low strikes. */
export async function loadBybitCatalogue(currency,contracts=[]) {
  const coin=String(currency || '').toUpperCase(),name='Bybit 双币';
  const result=(entries,status,reason,extra={})=>({entries,source:{platform:'bybit',name,status,reason,count:entries.length,...extra},receivedAt:Date.now()});
  if (!['USDT','USDC'].includes(coin)) return result([],'unavailable','该结算币种暂无可核验的同条件双币产品');
  const valid=(Array.isArray(contracts)?contracts:[]).filter(c=>c&&decimalParts(c.strike)&&positive(number(c.strike))&&positive(number(c.expires))&&Number.isInteger(number(c.expires)));
  if (!valid.length) return result([],'unavailable','没有有效的期权合约可匹配');
  try {
    const meta=await getMetadata(),metaNow=currentServerTime(meta),expiries=new Set(valid.map(c=>number(c.expires)));
    const pairProducts=meta.list.filter(p=>p&&p.baseCoin==='BTC'&&p.quoteCoin===coin);
    if (!pairProducts.length) return result([],'unavailable',`Bybit 当前未返回 BTC/${coin} 双币低买产品；不能用其他稳定币报价按 1:1 比较`,{productsRead:meta.list.length});
    const matched=pairProducts.filter(p=>expiries.has(normalizeSettlement(p.settlementTime)));
    const reasons=[],seenProducts=new Set(),eligible=[];
    for (const p of matched) {
      const issue=productProblem(p,coin,metaNow)||(p.productId==null||String(p.productId).trim()===''?'Bybit 双币缺少有效产品标识':null);
      if (issue) { reasons.push(issue);continue; }
      const id=String(p.productId);
      if (seenProducts.has(id)) continue;
      seenProducts.add(id);eligible.push(p);
    }
    let cursor=0;
    const batches=Array(eligible.length);
    async function consume() {
      for (;;) {
        const index=cursor++;
        if (index>=eligible.length) return;
        const product=eligible[index],entries=[];
        try {
          const read=await getJSON(ROOT+'product-extra-info?category=DualAssets&productId='+encodeURIComponent(product.productId));
          const time=currentServerTime(read),issue=productProblem(product,coin,time);
          if (issue) { batches[index]={entries,reasons:[issue]};continue; }
          const expiry=normalizeSettlement(product.settlementTime),source=read.list.find(p=>p&&String(p.productId)===String(product.productId));
          const quotes=Array.isArray(source?.buyLowPrice)?[...source.buyLowPrice].sort((a,b)=>number(b?.expiredAt)-number(a?.expiredAt)):[];
          const seenQuotes=new Set(),problems=[];
          for (const q of quotes) {
            if (!q||!decimalParts(q.selectPrice)||!positive(number(q.selectPrice))) continue;
            const contract=valid.find(c=>number(c.expires)===expiry&&sameDecimal(c.strike,q.selectPrice));
            if (!contract) continue;
            if (!positive(number(q.expiredAt))||!Number.isInteger(number(q.expiredAt))||number(q.expiredAt)<=time) { problems.push('同条件 Bybit 双币报价已失效，请刷新');continue; }
            const aprE8=number(q.apyE8);
            if (!decimalParts(q.apyE8)||!Number.isFinite(aprE8)||aprE8<0) { problems.push('Bybit 双币报价缺少有效年化收益率');continue; }
            const id='bybit:'+String(product.productId)+':'+String(expiry)+':'+String(number(q.selectPrice));
            if (seenQuotes.has(id)) continue;
            seenQuotes.add(id);
            const data={status:'ready',product:{...product},quote:{...q,productId:product.productId,source:'Bybit Dual Asset',apr:aprE8/1e8},serverTime:read.serverTime,receivedAt:read.receivedAt,currency:coin,contract:{symbol:contract.symbol,strike:contract.strike,expires:expiry}};
            entries.push({id,platform:'bybit',currency:coin,strike:number(q.selectPrice),expires:expiry,data});
          }
          batches[index]={entries,reasons:problems};
        } catch (error) { batches[index]={entries,reasons:['读取 Bybit 双币报价失败：'+String(error?.message||'网络异常')],failed:true}; }
      }
    }
    await Promise.all(Array.from({length:Math.min(4,eligible.length)},consume));
    const entries=batches.flatMap(b=>b.entries),failedProducts=batches.filter(b=>b.failed).length;
    reasons.push(...batches.flatMap(b=>b.reasons));
    const status=entries.length?'ready':failedProducts&&failedProducts===eligible.length?'error':'unavailable';
    return result(entries,status,entries.length?(failedProducts?'已读取部分同条件报价；部分产品读取失败':'已读取同条件双币公开报价'):reasons[0]||'Bybit 没有相同币种、接币价和到期时刻的有效低买报价',{productsRead:meta.list.length,matchedProducts:eligible.length,failedProducts,rejectedCount:reasons.length});
  } catch (error) { return result([],'error','读取 Bybit 双币产品失败：'+String(error?.message||'网络异常')); }
}

/** Compare the same complete funding amount; rates never stand in for missing quotes. */
export function compareDual(A,putModel,data,now=Date.now()) {
  const invalid=reason=>({valid:false,reason});
  const funds=number(A);
  if (!positive(funds)||funds>1e15) return invalid('请先填写有效的当次投入资金');
  if (!putModel?.valid || !Number.isFinite(number(putModel.netIncome))) return invalid('请先获得有效的 SELL PUT 净收益测算');
  if (data?.status!=='ready') return invalid(data?.reason||'暂未读取到同条件双币报价');
  const {product,quote}=data,serverNow=currentServerTime(data,now);
  if (!positive(serverNow)) return invalid('双币报价时间无效，请刷新');
  const currency=String(data.currency||product?.quoteCoin||'').toUpperCase();
  const problem=productProblem(product,currency,serverNow);
  if (problem) return invalid(problem);
  const rawExpiry=number(product.settlementTime),canonicalExpiry=normalizeSettlement(rawExpiry);
  const expectedExpiry=number(putModel.expires??putModel.expiryTimestamp??data.contract?.expires);
  if (!positive(expectedExpiry)||canonicalExpiry!==expectedExpiry) return invalid('双币与当前期权的到期时刻不完全相同');
  const expectedStrike=putModel.strike??data.contract?.strike;
  if (!sameDecimal(quote?.selectPrice,expectedStrike)) return invalid('双币与当前期权的接币价不完全相同');
  const putCurrency=putModel.currency??putModel.settleCoin;
  if (putCurrency && String(putCurrency).toUpperCase()!==currency) return invalid('双币与期权的结算币种不同，不能按 1:1 比较');
  const rateExpiry=number(quote?.expiredAt);
  if (!positive(rateExpiry)||rateExpiry<=serverNow) return invalid('双币报价已失效，请刷新后比较');
  const aprE8=number(quote?.apyE8),apr=aprE8/1e8,days=durationDays(product.duration);
  if (!Number.isFinite(aprE8)||aprE8<0||!positive(days)) return invalid('双币年化或计息期限无效，暂不计算收益差');
  const precision=number(product.orderPrecisionDigitalQuote),amount=floorAmount(funds,precision);
  if (!positive(amount)) return invalid('当次资金按双币申购精度取整后不足');
  const min=number(product.minPurchaseQuoteAmount),remaining=number(product.remainingAmountQuote),maximum=number(quote.maxInvestmentAmount);
  if (!Number.isFinite(min)||min<0||!positive(remaining)||!positive(maximum)) return invalid('双币申购额度信息不完整，暂不计算收益差');
  if (amount<min) return invalid('当次资金按精度取整后低于双币最低申购额');
  if (amount>remaining || amount>maximum) return invalid('当次资金超过同条件双币的剩余额度或单笔上限');
  const periodRate=apr*days/365,income=amount*periodRate,leftover=funds-amount,difference=number(putModel.netIncome)-income;
  const result={valid:true,income,periodRate,apr,days,amount,leftover,difference,term:income/funds,quotedApr:apr,source:quote.source||'Bybit Dual Asset',productId:product.productId,productExpiryRaw:rawExpiry,productExpiry:canonicalExpiry,originalExpiry:rawExpiry,canonicalExpiry,rateExpiry,settleCoin:currency,comparisonScope:'unconverted',product,quote,serverTime:serverNow,receivedAt:data.receivedAt};
  const actualDays=number(putModel.days);
  if (positive(actualDays)) {
    result.actualDays=actualDays;
    result.dualAnnual=income/funds*365/actualDays;
    result.yearDifference=difference/funds*365/actualDays;
  }
  const ST=number(putModel.expiryPrice),K=number(expectedStrike);
  if (Number.isFinite(ST)&&ST>=0&&positive(K)) {
    result.settledAsBTC=ST<=K;
    result.dualBtc=ST<=K?(amount+income)/K:0;
    result.dualCash=ST<=K?leftover:funds+income;
    result.dualAssets=result.dualCash+result.dualBtc*ST;
    if (Number.isFinite(number(putModel.assets))) result.scenarioDifference=number(putModel.assets)-result.dualAssets;
  }
  if (Object.values(result).some(v=>typeof v==='number'&&!Number.isFinite(v))) return invalid('双币报价超出可计算范围');
  return result;
}

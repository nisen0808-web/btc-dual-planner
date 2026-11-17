// Anonymous website quotes, not the authenticated OKX Open API.
// Source: /cdn/assets/okfe/earn/2137/index.a92e58d5.js and
// /cdn/assets/okfe/earn/8652/index.746fddba.js, observed 2026-10-22.
const TTL=30000;
const n=v=>v===''||v==null?NaN:Number(v);
const positive=v=>Number.isFinite(v)&&v>0;
const invalid=reason=>({valid:false,reason});
const unavailable=reason=>({status:'unavailable',reason,serverTime:0,receivedAt:Date.now()});
function decimal(v){
  const text=String(v).trim();
  if(text.length>120)return null;
  const m=/^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(text);
  if(!m)return null;
  const scale=(m[3]||'').length-Number(m[4]||0);
  return Number.isInteger(scale)&&Math.abs(scale)<=100?{d:BigInt((m[1]==='-'?'-':'')+m[2]+(m[3]||'')),s:scale}:null;
}
function same(a,b){const x=decimal(a),y=decimal(b);if(!x||!y)return false;const s=Math.max(x.s,y.s);return x.d*10n**BigInt(s-x.s)===y.d*10n**BigInt(s-y.s);}
function floorStep(value,step){
  const x=decimal(value),y=decimal(step);if(!x||!y||x.d<0n||y.d<=0n)return NaN;
  const s=Math.max(x.s,y.s),a=x.d*10n**BigInt(s-x.s),b=y.d*10n**BigInt(s-y.s);
  return Number(a/b*b)/10**s;
}
function currentTime(data,now){
  return positive(n(data?.serverTime))&&positive(n(data?.receivedAt))&&positive(n(now))?
    n(data.serverTime)+Math.max(0,n(now)-n(data.receivedAt)):NaN;
}
function daysFor(product){
  // dcdTerm is hours: this must agree with the explicitly returned accrual interval.
  const hours=n(product?.dcdTerm),start=n(product?.interestAccrualTime),end=n(product?.expiryTime);
  if(!positive(hours)||!positive(start)||!positive(end)||end<=start||Math.abs(hours-(end-start)/3600000)>1/3600000)return NaN;
  return hours/24;
}
function problem(p,currency,time){
  if(!p||p.currency!=='BTC'||p.alternativeCurrency!==currency||p.type!=='PUT')return 'OKX 双币与当前期权的币种或方向不一致';
  if(p.productType!=='DualCurrencyDeposit'||p.dcdType!=='Standard')return '暂不比较非标准 OKX 双币产品';
  if(n(p.status)!==1)return 'OKX 双币产品当前不可申购';
  const start=n(p.launchTime),end=n(p.stopTradingTime),expiry=n(p.expiryTime),stamp=n(p.quoteResponseTime);
  if(!positive(start)||!positive(end)||time<start||time>=end)return 'OKX 双币产品不在有效申购窗口内';
  if(!positive(expiry)||expiry<=time||n(p.settlementTime)!==expiry)return 'OKX 双币到期时间无效或结算时刻不一致';
  // HTTP Date is second precision, so a quote can be up to 999 ms ahead of it.
  if(!positive(stamp)||time-stamp>=TTL||stamp-time>1000)return 'OKX 双币报价已超过 30 秒或时间异常，请刷新';
  if(!positive(daysFor(p)))return 'OKX 双币计息期限尚未确认，暂不计算收益差';
  if(!Number.isFinite(n(p.absYield))||n(p.absYield)<0||!Number.isFinite(n(p.annualYield))||n(p.annualYield)<0)return 'OKX 双币收益字段无效';
  return null;
}

async function readProducts(coin){
  try{
    const response=await fetch('/api/okx-dual',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(18000)});
    if(!response.ok)throw Error('公开行情代理返回 '+response.status);
    const payload=await response.json(),body=payload?.data;
    if(Number(payload?.code)!==0||!Array.isArray(body?.products))throw Error(payload?.msg||'OKX 产品数据格式无效');
    const receivedAt=Date.now(),headerTime=Date.parse(response.headers?.get?.('date')||'');
    // responseTime in the observed upstream payload is 0, so it is not a clock.
    const serverTime=positive(n(payload.serverTime))?n(payload.serverTime):positive(headerTime)?headerTime:receivedAt;
    return {status:'ready',products:body.products,currency:coin,serverTime,receivedAt,clockSource:positive(n(payload.serverTime))?'proxy':positive(headerTime)?'http-date':'local',amountRules:payload.amountRules||null};
  }catch(error){return {status:'error',reason:'读取 OKX 双币公开报价失败：'+String(error?.message||'网络异常'),serverTime:0,receivedAt:Date.now()};}
}

function snapshot(base,product,contract){
  const {products,...clock}=base;
  return {...clock,status:'ready',product:{...product},quote:{selectPrice:product.strike,apr:n(product.annualYield),periodRate:n(product.absYield),expiredAt:n(product.quoteResponseTime)+TTL,source:'OKX Dual Investment'},contract:{symbol:contract.symbol,strike:contract.strike,expires:n(contract.expires)}};
}

export async function loadOKXDual(contract,currency){
  const coin=String(currency||'').toUpperCase();
  if(!contract||!positive(n(contract.expires))||!positive(n(contract.strike)))return unavailable('请先选择有效期权合约');
  if(coin!=='USDT')return unavailable('当前 OKX 匿名报价源仅核验了 BTC/USDT，不替换结算币种');
  const read=await readProducts(coin);
  if(read.status!=='ready')return read;
  const candidates=read.products.filter(p=>p&&p.currency==='BTC'&&p.alternativeCurrency===coin&&p.type==='PUT'&&same(p.strike,contract.strike)&&n(p.expiryTime)===n(contract.expires));
  if(!candidates.length)return {status:'unavailable',reason:'OKX 没有相同接币价、到期时刻及结算币种的双币报价',serverTime:read.serverTime,receivedAt:read.receivedAt};
  const time=currentTime(read,Date.now()),product=candidates.filter(p=>!problem(p,coin,time)).sort((a,b)=>n(b.quoteResponseTime)-n(a.quoteResponseTime))[0];
  if(!product)return {status:'unavailable',reason:problem(candidates[0],coin,time),serverTime:read.serverTime,receivedAt:read.receivedAt};
  return snapshot(read,product,contract);
}

/** The anonymous product-list request is shared across every exact combination. */
export async function loadOKXCatalogue(currency,contracts=[]){
  const coin=String(currency||'').toUpperCase(),name='OKX 双币';
  const result=(entries,status,reason,extra={})=>({entries,source:{platform:'okx',name,status,reason,count:entries.length,...extra},receivedAt:Date.now()});
  if(coin!=='USDT')return result([],'unavailable','当前 OKX 匿名报价源仅核验了 BTC/USDT，不替换结算币种');
  const valid=(Array.isArray(contracts)?contracts:[]).filter(c=>c&&decimal(c.strike)&&positive(n(c.strike))&&positive(n(c.expires))&&Number.isInteger(n(c.expires)));
  if(!valid.length)return result([],'unavailable','没有有效的期权合约可匹配');
  const read=await readProducts(coin);
  if(read.status!=='ready')return result([],read.status,read.reason);
  const time=currentTime(read,Date.now()),entries=[],seen=new Set(),reasons=[];
  // Prefer the newest quote when a product appears more than once.
  for(const p of [...read.products].sort((a,b)=>n(b?.quoteResponseTime)-n(a?.quoteResponseTime))){
    if(!p||p.currency!=='BTC'||p.alternativeCurrency!==coin||p.type!=='PUT')continue;
    const contract=valid.find(c=>n(c.expires)===n(p.expiryTime)&&same(c.strike,p.strike));
    if(!contract)continue;
    const issue=problem(p,coin,time)||(!decimal(p.strike)||!positive(n(p.strike))||!Number.isInteger(n(p.expiryTime))||p.ndBrokerProductId==null||String(p.ndBrokerProductId).trim()===''?'OKX 双币产品标识、接币价或到期时间无效':null)||(!decimal(p.annualYield)||!decimal(p.absYield)?'OKX 双币收益字段无效':null);
    if(issue){reasons.push(issue);continue;}
    const id='okx:'+String(p.ndBrokerProductId)+':'+String(p.expiryTime)+':'+String(n(p.strike));
    if(seen.has(id))continue;seen.add(id);
    entries.push({id,platform:'okx',currency:coin,strike:n(p.strike),expires:n(p.expiryTime),data:snapshot(read,p,contract)});
  }
  return result(entries,entries.length?'ready':'unavailable',entries.length?'已读取同条件公开报价，申购资格以平台确认为准':reasons[0]||'OKX 没有相同币种、接币价和到期时刻的有效双币报价',{productsRead:read.products.length,rejectedCount:reasons.length,clockSource:read.clockSource});
}

export function compareOKXDual(A,putModel,data,now=Date.now()){
  const funds=n(A);
  if(!positive(funds)||funds>1e15)return invalid('请先填写有效的当次投入资金');
  if(!putModel?.valid||!Number.isFinite(n(putModel.netIncome)))return invalid('请先获得有效的 SELL PUT 净收益测算');
  if(data?.status!=='ready')return invalid(data?.reason||'暂未读取到 OKX 同条件双币报价');
  const p=data.product,time=currentTime(data,now),currency=String(data.currency||'').toUpperCase();
  if(!positive(time))return invalid('OKX 报价时间无效，请刷新');
  const issue=problem(p,currency,time);if(issue)return invalid(issue);
  const expiry=n(putModel.expires??putModel.expiryTimestamp??data.contract?.expires),strike=putModel.strike??data.contract?.strike;
  if(n(p.expiryTime)!==expiry)return invalid('OKX 双币与期权的到期时刻不完全相同');
  if(!same(p.strike,strike))return invalid('OKX 双币与期权的接币价不完全相同');
  const putCurrency=putModel.currency??putModel.settleCoin;
  if(!putCurrency||String(putCurrency).toUpperCase()!==currency)return invalid('OKX 双币与期权结算币种不同或未确认');
  const quoted=reason=>({...invalid(reason),quoteApr:n(p.annualYield),quotePeriodRate:n(p.absYield),quoteDays:daysFor(p),quotedApr:n(p.annualYield),source:'OKX Dual Investment',productId:p.ndBrokerProductId,product:p,quote:data.quote,settleCoin:currency,serverTime:time,receivedAt:data.receivedAt});
  // An amount-times-rate estimate is useful without claiming this amount can
  // actually be subscribed. Never invent limits or round by an unknown step.
  const rules=data.amountRules;
  const minimum=n(rules?.min),maximum=n(rules?.max),step=n(rules?.step);
  const eligibilityVerified=!!(rules&&rules.verified===true&&rules.source&&String(rules.currency).toUpperCase()===currency&&String(rules.productId)===String(p.ndBrokerProductId)&&Number.isFinite(minimum)&&minimum>=0&&positive(maximum)&&maximum>=minimum&&positive(step));
  const amount=eligibilityVerified?floorStep(funds,rules.step):funds;
  if(eligibilityVerified&&(!positive(amount)||amount<minimum))return quoted('当次资金按申购步长取整后低于 OKX 最低申购额');
  if(eligibilityVerified&&amount>maximum)return quoted('当次资金超过 OKX 双币当前可申购上限');
  const periodRate=n(p.absYield),apr=n(p.annualYield),days=daysFor(p),income=amount*periodRate,leftover=funds-amount,difference=n(putModel.netIncome)-income;
  const result={valid:true,income,periodRate,apr,days,amount,leftover,difference,term:income/funds,quotedApr:apr,quoteApr:apr,quotePeriodRate:periodRate,quoteDays:days,source:'OKX Dual Investment',productId:p.ndBrokerProductId,productExpiryRaw:n(p.expiryTime),productExpiry:expiry,originalExpiry:n(p.expiryTime),canonicalExpiry:expiry,rateExpiry:n(p.quoteResponseTime)+TTL,settleCoin:currency,comparisonScope:'unconverted',product:p,quote:data.quote,serverTime:time,receivedAt:data.receivedAt,amountRules:eligibilityVerified?rules:null,eligibilityVerified,estimateOnly:!eligibilityVerified};
  if(!eligibilityVerified){result.label='报价估算 · 申购额度未核验';result.note='按本次金额×官方本期率估算；在该金额可实际申购的条件下成立，未校验个人资格和额度。';}
  const actualDays=n(putModel.days);
  if(positive(actualDays)){result.actualDays=actualDays;result.dualAnnual=income/funds*365/actualDays;result.yearDifference=difference/funds*365/actualDays;}
  const ST=n(putModel.expiryPrice),K=n(strike);
  if(Number.isFinite(ST)&&ST>=0&&positive(K)){
    result.settledAsBTC=ST<=K;result.dualBtc=ST<=K?(amount+income)/K:0;
    result.dualCash=ST<=K?leftover:funds+income;result.dualAssets=result.dualCash+result.dualBtc*ST;
    if(Number.isFinite(n(putModel.assets)))result.scenarioDifference=n(putModel.assets)-result.dualAssets;
  }
  if(Object.values(result).some(v=>typeof v==='number'&&!Number.isFinite(v)))return invalid('OKX 双币收益超出可计算范围');
  return result;
}

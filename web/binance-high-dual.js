// Binance sell-high only: income and principal in BTC. No fixed USDT conversion.
// Ordinary Dual Investment only. This endpoint is NOT Dual Investment RFQ.
// The same-origin reader normalizes the anonymous website product list and,
// if configured, the read-only SAPI fallback. No keys enter this client.
const TTL=30000;
const num=v=>v===''||v==null?NaN:Number(v);
const positive=v=>Number.isFinite(v)&&v>0;
const invalid=reason=>({valid:false,reason});
const coverageWarning='Binance 产品列表读取期间有变动，仅显示本次已核实的真实报价；未覆盖完整列表，未读到不代表平台没有该产品。';
function decimal(value){
  const s=String(value).trim();if(s.length>120)return null;
  const m=/^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(s);if(!m)return null;
  const scale=(m[3]||'').length-Number(m[4]||0);
  if(!Number.isInteger(scale)||Math.abs(scale)>100)return null;
  return {digits:BigInt((m[1]==='-'?'-':'')+m[2]+(m[3]||'')),scale};
}
function compareDecimal(a,b){
  const x=decimal(a),y=decimal(b);if(!x||!y)return NaN;
  const s=Math.max(x.scale,y.scale),left=x.digits*10n**BigInt(s-x.scale),right=y.digits*10n**BigInt(s-y.scale);
  return left===right?0:left<right?-1:1;
}
function principal(value,precision){
  const d=decimal(value);if(!d||d.digits<0n||!Number.isInteger(precision)||precision<0||precision>18)return null;
  const shift=precision-d.scale,digits=shift>=0?d.digits*10n**BigInt(shift):d.digits/10n**BigInt(-shift);
  return {digits,precision,value:Number(digits)/10**precision};
}
function periodUnits(apr,duration){
  const a=decimal(apr),d=decimal(duration);if(!a||!d||a.digits<0n||d.digits<=0n)return null;
  let numerator=a.digits*d.digits,denominator=365n;
  const shift=4-a.scale-d.scale;
  if(shift>=0)numerator*=10n**BigInt(shift);else denominator*=10n**BigInt(-shift);
  return numerator/denominator;
}
function readerClock(data,now){
  const server=num(data?.serverTime),received=num(data?.receivedAt),fetched=num(data?.fetchedAt),local=num(now);
  if(!positive(server)||!positive(received)||!positive(fetched)||!positive(local))return null;
  const initial=data?.snapshotAgeAtReceive==null?Math.max(0,received-fetched):num(data.snapshotAgeAtReceive);
  if(!Number.isFinite(initial)||initial<0)return null;
  const monotonic=performance.now(),receivedMonotonic=data?.receivedMonotonic;
  const elapsed=Math.max(0,local-received,typeof receivedMonotonic==='number'&&Number.isFinite(receivedMonotonic)?monotonic-receivedMonotonic:0);
  return {time:server+initial+elapsed,age:initial+elapsed};
}
function productProblem(p,currency,time,publicWeb=false){
  if(currency!=='BTC'||!p||p.optionType!=='CALL'||p.investCoin!=='BTC'||p.exercisedCoin!=='USDT')return 'Binance 普通双币高卖与当前期权币种或高卖方向不一致';
  if(p.canPurchase!==true)return 'Binance 普通双币高卖当前不可申购，或未返回明确可申购状态';
  if(!publicWeb&&(!positive(num(p.purchaseEndTime))||!Number.isInteger(num(p.purchaseEndTime))||num(p.purchaseEndTime)<=time))return 'Binance 普通双币高卖申购窗口已关闭或截止时间未确认';
  if(publicWeb&&(p.purchaseEndTime!==null||p.purchaseDecimal!==null))return 'Binance 公开产品的申购规则标识异常，请刷新';
  if(!positive(num(p.settleDate))||!Number.isInteger(num(p.settleDate))||num(p.settleDate)<=time)return 'Binance 普通双币高卖到期时间无效或已到期';
  if(!decimal(p.strikePrice)||!positive(num(p.strikePrice))||!decimal(p.duration)||!positive(num(p.duration))||!Number.isInteger(num(p.duration)))return 'Binance 普通双币高卖目标价或计息天数无效';
  const apr=decimal(p.apr);
  if(!apr||apr.digits<0n||!Number.isFinite(num(p.apr)))return 'Binance 普通双币高卖缺少有效年化 APR';
  const precision=num(p.purchaseDecimal),minimum=num(p.minAmount),maximum=num(p.maxAmount);
  if((!publicWeb&&(!decimal(p.purchaseDecimal)||!Number.isInteger(precision)||precision<0||precision>18))||!decimal(p.minAmount)||!decimal(p.maxAmount)||!Number.isFinite(minimum)||minimum<0||!positive(maximum)||compareDecimal(p.minAmount,p.maxAmount)>0)return 'Binance 普通双币高卖申购精度或金额限制不完整';
  if(p.id==null||String(p.id).trim()==='')return 'Binance 普通双币高卖缺少产品标识';
  return null;
}
function readerFailure(payload,status){
  const reason=typeof payload?.reason==='string'?payload.reason:typeof payload?.message==='string'?payload.message:typeof payload?.msg==='string'?payload.msg:'Binance 普通双币高卖报价读取失败';
  const supplied=payload?.status;
  const state=['authorization_required','unavailable','error'].includes(supplied)?supplied:status===401||status===403?'authorization_required':'error';
  return {status:state,reason,serverTime:0,fetchedAt:0,receivedAt:Date.now(),ordinary:true};
}

async function readProducts(coin){
  try{
    const requestStartedAt=Date.now(),requestStartedMonotonic=performance.now();
    const response=await fetch('/api/binance-dual-high',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(18000)});
    let payload;try{payload=await response.json();}catch{return readerFailure(null,response.status);}
    if(!response.ok||!Array.isArray(payload?.items))return readerFailure(payload,response.status);
    const receivedAt=Date.now(),receivedMonotonic=performance.now(),serverTime=num(payload.serverTime),fetchedAt=num(payload.fetchedAt),headerTime=Date.parse(response.headers?.get?.('date')||'');
    if(!positive(serverTime)||!positive(fetchedAt))return {status:'unavailable',reason:'Binance 报价缺少可验证的读取时间，请刷新',ordinary:true};
    const collectorPush=payload.deliveryType==='collector_push',cloudPull=payload.deliveryType==='cloud_pull';
    let snapshotAgeAtReceive;
    if(collectorPush||cloudPull){
      // The receiver has checked source and producer clocks. Add the whole
      // browser request duration conservatively, avoiding cross-device clock subtraction.
      const checkedAge=payload.snapshotAgeAtRead;
      if(typeof checkedAge!=='number'||!Number.isFinite(checkedAge)||checkedAge<0)return {status:'unavailable',reason:'Binance 同步报价缺少有效时效校验，请刷新',ordinary:true};
      snapshotAgeAtReceive=checkedAge+Math.max(0,receivedAt-requestStartedAt,receivedMonotonic-requestStartedMonotonic);
    }else{
      const reference=positive(headerTime)?headerTime:receivedAt;
      if(fetchedAt-reference>1000)return {status:'unavailable',reason:'Binance 报价读取时间异常，请刷新',ordinary:true};
      snapshotAgeAtReceive=Math.max(0,reference-fetchedAt);
    }
    const publicWeb=payload.sourceType==='public_web';
    if(publicWeb&&(payload.eligibility?.precisionKnown!==false||payload.eligibility?.purchaseWindowKnown!==false))return {status:'unavailable',reason:'Binance 公开报价缺少申购规则说明，请刷新',ordinary:true};
    if(payload.catalogueComplete===false&&(!publicWeb||!cloudPull||payload.coverageReason!=='changing_catalogue'||!Number.isSafeInteger(payload.pageCount)||payload.pageCount<1||payload.pageCount>20||!Array.isArray(payload.reportedTotals)||payload.reportedTotals.length!==payload.pageCount||!payload.reportedTotals.every(n=>Number.isSafeInteger(n)&&n>=0&&n<=2000)||payload.total!==payload.items.length||payload.total<1||payload.total>payload.pageCount*100||!Number.isSafeInteger(payload.rejectedConflictCount)||payload.rejectedConflictCount<0||payload.rejectedConflictCount>2000))return {status:'unavailable',reason:'Binance 产品覆盖范围无法核验，请刷新',ordinary:true};
    const base={serverTime,fetchedAt,receivedAt,receivedMonotonic,snapshotAgeAtReceive,currency:coin,ordinary:true,catalogueComplete:payload.catalogueComplete!==false,coverageNote:payload.catalogueComplete===false?coverageWarning:'',sourceType:payload.sourceType||'sapi',eligibility:payload.eligibility||null,deliveryType:cloudPull?'cloud_pull':collectorPush?'collector_push':'direct',transport:cloudPull&&payload.transport==='netlify_public_feed'?'netlify_public_feed':null,collectorLastSeen:positive(num(payload.collectorLastSeen))?num(payload.collectorLastSeen):null};
    const clock=readerClock(base,receivedAt);
    if(!clock||clock.age>=TTL)return {...base,status:'unavailable',reason:'Binance 产品报价快照已超过 30 秒，请刷新'};
    return {...base,status:'ready',items:payload.items};
  }catch(error){return {status:'error',reason:'读取 Binance 普通双币高卖失败：'+String(error?.message||'网络异常'),serverTime:0,fetchedAt:0,receivedAt:Date.now(),ordinary:true};}
}

function snapshot(base,product,contract){
  const {items,...clock}=base,units=periodUnits(product.apr,product.duration);
  return {...clock,status:'ready',contract:{symbol:contract.symbol,strike:contract.strike,expires:num(contract.expires)},product:{...product},quote:{source:'Binance 普通双币高卖',selectPrice:product.strikePrice,apr:num(product.apr),periodRate:Number(units)/10000,expiredAt:base.serverTime+TTL},source:'Binance 普通双币高卖'};
}

export async function loadBinanceHighDual(contract,currency){
  const coin=String(currency||'').toUpperCase();
  if(!contract||!positive(num(contract.strike))||!positive(num(contract.expires)))return {status:'unavailable',reason:'请先选择有效期权合约',ordinary:true};
  if(coin!=='BTC')return {status:'unavailable',reason:'当前 Binance 读取通道仅接入 BTC/USDT 普通双币高卖，不替换结算币种',ordinary:true};
  const read=await readProducts(coin);
  if(read.status!=='ready')return read;
  const {items,...base}=read,withContract={...base,contract:{symbol:contract.symbol,strike:contract.strike,expires:num(contract.expires)}},clock=readerClock(base,Date.now());
  if(!clock||clock.age>=TTL)return {...withContract,status:'unavailable',reason:'Binance 产品报价快照已超过 30 秒，请刷新'};
  const matches=items.filter(p=>p&&p.optionType==='CALL'&&p.investCoin==='BTC'&&p.exercisedCoin==='USDT'&&compareDecimal(p.strikePrice,contract.strike)===0&&num(p.settleDate)===num(contract.expires));
  if(!matches.length)return {...withContract,status:'unavailable',reason:read.catalogueComplete===false?coverageWarning:'Binance 普通双币高卖没有相同币种、目标卖价和到期时刻的报价；不能当作大额 RFQ 报价'};
  const publicWeb=read.sourceType==='public_web',product=matches.find(p=>!productProblem(p,coin,clock.time,publicWeb));
  if(!product)return {...withContract,status:'unavailable',reason:productProblem(matches[0],coin,clock.time,publicWeb)};
  return snapshot(base,product,contract);
}

/** One ordinary-product snapshot supplies the complete exact-match catalogue. */
export async function loadBinanceHighCatalogue(currency='BTC',contracts=[],{independent=true}={}){
  const coin=String(currency||'').toUpperCase(),name='Binance 普通双币高卖';
  const result=(entries,status,reason,extra={})=>({entries,source:{platform:'binance',name,status,reason,count:entries.length,...extra},receivedAt:Date.now()});
  if(coin!=='BTC')return result([],'unavailable','当前 Binance 读取通道仅接入 BTC/USDT 普通双币高卖，不替换结算币种');
  const valid=(Array.isArray(contracts)?contracts:[]).filter(c=>c&&decimal(c.strike)&&positive(num(c.strike))&&positive(num(c.expires))&&Number.isInteger(num(c.expires)));
  if(!independent&&!valid.length)return result([],'unavailable','没有有效的期权合约可匹配');
  const read=await readProducts(coin);
  if(read.status!=='ready')return result([],read.status,read.reason);
  const clock=readerClock(read,Date.now()),entries=[],seen=new Set(),reasons=[];
  if(!clock||clock.age>=TTL)return result([],'unavailable','Binance 产品报价快照已超过 30 秒，请刷新');
  for(const p of read.items){
    if(!p||p.optionType!=='CALL'||p.investCoin!==coin||p.exercisedCoin!=='USDT')continue;
    const contract=independent?{strike:num(p.strikePrice),expires:num(p.settleDate)}:valid.find(c=>num(c.expires)===num(p.settleDate)&&compareDecimal(c.strike,p.strikePrice)===0);
    if(!contract)continue;
    const issue=productProblem(p,coin,clock.time,read.sourceType==='public_web');
    if(issue){reasons.push(issue);continue;}
    const id='binance:'+String(p.id)+':'+String(p.settleDate)+':'+String(num(p.strikePrice));
    if(seen.has(id))continue;seen.add(id);
    entries.push({id,platform:'binance',currency:coin,strike:num(p.strikePrice),expires:num(p.settleDate),data:snapshot(read,p,contract)});
  }
  return result(entries,entries.length?'ready':'unavailable',read.catalogueComplete===false?coverageWarning:entries.length?(independent?'已独立读取普通双币高卖真实产品':'已读取普通双币高卖同条件公开报价'):reasons[0]||'Binance 普通双币高卖没有相同币种、目标卖价和到期时刻的有效报价',{productsRead:read.items.length,rejectedCount:reasons.length,catalogueComplete:read.catalogueComplete,coverageNote:read.coverageNote,sourceType:read.sourceType,deliveryType:read.deliveryType,fetchedAt:read.fetchedAt});
}

/** Product income is independent of any option quote; no synthetic PUT is required. */
export function deriveBinanceHighDualIncome(A,selection,data,now=Date.now()){
  const funds=num(A);
  if(!positive(funds)||funds>1e15)return invalid('请先填写有效的当次投入资金');
  if(data?.status!=='ready')return {...invalid(data?.reason||'暂未接通 Binance 普通双币高卖真实报价'),...(data?.status==='authorization_required'?{status:'authorization_required'}:{})};
  const clock=readerClock(data,now),p=data.product,currency=String(data.currency||'').toUpperCase();
  if(!clock||clock.age>=TTL)return invalid('Binance 产品报价快照已超过 30 秒或读取时间无效，请刷新');
  const publicWeb=data.sourceType==='public_web';
  if(publicWeb&&(data.eligibility?.precisionKnown!==false||data.eligibility?.purchaseWindowKnown!==false))return invalid('Binance 公开报价缺少申购规则说明，请刷新');
  const issue=productProblem(p,currency,clock.time,publicWeb);if(issue)return invalid(issue);
  const expiry=num(selection?.expires??selection?.expiryTimestamp??data.contract?.expires),strike=selection?.strike??data.contract?.strike;
  if(num(p.settleDate)!==expiry)return invalid('Binance 普通双币高卖与期权到期时刻不完全相同');
  if(compareDecimal(p.strikePrice,strike)!==0)return invalid('Binance 普通双币高卖与期权目标卖价不完全相同');
  const putCurrency=String(selection?.investCoin??selection?.currency??selection?.settleCoin??'').toUpperCase();
  if(putCurrency!==currency)return invalid('Binance 普通双币高卖投资币种须为 BTC；期权权利金另以 USDT 计价');
  const rawAmount=decimal(A);
  const amountData=publicWeb&&rawAmount?{digits:rawAmount.digits,precision:rawAmount.scale,value:funds}:principal(A,num(p.purchaseDecimal));
  if(!amountData||!positive(amountData.value))return invalid('当次资金按 Binance 申购精度取整后不足');
  // Compare scaled decimal integers, not binary numbers at limit boundaries.
  const amountText=publicWeb?'':amountData.digits.toString().padStart(amountData.precision+1,'0');
  const exactAmount=publicWeb?A:amountData.precision?amountText.slice(0,-amountData.precision)+'.'+amountText.slice(-amountData.precision):amountText;
  if(compareDecimal(exactAmount,p.minAmount)<0)return invalid(publicWeb?'当次资金低于 Binance 公开最低申购额':'当次资金按精度取整后低于 Binance 最低申购额');
  if(compareDecimal(exactAmount,p.maxAmount)>0)return invalid('当次资金超过 Binance 当前双币申购上限');
  const units=periodUnits(p.apr,p.duration),periodRate=Number(units)/10000;
  const income=Number(amountData.digits*units)/10**(amountData.precision+4),amount=amountData.value,leftover=funds-amount,apr=num(p.apr),days=num(p.duration);
  const result={valid:true,income,incomeBTC:income,periodRate,term:income/funds,apr,quotedApr:apr,days,amount,leftover,source:'Binance 普通双币高卖',sourceType:data.sourceType||'sapi',ordinary:true,productId:String(p.id),product:p,quote:data.quote,productExpiryRaw:num(p.settleDate),productExpiry:expiry,originalExpiry:num(p.settleDate),canonicalExpiry:expiry,rateExpiry:data.serverTime+TTL,settleCoin:currency,serverTime:clock.time,fetchedAt:data.fetchedAt,receivedAt:data.receivedAt,limitsVerified:!publicWeb,publicLimitsVerified:true,eligibilityVerified:false,estimateOnly:publicWeb,note:publicWeb?'官网普通双币高卖实时年化，已核对公开最低和最高金额。本期率向下截四位，收入按当次完整金额估算；申购精度、截止时间和个人资格以平台确认为准。':'普通双币高卖报价；本期率按官方规则向下截断四位。已校验产品金额限制，个人资格以平台确认为准。'};
  if(publicWeb)result.label='官网真实年化 · 金额收益估算';
  if(data.deliveryType==='collector_push'){
    const stamp=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Singapore',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(data.fetchedAt));
    result.label='本机采集同步 · 金额收益估算';
    result.deliveryType='collector_push';
    result.note='Binance 官网真实年化 · 报价更新 '+stamp+' SGT。'+result.note+' 报价超过 30 秒停止比较。';
  }
  if(data.deliveryType==='cloud_pull'){
    result.deliveryType='cloud_pull';result.transport=data.transport;
    result.label='Netlify云端实时读取 · 金额收益估算';
    result.note='Netlify云端实时读取。'+result.note+' 报价超过 30 秒停止展示。';
  }
  if(data.catalogueComplete===false){result.catalogueComplete=false;result.note=coverageWarning+' '+result.note;}
  if(Object.values(result).some(v=>typeof v==='number'&&!Number.isFinite(v)))return invalid('Binance 双币收益超出可计算范围');
  return result;
}


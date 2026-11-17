import {loadBinanceMarket,loadBinanceBook} from './binance-market.js';
import {calculatePutQuote,calculatePutAskLimitQuote} from './put-quote.js';
import {loadBinanceCatalogue,compareBinanceDual,deriveBinanceDualIncome} from './binance-dual.js';
const TTL=30000,DAY=86400000;
const finite=n=>typeof n==='number'&&Number.isFinite(n);
export const money=(n,d=2)=>n===null||n===undefined||typeof n==='boolean'||typeof n==='string'&&n.trim()===''?'—':finite(Number(n))?Number(n).toLocaleString('zh-CN',{maximumFractionDigits:d}):'—';
export const percent=n=>finite(n)?money(n*100,2)+'%':'—';
export const expiryLabel=t=>finite(t)&&t>0?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Singapore',year:'numeric',month:'long',day:'numeric',weekday:'short',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(t)):'—';
export const timestamp=t=>finite(t)&&t>0?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Singapore',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(t))+' SGT':'—';
export function timeLeft(expiry,now=Date.now()){const s=Math.max(0,Math.floor((expiry-now)/1000));if(!s)return '已到期';return(Math.floor(s/86400)?Math.floor(s/86400)+'天 ':'')+Math.floor(s%86400/3600)+'小时 '+Math.floor(s%3600/60)+'分钟';}
function sourceNow(m,now){return m?.time+Math.max(0,m?.receivedAt-m?.time,finite(m?.sourceAgeAtReceive)?m.sourceAgeAtReceive:0)+Math.max(0,now-m?.receivedAt);}
function marketFresh(m,now){return finite(m?.time)&&finite(m?.receivedAt)&&m.time>0&&m.time<=now+2000&&m.receivedAt<=now&&now-m.receivedAt<TTL&&sourceNow(m,now)-m.time<TTL;}
/** Display only the actual selected contract returned by the current market. */
export function binanceSelectedContractSymbol(data,now=Date.now()){
 const c=data?.row?.contract,m=data?.market;
 if(!marketFresh(m,now)||!c||!finite(c.strike)||!finite(c.expires)||c.strike!==Number(data.targetPrice)||c.expires!==Number(data.selectedExpiry)||c.expires<=sourceNow(m,now)||c.settleCoin!=='USDT'||c.active===false||c.is_active===false||typeof c.symbol!=='string'||!/^BTC-\d{6}-(?:[1-9]\d{0,8})(?:\.\d{1,4})?-P$/.test(c.symbol))return null;
 return c.symbol;
}
export function binanceRowFresh(row,now=Date.now()){
 const m=row?.market,serverNow=sourceNow(m,now),age=serverNow-row?.book?.time;
 return row?.quote?.valid===true&&marketFresh(m,now)&&finite(row.receivedAt)&&row.receivedAt<=now&&now-row.receivedAt<TTL&&finite(age)&&age>=-2000&&age<TTL&&row.contract.expires>now&&row.contract.expires>serverNow;
}
/** Discover real same-price maturities without fetching any additional PUT book. */
export function binanceComparableExpiries(data,now=Date.now()){
 const m=data?.market,A=Number(data?.amount),K=Number(data?.targetPrice);
 if(!finite(A)||A<=0||!finite(K)||K<=0||!marketFresh(m,now)||!Array.isArray(m.contracts))return [];
 const expiries=new Set();
 for(const e of data.entries||[]){
  if(e.platform!=='binance'||e.currency!=='USDT'||e.strike!==K||!finite(e.expires)||e.expires<=now||Math.abs(m.time-e.data?.serverTime)>=TTL)continue;
  const c=m.contracts.find(c=>c.strike===K&&c.expires===e.expires&&c.settleCoin==='USDT'&&c.active!==false&&c.is_active!==false);
  if(!c)continue;
  try{if(deriveBinanceDualIncome(A,{strike:K,expires:c.expires,settleCoin:'USDT'},e.data,now)?.valid)expiries.add(c.expires);}catch{}
 }
 return [...expiries].sort((a,b)=>a-b);
}
/** Actual dual-product maturities, not a claim that matching options are listed. */
export function binanceDualExpiries(data,now=Date.now()){
 const A=Number(data?.amount),K=Number(data?.targetPrice),times=new Set();
 for(const entry of data?.entries||[]){
  if(entry.platform!=='binance'||entry.currency!=='USDT'||entry.strike!==K)continue;
  if(deriveBinanceDualIncome(A,{strike:K,expires:entry.expires,settleCoin:'USDT'},entry.data,now).valid)times.add(entry.expires);
 }
 return [...times].sort((a,b)=>a-b);
}
export function binanceDualIncome(data,now=Date.now()){
 const base={platform:'binance',name:'Binance 普通双币',currency:'USDT',valid:false,comparable:false};
 let best=null,reason=data?.sources?.find(s=>s.platform==='binance'&&s.catalogueComplete===false)?.reason||'没有相同 USDT、接币价和到期时刻的有效普通双币产品';
 for(const entry of data?.entries||[]){
  if(entry.platform!=='binance'||entry.currency!=='USDT'||entry.strike!==Number(data.targetPrice)||entry.expires!==Number(data.selectedExpiry))continue;
  const income=deriveBinanceDualIncome(data.amount,{strike:data.targetPrice,expires:data.selectedExpiry,settleCoin:'USDT'},entry.data,now);
  if(!income.valid){reason=income.reason;continue;}
  if(!best||income.income>best.income)best={...income,quoteTime:entry.data.serverTime};
 }
 return best?{...base,...best,valid:true,eligibilityNote:best.note}:{...base,reason};
}
/** Same USDT principal, exact strike and expiry, with each product's actual accrual rule. */
export function compareBinanceDesk(row,entries=[],now=Date.now()){
 return ['binance'].map(platform=>{
  const base={platform,name:'Binance 普通双币',currency:'USDT',valid:false};
  if(!binanceRowFresh(row,now))return {...base,reason:'SELL PUT 真实报价已失效，请刷新'};
  const c=row.contract,serverNow=sourceNow(row.market,now),days=(c.expires-serverNow)/DAY;
  const model={...row.quote,valid:true,strike:c.strike,expires:c.expires,days,settleCoin:'USDT'};
  let best=null,reason='没有同 USDT、同接币价、同到期时刻的有效真实产品';
  for(const entry of entries.filter(e=>e.platform===platform&&e.currency==='USDT'&&e.strike===c.strike&&e.expires===c.expires)){
   if(Math.abs(row.book.time-entry.data?.serverTime)>=TTL){reason='期权与双币来源时间相差超过 30 秒，停止比较';continue;}
   let d;try{d=compareBinanceDual(row.quote.amount,model,entry.data,now);}catch{reason='双币产品数据无法核验';continue;}
   if(!d?.valid){reason=d?.reason||reason;continue;}
   if(!finite(d.income)||!finite(d.apr)||!finite(d.days)||!finite(d.term))continue;
   if(!best||d.income>best.income)best={...d,quoteTime:entry.data.serverTime};
  }
  if(!best)return {...base,reason};
  return {...base,...best,valid:true,conditional:row.quote.conditional===true,quoteMode:row.quote.quoteMode||'bid_taker',optionIncome:row.quote.netIncome,incomeDifference:row.quote.netIncome-best.income,optionApr:row.quote.annual,spreadPoints:(row.quote.annual-best.apr)*100,
   comparisonNote:`SELL PUT 按现在至到期 ${days.toFixed(3)} 天年化；双币按平台 ${best.days} 天计息。本次收入分别按真实计息规则计算，${row.quote.conditional===true?'卖一挂单全部成交且到期未触发时才成立':'未触发时成立'}。`,
   eligibilityNote:best.note||'个人资格和实际可申购额度以平台确认为准'};
 });
}
async function loadDeskBinanceCatalogue(currency,contracts){
 const catalogue=await loadBinanceCatalogue(currency,contracts,{independent:true});
 return {entries:catalogue.entries||[],sources:catalogue.source?[catalogue.source]:[],receivedAt:catalogue.receivedAt};
}
/** Only one selected exact strike/expiry depth request. Never substitutes another exchange or strike. */
export async function collectBinanceDesk(input,{marketLoader=loadBinanceMarket,bookLoader=loadBinanceBook,catalogueLoader=loadDeskBinanceCatalogue,clock=Date.now,isCurrent=()=>true,onMarket=()=>{}}={}){
 const amount=Number(input.amount),price=input.targetPrice===''||input.targetPrice==null?null:Number(input.targetPrice),settlementMode=input.settlementMode==='cash'?'cash':'buy_btc',quoteMode=input.quoteMode==null?'bid_taker':['ask_limit','bid_taker'].includes(input.quoteMode)?input.quoteMode:null;
 const catalogueTask=Promise.resolve().then(()=>catalogueLoader('USDT',[])).catch(error=>({entries:[],sources:[{platform:'binance',status:'unavailable',reason:String(error?.message||'普通双币读取失败')}]}));
 let market=null,marketReason='';
 try{market={...await marketLoader(),platform:'binance',receivedAt:clock()};if(!finite(market.spot)||market.spot<=0||!finite(market.time)||!Array.isArray(market.contracts))throw Error('Binance 公开行情格式无效');}
 catch(error){market=null;marketReason=String(error?.message||'公开期权来源不可用');}
 if(!isCurrent())return null;if(market)onMarket(market);
 const catalogue=await catalogueTask;if(!isCurrent())return null;
 const active=market?market.contracts.filter(c=>c.expires>market.time&&c.active!==false&&c.is_active!==false):[],optionExpiries=[...new Set(active.filter(c=>price===null||c.strike===price).map(c=>c.expires))].sort((a,b)=>a-b);
 const result={market,amount,targetPrice:price,settlementMode,quoteMode,expiries:[],expirySource:optionExpiries.length?'options':'dual',selectedExpiry:null,row:null,entries:catalogue.entries||[],sources:catalogue.sources||[],reason:'',marketReason,receivedAt:clock()};
 const allExpiries=optionExpiries.length?optionExpiries:binanceDualExpiries(result,clock());result.expiries=allExpiries;
 const chosen=input.expiry===''||input.expiry==null?allExpiries[0]??null:Number(input.expiry);result.selectedExpiry=chosen;
 if(!quoteMode)result.reason='请选择有效的报价方式';
 else if(!finite(amount)||amount<=0||amount>1e15)result.reason='请填写本次投入的 USDT 资金';
 else if(price===null)result.reason='填写想接 BTC 的精确价格，再选择到期日';
 else if(!finite(price)||price<=0)result.reason='接币价须为大于 0 的有效数值';
 else if(!market)result.reason='期权云端盘口未接通：'+marketReason+'；暂不能计算 SELL PUT 净权利金和收益差';
 else if(!optionExpiries.length)result.reason='Binance 没有这个精确接币价的在售 PUT，不会换成其他价格';
 else if(!optionExpiries.includes(chosen))result.reason='所选到期日没有这个接币价的 PUT，请重新选择';
 if(result.reason)return result;
 const contract=active.find(c=>c.strike===price&&c.expires===chosen);
 // Product discovery is independent; only this exact selected PUT requests depth.
 try{
  const book=await bookLoader(contract.symbol),receivedAt=clock();if(!isCurrent())return null;
  const serverTime=sourceNow(market,receivedAt);
  const sizingContract=settlementMode==='cash'?{...contract,spot:0}:contract;
  const quoteCalculator=quoteMode==='ask_limit'?calculatePutAskLimitQuote:calculatePutQuote;
  const quote=!marketFresh(market,receivedAt)?{valid:false,reason:'Binance 合约或指数来源已超过 30 秒'}:Math.abs(serverTime-book.time)<TTL?quoteCalculator(amount,sizingContract,book,market.spot,serverTime):{valid:false,reason:'Binance 盘口来源已超过 30 秒'};
  result.row={contract,book,market,quote,receivedAt};
 }catch(e){if(!isCurrent())return null;result.row={contract,market,quote:{valid:false,reason:'Binance 真实盘口暂不可读：'+String(e.message||'网络错误')},receivedAt:clock()};}
 result.receivedAt=clock();return result;
}

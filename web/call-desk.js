import {loadBinanceMarket,loadBinanceBook} from './binance-market.js';
import {loadBinanceHighCatalogue,deriveBinanceHighDualIncome} from './binance-high-dual.js';
import {calculateCallQuote} from './call-quote.js';
const TTL=30000;
const finite=n=>typeof n==='number'&&Number.isFinite(n);
const symbolValid=s=>typeof s==='string'&&/^BTC-\d{6}-(?:[1-9]\d{0,8})(?:\.\d{1,4})?-C$/.test(s);
function sourceNow(m,now){return m?.time+Math.max(0,m?.receivedAt-m?.time,finite(m?.sourceAgeAtReceive)?m.sourceAgeAtReceive:0)+Math.max(0,now-m?.receivedAt);}
function marketFresh(m,now){return finite(m?.time)&&finite(m?.receivedAt)&&m.time>0&&m.time<=now+2000&&m.receivedAt<=now&&now-m.receivedAt<TTL&&sourceNow(m,now)-m.time<TTL;}
function selection(data){return {strike:Number(data?.targetPrice),expires:Number(data?.selectedExpiry),settleCoin:'BTC'};}
function entriesMatching(data){return (data?.entries||[]).filter(e=>e.platform==='binance'&&e.currency==='BTC'&&e.strike===Number(data.targetPrice)&&e.expires===Number(data.selectedExpiry));}

export function binanceCallRowFresh(row,now=Date.now()){
 const m=row?.market,serverNow=sourceNow(m,now),age=serverNow-row?.book?.time,c=row?.contract;
 return row?.quote?.valid===true&&marketFresh(m,now)&&finite(row.receivedAt)&&row.receivedAt<=now&&now-row.receivedAt<TTL&&finite(age)&&age>=-2000&&age<TTL&&symbolValid(c?.symbol)&&c.settleCoin==='USDT'&&c.expires>now&&c.expires>serverNow;
}
export function binanceCallSelectedContractSymbol(data,now=Date.now()){
 const c=data?.row?.contract,m=data?.market;
 if(!marketFresh(m,now)||!symbolValid(c?.symbol)||c.settleCoin!=='USDT'||c.active===false||c.is_active===false||c.strike!==Number(data.targetPrice)||c.expires!==Number(data.selectedExpiry)||c.expires<=sourceNow(m,now))return null;
 return c.symbol;
}
export function binanceCallDualIncome(data,now=Date.now()){
 const base={platform:'binance',name:'Binance 普通双币高卖',currency:'BTC',valid:false};
 let best=null,reason=data?.sources?.find(s=>s.platform==='binance'&&(s.status!=='ready'||s.catalogueComplete===false))?.reason||'没有相同 BTC 数量范围、高卖价和到期时刻的有效双币高卖报价';
 for(const entry of entriesMatching(data)){
  const result=deriveBinanceHighDualIncome(data.quantity,selection(data),entry.data,now);
  if(!result?.valid){reason=result?.reason||reason;continue;}
  const incomeBTC=result.incomeBTC??result.income;
  if(!finite(incomeBTC)||incomeBTC<0||!finite(result.apr)||!finite(result.term))continue;
  if(!best||incomeBTC>best.incomeBTC)best={...result,incomeBTC,quoteTime:entry.data.serverTime};
 }
 if(!best)return {...base,reason};
 const indicativeUSDT=marketFresh(data.market,now)&&finite(data.market.spot)&&data.market.spot>0?best.incomeBTC*data.market.spot:null;
 return {...base,...best,valid:true,indicativeUSDT,valuationOnly:true,valuationSpot:indicativeUSDT===null?null:data.market.spot};
}
export function binanceCallDualExpiries(data,now=Date.now()){
 const times=new Set();
 for(const entry of data?.entries||[]){
  if(entry.platform!=='binance'||entry.currency!=='BTC'||entry.strike!==Number(data.targetPrice))continue;
  if(deriveBinanceHighDualIncome(data.quantity,{strike:Number(data.targetPrice),expires:entry.expires,settleCoin:'BTC'},entry.data,now).valid)times.add(entry.expires);
 }
 return [...times].sort((a,b)=>a-b);
}
export function compareBinanceCallDesk(row,entries=[],now=Date.now()){
 const base={platform:'binance',name:'Binance 普通双币高卖',currency:'BTC',valid:false};
 if(!binanceCallRowFresh(row,now))return [{...base,reason:'SELL CALL 真实盘口已失效，请刷新'}];
 const c=row.contract,q=row.quote;
 let best=null,reason='没有同 BTC 数量范围、同高卖价、同到期时刻的有效真实双币高卖产品';
 for(const entry of entries){
  if(entry.platform!=='binance'||entry.currency!=='BTC'||entry.strike!==c.strike||entry.expires!==c.expires)continue;
  if(!finite(entry.data?.serverTime)||Math.abs(row.book.time-entry.data.serverTime)>=TTL){reason='期权与双币高卖报价时间相差超过 30 秒，停止比较';continue;}
  const derived=deriveBinanceHighDualIncome(q.requestedBTC,{strike:c.strike,expires:c.expires,settleCoin:'BTC'},entry.data,now);
  if(!derived?.valid){reason=derived?.reason||reason;continue;}
  const incomeBTC=derived.incomeBTC??derived.income;
  if(!finite(incomeBTC)||incomeBTC<0||![derived.apr,derived.term,derived.days].every(finite))continue;
  if(!best||incomeBTC>best.incomeBTC)best={...derived,incomeBTC,quoteTime:entry.data.serverTime};
 }
 if(!best)return [{...base,reason}];
 const indicativeUSDT=best.incomeBTC*row.market.spot;
 return [{...base,...best,valid:true,conditional:q.conditional,quoteMode:q.quoteMode,valuationOnly:true,valuationSpot:row.market.spot,
  indicativeUSDT,optionIncomeUSDT:q.netIncome,incomeDifferenceUSDTIndicative:q.netIncome-indicativeUSDT,optionApr:q.annual,spreadPoints:(q.annual-best.apr)*100,
  comparisonScope:'untriggered_current_index_valuation',
  comparisonNote:'双币未触发利息为 BTC；SELL CALL 权利金为 USDT。此差额仅按当前指数折算，不是到期固定多赚的 USDT。CALL 收益已扣开仓费；触发后的结算损失、交割费及现货费另计。',
  annualBasisNote:'CALL 按本次 BTC 数量的当前指数市值、现在至到期的实际时长计算；双币 APR 及计息天数按平台报价。',
  eligibilityNote:best.note||'双币申购精度、个人资格及最终可申购额度以平台确认为准'}];
}

/** Select one real CALL with the exact strike and expiry; no synthetic quotes. */
export async function collectBinanceCallDesk(input,{marketLoader=loadBinanceMarket,bookLoader=loadBinanceBook,catalogueLoader=loadBinanceHighCatalogue,clock=Date.now,isCurrent=()=>true,onMarket=()=>{}}={}){
 const quantity=Number(input.quantity),price=input.targetPrice===''||input.targetPrice==null?null:Number(input.targetPrice),settlementMode=input.settlementMode==='cash'?'cash':'sell_btc',quoteMode=input.quoteMode==null?'ask_limit':['ask_limit','bid_taker'].includes(input.quoteMode)?input.quoteMode:null;
 const catalogueTask=Promise.resolve().then(()=>catalogueLoader()).catch(error=>({entries:[],sources:[{platform:'binance',status:'unavailable',reason:String(error?.message||'双币高卖报价读取失败')}]}));
 let market=null,marketReason='';
 try{
  market={...await marketLoader('CALL'),platform:'binance',receivedAt:clock()};
  if(!finite(market.spot)||market.spot<=0||!finite(market.time)||!Array.isArray(market.contracts))throw Error('Binance CALL 公开行情格式无效');
 }catch(error){market=null;marketReason=String(error?.message||'公开 CALL 来源不可用');}
 if(!isCurrent())return null;if(market)onMarket(market);
 const catalogue=await catalogueTask;if(!isCurrent())return null;
 const active=market?market.contracts.filter(c=>symbolValid(c.symbol)&&c.expires>market.time&&c.settleCoin==='USDT'&&c.active!==false&&c.is_active!==false):[];
 const optionExpiries=[...new Set(active.filter(c=>price===null||c.strike===price).map(c=>c.expires))].sort((a,b)=>a-b);
 const result={market,quantity,targetPrice:price,settlementMode,quoteMode,expiries:[],expirySource:optionExpiries.length?'options':'dual',selectedExpiry:null,row:null,entries:catalogue.entries||[],sources:catalogue.sources||(catalogue.source?[catalogue.source]:[]),reason:'',marketReason,receivedAt:clock()};
 const allExpiries=optionExpiries.length?optionExpiries:binanceCallDualExpiries(result,clock());result.expiries=allExpiries;
 const chosen=input.expiry===''||input.expiry==null?allExpiries[0]??null:Number(input.expiry);result.selectedExpiry=chosen;
 if(!quoteMode)result.reason='请选择有效的报价方式';
 else if(!finite(quantity)||quantity<=0||quantity>1e9)result.reason='请填写本次高卖的 BTC 数量';
 else if(price===null)result.reason='填写想卖 BTC 的精确价格，再选择到期日';
 else if(!finite(price)||price<=0)result.reason='高卖价须为大于 0 的有效数值';
 else if(!market)result.reason='CALL 云端盘口未接通：'+marketReason+'；暂不能计算净权利金和收益差';
 else if(!optionExpiries.length)result.reason='Binance 没有这个精确高卖价的在售 CALL，不会换成其他价格';
 else if(!optionExpiries.includes(chosen))result.reason='所选到期日没有这个高卖价的 CALL，请重新选择';
 if(result.reason)return result;
 const contract=active.find(c=>c.strike===price&&c.expires===chosen);
 try{
  const book=await bookLoader(contract.symbol),receivedAt=clock();if(!isCurrent())return null;
  const serverTime=sourceNow(market,receivedAt);
  const quote=!marketFresh(market,receivedAt)?{valid:false,reason:'Binance CALL 合约或指数来源已超过 30 秒'}:Math.abs(serverTime-book.time)<TTL?calculateCallQuote(quantity,contract,book,market.spot,serverTime,{quoteMode}):{valid:false,reason:'Binance CALL 盘口来源已超过 30 秒'};
  result.row={contract,book,market,quote,receivedAt};
 }catch(error){if(!isCurrent())return null;result.row={contract,market,quote:{valid:false,reason:'Binance CALL 真实盘口暂不可读：'+String(error?.message||'网络错误')},receivedAt:clock()};}
 result.receivedAt=clock();return result;
}

import {loadMarket,loadBook} from './market.js';
import {calculatePutQuote} from './live-quotes.js';
import {loadDualCatalogues} from './dual-catalogue.js';
import {compareBinanceDual} from './binance-dual.js';
import {compareOKXDual} from './okx-dual.js';

const DAY=86400000,TTL=30000;
export const finite=n=>typeof n==='number'&&Number.isFinite(n);
export const money=(n,d=2)=>n===null||n===undefined||typeof n==='boolean'||typeof n==='string'&&n.trim()===''?'—':finite(Number(n))?Number(n).toLocaleString('zh-CN',{maximumFractionDigits:d}):'—';
export const percent=n=>finite(n)?money(n*100,2)+'%':'—';
export function expiryLabel(t){return finite(t)&&t>0?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Singapore',year:'numeric',month:'long',day:'numeric',weekday:'short',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(t)):'—';}
export function timestamp(t){return finite(t)&&t>0?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Singapore',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(t))+' SGT':'—';}
export function timeLeft(expiry,now=Date.now()){
 const seconds=Math.max(0,Math.floor((expiry-now)/1000));if(!seconds)return '已到期';
 const days=Math.floor(seconds/86400),hours=Math.floor(seconds%86400/3600),minutes=Math.floor(seconds%3600/60);
 return (days?days+'天 ':'')+hours+'小时 '+minutes+'分钟';
}
export function deskRowFresh(row,now=Date.now()){
 const market=row?.market,serverNow=market?.time+Math.max(0,now-market?.receivedAt),sourceAge=serverNow-row?.book?.time;
 return row?.quote?.valid===true&&finite(row.receivedAt)&&now>=row.receivedAt&&now-row.receivedAt<TTL&&finite(sourceAge)&&sourceAge>=-2000&&sourceAge<TTL&&row.contract.expires>now&&row.contract.expires>serverNow;
}
/** USDT dual APR versus USDC PUT APR: rate observations, never a 1:1 cash claim. */
export function compareDeskRates(row,entries=[],now=Date.now()){
 return ['binance','okx'].map(platform=>{
  const name=platform==='binance'?'Binance 普通双币':'OKX 双币';
  const result={platform,name,currency:'USDT',optionCurrency:'USDC',sameCurrency:false,differenceUnit:'percentage_points',valid:false};
  if(!deskRowFresh(row,now))return {...result,reason:'期权报价已失效，请刷新'};
  const c=row.contract,clock=row.market.time+Math.max(0,now-row.market.receivedAt);
  const model={valid:true,strike:c.strike,expires:c.expires,days:(c.expires-clock)/DAY,settleCoin:'USDT',netIncome:0};
  const choices=entries.filter(e=>e.platform===platform&&e.currency==='USDT'&&e.strike===c.strike&&e.expires===c.expires);
  let best=null,reason='暂无同名义接币价、同到期时刻的有效公开报价';
  for(const entry of choices){
   if(Math.abs(row.book.time-entry.data.serverTime)>=TTL){reason='两边来源时间相差超过 30 秒';continue;}
   const compare=platform==='binance'?compareBinanceDual:compareOKXDual;
   let d;try{d=compare(row.quote.amount,model,entry.data,now);}catch{continue;}
   if(!d?.valid){reason=d?.reason||reason;continue;}
   if(!best||d.apr>best.apr)best={apr:d.apr,quoteTime:entry.data.serverTime};
  }
  if(!best)return {...result,reason};
  const days=(c.expires-clock)/DAY,optionApr=row.quote.term*365/days;
  return {...result,valid:true,...best,optionApr,spreadPoints:(optionApr-best.apr)*100,
   note:'USDT 双币与 USDC 期权，仅对照公开年化；币种、结算指数和计息周期不同，不计算同币种金额差'};
 });
}

/** Fixed public GET data only. No account, order or simulated future price. */
export async function collectDeribitDesk(input,{marketLoader=loadMarket,bookLoader=loadBook,catalogueLoader=loadDualCatalogues,clock=Date.now,isCurrent=()=>true,onMarket=()=>{}}={}){
 const amount=Number(input.amount),price=input.targetPrice===''||input.targetPrice==null?null:Number(input.targetPrice),maxDays=input.maxDays??7;
 const market={...await marketLoader('deribit'),platform:'deribit',receivedAt:clock()};
 if(!isCurrent())return null;onMarket(market);
 if(!finite(market.spot)||market.spot<=0||!finite(market.time)||!Array.isArray(market.contracts))throw Error('Deribit 公开行情无效');
 const current=market.time,active=market.contracts.filter(c=>c.expires>current&&c.active!==false&&c.is_active!==false);
 const allExpiries=[...new Set(active.filter(c=>price===null||c.strike===price).map(c=>c.expires))].sort((a,b)=>a-b);
 const expiries=allExpiries.filter(t=>t-current<=maxDays*DAY),strikes=[...new Set(active.map(c=>c.strike))].sort((a,b)=>a-b);
 let reason='';if(!finite(amount)||amount<=0||amount>1e15)reason='请填入本次投入的 USDC 资金';
 else if(price===null)reason='填入你想接 BTC 的价格，再选到期日';
 else if(!finite(price)||price<=0)reason='接币价须为大于 0 的有效数值';
 else if(!allExpiries.length)reason='Deribit 没有这个精确接币价的 PUT。相近真实价格：'+strikes.slice().sort((a,b)=>Math.abs(a-price)-Math.abs(b-price)).slice(0,4).sort((a,b)=>a-b).map(x=>money(x)).join(' / ');
 else if(!expiries.length)reason='当前范围内没有此接币价的到期日，可查看更多日期';
 const result={market,amount,targetPrice:price,allExpiries,expiries,rows:[],entries:[],sources:[],receivedAt:clock(),reason};
 if(reason)return result;
 const contracts=active.filter(c=>c.strike===price&&expiries.includes(c.expires));
 const catalogueTask=catalogueLoader('USDT',contracts.map(c=>({symbol:c.symbol,strike:c.strike,expires:c.expires}))).catch(()=>({entries:[],sources:[]}));
 let cursor=0;
 await Promise.all(Array.from({length:Math.min(4,contracts.length)},async()=>{
  while(isCurrent()&&cursor<contracts.length){const contract=contracts[cursor++];
   try{const book=await bookLoader('deribit',contract.symbol),receivedAt=clock();if(!isCurrent())return;
    const serverTime=market.time+Math.max(0,receivedAt-market.receivedAt);
    const quote=Math.abs(serverTime-book.time)<TTL?calculatePutQuote(amount,contract,book,market.spot,serverTime):{valid:false,reason:'买盘来源已过期'};
    result.rows.push({contract,book,market,quote,receivedAt});
   }catch{if(isCurrent())result.rows.push({contract,market,quote:{valid:false,reason:'该合约真实买盘暂不可读'},receivedAt:clock()});}
  }
 }));
 const catalogue=await catalogueTask;if(!isCurrent())return null;
 result.entries=catalogue.entries||[];result.sources=catalogue.sources||[];result.rows.sort((a,b)=>a.contract.expires-b.contract.expires);
 result.receivedAt=clock();return result;
}

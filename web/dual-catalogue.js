import {loadBybitCatalogue} from './dual.js';
import {loadBinanceCatalogue} from './binance-dual.js';
import {loadOKXCatalogue} from './okx-dual.js';

const n=value=>value===''||value==null?NaN:Number(value);
const positive=value=>Number.isFinite(value)&&value>0;
const definitions=[
  {platform:'bybit',name:'Bybit 双币',load:loadBybitCatalogue},
  {platform:'binance',name:'Binance 普通双币',load:loadBinanceCatalogue},
  {platform:'okx',name:'OKX 双币',load:loadOKXCatalogue}
];

function contractsFor(currency,contracts){
  return (Array.isArray(contracts)?contracts:[]).filter(c=>{
    if(!c||!positive(n(c.strike))||!positive(n(c.expires))||!Number.isInteger(n(c.expires)))return false;
    for(const value of [c.currency,c.settleCoin])if(value!=null&&String(value).toUpperCase()!==currency)return false;
    for(const value of [c.baseCoin,c.baseCurrency])if(value!=null&&String(value).toUpperCase()!=='BTC')return false;
    for(const value of [c.optionType,c.optionsType,c.option_type])if(value!=null&&String(value).toLowerCase()!=='put')return false;
    return true;
  });
}

/** Recheck early responses after slower sources finish; stale rows never rank. */
function current(entry,now){
  const data=entry?.data,server=n(data?.serverTime),received=n(data?.receivedAt);
  if(data?.status!=='ready'||!positive(server)||!positive(received))return false;
  const elapsed=Math.max(0,now-received),time=server+elapsed;
  if(!positive(n(entry.strike))||!Number.isInteger(n(entry.expires))||n(entry.expires)<=time)return false;
  if(entry.platform==='binance'){
    const initial=n(data.snapshotAgeAtReceive),mono=data.receivedMonotonic;
    const age=initial+Math.max(elapsed,typeof mono==='number'&&Number.isFinite(mono)?performance.now()-mono:0);
    const sourceTime=server+age;
    return Number.isFinite(age)&&initial>=0&&age<30000&&n(entry.expires)>sourceTime&&(data.sourceType==='public_web'||n(data.product?.purchaseEndTime)>sourceTime);
  }
  const windowEnd=n(entry.platform==='bybit'?data.product?.subscribeEndAt:data.product?.stopTradingTime);
  return positive(n(data.quote?.expiredAt))&&n(data.quote.expiredAt)>time&&windowEnd>time;
}

/** Public, read-only catalogues; execution, account access and RFQ are excluded. */
export async function loadDualCatalogues(currency,contracts=[]){
  const coin=String(currency||'').toUpperCase(),valid=contractsFor(coin,contracts);
  const results=await Promise.allSettled(definitions.map(source=>source.load(coin,valid)));
  const receivedAt=Date.now(),entries=[],sources=[];
  results.forEach((result,index)=>{
    const definition=definitions[index];
    if(result.status==='rejected'){
      sources.push({platform:definition.platform,name:definition.name,status:'error',reason:'公开报价目录读取失败：'+String(result.reason?.message||'网络异常'),count:0});
      return;
    }
    const catalogue=result.value,rows=Array.isArray(catalogue?.entries)?catalogue.entries:[];
    const fresh=rows.filter(entry=>entry?.platform===definition.platform&&entry.currency===coin&&entry.data?.currency===coin&&current(entry,receivedAt));
    const source=catalogue?.source||{platform:definition.platform,name:definition.name,status:'error',reason:'公开报价目录数据无效'};
    const staleCount=rows.length-fresh.length;
    sources.push({...source,platform:definition.platform,name:definition.name,count:fresh.length,...(staleCount?{staleCount,status:fresh.length?'ready':'unavailable',reason:fresh.length?'已读取部分有效报价，扫描期间失效的报价已移除':'报价在扫描完成前已失效，请刷新'}:{})});
    entries.push(...fresh);
  });
  sources.push({platform:'binance-rfq',name:'Binance 大额双币（RFQ）',status:'unavailable',reason:'尚无可核验的匿名独立 RFQ 报价；普通双币年化不作大额报价使用',count:0});
  return {entries,sources,receivedAt};
}

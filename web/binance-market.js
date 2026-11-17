const TTL=30000;
const symbolValid=s=>typeof s==='string'&&/^BTC-\d{6}-(?:[1-9]\d{0,8})(?:\.\d{1,4})?-[PC]$/.test(s);
const positive=n=>typeof n==='number'&&Number.isFinite(n)&&n>0;
const fresh=(time,now)=>Number.isSafeInteger(time)&&time>0&&time<=now+2000&&now-time<TTL;
function validateMarket(value,now,type='PUT'){
 if(value?.status!=='ready'||value.platform!=='binance'||value.currency!=='USDT'||value.sourceType!=='official_public_api'||!fresh(value.time,now)||!fresh(value.metadataTime,now)||!fresh(value.indexTime,now)||!fresh(value.receivedAt,now)||!positive(value.spot)||!Array.isArray(value.contracts)||!value.contracts.length)throw Error(value?.reason||'Binance 真实期权行情无效或超过 30 秒');
 const seen=new Set();for(const c of value.contracts){if(!symbolValid(c.symbol)||!c.symbol.endsWith(type==='CALL'?'-C':'-P')||(c.optionType!=null&&c.optionType!==type)||seen.has(c.symbol)||!positive(c.strike)||Number(c.symbol.split('-')[2])!==c.strike||!Number.isSafeInteger(c.expires)||c.expires<=now||c.settleCoin!=='USDT'||c.status!=='TRADING'||c.unit!==1||!positive(c.step)||c.step>1||!positive(c.min)||!positive(c.max)||!positive(c.priceTick)||![c.taker,c.cap,c.delivery,c.deliveryCap,c.spot].every(x=>typeof x==='number'&&Number.isFinite(x)&&x>=0&&x<=1)||c.accountFeeVerified!==false||![true,false,null].includes(c.nakedSell))throw Error('Binance 合约规格或公开费率标识无效');seen.add(c.symbol);}
 return {...value,receivedAt:now};
}
function validateBook(value,symbol,now){
 if(value?.status!=='ready'||value.platform!=='binance'||value.currency!=='USDT'||value.symbol!==symbol||value.sourceType!=='official_public_api'||!fresh(value.time,now)||!fresh(value.receivedAt,now)||!Array.isArray(value.bids)||!Array.isArray(value.asks)||value.bids.length>1000||value.asks.length>1000)throw Error(value?.reason||'Binance 真实买盘无效或超过 30 秒');
 for(const [rows,bid] of [[value.bids,true],[value.asks,false]]){let prev=bid?Infinity:0;for(const row of rows){if(!positive(row.price)||!positive(row.qty)||bid&&row.price>=prev||!bid&&row.price<=prev)throw Error('Binance 盘口档位无效');prev=row.price;}}
 return {...value,receivedAt:now};
}
export function createBinanceMarketClient({fetchImpl=(...args)=>fetch(...args),now=()=>Date.now()}={}){
 async function read(path,validate){
  try{
  const response=await fetchImpl('/api/binance-options'+path,{method:'GET',credentials:'omit',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(22000)});
  if(!response.ok){let reason;try{reason=(await response.json()).reason;}catch{}throw Error(reason||'公开期权接口返回 '+response.status);}
  const value=await response.json();if(value?.status!=='ready')throw Error(value?.reason||'尚未收到真实期权数据');
  return {...validate(value,now()),transport:'site_proxy',transportLabel:'云端公开行情'};
  }catch(error){if(['TimeoutError','AbortError'].includes(error?.name))throw Error('期权云端读取超时，请刷新重试；没有使用旧盘口');throw error;}
 }
 return {loadMarket:async(type='PUT')=>{if(!['PUT','CALL'].includes(type))throw Error('期权方向无效');return read('/market'+(type==='CALL'?'?type=CALL':''),(v,t)=>validateMarket(v,t,type));},loadBook:async symbol=>{if(!symbolValid(symbol))throw Error('请选择有效的 Binance BTC 期权');return read('/book?symbol='+encodeURIComponent(symbol),(value,time)=>validateBook(value,symbol,time));}};
}
const client=createBinanceMarketClient();
export const loadBinanceMarket=(type='PUT')=>client.loadMarket(type);
export const loadBinanceBook=symbol=>client.loadBook(symbol);

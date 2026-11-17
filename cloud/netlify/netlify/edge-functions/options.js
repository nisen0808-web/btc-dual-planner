// Fixed, anonymous Binance public market data only. No account headers or arbitrary URLs.
const BNO_ROOT='https://eapi.binance.com/eapi/v1/';
const BNO_DOC='https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-options/api/rest-api/market-data';
const BNO_FEES='https://www.binance.com/en/support/faq/detail/5326e5de61c34fed98abe28d2f175a23';
const BNO_SPOT_FEES='https://www.binance.com/en/fee/trading';
const BNO_TTL=30000,BNO_CACHE=3000,BNO_TIMEOUT=10000,BNO_LIMIT=4*1024*1024;
const bnoNumber=x=>typeof x==='number'&&Number.isFinite(x)?x:typeof x==='string'&&/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(x)&&x.length<=50?Number(x):NaN;
const bnoPositive=x=>Number.isFinite(x)&&x>0&&x<=1e15;
const bnoTime=(time,now)=>Number.isSafeInteger(time)&&time>0&&time<=now+2000&&now-time<BNO_TTL;
const bnoSymbol=s=>typeof s==='string'&&/^BTC-\d{6}-(?:[1-9]\d{0,8})(?:\.\d{1,4})?-[PC]$/.test(s);
const bnoError=message=>{throw Error(message);};
const bnoReply=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
function bnoExpiry(symbol){
 const [,date]=symbol.split('-'),year=2000+Number(date.slice(0,2)),month=Number(date.slice(2,4)),day=Number(date.slice(4));
 const time=Date.UTC(year,month-1,day,8),d=new Date(time);
 return d.getUTCFullYear()===year&&d.getUTCMonth()===month-1&&d.getUTCDate()===day?time:NaN;
}
function bnoContract(row,parent,now,type='PUT'){
 if(!row||row.underlying!=='BTCUSDT'||row.quoteAsset!=='USDT'||row.side!==type||!['PUT','CALL'].includes(type)||!row.symbol?.endsWith(type==='CALL'?'-C':'-P')||row.status!=='TRADING'||!bnoSymbol(row.symbol)||row.contractType!=='CRYPTO_OPTIONS'||row.underlyingType!=='CRYPTO')return null;
 const strike=bnoNumber(row.strikePrice),expires=row.expiryDate,unit=bnoNumber(row.unit);
 if(!bnoPositive(strike)||Number(row.symbol.split('-')[2])!==strike||!Number.isSafeInteger(expires)||expires<=now||bnoExpiry(row.symbol)!==expires||unit!==1)return null;
 const lot=row.filters?.find(x=>x.filterType==='LOT_SIZE'),price=row.filters?.find(x=>x.filterType==='PRICE_FILTER');
 const step=bnoNumber(lot?.stepSize),min=bnoNumber(lot?.minQty),max=bnoNumber(lot?.maxQty),priceTick=bnoNumber(price?.tickSize);
 if(!bnoPositive(step)||step>1||!bnoPositive(min)||!bnoPositive(max)||max<min||!bnoPositive(priceTick))return null;
 const nakedSell=typeof row.nakedSell==='boolean'?row.nakedSell:null;
 return {symbol:row.symbol,optionType:type,strike,expires,unit:1,underlying:'BTCUSDT',settleCoin:'USDT',currency:'USDT',status:'TRADING',step,min,max,priceTick,
  nakedSell,nakedSellSource:nakedSell===null?'unverified_symbol':'public_symbol',underlyingNakedSell:typeof parent?.nakedSell==='boolean'?parent.nakedSell:null,
  sellPermissionScope:nakedSell===null&&typeof parent?.nakedSell==='boolean'?'underlying':nakedSell===null?'unverified':'symbol',sellPermissionSource:BNO_ROOT+'exchangeInfo',
  taker:.00024,cap:.10,delivery:.00015,deliveryCap:.10,deliveryExemptionConfirmed:false,deliveryClassification:'standard',spot:.001,spotDeductBase:true,
  openingRateSource:'published_standard',deliveryRateSource:'published_standard',spotRateSource:'published_standard',accountFeeVerified:false,
  feeTier:'公开普通费率；个人账户费率和优惠未核实',feeCheckedAt:'2026-11-13',feeSourceURLs:{opening:BNO_FEES,delivery:BNO_FEES,spot:BNO_SPOT_FEES},
  feeProvenance:{basis:'published_standard',personalRateVerified:false,openingRate:.00024,openingCap:.10,deliveryRate:.00015,deliveryCap:.10,spotRate:.001,checkedAt:'2026-11-13',sources:[BNO_FEES,BNO_SPOT_FEES]},
  feeNote:'期权开仓按公开 0.024%（新挂 Crypto Options 优惠），上限为各档权利金的 10%；交割 0.015%，上限为内在价值的 10%；现货普通费率 0.1%。个人账户费率、BNB 抵扣和费币种须连接后核实。'};
}
export function normalizeBinanceOptionsMarket(specs,index,now=Date.now(),type='PUT'){
 if(!specs||!Array.isArray(specs.optionSymbols)||specs.optionSymbols.length>30000||!Array.isArray(specs.optionContracts)||!bnoTime(specs.serverTime,now)||!bnoTime(index?.time,now))bnoError('Binance 公开合约或指数时间无效、已超过 30 秒');
 const parent=specs.optionContracts.find(x=>x.baseAsset==='BTC'&&x.quoteAsset==='USDT'&&x.underlying==='BTCUSDT'&&x.settleAsset==='USDT');
 if(!parent)bnoError('Binance 未返回 BTC/USDT 期权市场');
 const spot=bnoNumber(index.indexPrice);if(!bnoPositive(spot))bnoError('Binance BTC/USDT 指数价格无效');
 const seen=new Set(),contracts=[];
 for(const row of specs.optionSymbols){const contract=bnoContract(row,parent,now,type);if(!contract)continue;if(seen.has(contract.symbol))bnoError('Binance 公开合约标识重复');seen.add(contract.symbol);contracts.push(contract);}
 contracts.sort((a,b)=>a.expires-b.expires||a.strike-b.strike);
 if(!contracts.length)bnoError('Binance 暂无可核实的 BTC/USDT '+type+' 合约');
 return {status:'ready',platform:'binance',currency:'USDT',optionType:type,source:'Binance BTC/USDT 期权指数及真实挂牌',sourceType:'official_public_api',sourceURLs:[BNO_ROOT+'exchangeInfo',BNO_ROOT+'index?underlying=BTCUSDT'],documentation:BNO_DOC,time:Math.min(specs.serverTime,index.time),metadataTime:specs.serverTime,indexTime:index.time,receivedAt:now,spot,contracts};
}
function bnoLevels(rows,bid){
 if(!Array.isArray(rows)||rows.length>1000)bnoError('Binance 盘口深度格式无效');
 const result=[],seen=new Set();let previous=bid?Infinity:0;
 for(const row of rows){if(!Array.isArray(row)||row.length!==2)bnoError('Binance 盘口档位无效');const price=bnoNumber(row[0]),qty=bnoNumber(row[1]);if(!bnoPositive(price)||!Number.isFinite(qty)||qty<0||qty>1e15)bnoError('Binance 盘口价格或数量无效');if(qty===0)continue;if(seen.has(price)||bid&&price>=previous||!bid&&price<=previous)bnoError('Binance 盘口价格次序无效');seen.add(price);previous=price;result.push({price,qty});}
 return result;
}
export function normalizeBinanceOptionsBook(raw,symbol,now=Date.now()){
 if(!bnoSymbol(symbol)||!bnoTime(raw?.T,now)||!Number.isSafeInteger(raw.lastUpdateId)||raw.lastUpdateId<0)bnoError('Binance 买盘来源时间无效或已超过 30 秒');
 const bids=bnoLevels(raw.bids,true),asks=bnoLevels(raw.asks,false);
 if(bids.length&&asks.length&&bids[0].price>=asks[0].price)bnoError('Binance 期权盘口交叉，等待新报价');
 return {status:'ready',platform:'binance',currency:'USDT',symbol,time:raw.T,receivedAt:now,lastUpdateId:raw.lastUpdateId,bids,asks,depthLimit:1000,sourceType:'official_public_api',source:BNO_ROOT+'depth?symbol='+encodeURIComponent(symbol)+'&limit=1000'};
}
// The verified Site pure normalizers are prepended during packaging.
export const config={path:['/options/market','/options/book','/edge-health']};
const EDGE_LIMIT=4*1024*1024,EDGE_TOTAL_MS=15000,EDGE_CACHE_MS=3000,EDGE_COOLDOWN_MS=10000;
export function createOptionsProductionReader({fetchImpl=(...args)=>fetch(...args),now=()=>Date.now(),type='PUT'}={}){
 let market=null,marketPending=null,cooldown=null,stopped=0;
 const books=new Map(),bookPending=new Map(),contexts=new Set();
 const fault=(reason,ctx,status=0,code='source_unavailable',httpStatus=503)=>Object.assign(Error(reason),{stage:ctx?.stage||'request',upstreamStatus:status,code,httpStatus});
 function context(){const c={startedAt:now(),stage:'exchangeInfo',status:0,bytes:0,controller:new AbortController()};c.timer=setTimeout(()=>c.controller.abort(),EDGE_TOTAL_MS);contexts.add(c);return c;}
 function check(c){if(stopped)throw fault('官方期权来源返回 HTTP '+stopped+'，当前实例已停止，不切换来源或自动重试。',c,stopped,'source_restricted');if(c.controller.signal.aborted||now()-c.startedAt>=EDGE_TOTAL_MS)throw fault('公开行情读取超过总计 15 秒。',c,c.status,'source_timeout');}
 function before(c){check(c);if(cooldown&&now()<cooldown.until)throw cooldown.error;}
 function freshMarket(v){return v&&bnoTime(v.metadataTime,now())&&bnoTime(v.indexTime,now())&&bnoTime(v.time,now());}
 function freshCache(v){return v&&bnoTime(v.time,now())&&now()-v.receivedAt>=0&&now()-v.receivedAt<EDGE_CACHE_MS;}
 function remember(error){if(cooldown?.error===error)return;if(!stopped&&!['not_listed','busy','invalid_request'].includes(error.code))cooldown={error,until:now()+EDGE_COOLDOWN_MS};}
 async function read(path,c,stage){
  c.stage=stage;c.status=0;check(c);
  let response;
  try{response=await fetchImpl(BNO_ROOT+path,{method:'GET',credentials:'omit',redirect:'manual',cache:'no-store',headers:{accept:'application/json'},signal:c.controller.signal});}
  catch{check(c);throw fault('官方公开期权行情连接失败。',c,0);}
  c.status=response.status;
  if(response.status===403||response.status===451){
   stopped=response.status;market=null;books.clear();
   for(const other of contexts)if(other!==c)other.controller.abort();
  }
  if(response.status!==200){await response.body?.cancel().catch(()=>{});throw fault('官方期权来源返回 HTTP '+response.status+'。',c,response.status,stopped?'source_restricted':'source_unavailable');}
  check(c);
  if(Number(response.headers.get('content-length'))>EDGE_LIMIT-c.bytes){await response.body?.cancel().catch(()=>{});throw fault('公开行情超过累计 4MB 字节上限。',c,200,'response_too_large');}
  const stream=response.body?.getReader();if(!stream)throw fault('官方公开期权接口没有响应体。',c,200,'schema_unsupported');
  const decoder=new TextDecoder();let text='';
  try{
   for(;;){check(c);const part=await stream.read();if(part.done)break;c.bytes+=part.value.byteLength;if(c.bytes>EDGE_LIMIT){await stream.cancel();throw fault('公开行情超过累计 4MB 字节上限。',c,200,'response_too_large');}text+=decoder.decode(part.value,{stream:true});}
   text+=decoder.decode();check(c);
  }catch(error){if(error?.stage)throw error;check(c);throw fault('公开行情响应读取失败。',c,c.status);}
  finally{stream.releaseLock();}
  let value;try{value=JSON.parse(text);}catch{throw fault('官方公开期权接口未返回有效 JSON。',c,200,'schema_unsupported');}
  if(value?.code!==undefined&&Number(value.code)!==0)throw fault('官方期权接口拒绝本次公开读取。',c,200);
  return value;
 }
 async function loadMarket(c){
  before(c);
  if(freshMarket(market)&&freshCache(market))return market;
  if(marketPending){const value=await marketPending.promise;if(c!==marketPending?.context){c.bytes+=value.bytes;if(c.bytes>EDGE_LIMIT)throw fault('公开行情超过累计 4MB 字节上限。',c,200,'response_too_large');}check(c);return value.market;}
  const entry={context:c,promise:null};
  entry.promise=(async()=>{
   const initial=c.bytes,specs=await read('exchangeInfo',c,'exchangeInfo');
   if(!Array.isArray(specs?.optionSymbols)||!Array.isArray(specs.optionContracts)||!bnoTime(specs.serverTime,now()))throw fault('真实挂牌缺少完整列表或原始 serverTime 已超过 30 秒。',c,200,'schema_unsupported');
   const parent=specs.optionContracts.find(x=>x?.baseAsset==='BTC'&&x.quoteAsset==='USDT'&&x.underlying==='BTCUSDT'&&x.settleAsset==='USDT');
   if(!parent||!specs.optionSymbols.some(row=>bnoContract(row,parent,now(),type)))throw fault('真实 BTC/USDT '+type+' 的合约单位、分类、LOT_SIZE、PRICE_FILTER 或到期格式不受当前模型支持；不猜测规则。',c,200,'schema_unsupported');
   const index=await read('index?underlying=BTCUSDT',c,'index');
   let value;try{value=normalizeBinanceOptionsMarket(specs,index,now(),type);}catch{throw fault('挂牌或指数格式无效，或原始时间已超过 30 秒。',c,200,'schema_unsupported');}
   check(c);market=value;return {market:value,bytes:c.bytes-initial};
  })();
  marketPending=entry;
  try{const result=await entry.promise;return result.market;}
  catch(error){market=null;throw error;}
  finally{if(marketPending===entry)marketPending=null;}
 }
 async function loadBook(symbol,c){
  const listed=await loadMarket(c);check(c);
  if(!listed.contracts.some(x=>x.symbol===symbol))throw fault('所选 BTC/USDT 期权不在当前真实挂牌名单内。',c,0,'not_listed',422);
  const cached=books.get(symbol);
  if(freshMarket(listed)&&freshCache(cached)){books.delete(symbol);books.set(symbol,cached);return cached;}
  if(bookPending.has(symbol))return bookPending.get(symbol);
  if(bookPending.size>=8)throw fault('公开盘口读取繁忙，请稍后再试。',c,0,'busy');
  const task=(async()=>{
   const raw=await read('depth?symbol='+encodeURIComponent(symbol)+'&limit=1000',c,'depth');
   let value;try{value=normalizeBinanceOptionsBook(raw,symbol,now());}catch{throw fault('真实盘口缺少有效 T/lastUpdateId/价格数量，或超过 30 秒、乱序及交叉。',c,200,'schema_unsupported');}
   check(c);if(!freshMarket(listed))throw fault('读取盘口期间挂牌或指数已超过 30 秒。',c,200,'source_stale');
   books.delete(symbol);books.set(symbol,value);while(books.size>32)books.delete(books.keys().next().value);return value;
  })();
  bookPending.set(symbol,task);
  try{return await task;}finally{bookPending.delete(symbol);}
 }
 function reply(status,value,ctx={}){
  const region=ctx?.server?.region,serverRegion=typeof region==='string'?region.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,80):null;
  let body=JSON.stringify({...value,serverRegion});
  if(new TextEncoder().encode(body).byteLength>EDGE_LIMIT){status=503;body=JSON.stringify({status:'unavailable',reason:'归一化响应超过 4MB 上限。',code:'response_too_large',time:0,serverRegion});}
  return new Response(body,{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*','x-content-type-options':'nosniff',...(status===405?{allow:'GET'}:{})}});
 }
 function unavailable(error){return {status:'unavailable',platform:'binance',currency:'USDT',sourceType:'official_public_api',reason:error.message,code:error.code||'source_unavailable',stage:error.stage||'request',upstreamStatus:stopped||error.upstreamStatus||0,time:0,receivedAt:0,...(stopped?{sourceStopped:true}:{}),...(cooldown?{retryAfterMs:Math.max(0,cooldown.until-now())}:{})};}
 return async function handle(request,ctx={}){
  if(request.method!=='GET')return reply(405,{status:'unavailable',reason:'仅允许匿名 GET。'},ctx);
  let url;try{url=new URL(request.url);}catch{return reply(400,{status:'unavailable',reason:'请求地址无效。'},ctx);}
  const isMarket=url.pathname==='/options/market',isBook=url.pathname==='/options/book',isHealth=url.pathname==='/edge-health';
  if(!isMarket&&!isBook&&!isHealth)return reply(404,{status:'unavailable',reason:'未知公开期权路径。'},ctx);
  const keys=[...url.searchParams.keys()],symbol=url.searchParams.get('symbol');
  if(url.username||url.password||url.hash||(!isBook&&url.search&&!(isMarket&&keys.length===1&&keys[0]==='type'&&url.searchParams.getAll('type').length===1&&url.searchParams.get('type')===type))||(isBook&&(keys.length!==1||keys[0]!=='symbol'||url.searchParams.getAll('symbol').length!==1||!bnoSymbol(symbol)||!symbol.endsWith(type==='CALL'?'-C':'-P'))))return reply(400,{status:'unavailable',reason:'公开期权参数无效；仅允许精确 BTC PUT 合约。'},ctx);
  if(isHealth)return reply(200,{serviceReady:true,readOnly:true},ctx);
  const c=context();
  try{const value=isMarket?await loadMarket(c):await loadBook(symbol,c);check(c);return reply(200,value,ctx);}
  catch(raw){const error=raw?.stage?raw:fault('公开期权行情读取失败。',c,c.status);remember(error);return reply(error.httpStatus||503,unavailable(error),ctx);}
  finally{clearTimeout(c.timer);contexts.delete(c);}
 };
}
const productionOptions=createOptionsProductionReader(),productionCalls=createOptionsProductionReader({type:'CALL'});
export default (request,context)=>{const url=new URL(request.url);return (url.searchParams.get('type')==='CALL'||url.searchParams.get('symbol')?.endsWith('-C')?productionCalls:productionOptions)(request,context);};

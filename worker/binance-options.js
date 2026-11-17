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
  feeNote:'期权开仓按公开费率 0.024% 估算，最高为各档权利金的 10%。交割费率为 0.015%，最高为内在价值的 10%。现货普通费率为 0.1%。个人等级、活动优惠及手续费抵扣可能改变实际费用。'};
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
export function createBinanceOptionsReader({fetchImpl=(...args)=>fetch(...args),now=()=>Date.now(),type='PUT'}={}){
 let market=null,marketPending=null;const books=new Map(),pending=new Map();
 const fresh=x=>x&&bnoTime(x.time,now())&&now()-x.receivedAt<BNO_CACHE;
 async function read(path){
  const response=await fetchImpl(BNO_ROOT+path,{method:'GET',credentials:'omit',redirect:'manual',headers:{accept:'application/json'},signal:AbortSignal.timeout(BNO_TIMEOUT)});
  if(!response.ok)bnoError('Binance 官方公开期权接口返回 '+response.status);
  const declared=response.headers.get('content-length');if(declared&&Number(declared)>BNO_LIMIT)bnoError('Binance 公开响应超过大小上限');
  const text=await response.text();if(text.length>BNO_LIMIT)bnoError('Binance 公开响应超过大小上限');
  const value=JSON.parse(text);if(value?.code!==undefined&&Number(value.code)!==0)bnoError('Binance 官方公开接口暂不可用');return value;
 }
 async function loadMarket(){
  if(fresh(market))return market;if(marketPending)return marketPending;
  marketPending=(async()=>{const [specs,index]=await Promise.all([read('exchangeInfo'),read('index?underlying=BTCUSDT')]);market=normalizeBinanceOptionsMarket(specs,index,now(),type);return market;})();
  try{return await marketPending;}finally{marketPending=null;}
 }
 async function loadBook(symbol){
  if(!bnoSymbol(symbol)||!symbol.endsWith(type==='CALL'?'-C':'-P'))bnoError('仅支持当前方向真实 BTC/USDT 期权合约');
  const listed=await loadMarket();if(!listed.contracts.some(x=>x.symbol===symbol))bnoError('所选接币价与到期日在 Binance 没有真实挂牌 PUT');
  const cached=books.get(symbol);if(fresh(cached))return cached;if(pending.has(symbol))return pending.get(symbol);if(pending.size>=8)bnoError('公开盘口读取繁忙，请稍后刷新');
  const task=(async()=>{const value=normalizeBinanceOptionsBook(await read('depth?symbol='+encodeURIComponent(symbol)+'&limit=1000'),symbol,now());books.delete(symbol);books.set(symbol,value);while(books.size>32)books.delete(books.keys().next().value);return value;})();pending.set(symbol,task);
  try{return await task;}finally{pending.delete(symbol);}
 }
 async function handle(request){
  const url=new URL(request.url),marketPath=url.pathname.endsWith('/market'),bookPath=url.pathname.endsWith('/book');
  if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405,headers:{allow:'GET, HEAD','cache-control':'no-store'}});
  if(!marketPath&&!bookPath)return bnoReply({status:'unavailable',reason:'未知公开期权接口'},404);
  const keys=[...url.searchParams.keys()];
  if(marketPath&&keys.length||bookPath&&(keys.length!==1||keys[0]!=='symbol'||url.searchParams.getAll('symbol').length!==1||!bnoSymbol(url.searchParams.get('symbol'))||!url.searchParams.get('symbol').endsWith(type==='CALL'?'-C':'-P')))return bnoReply({status:'unavailable',reason:'公开期权参数无效'},400);
  try{const value=marketPath?await loadMarket():await loadBook(url.searchParams.get('symbol'));return request.method==='HEAD'?new Response(null,{headers:{'content-type':'application/json','cache-control':'no-store'}}):bnoReply(value);}
  catch(error){return bnoReply({status:'unavailable',platform:'binance',reason:error.message,sourceType:'official_public_api',time:0,receivedAt:0},502);}
 }
 return {loadMarket,loadBook,handle};
}

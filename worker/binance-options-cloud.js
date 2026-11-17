/** Anonymous fixed cloud feed. No visitor credentials, local relay or account API. */
function createBinanceOptionsCloudReader({fetchImpl=(...args)=>fetch(...args),now=()=>Date.now(),type='PUT'}={}){
 const root='https://harmonious-bienenstitch-ef1a0a.netlify.app/options',limit=4*1024*1024;
 const cache=new Map(),pending=new Map(),failures=new Map();
 const failure=reason=>({status:'unavailable',platform:'binance',currency:'USDT',reason,sourceType:'official_public_api',time:0,receivedAt:0});
 function validate(value,symbol){
  const time=now();
  if(value?.status!=='ready'||value.platform!=='binance'||value.currency!=='USDT'||value.sourceType!=='official_public_api'||!bnoTime(value.time,time)||!bnoTime(value.receivedAt,time))throw Error(value?.reason||'期权云端报价无效或已超过 30 秒');
  let normalized;
  if(symbol){
   if(value.symbol!==symbol||value.source!==BNO_ROOT+'depth?symbol='+encodeURIComponent(symbol)+'&limit=1000'||value.depthLimit!==1000)throw Error('期权云端盘口合约或来源不一致');
   normalized=normalizeBinanceOptionsBook({T:value.time,lastUpdateId:value.lastUpdateId,bids:value.bids?.map(x=>[String(x.price),String(x.qty)]),asks:value.asks?.map(x=>[String(x.price),String(x.qty)])},symbol,time);
  }else{
   if(!bnoTime(value.metadataTime,time)||!bnoTime(value.indexTime,time)||!Array.isArray(value.contracts)||!value.contracts.length||value.contracts.length>30000||!Array.isArray(value.sourceURLs)||value.sourceURLs.length!==2||value.sourceURLs[0]!==BNO_ROOT+'exchangeInfo'||value.sourceURLs[1]!==BNO_ROOT+'index?underlying=BTCUSDT')throw Error('期权云端挂牌、指数或来源不完整');
   const rows=value.contracts.map(c=>{
    if(c.unit!==1||c.underlying!=='BTCUSDT'||c.settleCoin!=='USDT'||c.status!=='TRADING'||c.accountFeeVerified!==false||!c.symbol?.endsWith(type==='CALL'?'-C':'-P')||(c.optionType!=null&&c.optionType!==type))throw Error('期权合约规格或个人费率标识无效');
    return {symbol:c.symbol,side:type,strikePrice:String(c.strike),expiryDate:c.expires,underlying:'BTCUSDT',quoteAsset:'USDT',status:c.status,unit:c.unit,contractType:'CRYPTO_OPTIONS',underlyingType:'CRYPTO',...(typeof c.nakedSell==='boolean'?{nakedSell:c.nakedSell}:{}),filters:[{filterType:'LOT_SIZE',minQty:String(c.min),maxQty:String(c.max),stepSize:String(c.step)},{filterType:'PRICE_FILTER',tickSize:String(c.priceTick)}]};
   });
   const parent={baseAsset:'BTC',quoteAsset:'USDT',underlying:'BTCUSDT',settleAsset:'USDT'};
   const parentPermission=value.contracts[0]?.underlyingNakedSell;if(typeof parentPermission==='boolean'&&value.contracts.every(c=>c.underlyingNakedSell===parentPermission))parent.nakedSell=parentPermission;
   normalized=normalizeBinanceOptionsMarket({serverTime:value.metadataTime,optionContracts:[parent],optionSymbols:rows},{time:value.indexTime,indexPrice:String(value.spot)},time,type);
   if(normalized.contracts.length!==value.contracts.length||normalized.time!==value.time)throw Error('期权云端合约列表未通过完整核验');
  }
  const region=typeof value.serverRegion==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(value.serverRegion)?value.serverRegion:null;
  return {...normalized,receivedAt:value.receivedAt,transport:'netlify_edge_feed',transportLabel:'Netlify 免费云端实时盘口',serverRegion:region};
 }
 async function read(key,symbol){
  const prior=cache.get(key);if(prior&&now()-prior.receivedAt<3000){try{return validate(prior,symbol);}catch{cache.delete(key);}}
  const failed=failures.get(key);if(failed&&now()<failed.until)return failed.value;
  if(pending.has(key))return pending.get(key);if(pending.size>=8)return failure('期权公开行情读取繁忙，请稍后刷新');
  const task=(async()=>{
   try{
    const response=await fetchImpl(root+(symbol?'/book?symbol='+encodeURIComponent(symbol):'/market'+(type==='CALL'?'?type=CALL':'')),{method:'GET',credentials:'omit',cache:'no-store',redirect:'manual',headers:{accept:'application/json'},signal:AbortSignal.timeout(18000)});
    if(Number(response.headers.get('content-length'))>limit){await response.body?.cancel().catch(()=>{});throw Error('期权云端响应超过 4MB');}
    const reader=response.body?.getReader();if(!reader)throw Error('期权云端没有返回数据');
    const decoder=new TextDecoder();let text='',size=0;
    try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>limit){await reader.cancel();throw Error('期权云端响应超过 4MB');}text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}finally{reader.releaseLock();}
    let value;try{value=JSON.parse(text);}catch{throw Error('期权云端未返回有效行情');}
    if(response.status!==200)throw Error(typeof value?.reason==='string'?value.reason.slice(0,400):'期权云端服务返回 HTTP '+response.status);
    const verified=validate(value,symbol);cache.delete(key);cache.set(key,verified);while(cache.size>32)cache.delete(cache.keys().next().value);failures.delete(key);return verified;
   }catch(error){cache.delete(key);const value=failure(String(error?.message||'期权云端读取失败'));failures.set(key,{value,until:now()+10000});while(failures.size>32)failures.delete(failures.keys().next().value);return value;}
  })();pending.set(key,task);try{return await task;}finally{pending.delete(key);}
 }
 return async function handle(request){
  const url=new URL(request.url),headers={'cache-control':'no-store','x-content-type-options':'nosniff'};
  if(request.method!=='GET')return Response.json(failure('仅允许 GET 读取真实公开盘口'),{status:405,headers:{...headers,allow:'GET'}});
  const isMarket=url.pathname==='/api/binance-options/market',keys=[...url.searchParams.keys()],symbol=isMarket?null:url.searchParams.get('symbol');
  if(isMarket?(keys.length!==0&&!(keys.length===1&&keys[0]==='type'&&url.searchParams.getAll('type').length===1&&url.searchParams.get('type')===type)): url.pathname!=='/api/binance-options/book'||keys.length!==1||keys[0]!=='symbol'||url.searchParams.getAll('symbol').length!==1||!bnoSymbol(symbol)||!symbol.endsWith(type==='CALL'?'-C':'-P'))return Response.json(failure('公开期权参数无效'),{status:400,headers});
  const result=await read(symbol||'market',symbol);return Response.json(result,{status:result.status==='ready'?200:503,headers});
 };
}

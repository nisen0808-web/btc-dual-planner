// Fixed server-to-server public quotes. Browser/account headers never leave this Site.
export function createBinanceCloudFeedReader({fetchImpl=(...args)=>fetch(...args),now=Date.now}={}){
 const ttl=30000,maximum=4*1024*1024;
 const reply=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
 const failed=reason=>reply({status:'unavailable',platform:'binance',sourceType:'cloud_public_feed',reason,time:0,receivedAt:0},503);
 const validTime=t=>Number.isSafeInteger(t)&&t>0&&t<=now()+2000&&now()-t<ttl;
 return async(request,env)=>{
  const incoming=new URL(request.url),route=incoming.pathname;
  const path=route==='/api/binance-options/market'?'/market':route==='/api/binance-options/book'?'/book':route==='/api/binance-dual'?'/dual':null;
  if(!path)return reply({status:'unavailable',reason:'未知公开行情接口'},404);
  if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405,headers:{allow:'GET, HEAD'}});
  const keys=[...incoming.searchParams.keys()],symbol=incoming.searchParams.get('symbol');
  if(path==='/book'?(keys.length!==1||keys[0]!=='symbol'||incoming.searchParams.getAll('symbol').length!==1||!/^BTC-\d{6}-[1-9]\d{0,8}(?:\.\d{1,4})?-P$/.test(symbol||'')):keys.length)return reply({status:'unavailable',reason:'公开行情参数无效'},400);
  let origin;try{origin=new URL(env?.BINANCE_CLOUD_ORIGIN);}catch{return failed('云端行情服务尚未配置');}
  if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||!origin.hostname.endsWith('.onrender.com')||typeof env?.BINANCE_CLOUD_TOKEN!=='string'||env.BINANCE_CLOUD_TOKEN.length<32)return failed('云端行情服务配置无效');
  const url=origin.origin+path+(path==='/book'?'?symbol='+encodeURIComponent(symbol):'');
  try{
   const response=await fetchImpl(url,{method:'GET',credentials:'omit',redirect:'manual',headers:{accept:'application/json',authorization:'Bearer '+env.BINANCE_CLOUD_TOKEN},signal:AbortSignal.timeout(15000)});
   if(!response.ok||!response.headers.get('content-type')?.includes('application/json'))return failed('独立云端行情服务暂不可用或正在启动，请稍后刷新');
   const length=Number(response.headers.get('content-length')||0);if(length>maximum)return failed('云端行情响应超过大小上限');
   const text=await response.text();if(text.length>maximum)return failed('云端行情响应超过大小上限');
   const body=JSON.parse(text);
   if(body?.status!=='ready')return failed('独立云端服务未取得有效 Binance 真实报价');
   if(path==='/dual'){
    if(!validTime(body.serverTime)||!validTime(body.fetchedAt)||!Array.isArray(body.items)||body.items.length>2000)return failed('云端双币原始报价已过期或格式异常');
   }else{
    if(body.platform!=='binance'||body.currency!=='USDT'||!validTime(body.time)||!validTime(body.receivedAt))return failed('云端期权原始报价已过期或格式异常');
    if(path==='/market'&&(!validTime(body.metadataTime)||!validTime(body.indexTime)||!Array.isArray(body.contracts)||body.contracts.length>30000))return failed('云端期权挂牌或指数数据不完整');
    if(path==='/book'&&(body.symbol!==symbol||!Array.isArray(body.bids)||!Array.isArray(body.asks)||body.bids.length>1000||body.asks.length>1000))return failed('云端期权盘口与所选合约不匹配');
   }
   if(request.method==='HEAD')return new Response(null,{headers:{'content-type':'application/json','cache-control':'no-store'}});
   return reply({...body,transport:'cloud_service'});
  }catch{return failed('独立云端行情暂未返回有效数据，请稍后刷新');}
 };
}

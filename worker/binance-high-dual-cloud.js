/** Fixed public-data transport. No owner collector, account or visitor headers. */
function createBinanceHighDualCloudReader({fetchImpl=(...args)=>fetch(...args),now=()=>Date.now()}={}){
 const endpoint='https://harmonious-bienenstitch-ef1a0a.netlify.app/dual-high';
 const source='https://www.binance.com/bapi/earn/v5/friendly/pos/dc/project/list?investmentAsset=BTC&targetAsset=USDT&projectType=UP&sortType=APY_DESC&pageSize=100';
 const TTL=30000,LIMIT=4*1024*1024;
 let snapshot=null,pending=null,failure=null;
 const unavailable=reason=>({status:'unavailable',reason,source,sourceType:'public_web',deliveryType:'cloud_pull',transport:'netlify_public_feed',serverTime:0,fetchedAt:0});
 function fresh(t,time){return Number.isSafeInteger(t)&&t>0&&t<=time+2000&&time-t<TTL;}
 function validate(value,time){
  if(value?.status!=='ready')throw Error(typeof value?.reason==='string'?value.reason:'云端双币来源暂不可用');
  if(value.source!==source||value.sourceType!=='public_web'||![value.serverTime,value.lastServerTime,value.fetchedAt,value.completedAt].every(t=>fresh(t,time))||value.fetchedAt>value.completedAt||value.serverTime>value.lastServerTime||value.serverTime<value.fetchedAt-2000||value.lastServerTime>value.completedAt+2000)throw Error('云端双币报价来源时间无效或已超过 30 秒');
  const partial=value.catalogueComplete===false;
  const pagesValid=partial?value.total>0&&value.coverageReason==='changing_catalogue'&&Number.isSafeInteger(value.pageCount)&&value.pageCount>=1&&value.pageCount<=20&&value.total<=value.pageCount*100&&Array.isArray(value.reportedTotals)&&value.reportedTotals.length===value.pageCount&&value.reportedTotals.every(n=>Number.isSafeInteger(n)&&n>=0&&n<=2000)&&Number.isSafeInteger(value.rejectedConflictCount)&&value.rejectedConflictCount>=0&&value.rejectedConflictCount<=2000:(value.catalogueComplete==null||value.catalogueComplete===true)&&value.pageCount===Math.max(1,Math.ceil(value.total/100));
  if(!Array.isArray(value.items)||!Number.isSafeInteger(value.total)||value.total<0||value.total>2000||value.items.length!==value.total||!pagesValid||value.eligibility?.precisionKnown!==false||value.eligibility?.purchaseWindowKnown!==false||value.eligibility?.accountEligibilityVerified!==false)throw Error('云端双币产品列表、覆盖范围或申购规则标识不完整');
  const decimal=x=>(typeof x==='string'||typeof x==='number')&&/^\d+(?:\.\d*)?(?:e[+-]?\d+)?$/i.test(String(x))&&Number.isFinite(Number(x));
  const seen=new Set(),items=value.items.map(p=>{
   if(!p||typeof p!=='object'||typeof p.id!=='string'||!p.id.trim()||p.id.length>150||seen.has(p.id)||p.optionType!=='CALL'||p.investCoin!=='BTC'||p.exercisedCoin!=='USDT'||typeof p.canPurchase!=='boolean'||p.purchaseDecimal!==null||p.purchaseEndTime!==null||![p.strikePrice,p.apr,p.minAmount,p.maxAmount].every(decimal)||Number(p.strikePrice)<=0||!Number.isSafeInteger(p.duration)||p.duration<=0||p.duration>3650||!Number.isSafeInteger(p.settleDate)||p.settleDate<=0||p.canPurchase&&Number(p.maxAmount)<Number(p.minAmount))throw Error('云端双币产品字段、币种或唯一标识无效');
   seen.add(p.id);return {id:p.id,optionType:'CALL',investCoin:'BTC',exercisedCoin:'USDT',strikePrice:p.strikePrice,apr:p.apr,minAmount:p.minAmount,maxAmount:p.maxAmount,duration:p.duration,settleDate:p.settleDate,canPurchase:p.canPurchase,purchaseDecimal:null,purchaseEndTime:null};
  });
  return {status:'ready',source,sourceType:'public_web',serverTime:value.serverTime,lastServerTime:value.lastServerTime,fetchedAt:value.fetchedAt,completedAt:value.completedAt,total:value.total,pageCount:value.pageCount,catalogueComplete:!partial,...(partial?{coverageReason:'changing_catalogue',reportedTotals:[...value.reportedTotals],rejectedConflictCount:value.rejectedConflictCount}:{}),eligibility:{precisionKnown:false,purchaseWindowKnown:false,accountEligibilityVerified:false,missingFields:['purchaseDecimal','purchaseEndTime']},items};
 }
 function output(value){
  const time=now();validate(value,time);
  return {...value,deliveryType:'cloud_pull',transport:'netlify_public_feed',upstreamURL:endpoint,siteValidatedAt:time,snapshotAgeAtRead:Math.max(0,time-value.fetchedAt,time-value.serverTime)};
 }
 async function load(){
  const time=now();
  if(snapshot&&time-snapshot.completedAt<10000){try{return output(snapshot);}catch{snapshot=null;}}
  if(failure&&time<failure.until)return failure.value;
  if(pending)return pending;
  const task=(async()=>{
   try{
    const response=await fetchImpl(endpoint,{method:'GET',credentials:'omit',redirect:'manual',cache:'no-store',headers:{accept:'application/json'},signal:AbortSignal.timeout(18000)});
    if(Number(response.headers.get('content-length'))>LIMIT){await response.body?.cancel().catch(()=>{});throw Error('云端双币响应超过 4MB 上限');}
    const stream=response.body?.getReader();if(!stream)throw Error('云端双币来源没有返回数据');
    const decoder=new TextDecoder();let text='',size=0;
    try{for(;;){const part=await stream.read();if(part.done)break;size+=part.value.byteLength;if(size>LIMIT){await stream.cancel();throw Error('云端双币响应超过 4MB 上限');}text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}finally{stream.releaseLock();}
    let value;try{value=JSON.parse(text);}catch{throw Error(response.status!==200?'双币云端读取服务返回 HTTP '+response.status:'双币云端未返回有效产品数据');}
    if(response.status!==200)throw Error('双币云端读取服务返回 HTTP '+response.status+(typeof value?.reason==='string'?'：'+value.reason.slice(0,400):''));
    snapshot=validate(value,now());failure=null;return output(snapshot);
   }catch(error){snapshot=null;const value=unavailable('Binance 普通双币高卖云端报价不可用：'+String(error?.message||'读取失败'));failure={value,until:now()+10000};return value;}
  })();pending=task;try{return await task;}finally{if(pending===task)pending=null;}
 }
 return async function handle(request){
  const url=new URL(request.url),headers={'cache-control':'no-store','x-content-type-options':'nosniff'};
  if(request.method!=='GET')return Response.json(unavailable('仅允许 GET 读取公开报价'),{status:405,headers:{...headers,allow:'GET'}});
  if(url.search)return Response.json(unavailable('公开双币接口不接受查询参数'),{status:400,headers});
  const result=await load();return Response.json(result,{status:result.status==='ready'?200:503,headers});
 };
}

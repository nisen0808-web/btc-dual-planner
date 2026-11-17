/** Private execution bridge. Public quotes never enter this path. */
function createBinanceExecutionProxy({fetchImpl=(...args)=>fetch(...args)}={}){
 const actions=new Set(['status','connect','disconnect','prepare','confirm','plans','pause']);
 const reads=new Set(['status','plans']),requestLimit=8192,responseLimit=1024*1024;
 const headers={'cache-control':'no-store, private','pragma':'no-cache','x-content-type-options':'nosniff','referrer-policy':'no-referrer'};
 const disconnected={ok:true,status:'broker_not_configured',brokerConfigured:false,autoSettleReady:false,connected:false,accountVerified:false,accountFeeVerified:false,canSubmit:false,cashCanSubmit:false,buyBTCCanSubmit:false,runnerOnline:false,reconciliationRequired:false,currency:'USDT',environment:'mainnet',reason:'云端交易执行服务尚未配置；真实行情可继续查看。连接交易需要固定 IP 出口、加密密钥存储及持久执行记录。'};
 const reply=(data,status=200,extra={})=>Response.json(data,{status,headers:{...headers,...extra}});
 const fail=(code,message,status)=>reply({ok:false,error:{code,message},reason:message,canSubmit:false},status);
 function origin(value){
  try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/'||!u.hostname.includes('.')||/^(?:localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(u.hostname))return null;return u.origin;}catch{return null;}
 }
 async function bounded(stream,max){
  const reader=stream?.getReader();if(!reader)throw Error('empty');const chunks=[];let bytes=0;
  try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>max){await reader.cancel();throw Error('large');}chunks.push(part.value);}}finally{reader.releaseLock();}
  const joined=new Uint8Array(bytes);let at=0;for(const chunk of chunks){joined.set(chunk,at);at+=chunk.byteLength;}return new TextDecoder().decode(joined);
 }
 function privateResponse(value){
  if(!value||typeof value!=='object'||typeof value.ok!=='boolean')return false;
  const visit=x=>{if(!x||typeof x!=='object')return true;return Object.entries(x).every(([k,v])=>!/(?:api.?key|api.?secret|authorization|password|signature|bearer|sessiontoken|sessionhash|ciphertext|master.?key)/i.test(k)&&visit(v));};
  return visit(value);
 }
 return async function handle(request,env={}){
  const url=new URL(request.url),action=url.pathname.slice('/api/execution/'.length);
  if(!actions.has(action)||url.search)return fail('route_invalid','交易接口或参数无效。',404);
  const method=reads.has(action)?'GET':'POST';if(request.method!==method)return fail('method_invalid','该交易接口不支持此请求方式。',405);
  const siteOrigin=url.origin;
  if(request.method==='POST'&&request.headers.get('origin')!==siteOrigin)return fail('origin_invalid','交易操作必须从当前页面发起。',403);
  const endpoint=origin(env.BINANCE_EXECUTION_ORIGIN),secret=env.BINANCE_EXECUTION_SERVICE_AUTH;
  if(!endpoint||typeof secret!=='string'||!/^[A-Za-z0-9_-]{43,128}$/.test(secret)){
   if(action==='status')return reply(disconnected);
   if(action==='plans')return reply({ok:true,data:{plans:[]},brokerConfigured:false});
   return fail('broker_not_configured',disconnected.reason,503);
  }
  const cookiePairs=(request.headers.get('cookie')||'').split(';').map(x=>x.trim()).filter(x=>x.startsWith('__Host-btc_put_session='));
  if(cookiePairs.length>1||cookiePairs.some(x=>!/^__Host-btc_put_session=[A-Za-z0-9_-]{43}$/.test(x)))return fail('session_invalid','交易会话无效，请重新连接。',401);
  const csrf=request.headers.get('x-strategy-csrf');
  if(request.method==='POST'&&(!cookiePairs.length||typeof csrf!=='string'||!/^[A-Za-z0-9_-]{32,128}$/.test(csrf)))return fail('session_required','请先建立交易会话，再确认操作。',401);
  let body,received;
  if(method==='POST'){
   if(!request.headers.get('content-type')?.startsWith('application/json')||Number(request.headers.get('content-length'))>requestLimit)return fail('body_invalid','请求必须是有限长度的 JSON。',400);
   try{body=await bounded(request.body,requestLimit);received=JSON.parse(body);if(!received||typeof received!=='object'||Array.isArray(received))throw Error('invalid');}catch{return fail('body_invalid','交易请求格式无效或过大。',400);}
   const allowed={connect:['apiKey','apiSecret','tradingEnabled'],disconnect:[],prepare:['amount','symbol','buyBufferRate','settlementMode'],confirm:['id','fingerprint','account','currency','confirmed'],pause:['id']}[action];
   if(Object.keys(received).some(k=>!allowed.includes(k)))return fail('body_invalid','交易请求含不允许的字段。',400);
   if(action==='connect'&&(received.tradingEnabled!==true||!['apiKey','apiSecret'].every(k=>typeof received[k]==='string'&&received[k].length>=16&&received[k].length<=512&&!/[\u0000-\u0020\u007f]/.test(received[k]))))return fail('credentials_invalid','请使用有效的 HMAC API Key 和 Secret，并确认交易授权范围。',400);
  }
  const outgoing={accept:'application/json',authorization:'Bearer '+secret,origin:siteOrigin,'x-forwarded-proto':'https',...(cookiePairs.length?{cookie:cookiePairs[0]}:{}),...(method==='POST'?{'content-type':'application/json','x-csrf-token':csrf}:{})};
  try{
   const response=await fetchImpl(endpoint+'/v1/'+action,{method,headers:outgoing,body,credentials:'omit',cache:'no-store',redirect:'manual',signal:AbortSignal.timeout(30000)});
   if(response.status>=300&&response.status<400){await response.body?.cancel().catch(()=>{});throw Error('redirect');}
   if(!response.headers.get('content-type')?.includes('application/json')||Number(response.headers.get('content-length'))>responseLimit){await response.body?.cancel().catch(()=>{});throw Error('response');}
   const text=await bounded(response.body,responseLimit),value=JSON.parse(text);
   if(!privateResponse(value)||text.includes(secret)||action==='connect'&&[received.apiKey,received.apiSecret].some(x=>text.includes(x)))throw Error('private_response');
   const extra={},cookie=response.headers.get('set-cookie');
   if(cookie){if(/[,\r\n]/.test(cookie)||!/^__Host-btc_put_session=(?:[A-Za-z0-9_-]{43})?;/.test(cookie)||!/(?:^|;)\s*Secure(?:;|$)/i.test(cookie)||!/(?:^|;)\s*HttpOnly(?:;|$)/i.test(cookie)||!/(?:^|;)\s*SameSite=Strict(?:;|$)/i.test(cookie)||!/(?:^|;)\s*Path=\/(?:;|$)/i.test(cookie)||/(?:^|;)\s*Domain=/i.test(cookie))throw Error('cookie');extra['set-cookie']=cookie;}
   return reply(value,response.status,extra);
  }catch{
   const unknown=action==='confirm';return fail(unknown?'confirmation_unknown':'broker_unavailable',unknown?'订单结果尚未核验，请按原订单标识对账，不能重复提交。':'云端交易服务暂不可用；未启用交易，请稍后重新核验连接。',503);
  }
 };
}

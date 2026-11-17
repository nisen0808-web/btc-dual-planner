import {createBinanceReadOnlyAuth} from './binance-account-signing.js';

/** Per-Sites-user, verification-only custody. No Binance financial writes. */
export function createBinanceAccountService({fetchImpl=(...args)=>fetch(...args),now=Date.now}={}) {
 const SITE='appgprj_6ad9e0a3e8c081919d7bf6bb0fb41f53';
 const VERIFY='https://jvriieraremfzlktzpkg.supabase.co/functions/v1/account-verify';
 const PREFIX='binance/account-v1/',encoder=new TextEncoder(),limit=24576;
 const cacheHeaders={'cache-control':'private, no-store','pragma':'no-cache','vary':'cookie, oai-authenticated-user-id','x-content-type-options':'nosniff','referrer-policy':'no-referrer'};
 const routes={
  'https://api.binance.com/sapi/v1/account/apiRestrictions':'restrictions',
  'https://api.binance.com/api/v3/account':'spot',
  'https://eapi.binance.com/eapi/v1/marginAccount':'options',
  'https://eapi.binance.com/eapi/v1/commission':'optionFees',
  'https://api.binance.com/api/v3/account/commission':'spotFees',
 };
 const reply=(body,status=200)=>Response.json({...body,readOnly:true,canSubmit:false,tradingEnabled:false},{status,headers:cacheHeaders});
 const error=(code,message,status=400)=>reply({ok:false,error:{code,message}},status);
 const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
 const b64=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes)));
 const unbase64=text=>Uint8Array.from(atob(text),c=>c.charCodeAt(0));
 const b64url=bytes=>b64(bytes).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
 const pemBytes=pem=>unbase64(pem.replace(/^-----BEGIN PRIVATE KEY-----\s*/,'').replace(/\s*-----END PRIVATE KEY-----\s*$/,'').replace(/\s/g,''));
 let configPromise,configStamp;
 async function config(env) {
  const bucket=env?.BINANCE_QUOTES,master=env?.BINANCE_ACCOUNT_STORAGE_KEY,privatePem=env?.BINANCE_ACCOUNT_BRIDGE_PRIVATE_KEY;
  if(!bucket||typeof bucket.get!=='function'||typeof bucket.put!=='function'||env.BINANCE_ACCOUNT_VERIFY_URL!==VERIFY||typeof master!=='string'||!/^[A-Za-z0-9+/]{43}=$/.test(master)||typeof privatePem!=='string'||!privatePem.startsWith('-----BEGIN PRIVATE KEY-----'))return null;
  const stamp=master+'\0'+privatePem;
  if(stamp!==configStamp){configStamp=stamp;configPromise=(async()=>{
   const material=await crypto.subtle.importKey('raw',unbase64(master),'HKDF',false,['deriveKey']);
   const derive=(info,algorithm,usages)=>crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:encoder.encode(SITE),info:encoder.encode(info)},material,algorithm,false,usages);
   const encryption=await derive('account-storage-v1',{name:'AES-GCM',length:256},['encrypt','decrypt']);
   const userKey=await derive('account-owner-hash-v1',{name:'HMAC',hash:'SHA-256',length:256},['sign']);
   const bridge=await crypto.subtle.importKey('pkcs8',pemBytes(privatePem),'Ed25519',false,['sign']);
   return {encryption,userKey,bridge};
  })().catch(()=>null);}
  const keys=await configPromise;return keys?{...keys,bucket,enabled:env.BINANCE_ACCOUNT_BINDING_ENABLED==='true'}:null;
 }
 async function userHash(cfg,id) {
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',cfg.userKey,encoder.encode(SITE+'\0'+id)))).map(x=>x.toString(16).padStart(2,'0')).join('');
 }
 async function bounded(stream,max) {
  if(!stream)throw Error('empty');const reader=stream.getReader(),chunks=[];let size=0;
  try{for(;;){const p=await reader.read();if(p.done)break;size+=p.value.byteLength;if(size>max){await reader.cancel();throw Error('large');}chunks.push(p.value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.byteLength;}return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
 }
 async function readRecord(cfg,key) {
  const obj=await cfg.bucket.get(key);if(!obj)return null;
  if(typeof obj.etag!=='string'||!Number.isSafeInteger(obj.size)||obj.size>65536||typeof obj.text!=='function')throw Error('storage');
  const text=await obj.text();if(encoder.encode(text).byteLength>65536)throw Error('storage');const value=JSON.parse(text);
  if(!object(value)||value.version!==1||typeof value.bindingId!=='string'||typeof value.phase!=='string')throw Error('storage');
  return {etag:obj.etag,value};
 }
 async function putRecord(cfg,key,value,previous) {
  const text=JSON.stringify(value);if(encoder.encode(text).byteLength>65536)throw Error('storage');
  return cfg.bucket.put(key,text,{onlyIf:previous?{etagMatches:previous.etag}:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json',cacheControl:'private, no-store'}});
 }
 const aad=(hash,r)=>encoder.encode(['account-v1','storage-key-v1',SITE,hash,r.bindingId,r.keyType||'none'].join('\0'));
 async function encrypt(cfg,hash,r,payload) {
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(hash,r)},cfg.encryption,encoder.encode(JSON.stringify(payload)));
  return {version:1,keyId:'storage-key-v1',iv:b64(iv),ciphertext:b64(cipher)};
 }
 async function decrypt(cfg,hash,r) {
  const e=r.encrypted;if(!object(e)||e.version!==1||e.keyId!=='storage-key-v1'||typeof e.iv!=='string'||typeof e.ciphertext!=='string'||e.ciphertext.length>60000)throw Error('storage');
  const iv=unbase64(e.iv);if(iv.byteLength!==12)throw Error('storage');
  const bytes=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:aad(hash,r)},cfg.encryption,unbase64(e.ciphertext));
  const value=JSON.parse(new TextDecoder().decode(bytes));if(!object(value))throw Error('storage');return value;
 }
 async function signedRequest(cfg,hash,action,request,signal) {
  const body=JSON.stringify({aud:'binance-account-verify-v1',siteId:SITE,userHash:hash,issuedAt:now(),nonce:crypto.randomUUID(),action,...(request?{request}:{})});
  const signature=b64url(await crypto.subtle.sign('Ed25519',cfg.bridge,encoder.encode(body)));
  const timeout=AbortSignal.timeout(10000),requestSignal=signal?AbortSignal.any([timeout,signal]):timeout;
  requestSignal.throwIfAborted();
  const response=await fetchImpl(VERIFY,{method:'POST',credentials:'omit',redirect:'manual',cache:'no-store',headers:{'content-type':'application/json','x-account-signature':signature,'x-region':'ap-southeast-1'},body,signal:requestSignal});
  if(response.status>=300&&response.status<400||response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json'){await response.body?.cancel();throw Error('bridge');}
  const raw=await bounded(response.body,1048576),value=JSON.parse(raw);
  if(!object(value)||value.readOnly!==true||value.canSubmit!==false||value.tradingEnabled!==false)throw Error('bridge');
  return {status:response.status,value};
 }
 async function health(cfg,refresh=true) {
  if(!cfg)return false;
  // This cache contains no account identifier, API key, nonce, or credential.
  const key=PREFIX+'service-health.json',stamp=await userHash(cfg,'service-health');
  try{
   const cached=await cfg.bucket.get(key);
   if(cached&&cached.size<2048){const v=JSON.parse(await cached.text());if(v.stamp===stamp&&Number.isSafeInteger(v.at)&&v.at<=now()+2000&&now()-v.at<30000)return v.ready===true;}
   if(!refresh)return false;
   const r=await signedRequest(cfg,stamp,'health');const ready=r.status===200&&r.value.ok===true&&r.value.status==='ready';
   await cfg.bucket.put(key,JSON.stringify({stamp,at:now(),ready}),{httpMetadata:{contentType:'application/json',cacheControl:'private, no-store'}});return ready;
  }catch{return false;}
 }
 function identity(request) {
  // Sites dispatch supplies these headers after its own authentication; never
  // use body, email, an execution cookie or service-bypass token as ownership.
  const id=request.headers.get('oai-authenticated-user-id'),email=request.headers.get('oai-authenticated-user-email');
  return typeof id==='string'&&/^[A-Za-z0-9_.:@/-]{1,200}$/.test(id)&&typeof email==='string'&&email.length>2&&email.length<320?id:null;
 }
 async function session(cfg,id,configured) {
  const base={ok:true,signedIn:!!id,configured,connected:false,hasCredential:false,phase:id?'disconnected':'signed_out',signInPath:'/signin-with-chatgpt?return_to=%2F%23accountAccessTitle'};
  if(!cfg||!id)return base;const hash=await userHash(cfg,id),row=await readRecord(cfg,PREFIX+hash+'.json');if(!row)return base;
  const r=row.value;let payload=null;if(r.encrypted)payload=await decrypt(cfg,hash,r);
  const hasCredential=!!payload?.credentials,report=payload?.report||null;
  return {...base,phase:r.phase,connected:hasCredential,hasCredential,keyType:r.keyType||null,keyHint:r.keyHint||null,checkedAt:r.checkedAt||null,...(report?{report,account:report.account||null}:{})};
 }
 async function verify(cfg,hash,key,pending,credentials,signal) {
  const checks=Object.fromEntries(['restrictions','spot','options','optionFees','spotFees'].map(k=>[k,{status:'not_checked'}]));
  const isCurrent=async()=>{if(signal?.aborted)return false;const r=await readRecord(cfg,key);return !signal?.aborted&&r?.etag===pending.etag&&r.value.phase==='checking'&&r.value.bindingId===pending.value.bindingId;};
  const relay=async(url,options)=>{
   if(!await isCurrent())throw Error('superseded');
   const u=new URL(url),route=routes[u.origin+u.pathname];
   if(!route||options.method!=='GET'||options.redirect!=='manual'||u.hash)throw Error('route');
   const r=await signedRequest(cfg,hash,'relay',{route,apiKey:options.headers['X-MBX-APIKEY'],query:u.search.slice(1)},signal?AbortSignal.any([signal,options.signal]):options.signal);
   if(!await isCurrent())throw Error('superseded');
   if(r.value.ok!==true){const status=r.value.code==='upstream_refused'?451:r.status>=400?r.status:503;return Response.json({code:-90000},{status});}
   if(r.value.status===200&&object(r.value.payload))return Response.json(r.value.payload,{status:200});
   const status=Number(r.value.status);if(!Number.isInteger(status)||status<400||status>599)throw Error('bridge');
   const code=object(r.value.payload)&&Number.isInteger(r.value.payload.code)?r.value.payload.code:-90000;
   return Response.json({code},{status});
  };
  const api=createBinanceReadOnlyAuth({...credentials,fetchImpl:relay,now});let refused=false;
  const read=async(name,method)=>{
   if(!await isCurrent())throw Error('superseded');const r=await api[method]();refused ||= r.refused===true;
   checks[name]=r.ok?{status:'verified',data:r.data}:{status:'failed',code:r.code};
   if(!r.ok&&['timeout_unknown','network_unknown','request_unknown','response_unknown'].includes(r.code))throw Error('read_incomplete');
   return r;
  };
  try{
   const restriction=await read('restrictions','apiRestrictions');
   if(restriction.ok&&restriction.data.enableReading===true&&restriction.data.enableWithdrawals===false){
    const spot=await read('spot','spotAccount');
    if(spot.ok&&typeof spot.data.uid==='string'){
     const option=await read('options','optionAccount');
     if(!refused&&option.ok)await read('optionFees','optionFees');
     if(!refused)await read('spotFees','spotFees');
    }
   }
  }catch{if(!await isCurrent())throw Error('superseded');}
  const flags=checks.restrictions.data,spot=checks.spot.data;
  const accountVerified=checks.spot.status==='verified'&&typeof spot?.uid==='string';
  const saveEligible=accountVerified&&checks.restrictions.status==='verified'&&flags?.enableReading===true&&flags?.enableWithdrawals===false&&!refused;
  return {ok:true,readOnly:true,canSubmit:false,tradingEnabled:false,checkedAt:now(),accountVerified,account:accountVerified?{uid:spot.uid}:null,checks,saveEligible};
 }
 function validCredentials(c) {
  return object(c)&&['RSA','Ed25519'].includes(c.keyType)&&typeof c.apiKey==='string'&&/^[A-Za-z0-9_-]{32,256}$/.test(c.apiKey)&&typeof c.privateKeyPem==='string'&&c.privateKeyPem.length<=16384&&/^-----BEGIN PRIVATE KEY-----\s+[A-Za-z0-9+/=\s]+\s+-----END PRIVATE KEY-----\s*$/.test(c.privateKeyPem);
 }
 return async function handle(request,env={}) {
  const url=new URL(request.url),action=url.pathname.slice('/api/binance-account/'.length),id=identity(request);
  if(!['session','health','connect','recheck','disconnect'].includes(action)||url.search)return error('route_invalid','账户接口或参数无效。',404);
  if(request.method!==(['session','health'].includes(action)?'GET':'POST'))return error('method_invalid','该账户接口不支持此请求方式。',405);
  let cfg;try{cfg=await config(env);}catch{cfg=null;}
  if(action==='health')return reply({ok:true,configured:!!cfg,ready:await health(cfg,!!id),bindingEnabled:cfg?.enabled===true});
  if(action==='session'){
   try{return reply(await session(cfg,id,!!cfg&&cfg.enabled&&(!!id?await health(cfg):true)));}catch{return error('account_state_unavailable','账户状态暂不可核验，请稍后重试。',503);}
  }
  if(!id)return error('sign_in_required','请先登录本站，再绑定你本人的 Binance API。',401);
  if(request.headers.get('origin')!==url.origin||!['same-origin','none',null].includes(request.headers.get('sec-fetch-site'))||request.headers.get('x-account-request')!=='1')return error('origin_invalid','账户操作必须从当前页面发起。',403);
  if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json'||Number(request.headers.get('content-length'))>limit)return error('body_invalid','账户请求格式无效或过大。');
  let body,credentials;
  try{body=JSON.parse(await bounded(request.body,limit));if(!object(body))throw Error('body');}catch{return error('body_invalid','账户请求格式无效或过大。');}
  const allowed=action==='connect'?['apiKey','privateKeyPem','keyType','consent']:[];
  if(Object.keys(body).some(k=>!allowed.includes(k)))return error('body_invalid','账户请求包含不允许的字段。');
  if(action==='connect'){
   credentials={apiKey:body.apiKey,privateKeyPem:body.privateKeyPem,keyType:body.keyType};
   body.apiKey='';body.privateKeyPem='';
   if(body.consent!==true||!validCredentials(credentials)){credentials.apiKey='';credentials.privateKeyPem='';return error('credentials_invalid','请使用本人 RSA／Ed25519 API Key 与 PKCS8 私钥，并同意只读核验和加密保存。');}
  }
  try{
   if(!cfg||!cfg.enabled&&action!=='disconnect')return error('service_not_configured','云端账户核验尚未就绪，未保存密钥。',503);
   const hash=await userHash(cfg,id),key=PREFIX+hash+'.json';let current=await readRecord(cfg,key);
   if(action==='disconnect'){
    for(let attempt=0;attempt<3;attempt++){
     const tombstone={version:1,bindingId:crypto.randomUUID(),phase:'disconnected',createdAt:now(),checkedAt:now()};
     if(await putRecord(cfg,key,tombstone,current))return reply(await session(cfg,id,!!cfg.enabled));
     current=await readRecord(cfg,key);
    }
    return error('state_changed','账户状态正在变化，断开尚未确认，请重试。',409);
   }
   if(current?.value.phase==='checking'&&now()-current.value.createdAt<60000)return error('check_in_progress','已有账户核验正在进行，请稍候。',409);
   if(current&&now()-(current.value.lastStartedAt||0)<10000)return error('check_too_frequent','请稍候再刷新核验。',429);
   if(action==='recheck'){
    if(!current?.value.encrypted)return error('not_connected','请先绑定本人的 API。',409);
    const payload=await decrypt(cfg,hash,current.value);credentials=payload.credentials;
    if(!validCredentials(credentials))return error('not_connected','当前没有可核验的绑定，请重新连接。',409);
   }
   if(!await health(cfg))return error('service_unavailable','云端只读核验暂不可用，未发起新的账户查询。',503);
   const pendingValue={version:1,bindingId:crypto.randomUUID(),phase:'checking',createdAt:now(),lastStartedAt:now(),keyType:credentials.keyType,keyHint:'**** '+credentials.apiKey.slice(-4)};
   const written=await putRecord(cfg,key,pendingValue,current);
   if(!written||typeof written.etag!=='string')return error('state_changed','账户状态已变化，请重新核验。',409);
   const pending={etag:written.etag,value:pendingValue};let report;
   try{report=await verify(cfg,hash,key,pending,credentials,request.signal);}catch{return error('state_changed','此核验已被新的连接或断开操作取消。',409);}
   const complete={...pendingValue,phase:report.saveEligible?(Object.values(report.checks).every(v=>v.status==='verified')?'verified':'partial'):'failed',checkedAt:report.checkedAt};
   complete.encrypted=await encrypt(cfg,hash,complete,{credentials:report.saveEligible?credentials:null,report});
   if(request.signal.aborted||!await putRecord(cfg,key,complete,pending))return error('state_changed','此核验已被新的连接或断开操作取消。',409);
   return reply(await session(cfg,id,true));
  }catch{return error('verification_unavailable','账户核验未完成；没有启用交易，请查看状态后重试。',503);}
  finally{if(credentials){credentials.apiKey='';credentials.privateKeyPem='';}if(body){body.apiKey='';body.privateKeyPem='';}}
 };
}

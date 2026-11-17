import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source=await readFile(new URL('./worker/binance-execution-proxy.js',import.meta.url),'utf8');
const {createBinanceExecutionProxy}=await import('data:text/javascript;base64,'+Buffer.from(source+'\nexport {createBinanceExecutionProxy};').toString('base64'));
const SITE='https://strategy.invalid',BROKER='https://executor.invalid',SECRET='s'.repeat(43),TOKEN='t'.repeat(43),CSRF='c'.repeat(43),COOKIE='__Host-btc_put_session='+TOKEN;
const env={BINANCE_EXECUTION_ORIGIN:BROKER,BINANCE_EXECUTION_SERVICE_AUTH:SECRET};
const request=(action='status',{method= ['status','plans'].includes(action)?'GET':'POST',body={},headers={}}={})=>new Request(SITE+'/api/execution/'+action,{method,headers:{origin:SITE,...(method==='POST'?{'content-type':'application/json',cookie:COOKIE,'x-strategy-csrf':CSRF}:{}),...headers},...(method==='POST'?{body:JSON.stringify(body)}:{})});
const ready=()=>({ok:true,brokerConfigured:true,autoSettleReady:false,connected:false,accountVerified:false,canSubmit:false,csrf:CSRF,currency:'USDT',environment:'mainnet'});

test('missing or invalid fixed broker config never reads credential bodies or performs fetch',async()=>{
 const bad=[{}, {...env,BINANCE_EXECUTION_SERVICE_AUTH:''},{...env,BINANCE_EXECUTION_SERVICE_AUTH:'short'},...['http://executor.invalid','https://localhost','https://127.0.0.1','https://10.0.0.1','https://executor.invalid/path','https://user:pass@executor.invalid','https://executor.invalid/?url=x'].map(origin=>({...env,BINANCE_EXECUTION_ORIGIN:origin}))];
 for(const config of bad){const handle=createBinanceExecutionProxy({fetchImpl:()=>assert.fail('unconfigured proxy must not fetch')});const r=await handle(request(),config);assert.equal((await r.json()).brokerConfigured,false);const keyRequest={url:SITE+'/api/execution/connect',method:'POST',headers:new Headers({origin:SITE}),get body(){assert.fail('unconfigured proxy must not read keys');}};assert.equal((await handle(keyRequest,config)).status,503);}
});

test('fixed actions, source, CSRF, and exactly one host cookie are enforced before fetching',async()=>{
 const handle=createBinanceExecutionProxy({fetchImpl:()=>assert.fail('invalid request must not fetch')});
 for(const [r,status]of [[request('status',{method:'POST'}),405],[request('withdraw'),404],[request('status?token=secret'),404],[request('connect',{headers:{origin:'https://evil.invalid'}}),403],[request('connect',{headers:{cookie:''}}),401],[request('connect',{headers:{'x-strategy-csrf':''}}),401],[request('connect',{headers:{cookie:COOKIE+'; '+COOKIE}}),401],[request('connect',{headers:{cookie:'__Host-btc_put_session=short'}}),401]])assert.equal((await handle(r,env)).status,status);
});

test('valid proxy forwards one fixed POST with only private transport headers and the selected cookie',async()=>{
 let calls=0;const input={amount:'10000',symbol:'BTC-261025-79000-P',settlementMode:'cash'};
 const handle=createBinanceExecutionProxy({fetchImpl:async(url,options)=>{calls++;assert.equal(url,BROKER+'/v1/prepare');assert.equal(options.method,'POST');assert.equal(options.redirect,'manual');assert.equal(options.credentials,'omit');assert.equal(options.cache,'no-store');assert.ok(options.signal instanceof AbortSignal);assert.equal(options.body,JSON.stringify(input));assert.deepEqual(options.headers,{accept:'application/json',authorization:'Bearer '+SECRET,origin:SITE,'x-forwarded-proto':'https',cookie:COOKIE,'content-type':'application/json','x-csrf-token':CSRF});return Response.json({ok:true,data:{id:'prepared',account:'uid_101'}});}});
 const r=await handle(request('prepare',{body:input,headers:{authorization:'Bearer VISITOR_PRIVATE',cookie:'analytics=PRIVATE; '+COOKIE+'; other=PRIVATE','X-MBX-APIKEY':'PRIVATE','x-forwarded-for':'PRIVATE'}}),env);assert.equal(r.status,200);assert.equal((await r.json()).data.id,'prepared');assert.equal(calls,1);
});

test('status forwards the HTTPS proxy contract and safely returns a single secure session cookie',async()=>{
 let calls=0;const safe=COOKIE+'; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=28800';
 const handle=createBinanceExecutionProxy({fetchImpl:async(url,options)=>{calls++;assert.equal(url,BROKER+'/v1/status');assert.deepEqual(options.headers,{accept:'application/json',authorization:'Bearer '+SECRET,origin:SITE,'x-forwarded-proto':'https'});return Response.json(ready(),{headers:{'set-cookie':safe}});}});
 const r=await handle(request('status',{headers:{cookie:'analytics=not_forwarded'}}),env);assert.equal(r.status,200);assert.equal(r.headers.get('set-cookie'),safe);assert.equal((await r.json()).csrf,CSRF);assert.equal(calls,1);
});

test('response secret disclosure and unsafe or multiple cookies are rejected without forwarding',async()=>{
 const responses=[()=>Response.json({ok:true,apiSecret:'never'}),()=>Response.json({ok:true,reason:SECRET}),...[
 COOKIE+'; Path=/; HttpOnly; SameSite=Strict',COOKIE+'; Path=/; Secure; SameSite=Strict',COOKIE+'; Path=/; Secure; HttpOnly; SameSite=None',COOKIE+'; Path=/; Secure; HttpOnly; SameSite=Strict; Domain=.invalid','other=value; Path=/; Secure; HttpOnly; SameSite=Strict',COOKIE+'; Path=/; Secure; HttpOnly; SameSite=Strict, other=stolen; Secure; HttpOnly; SameSite=Strict; Path=/'
 ].map(cookie=>()=>Response.json(ready(),{headers:{'set-cookie':cookie}}))];
 for(const make of responses){let calls=0;const handle=createBinanceExecutionProxy({fetchImpl:async()=>{calls++;return make();}}),r=await handle(request(),env);assert.equal(r.status,503);assert.equal(r.headers.get('set-cookie'),null);assert.equal((await r.json()).error.code,'broker_unavailable');assert.equal(calls,1);}
});

test('redirect, non-JSON and oversized broker replies fail closed with no alternate fetch',async()=>{
 const responses=[()=>new Response(null,{status:302,headers:{location:'https://attacker.invalid'}}),()=>new Response('<html>private</html>',{headers:{'content-type':'text/html'}}),()=>new Response('{}',{headers:{'content-type':'application/json','content-length':String(1024*1024+1)}}),()=>new Response('x'.repeat(1024*1024+1),{headers:{'content-type':'application/json'}})];
 for(const make of responses){let calls=0;const handle=createBinanceExecutionProxy({fetchImpl:async()=>{calls++;return make();}});assert.equal((await handle(request(),env)).status,503);assert.equal(calls,1);}
});

test('unknown confirmation cannot retry on timeout or redirect and keeps the reconciliation message',async()=>{
 for(const fail of [()=>{throw new DOMException('timeout','TimeoutError');},()=>new Response(null,{status:307,headers:{location:BROKER+'/v1/confirm'}})]){let calls=0;const handle=createBinanceExecutionProxy({fetchImpl:async()=>{calls++;return fail();}}),r=await handle(request('confirm',{body:{id:'i',fingerprint:'f',account:'uid_101',currency:'USDT',confirmed:true}}),env),body=await r.json();assert.equal(r.status,503);assert.equal(body.error.code,'confirmation_unknown');assert.match(body.error.message,/不能重复提交/);assert.equal(body.canSubmit,false);assert.equal(calls,1);}
});

test('connect only calls one fake broker HTTP endpoint and never exposes or echoes submitted keys',async()=>{
 const keys={apiKey:'public_key_12345678',apiSecret:'secret_key_12345678',tradingEnabled:true};
 let calls=0;const handle=createBinanceExecutionProxy({fetchImpl:async(url,options)=>{calls++;assert.equal(url,BROKER+'/v1/connect');assert.deepEqual(JSON.parse(options.body),keys);return Response.json({...ready(),connected:true,accountVerified:true,canSubmit:false});}});
 const r=await handle(request('connect',{body:keys}),env);assert.equal(r.status,200);const text=await r.text();assert.equal(text.includes(keys.apiKey),false);assert.equal(text.includes(keys.apiSecret),false);assert.equal(calls,1);
 const echo=createBinanceExecutionProxy({fetchImpl:async()=>Response.json({ok:true,reason:keys.apiSecret})});assert.equal((await echo(request('connect',{body:keys}),env)).status,503);
});

test('unsupported body fields and excessive credential payloads never enter private transport',async()=>{
 const handle=createBinanceExecutionProxy({fetchImpl:()=>assert.fail('invalid body must not fetch')});
 for(const r of [request('prepare',{body:{amount:'100',url:'https://evil.invalid'}}),request('connect',{body:{apiKey:'a'.repeat(16),apiSecret:'b'.repeat(16),tradingEnabled:false}}),request('connect',{body:{apiKey:'a'.repeat(9000),apiSecret:'b'.repeat(16),tradingEnabled:true}})])assert.equal((await handle(r,env)).status,400);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createBinanceLocalExecutionHttp} from './execution/binance-local-http.mjs';
const SITE='https://btc-dual-planner-oct22.phyrex-ni.chatgpt.site';
async function fixture(service=null,publicReader){
  const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  let time=Date.now(),configured=0;
  const gateway=createBinanceLocalExecutionHttp({port,serviceProvider:()=>service,configure:async()=>{configured++;return {configured:true};},publicReader,now:()=>time,setupTemplate:'<script nonce="__NONCE__">const origin="__SITE_ORIGIN__";</script>'});
  await new Promise(r=>gateway.server.listen(port,'127.0.0.1',r));const origin=gateway.localOrigin;
  const setup=await fetch(origin+'/setup'),html=await setup.text(),nonce=html.match(/nonce="([^"]+)"/)[1];
  const localHeaders={Origin:origin,'X-Local-CSRF':nonce,'Content-Type':'application/json'};
  const call=(path,options={})=>fetch(origin+path,options);
  const pair=async()=>{const r=await call('/local/pair',{method:'POST',headers:localHeaders,body:'{}'});assert.equal(r.status,200);return r.json();};
  const remoteHeaders=token=>({Origin:SITE,Authorization:'Bearer '+token,'X-Strategy-Local':'binance-v1','Content-Type':'application/json'});
  return {call,pair,origin,nonce,localHeaders,remoteHeaders,setup,time:t=>time=t,get now(){return time;},get configured(){return configured;},close:()=>new Promise(r=>gateway.server.close(r))};
}
test('loopback health is public but forged origins, hosts and unpaired execution cannot access private actions',async()=>{
  const f=await fixture();try{
    assert.equal((await (await f.call('/health')).json()).service,'binance-local-execution');
    assert.equal((await f.call('/v1/status',{headers:{Origin:SITE,'X-Strategy-Local':'binance-v1'}})).status,403);
    assert.equal((await f.call('/local/pair',{method:'POST',headers:{Origin:SITE,'Content-Type':'application/json'},body:'{}'})).status,403);
    const spoofed=await new Promise((resolve,reject)=>{const req=http.get(f.origin+'/setup',{headers:{Host:'evil.invalid'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});assert.equal(spoofed,403);
    assert.equal(f.setup.headers.get('x-frame-options'),'DENY');assert.match(f.setup.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  }finally{await f.close();}
});
test('local authorization creates an origin-bound short session and never promotes an unconfigured account',async()=>{
  const f=await fixture();try{
    const p=await f.pair();assert.match(p.token,/^[A-Za-z0-9_-]{43}$/);assert.equal(p.expiresAt-f.now,28800000);
    const response=await f.call('/v1/status',{headers:f.remoteHeaders(p.token)}),data=await response.json();assert.equal(data.canSubmit,false);assert.equal(data.accountVerified,false);assert.equal(response.headers.get('access-control-allow-origin'),SITE);assert.equal(response.headers.has('access-control-allow-credentials'),false);
    assert.equal((await f.call('/v1/status',{headers:{...f.remoteHeaders(p.token),Origin:'https://evil.invalid'}})).status,403);
    assert.equal((await f.call('/v1/withdraw',{method:'POST',headers:f.remoteHeaders(p.token),body:'{}'})).status,404);
    f.time(f.now+900000);assert.equal((await f.call('/v1/status',{headers:f.remoteHeaders(p.token)})).status,401);
  }finally{await f.close();}
});
test('only localhost CSRF-protected configuration accepts credentials and revokes prior sessions',async()=>{
  const f=await fixture();try{
    const p=await f.pair(),input=JSON.stringify({apiKey:'mockClientOnly',apiSecret:'mockSecretOnly',environment:'mainnet',tradingEnabled:false});
    assert.equal((await f.call('/local/configure',{method:'POST',headers:f.remoteHeaders(p.token),body:input})).status,403);
    const response=await f.call('/local/configure',{method:'POST',headers:f.localHeaders,body:input});assert.equal(response.status,200);assert.deepEqual(await response.json(),{configured:true});assert.equal(f.configured,1);
    assert.equal((await f.call('/v1/status',{headers:f.remoteHeaders(p.token)})).status,401);
  }finally{await f.close();}
});
test('preflight only allows the paired Site, fixed methods and explicit headers',async()=>{
  const f=await fixture();try{
    const headers={Origin:SITE,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,content-type,x-strategy-local','Access-Control-Request-Private-Network':'true'};
    const ok=await f.call('/v1/confirm',{method:'OPTIONS',headers});assert.equal(ok.status,204);assert.equal(ok.headers.get('access-control-allow-private-network'),'true');
    const bad=await f.call('/v1/confirm',{method:'OPTIONS',headers:{...headers,'Access-Control-Request-Headers':'cookie,x-private-key'}});assert.equal(bad.status,403);
    const evil=await f.call('/v1/confirm',{method:'OPTIONS',headers:{...headers,Origin:'https://evil.invalid'}});assert.equal(evil.status,403);assert.equal(evil.headers.has('access-control-allow-origin'),false);
  }finally{await f.close();}
});
test('same-origin remote confirmation invokes only its fixed service action and errors stay generic',async()=>{
  let calls=0;const f=await fixture({confirm:async input=>{calls++;assert.deepEqual(input,{id:'test-intent',confirmed:true});throw Error('never-expose-private-response');}});
  try{const p=await f.pair();const r=await f.call('/v1/confirm',{method:'POST',headers:f.remoteHeaders(p.token),body:JSON.stringify({id:'test-intent',confirmed:true})});assert.equal(r.status,409);assert.doesNotMatch(await r.text(),/never-expose/);assert.equal(calls,1);}finally{await f.close();}
});

test('anonymous public fallback only reads fixed BTC option market routes for the trusted Site',async()=>{
  const reads=[],f=await fixture(null,async(action,symbol)=>{reads.push({action,symbol});return {status:'ready',data:'public-only'};});
  try{
    const market=await f.call('/public/binance-options/market',{headers:{Origin:SITE}});assert.equal(market.status,200);assert.equal((await market.json()).data,'public-only');
    assert.equal(market.headers.get('access-control-allow-origin'),SITE);assert.equal(market.headers.has('access-control-allow-credentials'),false);
    assert.equal((await f.call('/public/binance-options/book?symbol=BTC-261026-79000-P',{headers:{Origin:SITE}})).status,200);
    assert.deepEqual(reads,[{action:'market',symbol:null},{action:'book',symbol:'BTC-261026-79000-P'}]);
    for(const path of ['/public/binance-options/book?symbol=BTC-261026-79000-C','/public/binance-options/book?symbol=BTC-261026-79000-P&symbol=x','/public/binance-options/market?url=https://evil.invalid','/public/binance-options/account'])assert.equal((await f.call(path,{headers:{Origin:SITE}})).status,400);
    assert.equal((await f.call('/public/binance-options/market',{headers:{Origin:'https://evil.invalid'}})).status,403);
    assert.equal((await f.call('/public/binance-options/market')).status,403);
    assert.equal((await f.call('/public/binance-options/market',{method:'POST',headers:{Origin:SITE}})).status,405);
    assert.equal(reads.length,2);assert.equal(f.configured,0);
  }finally{await f.close();}
});

test('public preflight cannot authorize private headers or a write',async()=>{
  const f=await fixture(null,async()=>({}));try{
    const headers={Origin:SITE,'Access-Control-Request-Method':'GET','Access-Control-Request-Private-Network':'true'};
    const allowed=await f.call('/public/binance-options/market',{method:'OPTIONS',headers});assert.equal(allowed.status,204);assert.equal(allowed.headers.get('access-control-allow-private-network'),'true');
    assert.equal((await f.call('/public/binance-options/market',{method:'OPTIONS',headers:{...headers,'Access-Control-Request-Method':'POST'}})).status,403);
    assert.equal((await f.call('/public/binance-options/market',{method:'OPTIONS',headers:{...headers,'Access-Control-Request-Headers':'authorization'}})).status,403);
  }finally{await f.close();}
});

test('Binance config rejects false test environments, old exchange fields and hidden secret additions',async()=>{
  const f=await fixture();try{
    const config={apiKey:'synthetic-api-key',apiSecret:'synthetic-secret',environment:'mainnet',tradingEnabled:false};
    for(const change of [{environment:'testnet'},{clientId:'otherExchange'},{apiSecret:'invalid\nsecret'},{tradingEnabled:'true'},{apiSecret:'x'}]){
      const response=await f.call('/local/configure',{method:'POST',headers:f.localHeaders,body:JSON.stringify({...config,...change})});assert.equal(response.status,400);
    }
    assert.equal(f.configured,0);
  }finally{await f.close();}
});

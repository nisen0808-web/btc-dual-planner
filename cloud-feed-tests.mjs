import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {request as httpRequest} from 'node:http';

execFileSync(process.execPath,['scripts/build-cloud-feed.mjs'],{cwd:import.meta.dirname});
const {createQuoteService}=await import('./dist-cloud/binance-cloud-feed.mjs');
const token='test-read-token',symbol='BTC-261030-79000-P';
const quote={status:'ready',time:123,receivedAt:456,serverTime:100,fetchedAt:200};
async function open(t,config={}){
 const server=createQuoteService({token,optionsReader:{loadMarket:async()=>quote,loadBook:async()=>quote},dualReader:async()=>quote,...config});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 return (path,options={})=>new Promise((resolve,reject)=>{
  const req=httpRequest({hostname:'127.0.0.1',port:server.address().port,path,method:options.method||'GET',headers:{authorization:'Bearer '+token,...options.headers}},res=>{
   let body='';res.on('data',part=>body+=part);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:body?JSON.parse(body):null}));
  });req.on('error',reject);req.end();
 });
}
test('build embeds both current readers verbatim and requires a token',async()=>{
 const artifact=await readFile(new URL('./dist-cloud/binance-cloud-feed.mjs',import.meta.url),'utf8');
 for(const path of ['worker/binance.js','worker/binance-options.js'])assert.ok(artifact.includes(await readFile(new URL('./'+path,import.meta.url),'utf8')));
 assert.throws(()=>createQuoteService({token:''}),/QUOTE_READ_TOKEN/);
});
test('health is anonymous, quotes require exact bearer token and retain timestamps',async t=>{
 const get=await open(t);
 const health=await get('/health',{headers:{authorization:''}});
 assert.equal(health.status,200);assert.deepEqual(health.body,{serviceReady:true});
 for(const authorization of ['', 'Bearer wrong','Basic '+token])assert.equal((await get('/market',{headers:{authorization}})).status,401);
 for(const path of ['/market','/book?symbol='+symbol,'/dual']){
  const res=await get(path);assert.equal(res.status,200);assert.deepEqual(res.body,quote);assert.equal(res.headers['cache-control'],'no-store');
 }
});
test('fixed routes, strict queries, GET only, no credentials or forwarding',async t=>{
 const calls=[];
 const get=await open(t,{dualReader:async value=>{calls.push(value);return quote;},optionsReader:{loadMarket:async(...args)=>{calls.push(args);return quote;},loadBook:async(...args)=>{calls.push(args);return quote;}}});
 for(const path of ['/market?url=https://example.org','/dual?apiKey=secret','/health?x=1','/book','/book?symbol='+symbol+'&symbol='+symbol,'/book?symbol=ETH-261030-1000-P','//example.org/market','/x/../market'])assert.equal((await get(path)).status,400,path);
 assert.equal((await get('/account')).status,404);
 assert.equal((await get('/market',{method:'POST'})).status,405);
 for(const name of ['cookie','x-mbx-apikey','x-api-key','proxy-authorization'])assert.equal((await get('/dual',{headers:{[name]:'private'}})).status,400);
 await get('/dual',{headers:{'x-forwarded-host':'example.org'}});await get('/market');await get('/book?symbol='+symbol);
 assert.deepEqual(calls,[{},[],[symbol]]);
});
test('HTTP 403 stops its source without retries and leaves the other source available',async t=>{
 let calls=0;
 const get=await open(t,{optionsReader:{loadMarket:async()=>{calls++;throw Error('Binance official API HTTP 403');},loadBook:async()=>{calls++;return quote;}}});
 assert.equal((await get('/market')).status,503);
 assert.equal((await get('/book?symbol='+symbol)).body.upstreamStatus,403);
 assert.equal((await get('/dual')).status,200);assert.equal(calls,1);
 assert.deepEqual((await get('/health')).body,{serviceReady:true});
});
test('unavailable dual data and oversized responses are rejected',async t=>{
 const get=await open(t,{dualReader:async()=>({status:'unavailable',reason:'HTTP 403'}),optionsReader:{loadMarket:async()=>({...quote,large:'x'.repeat(4*1024*1024+1)})}});
 assert.equal((await get('/market')).status,503);
 const failure=await get('/dual');assert.equal(failure.status,503);assert.equal(failure.body.upstreamStatus,403);
});
test('418, 429 and 451 stop only the affected source and preserve status',async t=>{
 for(const status of [418,429,451]){
  let calls=0;
  const get=await open(t,{dualReader:async()=>{calls++;return {status:'unavailable',httpStatus:status};}});
  assert.equal((await get('/dual')).body.upstreamStatus,status);
  assert.equal((await get('/dual')).status,503);assert.equal(calls,1);
  assert.equal((await get('/market')).status,200);
 }
});
test('actual anonymous dual reader preserves redacted upstream rate-limit status and sends no Binance key',async t=>{
 const previousFetch=globalThis.fetch;let calls=0;
 globalThis.fetch=async(url,options)=>{
  calls++;assert.ok(String(url).startsWith('https://www.binance.com/bapi/earn/'));
  assert.equal(options.method,'GET');assert.equal(options.headers['X-MBX-APIKEY'],undefined);
  return new Response('',{status:429});
 };
 t.after(()=>{globalThis.fetch=previousFetch;});
 const get=await open(t,{dualReader:undefined});
 assert.equal((await get('/dual')).body.upstreamStatus,429);
 assert.equal((await get('/dual')).status,503);assert.equal(calls,1);
 assert.equal((await get('/market')).status,200);
});
test('concurrency is bounded while health stays available',async t=>{
 let release;const pending=new Promise(resolve=>release=resolve);let active=0;
 const get=await open(t,{optionsReader:{loadMarket:async()=>{active++;await pending;return quote;}}});
 const requests=Array.from({length:4},()=>get('/market'));
 while(active<4)await new Promise(resolve=>setImmediate(resolve));
 assert.equal((await get('/market')).status,503);assert.equal((await get('/health')).status,200);
 release();for(const response of await Promise.all(requests))assert.equal(response.status,200);
});

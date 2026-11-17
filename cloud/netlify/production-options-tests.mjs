import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
const source=await readFile(new URL('./netlify/edge-functions/options.js',import.meta.url),'utf8');
const {createOptionsProductionReader}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const NOW=Date.UTC(2026,9,24,1),EXP=Date.UTC(2026,9,25,8),ROOT='https://eapi.binance.com/eapi/v1/';
const symbol=i=>'BTC-261025-'+(79000+i)+'-P';
const contract=i=>({symbol:symbol(i),side:'PUT',strikePrice:String(79000+i),expiryDate:EXP,underlying:'BTCUSDT',quoteAsset:'USDT',status:'TRADING',unit:1,contractType:'CRYPTO_OPTIONS',underlyingType:'CRYPTO',nakedSell:true,filters:[{filterType:'LOT_SIZE',stepSize:'0.01',minQty:'0.01',maxQty:'100'},{filterType:'PRICE_FILTER',tickSize:'1'}]});
const specs=(time=NOW,count=40)=>({serverTime:time,optionContracts:[{baseAsset:'BTC',quoteAsset:'USDT',underlying:'BTCUSDT',settleAsset:'USDT'}],optionSymbols:Array.from({length:count},(_,i)=>contract(i))});
const book=(time=NOW)=>({T:time,lastUpdateId:17,bids:[['100','0.05'],['95','0.3']],asks:[['105','1']]});
const response=(url,time=NOW)=>Response.json(url.endsWith('exchangeInfo')?specs(time):url.includes('/index?')?{indexPrice:'80000',time}:book(time));
const request=(path='/options/market',init={})=>new Request('https://feed.example'+path,init);

test('market reads metadata/index serially, preserves all normalized contracts/times and refreshes after 3 seconds',async()=>{
 let clock=NOW,active=0,max=0;const calls=[];
 const handle=createOptionsProductionReader({now:()=>clock,fetchImpl:async(url,options)=>{calls.push({url,options});active++;max=Math.max(max,active);await Promise.resolve();active--;return response(url,clock);}});
 const [a,b]=await Promise.all([handle(request('/options/market',{headers:{cookie:'PRIVATE',authorization:'Bearer PRIVATE'}}),{server:{region:'actual-test'},ip:'PRIVATE'}),handle(request())]);
 assert.equal(a.status,200);assert.equal(b.status,200);assert.equal(max,1);assert.deepEqual(calls.map(x=>x.url),[ROOT+'exchangeInfo',ROOT+'index?underlying=BTCUSDT']);
 const value=await a.json();assert.equal(value.contracts.length,40);assert.equal(value.metadataTime,NOW);assert.equal(value.indexTime,NOW);assert.equal(value.serverRegion,'actual-test');assert.equal(value.contracts[0].accountFeeVerified,false);assert.equal(value.contracts[0].unit,1);assert.equal(value.contracts[0].taker,.00024);
 for(const {options} of calls){assert.equal(options.method,'GET');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'manual');assert.deepEqual(options.headers,{accept:'application/json'});}
 assert.doesNotMatch(JSON.stringify(value),/PRIVATE|cookie|stack/);clock+=2999;await handle(request());assert.equal(calls.length,2);clock++;await handle(request());assert.equal(calls.length,4);
});
test('book is exact, listed and coalesced; no auto-selection or substituted strike',async()=>{
 const calls=[],handle=createOptionsProductionReader({now:()=>NOW,fetchImpl:async url=>{calls.push(url);return response(url);}});
 const path='/options/book?symbol='+symbol(7);
 const [a,b]=await Promise.all([handle(request(path)),handle(request(path))]);assert.equal(a.status,200);assert.equal(b.status,200);
 assert.deepEqual(calls,[ROOT+'exchangeInfo',ROOT+'index?underlying=BTCUSDT',ROOT+'depth?symbol='+symbol(7)+'&limit=1000']);
 const value=await a.json();assert.equal(value.symbol,symbol(7));assert.equal(value.time,NOW);assert.equal(value.depthLimit,1000);assert.equal(value.bids[1].qty,.3);
 const missing=await handle(request('/options/book?symbol=BTC-261025-88000-P'));assert.equal(missing.status,422);assert.equal(calls.length,3);
});
test('403/451 at metadata or index latch the instance and stop later reads',async()=>{
 for(const status of [403,451])for(const phase of ['exchangeInfo','index']){
  const calls=[],handle=createOptionsProductionReader({now:()=>NOW,fetchImpl:async url=>{calls.push(url);return url.includes(phase)?new Response('<html>PRIVATE</html>',{status}):response(url);}});
  const a=await handle(request()),value=await a.json();assert.equal(a.status,503);assert.equal(value.upstreamStatus,status);assert.equal(value.sourceStopped,true);assert.equal(value.contracts,undefined);assert.doesNotMatch(JSON.stringify(value),/PRIVATE|<html>|stack/);
  assert.equal((await handle(request('/options/book?symbol='+symbol(0)))).status,503);assert.equal(calls.length,phase==='exchangeInfo'?1:2);
 }
});
test('health and invalid methods, query and symbols perform zero source reads',async()=>{
 let calls=0;const handle=createOptionsProductionReader({fetchImpl:async()=>{calls++;throw Error('Unexpected');}});
 assert.deepEqual(await (await handle(request('/edge-health'),{server:{region:'test'},geo:{ip:'PRIVATE'}})).json(),{serviceReady:true,readOnly:true,serverRegion:'test'});
 for(const [path,init,status] of [['/options/market?symbol='+symbol(0),{},400],['/options/book?symbol='+symbol(0)+'&symbol='+symbol(1),{},400],['/options/book?symbol=BTC-261025-79000-C',{},400],['/options/book?url=https://private.example',{},400],['/options/market',{method:'POST'},405],['/options/market',{method:'HEAD'},405],['/edge-verify',{},404]])assert.equal((await handle(request(path,init))).status,status);
 assert.equal(calls,0);assert.deepEqual(await readdir(new URL('./netlify/edge-functions/',import.meta.url)),['options.js']);
});
test('ordinary failure has ten-second cooldown and successful reads may resume normally',async()=>{
 let clock=NOW,calls=0,down=true;const handle=createOptionsProductionReader({now:()=>clock,fetchImpl:async url=>{calls++;return down?new Response('No',{status:500}):response(url,clock);}});
 assert.equal((await handle(request())).status,503);clock+=9999;down=false;assert.equal((await handle(request())).status,503);assert.equal(calls,1);
 clock++;assert.equal((await handle(request())).status,200);assert.equal(calls,3);
});
test('malformed/old source time and old book T never become current-time quotes',async()=>{
 for(const invalid of [url=>url.endsWith('exchangeInfo')?Response.json({...specs(),serverTime:NOW-30000}):response(url),url=>url.includes('/index?')?Response.json({indexPrice:'80000',time:NOW+2001}):response(url),url=>url.includes('/depth?')?Response.json({...book(),T:NOW-30000}):response(url),url=>url.includes('/depth?')?Response.json({...book(),asks:[['99','1']]}):response(url)]){
  const handle=createOptionsProductionReader({now:()=>NOW,fetchImpl:async url=>invalid(url)}),result=await handle(request('/options/book?symbol='+symbol(0))),value=await result.json();assert.equal(result.status,503);assert.equal(value.time,0);assert.equal(value.bids,undefined);
 }
});
test('four-megabyte body and fifteen-second total deadline fail closed',async()=>{
 const large=createOptionsProductionReader({now:()=>NOW,fetchImpl:async()=>new Response('x'.repeat(4*1024*1024+1))});
 assert.equal((await (await large(request())).json()).code,'response_too_large');
 let clock=NOW,calls=0;const timed=createOptionsProductionReader({now:()=>clock,fetchImpl:async url=>{calls++;clock+=15001;return response(url);}});
 const value=await (await timed(request())).json();assert.equal(value.code,'source_timeout');assert.equal(calls,1);
});
test('pending books are limited to eight and completed book cache evicts beyond 32 symbols',async()=>{
 let release;const gate=new Promise(resolve=>{release=resolve;}),depthCalls=[];
 const handle=createOptionsProductionReader({now:()=>NOW,fetchImpl:async url=>{if(url.includes('/depth?')){depthCalls.push(url);await gate;}return response(url);}});
 await handle(request());
 const jobs=Array.from({length:8},(_,i)=>handle(request('/options/book?symbol='+symbol(i))));
 await new Promise(resolve=>setImmediate(resolve));
 const ninth=await handle(request('/options/book?symbol='+symbol(8)));assert.equal(ninth.status,503);assert.equal((await ninth.json()).code,'busy');assert.equal(depthCalls.length,8);
 release();for(const result of await Promise.all(jobs))assert.equal(result.status,200);
 for(let i=8;i<34;i++)assert.equal((await handle(request('/options/book?symbol='+symbol(i)))).status,200);
 const before=depthCalls.length;await handle(request('/options/book?symbol='+symbol(0)));assert.equal(depthCalls.length,before+1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {loadBinanceCatalogue,compareBinanceDual} from './web/binance-dual.js';

const built=spawnSync(process.execPath,['scripts/build-netlify-dual-feed.mjs'],{cwd:fileURLToPath(new URL('.',import.meta.url)),encoding:'utf8'});
assert.equal(built.status,0,built.stderr||built.stdout);
const {createAnonymousDualHandler}=await import('./dist-netlify-dual/netlify/functions/dual.mjs');
const source='https://www.binance.com/bapi/earn/v5/friendly/pos/dc/project/list?investmentAsset=USDT&targetAsset=BTC&projectType=DOWN&sortType=APY_DESC&pageSize=100';
const request=(path='/dual',options={})=>new Request('https://public-feed.example'+path,options);
const row=(id,time,patch={})=>({id:String(id),type:'DOWN',investmentAsset:'USDT',targetAsset:'BTC',underlying:'BTC',strikePrice:String(79000+Number(id)),apr:'0.12',duration:7,settleTime:time+7*86400000,minDepositAmount:'10',maxDepositAmount:'1000000',canPurchase:true,...patch});
const page=(rows,total,time,pad='')=>Response.json({code:'000000',data:{total,list:rows},unexpectedPrivateField:pad},{headers:{date:new Date(time).toUTCString()}});

test('generated package embeds the complete ordinary reader and only public dual routes',async()=>{
 const generated=await readFile(new URL('./dist-netlify-dual/netlify/functions/dual.mjs',import.meta.url),'utf8');
 const original=await readFile(new URL('./worker/binance.js',import.meta.url),'utf8');
 assert.ok(generated.includes(original.replace('export function createBinanceReader()','function createBinanceReader()')));
 assert.match(generated,/await read\(\{\}\)/);
 assert.doesNotMatch(generated,/createBinanceOptionsReader|eapi\/v1|process\.env|QUOTE_READ_TOKEN/);
 const config=await readFile(new URL('./dist-netlify-dual/netlify.toml',import.meta.url),'utf8');
 assert.match(config,/command = "node --check netlify\/functions\/dual\.mjs"/);
 assert.match(config,/\[functions\]\s+directory = "netlify\/functions"/);
 assert.doesNotMatch(config,/\bregion\b|\btoken\b|\bpaid\b/i);
 assert.equal(spawnSync(process.execPath,['--check','dist-netlify-dual/netlify/functions/dual.mjs'],{cwd:fileURLToPath(new URL('.',import.meta.url))}).status,0);
});

test('all 101 products survive pagination/coalescing and parse in the current browser comparison',async t=>{
 const time=Date.now(),raw=Array.from({length:101},(_,i)=>row(i,time));let calls=0,release;
 const gate=new Promise(resolve=>{release=resolve;});
 const handler=createAnonymousDualHandler({now:()=>time,fetchImpl:async(url,options)=>{
  calls++;assert.equal(url,source+'&pageIndex='+calls);
  assert.equal(options.method,'GET');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'manual');
  const sent=new Headers(options.headers);
  for(const name of ['cookie','authorization','x-mbx-apikey','x-api-key','x-untrusted'])assert.equal(sent.has(name),false);
  if(calls===1)await gate;
  return page(calls===1?raw.slice(0,100):raw.slice(100),101,time,'DO_NOT_LEAK');
 }});
 const first=handler(request('/dual',{headers:{cookie:'DO_NOT_FORWARD',authorization:'Bearer DO_NOT_FORWARD','x-untrusted':'DO_NOT_FORWARD'}}));
 const second=handler(request());release();
 const [a,b]=await Promise.all([first,second]);assert.equal(calls,2);assert.equal(a.status,200);assert.equal(b.status,200);
 assert.equal(a.headers.get('access-control-allow-origin'),'*');
 const payload=await a.json();
 assert.equal(payload.items.length,101);assert.equal(payload.total,101);assert.equal(payload.pageCount,2);
 assert.equal(payload.sourceType,'public_web');assert.equal(payload.source,source);
 assert.equal(payload.serverTime,Math.floor(time/1000)*1000);assert.equal(payload.fetchedAt,time);
 assert.deepEqual(payload.eligibility,{precisionKnown:false,purchaseWindowKnown:false,accountEligibilityVerified:false,missingFields:['purchaseDecimal','purchaseEndTime']});
 assert.doesNotMatch(JSON.stringify(payload),/DO_NOT_|unexpectedPrivateField/);
 await handler(request());assert.equal(calls,2,'reader cache avoids refetching the same fresh product pages');
 t.mock.method(globalThis,'fetch',async(url)=>{
  assert.equal(url,'/api/binance-dual');
  return Response.json(payload,{headers:{date:new Date(time).toUTCString()}});
 });
 const catalogue=await loadBinanceCatalogue('USDT',[{symbol:'BTC-261031-79000-P',strike:79000,expires:raw[0].settleTime}]);
 assert.equal(catalogue.source.status,'ready');assert.equal(catalogue.entries.length,1);
 const compared=compareBinanceDual(10000,{valid:true,netIncome:30,strike:79000,expires:raw[0].settleTime,settleCoin:'USDT',days:7},catalogue.entries[0].data);
 assert.equal(compared.valid,true);assert.equal(compared.apr,0.12);assert.equal(compared.income,23);assert.equal(compared.difference,7);
});

test('health, methods, paths and query rejection never invoke the source',async()=>{
 let calls=0;const handler=createAnonymousDualHandler({fetchImpl:async()=>{calls++;throw Error('Unexpected network');}});
 assert.deepEqual(await (await handler(request('/health'))).json(),{serviceReady:true,readOnly:true});
 for(const [path,options,status] of [
  ['/dual?symbol=BTC',{},400],['/dual?url=https://untrusted.example',{},400],['/health?key=anything',{},400],
  ['/market',{},404],['/book',{},404],['/dual',{method:'POST',body:'{}'},405],['/dual',{method:'HEAD'},405],['/dual',{method:'OPTIONS'},405]
 ])assert.equal((await handler(request(path,options))).status,status);
 assert.equal(calls,0);
});

test('403 and 451 lock only the fixed source for the current instance without retrying',async()=>{
 for(const status of [403,451]){
  let calls=0;const handler=createAnonymousDualHandler({fetchImpl:async()=>{calls++;return new Response('Denied',{status});}});
  const first=await handler(request()),second=await handler(request());
  assert.equal(first.status,503);assert.equal(second.status,503);assert.equal(calls,1);
  const value=await second.json();assert.equal(value.upstreamStatus,status);assert.equal(value.sourceStopped,true);assert.equal(value.items,undefined);
  assert.equal((await handler(request('/health'))).status,200);assert.equal(calls,1);
 }
});

test('stale/future source dates, incomplete pagination and aggregate 4MB bodies fail closed',async()=>{
 const time=Date.now();
 for(const date of [time-31000,time+4000]){
  const handler=createAnonymousDualHandler({now:()=>time,fetchImpl:async()=>page([row(0,time)],1,date)});
  const response=await handler(request());assert.equal(response.status,503);
  const value=await response.json();assert.equal(value.items,undefined);assert.match(value.reason,/30 秒/);
 }
 const incomplete=createAnonymousDualHandler({now:()=>time,fetchImpl:async()=>page([row(0,time)],101,time)});
 const incompleteResponse=await incomplete(request());assert.equal(incompleteResponse.status,503);assert.equal((await incompleteResponse.json()).items,undefined);
 let calls=0;const padded=createAnonymousDualHandler({now:()=>time,fetchImpl:async()=>{
  const start=calls++*100;
  return page(Array.from({length:100},(_,i)=>row(start+i,time)),200,time,'x'.repeat(2200000));
 }});
 const tooLarge=await padded(request());assert.equal(tooLarge.status,503);assert.equal(calls,2);
 const value=await tooLarge.json();assert.equal(value.items,undefined);assert.match(value.reason,/4MB/);
});

test('one pagination-consistency restart discards the failed batch and preserves every new source time',async()=>{
 for(const issue of ['total','duplicate','incomplete']){
  const start=Math.floor(Date.now()/1000)*1000;let clock=start;const calls=[],signals=[];
  const handler=createAnonymousDualHandler({now:()=>clock,fetchImpl:async(url,options)=>{
   const index=calls.length;calls.push(url);signals.push(options.signal);
   if(index===1||index===3)clock+=1000;
   const secondBatch=index>=2,isFirstPage=index%2===0,offset=secondBatch?1000:0;
   if(isFirstPage)return page(Array.from({length:100},(_,i)=>row(offset+i,clock)),101,clock);
   if(!secondBatch&&issue==='total')return page([row(100,clock)],102,clock);
   if(!secondBatch&&issue==='duplicate')return page([row(0,clock)],101,clock);
   if(!secondBatch&&issue==='incomplete')return page([],101,clock);
   return page([row(1100,clock)],101,clock);
  }});
  const response=await handler(request()),value=await response.json();assert.equal(response.status,200,issue);
  assert.deepEqual(calls.map(url=>Number(new URL(url).searchParams.get('pageIndex'))),[1,2,1,2]);
  assert.ok(calls.every(url=>url.startsWith(source+'&pageIndex=')));assert.ok(signals.every(signal=>signal===signals[0]));
  assert.equal(value.serverTime,start+1000);assert.equal(value.lastServerTime,start+2000);assert.equal(value.fetchedAt,start+1000);assert.equal(value.completedAt,start+2000);
  assert.equal(value.total,101);assert.equal(value.pageCount,2);assert.equal(value.items.length,101);
  assert.equal(new Set(value.items.map(item=>item.id)).size,101);assert.ok(value.items.every(item=>Number(item.id)>=1000));
 }
});

test('a second fresh walk reports partial coverage instead of discarding individually verified products',async()=>{
 const time=Date.now(),calls=[];
 const handler=createAnonymousDualHandler({now:()=>time,fetchImpl:async url=>{
  calls.push(url);const first=new URL(url).searchParams.get('pageIndex')==='1';
  return page(first?Array.from({length:100},(_,i)=>row(i,time)):[row(100,time),row(101,time)],first?101:102,time);
 }});
 const response=await handler(request()),value=await response.json();assert.equal(response.status,200);assert.equal(value.catalogueComplete,false);assert.equal(value.items.length,102);assert.deepEqual(value.reportedTotals,[101,102]);assert.equal(value.pageCount,2);assert.equal(response.headers.get('x-quote-reader'),'changing-catalogue-v1');
 assert.deepEqual(calls.map(url=>Number(new URL(url).searchParams.get('pageIndex'))),[1,2,1,2]);
 assert.equal(value.total,102);assert.equal(value.coverageReason,'changing_catalogue');
 await handler(request());assert.equal(calls.length,4,'fresh partial coverage is cached without renewing source times');
});

test('HTTP refusal, rate limits, invalid schema and future time are never pagination-retried',async()=>{
 const time=Date.now();
 for(const make of [
  ()=>new Response('No',{status:403}),()=>new Response('No',{status:451}),()=>new Response('No',{status:429}),()=>new Response('No',{status:418}),
  ()=>Response.json({code:'000000',data:{list:[],total:0}}),
  ()=>page([row(0,time,{apr:null})],1,time),
  ()=>page([row(0,time)],1,time+4000),
  ()=>{const error=Error('timeout');error.name='TimeoutError';throw error;}
 ]){
  let calls=0;const handler=createAnonymousDualHandler({now:()=>time,fetchImpl:async()=>{calls++;return make();}});
  const response=await handler(request());assert.equal(response.status,503);assert.equal((await response.json()).items,undefined);assert.equal(calls,1);
 }
});

test('restart shares the original cumulative byte budget and the same hard deadline signal',async()=>{
 const time=Math.floor(Date.now()/1000)*1000;let calls=0;
 const large=createAnonymousDualHandler({now:()=>time,fetchImpl:async()=>{
  calls++;
  if(calls===1)return page(Array.from({length:100},(_,i)=>row(i,time)),101,time,'x'.repeat(1500000));
  if(calls===2)return page([row(100,time)],102,time,'x'.repeat(700000));
  return page(Array.from({length:100},(_,i)=>row(1000+i,time)),101,time,'x'.repeat(2100000));
 }});
 const over=await large(request());assert.equal(over.status,503);assert.match((await over.json()).reason,/4MB/);assert.equal(calls,3);
 let clock=time;const signals=[],steps=[6000,2000,8001];
 const timed=createAnonymousDualHandler({now:()=>clock,fetchImpl:async(url,options)=>{
  const index=signals.length;signals.push(options.signal);clock+=steps[index]||0;
  const first=new URL(url).searchParams.get('pageIndex')==='1';
  return page(first?Array.from({length:100},(_,i)=>row(1000+i,clock)):[row(1100,clock)],first?101:102,clock);
 }});
 const late=await timed(request()),value=await late.json();assert.equal(late.status,503);assert.match(value.reason,/超时/);assert.equal(value.items,undefined);
 assert.equal(signals.length,3);assert.ok(signals.every(signal=>signal===signals[0]));assert.equal(signals[0].aborted,true);
});

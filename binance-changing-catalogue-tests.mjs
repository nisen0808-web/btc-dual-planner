import test from 'node:test';
import assert from 'node:assert/strict';
import {createBinanceReader} from './worker/binance.js';

const SOURCE='https://www.binance.com/bapi/earn/v5/friendly/pos/dc/project/list?investmentAsset=USDT&targetAsset=BTC&projectType=DOWN&sortType=APY_DESC&pageSize=100';
const START=Date.UTC(2026,9,27,8);
const row=(id,extra={})=>({id:String(id),type:'DOWN',investmentAsset:'USDT',targetAsset:'BTC',underlying:'BTC',strikePrice:'79000',apr:'0.12',duration:2,settleTime:START+2*86400000,minDepositAmount:'10',maxDepositAmount:'1000000',canPurchase:true,...extra});
const rows=(offset,count=100)=>Array.from({length:count},(_,i)=>row(offset+i));
const page=(total,list,time=START)=>Response.json({code:'000000',data:{total,list}},{headers:{date:new Date(time).toUTCString()}});

test('explicit changing read retains real rows and actual coverage despite drifting totals',async t=>{
 let clock=START;const calls=[];
 t.mock.method(Date,'now',()=>clock);
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  calls.push(url);assert.equal(url,SOURCE+'&pageIndex='+calls.length);
  assert.equal(options.method,'GET');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'manual');assert.equal(options.cache,'no-store');
  const headers=new Headers(options.headers);for(const key of ['authorization','cookie','x-mbx-apikey'])assert.equal(headers.has(key),false);
  if(calls.length===1)return page(901,rows(0));
  clock+=1000;return calls.length===2?page(899,rows(100),clock):page(203,rows(200,3),clock);
 });
 const ignored={get BINANCE_API_KEY(){assert.fail('changing read must not read credentials');}};
 const result=await createBinanceReader().changingPublic(ignored);
 assert.equal(result.status,'ready');assert.equal(result.catalogueComplete,false);assert.equal(result.coverageReason,'changing_catalogue');
 assert.equal(result.total,203);assert.equal(result.items.length,203);assert.equal(result.pageCount,3);assert.deepEqual(result.reportedTotals,[901,899,203]);assert.equal(result.rejectedConflictCount,0);
 assert.equal(result.serverTime,START);assert.equal(result.lastServerTime,START+2000);assert.equal(result.fetchedAt,START);assert.equal(result.completedAt,START+2000);
 assert.equal(result.source,SOURCE);assert.equal(result.sourceType,'public_web');assert.equal(result.eligibility.accountEligibilityVerified,false);
});

test('exact duplicates deduplicate; conflicting product IDs are quarantined for the entire batch',async t=>{
 t.mock.method(Date,'now',()=>START);let calls=0;
 t.mock.method(globalThis,'fetch',async()=>++calls===1?page(205,rows(0)):calls===2?page(203,[row(0),row(1,{apr:'0.99'}),...rows(100,98)]):page(202,[row(1),row(199)]));
 const result=await createBinanceReader().changingPublic();
 assert.equal(result.status,'ready');assert.equal(result.pageCount,3);assert.equal(result.total,198);assert.equal(result.items.filter(p=>p.id==='0').length,1);assert.equal(result.items.some(p=>p.id==='1'),false);assert.equal(result.rejectedConflictCount,1);
 assert.ok(result.items.every(p=>p.apr==='0.12'));assert.deepEqual(result.reportedTotals,[205,203,202]);
});

test('conflicts in each financial field cannot choose a higher yield or mix product identity',async t=>{
 t.mock.method(Date,'now',()=>START);
 for(const patch of [{apr:'0.99'},{strikePrice:'78000'},{settleTime:START+3*86400000},{duration:3},{minDepositAmount:'20'},{maxDepositAmount:'999999'},{canPurchase:false}]){
  let calls=0;t.mock.method(globalThis,'fetch',async()=>++calls===1?page(102,rows(0)):page(101,[row(0,patch)]));
  const result=await createBinanceReader().changingPublic();assert.equal(result.status,'ready');assert.equal(result.total,99);assert.equal(result.rejectedConflictCount,1);assert.equal(result.items.some(p=>p.id==='0'),false);
 }
});

test('default strict discovery still rejects changing totals and does not invoke the partial path',async t=>{
 t.mock.method(Date,'now',()=>START);let calls=0;
 t.mock.method(globalThis,'fetch',async()=>++calls===1?page(101,rows(0)):page(102,[row(100)]));
 const result=await createBinanceReader()({});assert.equal(result.status,'unavailable');assert.match(result.reason,/分页期间发生变化/);assert.equal(calls,2);assert.equal(result.items,undefined);assert.equal(result.catalogueComplete,undefined);
});

test('invalid schema, wrong financial data, stale/future or backward source times fail closed',async t=>{
 t.mock.method(Date,'now',()=>START);
 const bad=[
  ()=>page(-1,[row(0)]),()=>page(2001,[row(0)]),()=>page(1.5,[row(0)]),()=>page(true,[row(0)]),()=>page(1,rows(0,101)),
  ()=>page(1,[row(0,{targetAsset:'ETH'})]),()=>page(1,[row(0,{investmentAsset:'USDC'})]),()=>page(1,[row(0,{type:'UP'})]),
  ()=>page(1,[row(0,{apr:null})]),()=>page(1,[row(0,{apr:'-0.1'})]),()=>page(1,[row(0,{canPurchase:'true'})]),
  ()=>page(1,[row(0,{minDepositAmount:'100',maxDepositAmount:'99'})]),()=>page(1,[row(0,{maxDepositAmount:'1e16'})]),
  ()=>page(1,[row(0)],START-30000),()=>page(1,[row(0)],START+3000),
  ()=>Response.json({code:'000000',data:{total:1,list:[row(0)]}}),()=>Response.json({code:'error',data:{total:1,list:[row(0)]}}),
 ];
 for(const make of bad){t.mock.method(globalThis,'fetch',async()=>make());const result=await createBinanceReader().changingPublic();assert.equal(result.status,'unavailable');assert.equal(result.items,undefined);}
 let calls=0;t.mock.method(globalThis,'fetch',async()=>++calls===1?page(101,rows(0),START):page(101,[row(100)],START-1000));
 assert.equal((await createBinanceReader().changingPublic()).status,'unavailable');
});

test('a short or oversized page must match its own reported total before it can prove a tail',async t=>{
 t.mock.method(Date,'now',()=>START);
 for(const make of [()=>page(101,[row(0)]),()=>page(50,rows(0)),()=>page(0,[row(0)])]){
  t.mock.method(globalThis,'fetch',async()=>make());const result=await createBinanceReader().changingPublic();
  assert.equal(result.status,'unavailable');assert.equal(result.items,undefined);assert.match(result.reason,/截断报价/);
 }
 let calls=0;t.mock.method(globalThis,'fetch',async()=>++calls===1?page(102,rows(0)):page(101,[]));
 const missingTail=await createBinanceReader().changingPublic();assert.equal(missingTail.status,'unavailable');assert.equal(missingTail.items,undefined);assert.equal(calls,2);assert.match(missingTail.reason,/截断报价/);
});

test('empty valid set, all full pages at limit, and unread tail cannot become ready',async t=>{
 t.mock.method(Date,'now',()=>START);
 t.mock.method(globalThis,'fetch',async()=>page(0,[]));assert.equal((await createBinanceReader().changingPublic()).status,'unavailable');
 let calls=0;t.mock.method(globalThis,'fetch',async()=>page(2000,rows(calls++*100)));
 const full=await createBinanceReader().changingPublic();assert.equal(calls,20);assert.equal(full.status,'unavailable');assert.equal(full.items,undefined);assert.match(full.reason,/分页上限/);
 calls=0;t.mock.method(globalThis,'fetch',async()=>++calls===1?page(101,rows(0)):new Response('unavailable',{status:503}));
 const tail=await createBinanceReader().changingPublic();assert.equal(tail.status,'unavailable');assert.equal(tail.items,undefined);
});

test('HTTP errors and source rejections do not retry or read any credential',async t=>{
 t.mock.method(Date,'now',()=>START);
 for(const status of [301,400,401,403,418,429,451,500,503]){
  let calls=0;t.mock.method(globalThis,'fetch',async(url,options)=>{calls++;assert.equal(url,SOURCE+'&pageIndex=1');assert.equal(new Headers(options.headers).has('x-mbx-apikey'),false);return new Response('DO_NOT_LEAK',{status});});
  const result=await createBinanceReader().changingPublic();assert.equal(calls,1);assert.equal(result.status,'unavailable');assert.equal(result.items,undefined);assert.doesNotMatch(JSON.stringify(result),/DO_NOT_LEAK/);
 }
});

test('read deadline includes page JSON and excludes late or partial output',async t=>{
 let clock=START;t.mock.method(Date,'now',()=>clock);
 t.mock.method(globalThis,'fetch',async()=>{const response=page(1,[row(0)]);const json=response.json.bind(response);response.json=async()=>{const value=await json();clock+=15000;return value;};return response;});
 const late=await createBinanceReader().changingPublic();assert.equal(late.status,'unavailable');assert.equal(late.items,undefined);assert.match(late.reason,/超时/);
});

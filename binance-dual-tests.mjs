import test from 'node:test';
import assert from 'node:assert/strict';
import {loadBinanceDual,loadBinanceCatalogue,compareBinanceDual,deriveBinanceDualIncome} from './web/binance-dual.js';
const now=Date.UTC(2026,9,22,12),expiry=Date.UTC(2026,9,30,8);
// Shape follows official {total,list:[...]} documentation. Values are test fixtures,
// not live account quotes. The reader only sends trimmed list entries as items.
const product={id:'741590',investCoin:'USDT',exercisedCoin:'BTC',strikePrice:'80000',duration:3,settleDate:expiry,purchaseDecimal:4,purchaseEndTime:now+86400000,canPurchase:true,apr:'0.0365',minAmount:'20',maxAmount:'20000',createTimestamp:1708560084000,optionType:'PUT'};
const quote={source:'Binance 普通双币',selectPrice:'80000',apr:.0365,periodRate:.0003};
const data={status:'ready',product,quote,serverTime:now,fetchedAt:now,receivedAt:now,currency:'USDT',ordinary:true,contract:{strike:80000,expires:expiry}};
const put={valid:true,netIncome:90,days:7.8,strike:80000,expires:expiry,currency:'USDT',expiryPrice:90000,assets:10090};
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);

test('ordinary product income needs no option quote and never manufactures a comparison',()=>{
 const selection={strike:80000,expires:expiry,settleCoin:'USDT'},income=deriveBinanceDualIncome(10000,selection,data,now);
 assert.equal(income.valid,true);near(income.income,3);near(income.apr,.0365);near(income.periodRate,.0003);
 for(const key of ['difference','yearDifference','optionIncome','comparisonScope'])assert.equal(Object.hasOwn(income,key),false);
 assert.equal(deriveBinanceDualIncome(10000,{...selection,strike:78000},data,now).valid,false);
 assert.equal(deriveBinanceDualIncome(10000,selection,data,now+30000).valid,false);
 assert.equal(deriveBinanceDualIncome(20001,selection,data,now).valid,false);
});

test('independent catalogue reads validated product maturities without claiming option listing',async t=>{
 t.mock.method(Date,'now',()=>now);let reads=0;
 t.mock.method(globalThis,'fetch',async url=>{reads++;assert.equal(url,'/api/binance-dual');return Response.json({status:'ready',sourceType:'sapi',serverTime:now,fetchedAt:now,items:[product,{...product,id:'bad',canPurchase:false}]},{headers:{date:new Date(now).toUTCString()}});});
 assert.equal((await loadBinanceCatalogue('USDT',[])).entries.length,0);assert.equal(reads,0);
 const catalogue=await loadBinanceCatalogue('USDT',[],{independent:true});assert.equal(reads,1);assert.equal(catalogue.entries.length,1);
 assert.equal(catalogue.entries[0].strike,80000);assert.equal(catalogue.entries[0].expires,expiry);assert.equal(catalogue.entries[0].data.contract.symbol,undefined);
 assert.equal((await loadBinanceCatalogue('USDC',[],{independent:true})).entries.length,0);
});

test('cloud-pulled products retain source times and include checked age plus request duration',async t=>{
 let localNow=now;
 t.mock.method(Date,'now',()=>localNow);
 t.mock.method(globalThis,'fetch',async()=>{localNow+=250;return Response.json({status:'ready',sourceType:'sapi',deliveryType:'cloud_pull',transport:'netlify_public_feed',snapshotAgeAtRead:1200,serverTime:now-1200,fetchedAt:now-1000,items:[product]});});
 const snapshot=await loadBinanceDual({strike:80000,expires:expiry},'USDT');
 assert.equal(snapshot.status,'ready');assert.equal(snapshot.deliveryType,'cloud_pull');assert.equal(snapshot.transport,'netlify_public_feed');assert.equal(snapshot.serverTime,now-1200);assert.equal(snapshot.fetchedAt,now-1000);assert.ok(snapshot.snapshotAgeAtReceive>=1450);
 const income=deriveBinanceDualIncome(10000,{strike:80000,expires:expiry,settleCoin:'USDT'},snapshot,localNow);
 assert.equal(income.valid,true);assert.match(income.note,/Netlify云端实时读取/);assert.equal(income.fetchedAt,now-1000);
 assert.equal(deriveBinanceDualIncome(10000,{strike:80000,expires:expiry,settleCoin:'USDT'},snapshot,localNow+28550).valid,false);
});
test('decimal rate truncation avoids the documented binary boundary failure',()=>{
  assert.equal(Math.floor(.0365*3/365*10000)/10000,.0002);
  const m=compareBinanceDual(10000,put,data,now);assert.equal(m.valid,true);near(m.periodRate,.0003);near(m.income,3);near(m.difference,87);near(m.apr,.0365);near(m.days,3);near(m.dualAnnual,3/10000*365/7.8);assert.equal(m.ordinary,true);assert.match(m.source,/普通/);
});
test('four-decimal period rate follows the official ordinary example',()=>{
  const m=compareBinanceDual(1000,put,{...data,product:{...product,apr:'0.853',duration:2}},now);near(m.periodRate,.0046);near(m.income,4.6);
});
test('extremely small and zero APR remain valid zero-period-income products',()=>{
  for(const apr of ['0.000001','0']){const m=compareBinanceDual(10000,put,{...data,product:{...product,apr,duration:7}},now);assert.equal(m.valid,true);near(m.periodRate,0);near(m.income,0);near(m.difference,90);}
});
test('principal rounds downward while whole funding remains the denominator',()=>{
  const m=compareBinanceDual('12345.67891',put,{...data,product:{...product,apr:'0.365',duration:1}},now);assert.equal(m.valid,true);near(m.amount,12345.6789);near(m.leftover,.00001);near(m.income,12.3456789);near(m.term,m.income/12345.67891);
});
test('minimum and maximum are checked on exact rounded principal without clipping',()=>{
  assert.equal(compareBinanceDual('19.99999',put,data,now).valid,false);
  assert.equal(compareBinanceDual('20000.00009',put,data,now).valid,true);
  assert.equal(compareBinanceDual('20000.0001',put,data,now).valid,false);
  for(const patch of [{purchaseDecimal:null},{purchaseDecimal:true},{purchaseDecimal:19},{minAmount:null},{minAmount:false},{maxAmount:''},{maxAmount:true}])assert.equal(compareBinanceDual(10000,put,{...data,product:{...product,...patch}},now).valid,false);
});
test('matching rejects wrong currency, target price, expiry, and direction',()=>{
  for(const patch of [{currency:'USDC'},{currency:undefined},{strike:80000.001},{expires:expiry+1}])assert.equal(compareBinanceDual(10000,{...put,...patch},data,now).valid,false);
  for(const patch of [{optionType:'CALL'},{investCoin:'USDC'},{exercisedCoin:'ETH'}])assert.equal(compareBinanceDual(10000,put,{...data,product:{...product,...patch}},now).valid,false);
});
test('availability and subscription deadline must be explicitly valid',()=>{
  for(const patch of [{canPurchase:false},{canPurchase:'true'},{canPurchase:undefined},{purchaseEndTime:now},{purchaseEndTime:null},{duration:0},{duration:true},{duration:1.5},{apr:''},{apr:-.1}])assert.equal(compareBinanceDual(10000,put,{...data,product:{...product,...patch}},now).valid,false);
});
test('snapshot freshness uses reader fetchedAt and never product creation time',()=>{
  assert.equal(compareBinanceDual(10000,put,data,now+29999).valid,true);
  assert.equal(compareBinanceDual(10000,put,data,now+30000).valid,false);
  const cached={...data,fetchedAt:now-31000,product:{...product,createTimestamp:now}};assert.equal(compareBinanceDual(10000,put,cached,now).valid,false);
  assert.equal(compareBinanceDual(10000,put,{...data,fetchedAt:null},now).valid,false);
});
test('equality and crash settle into BTC with uninvested residual cash preserved',()=>{
  const equal=compareBinanceDual('10000.00001',{...put,expiryPrice:80000},data,now);assert.equal(equal.settledAsBTC,true);near(equal.dualBtc,10003/80000);near(equal.dualAssets,10003.00001);
  const zero=compareBinanceDual('10000.00001',{...put,expiryPrice:0},data,now);near(zero.dualAssets,.00001);near(zero.difference,87);
});
test('invalid amounts and authorization states cannot become zero-yield quotes',()=>{
  for(const amount of [0,-1,null,'',NaN,Infinity,1e16])assert.equal(compareBinanceDual(amount,put,data,now).valid,false);
  const m=compareBinanceDual(10000,put,{status:'authorization_required',reason:'服务端只读授权不可用'},now);assert.equal(m.valid,false);assert.equal(m.status,'authorization_required');assert.match(m.reason,/授权/);
});
test('loader reads only the same-origin ordinary-product reader and preserves identity',async t=>{
  t.mock.method(Date,'now',()=>now);
  t.mock.method(globalThis,'fetch',async(url,options)=>{assert.equal(url,'/api/binance-dual');assert.equal(options.credentials,'same-origin');assert.equal(options.cache,'no-store');return {ok:true,status:200,headers:{get:()=>new Date(now).toUTCString()},json:async()=>({items:[{...product,exercisedCoin:'ETH'},product],serverTime:now,fetchedAt:now})};});
  const m=await loadBinanceDual({symbol:'test',strike:80000,expires:expiry},'USDT');assert.equal(m.status,'ready');assert.equal(m.product.id,'741590');assert.equal(m.quote.source,'Binance 普通双币');assert.equal(m.ordinary,true);near(m.quote.periodRate,.0003);
});
test('loader preserves authorization reason and never consumes raw list instead of reader items',async t=>{
  t.mock.method(globalThis,'fetch',async()=>({ok:false,status:401,json:async()=>({status:'authorization_required',reason:'服务端只读授权未完成'})}));
  const denied=await loadBinanceDual({strike:80000,expires:expiry},'USDT');assert.equal(denied.status,'authorization_required');assert.equal(denied.reason,'服务端只读授权未完成');
  t.mock.method(globalThis,'fetch',async()=>({ok:true,status:200,json:async()=>({total:1,list:[product],serverTime:now,fetchedAt:now})}));
  assert.equal((await loadBinanceDual({strike:80000,expires:expiry},'USDT')).status,'error');
});
test('loader refuses stale reader snapshots and never picks a nearby price or date',async t=>{
  t.mock.method(Date,'now',()=>now);
  t.mock.method(globalThis,'fetch',async()=>({ok:true,status:200,headers:{get:()=>new Date(now).toUTCString()},json:async()=>({items:[product],serverTime:now-31000,fetchedAt:now-31000})}));
  assert.equal((await loadBinanceDual({strike:80000,expires:expiry},'USDT')).status,'unavailable');
  t.mock.method(globalThis,'fetch',async()=>({ok:true,status:200,headers:{get:()=>new Date(now).toUTCString()},json:async()=>({items:[product],serverTime:now,fetchedAt:now})}));
  assert.equal((await loadBinanceDual({strike:80001,expires:expiry},'USDT')).status,'unavailable');
  assert.equal((await loadBinanceDual({strike:80000,expires:expiry+1},'USDT')).status,'unavailable');
  assert.equal((await loadBinanceDual({strike:80000,expires:expiry},'USDC')).status,'unavailable');
});

const publicProduct={...product,purchaseDecimal:null,purchaseEndTime:null};
const publicData={...data,product:publicProduct,sourceType:'public_web',eligibility:{precisionKnown:false,purchaseWindowKnown:false,accountEligibilityVerified:false}};
test('anonymous website APR produces a conditional amount estimate without inventing precision',()=>{
  const m=compareBinanceDual('12345.67891',put,{...publicData,product:{...publicProduct,apr:'0.365',duration:1}},now);
  assert.equal(m.valid,true);assert.equal(m.estimateOnly,true);assert.equal(m.limitsVerified,false);assert.equal(m.publicLimitsVerified,true);assert.equal(m.eligibilityVerified,false);
  near(m.amount,12345.67891);near(m.leftover,0);near(m.income,12.34567891);near(m.term,.001);assert.match(m.label,/估算/);assert.match(m.note,/截止时间/);
});
test('anonymous amount limits are checked before computing and never clipped to a maximum',()=>{
  for(const amount of ['19.99999','20000.00001'])assert.equal(compareBinanceDual(amount,put,publicData,now).valid,false);
  assert.equal(compareBinanceDual('20000',put,publicData,now).valid,true);
  const integer=compareBinanceDual('1e4',put,publicData,now);assert.equal(integer.valid,true);near(integer.income,3);
});
test('public provenance cannot hide malformed or missing product rules or mismatches',()=>{
  for(const patch of [{canPurchase:false},{purchaseDecimal:4},{purchaseEndTime:now},{minAmount:null},{maxAmount:true},{apr:true},{settleDate:now}])assert.equal(compareBinanceDual(10000,put,{...publicData,product:{...publicProduct,...patch}},now).valid,false);
  assert.equal(compareBinanceDual(10000,put,{...publicData,eligibility:null},now).valid,false);
  assert.equal(compareBinanceDual(10000,put,{...publicData,sourceType:'unknown'},now).valid,false);
  assert.equal(compareBinanceDual(10000,{...put,expires:expiry+1},publicData,now).valid,false);
  assert.equal(compareBinanceDual(10000,put,publicData,now+30000).valid,false);
});
test('loader accepts declared public omissions and retains their conditional status',async t=>{
  t.mock.method(Date,'now',()=>now);
  t.mock.method(globalThis,'fetch',async()=>({ok:true,status:200,headers:{get:()=>new Date(now).toUTCString()},json:async()=>({...publicData,items:[publicProduct]})}));
  const snapshot=await loadBinanceDual({strike:80000,expires:expiry},'USDT');assert.equal(snapshot.status,'ready');assert.equal(snapshot.sourceType,'public_web');assert.equal(snapshot.product.purchaseDecimal,null);
  const m=compareBinanceDual(10000,put,snapshot,now);assert.equal(m.valid,true);assert.equal(m.estimateOnly,true);near(m.income,3);near(m.difference,87);
});
test('collector delivery preserves the source timestamp and explicitly labels the amount estimate',async t=>{
  t.mock.method(Date,'now',()=>now);
  t.mock.method(globalThis,'fetch',async()=>({ok:true,status:200,headers:{get:()=>new Date(now).toUTCString()},json:async()=>({...publicData,deliveryType:'collector_push',collectorLastSeen:now,snapshotAgeAtRead:0,items:[publicProduct]})}));
  const snapshot=await loadBinanceDual({strike:80000,expires:expiry},'USDT');assert.equal(snapshot.deliveryType,'collector_push');assert.equal(snapshot.fetchedAt,now);
  const result=compareBinanceDual(10000,put,snapshot,now);assert.equal(result.valid,true);assert.match(result.label,/本机采集/);assert.match(result.note,/30 秒/);near(result.income,3);
});

test('collector age uses verified source age plus network duration despite producer clock skew',async t=>{
  let local=now;t.mock.method(Date,'now',()=>local);
  t.mock.method(performance,'now',()=>local-now);
  const payload={...publicData,deliveryType:'collector_push',collectorLastSeen:now,serverTime:now-1000,fetchedAt:now+1500,snapshotAgeAtRead:1000,items:[publicProduct]};
  t.mock.method(globalThis,'fetch',async()=>{local+=400;return {ok:true,status:200,headers:{get:()=>new Date(now).toUTCString()},json:async()=>payload};});
  const snapshot=await loadBinanceDual({strike:80000,expires:expiry},'USDT');assert.equal(snapshot.status,'ready');assert.equal(snapshot.snapshotAgeAtReceive,1400);
  assert.equal(compareBinanceDual(10000,put,snapshot,local+28599).valid,true);
  assert.equal(compareBinanceDual(10000,put,snapshot,local+28600).valid,false);
});

test('collector age is required and stale responses including network time cannot participate',async t=>{
  let local=now;t.mock.method(Date,'now',()=>local);
  let checkedAge;
  t.mock.method(globalThis,'fetch',async()=>{local+=500;return {ok:true,status:200,json:async()=>({...publicData,deliveryType:'collector_push',snapshotAgeAtRead:checkedAge,items:[publicProduct]})};});
  for(const invalidAge of [undefined,null,'0',NaN,-1,30000,29500]){checkedAge=invalidAge;assert.equal((await loadBinanceDual({strike:80000,expires:expiry},'USDT')).status,'unavailable');}
});

test('consumer wall-clock rollback cannot extend the 30-second expiry',async t=>{
  let local=now,monotonic=100;t.mock.method(Date,'now',()=>local);t.mock.method(performance,'now',()=>monotonic);
  t.mock.method(globalThis,'fetch',async()=>{local-=60000;monotonic+=500;return {ok:true,status:200,json:async()=>({...publicData,deliveryType:'collector_push',snapshotAgeAtRead:1000,items:[publicProduct]})};});
  const snapshot=await loadBinanceDual({strike:80000,expires:expiry},'USDT');assert.equal(snapshot.status,'ready');assert.equal(snapshot.snapshotAgeAtReceive,1500);
  local-=60000;monotonic+=28499;assert.equal(compareBinanceDual(10000,put,snapshot,local).valid,true);
  monotonic+=1;assert.equal(compareBinanceDual(10000,put,snapshot,local).valid,false);
});

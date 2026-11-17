import test from 'node:test';
import assert from 'node:assert/strict';
import {compareDual,normalizeSettlement} from './web/dual.js';

const now=Date.UTC(2026,9,22,8),expiry=now+7*86400000;
const product={productId:'p1',baseCoin:'BTC',quoteCoin:'USDT',duration:'7d',status:'Available',isVipProduct:false,subscribeStartAt:String(now-1000),subscribeEndAt:String(now+3600000),applyStartAt:String(now-86400000),settlementTime:String(expiry-1000),minPurchaseQuoteAmount:'20',remainingAmountQuote:'4000000',orderPrecisionDigitalQuote:4};
const quote={selectPrice:'90000',apyE8:'36500000',maxInvestmentAmount:'1000000',expiredAt:String(now+20000),source:'Bybit Dual Asset'};
const data={status:'ready',product,quote,serverTime:now,receivedAt:now,currency:'USDT',contract:{strike:90000,expires:expiry}};
const put={valid:true,netIncome:95.7,days:6.5,strike:90000,expires:expiry,currency:'USDT',expiryPrice:100000,assets:10095.7};
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);

test('same complete funding amount is compared, preserving PUT idle cash',()=>{
  const m=compareDual(10000,put,data,now);assert.equal(m.valid,true);near(m.income,70);near(m.difference,25.7);near(m.term,.007);near(m.apr,.365);near(m.amount,10000);near(m.days,7);near(m.dualAssets,10070);
  near(m.yearDifference,25.7/10000*365/6.5);
});
test('uses product duration instead of apply-to-settlement span or PUT fractional days',()=>{
  const m=compareDual(10000,put,data,now);near(m.days,7);near(m.income,70);
  const h=compareDual(10000,put,{...data,product:{...product,duration:'8h'}},now);near(h.days,1/3);near(h.income,10000*.365/3/365);
});
test('only the exact 07:59:59.000 boundary is canonicalized',()=>{
  assert.equal(normalizeSettlement(expiry-1000),expiry);
  assert.equal(normalizeSettlement(expiry-1),expiry-1);
  assert.equal(normalizeSettlement(expiry),expiry);
  assert.equal(normalizeSettlement(expiry-3600000),expiry-3600000);
  assert.ok(Number.isNaN(normalizeSettlement('')));
});
test('zero APR is valid but missing or negative APR is not',()=>{
  const zero=compareDual(10000,put,{...data,quote:{...quote,apyE8:'0'}},now);assert.equal(zero.valid,true);near(zero.income,0);near(zero.difference,95.7);
  for(const apyE8 of [undefined,'',-1])assert.equal(compareDual(10000,put,{...data,quote:{...quote,apyE8}},now).valid,false);
});
test('quote expiry follows server time plus locally elapsed time',()=>{
  assert.equal(compareDual(10000,put,data,now+19999).valid,true);
  const expired=compareDual(10000,put,data,now+20000);assert.equal(expired.valid,false);assert.match(expired.reason,/失效/);
});
test('strict currency, strike, expiry, and subscription-window matching',()=>{
  assert.equal(compareDual(10000,{...put,currency:'USDC'},data,now).valid,false);
  assert.equal(compareDual(10000,{...put,strike:90000.01},data,now).valid,false);
  assert.equal(compareDual(10000,{...put,expires:expiry+1000},data,now).valid,false);
  assert.equal(compareDual(10000,put,{...data,product:{...product,subscribeEndAt:String(now)}},now).valid,false);
  assert.equal(compareDual(10000,put,{...data,product:{...product,isVipProduct:true}},now).valid,false);
});
test('amount rounding is downward and minimum is checked after rounding',()=>{
  const p={...product,orderPrecisionDigitalQuote:2,minPurchaseQuoteAmount:'1'};
  const m=compareDual(1.159,put,{...data,product:p},now);assert.equal(m.valid,true);near(m.amount,1.15);near(m.leftover,.009);
  const tiny=compareDual(19.99999,put,data,now);assert.equal(tiny.valid,false);assert.match(tiny.reason,/最低申购/);
});
test('remaining capacity and per-quote maximum cannot be silently clipped',()=>{
  assert.equal(compareDual(10000,put,{...data,product:{...product,remainingAmountQuote:'9999'}},now).valid,false);
  assert.equal(compareDual(10000,put,{...data,quote:{...quote,maxInvestmentAmount:'9999'}},now).valid,false);
});
test('converted scenarios compare total assets and keep the unconverted income difference separate',()=>{
  const m=compareDual(10000,{...put,expiryPrice:70000,assets:7890.695},data,now);
  near(m.dualBtc,10070/90000);near(m.dualAssets,10070/90000*70000);near(m.scenarioDifference,7890.695-m.dualAssets);near(m.difference,25.7);assert.equal(m.settledAsBTC,true);
  const equal=compareDual(10000,{...put,expiryPrice:90000},data,now);assert.equal(equal.settledAsBTC,true);near(equal.dualAssets,10070);
});
test('unavailable quotes and invalid products remain unavailable rather than zero-yield fallbacks',()=>{
  for(const value of [{status:'unavailable',reason:'没有同条件产品'},{...data,product:{...product,duration:''}},{...data,quote:{...quote,maxInvestmentAmount:null}}])assert.equal(compareDual(10000,put,value,now).valid,false);
});
test('loadDual reads fresh quotes each time while caching only metadata',async t=>{
  const mod=await import('./web/dual.js?load-cache-test');let metadataCalls=0,quoteCalls=0;const realNow=Date.now();
  const liveProduct={...product,subscribeStartAt:String(realNow-1000),subscribeEndAt:String(realNow+3600000),settlementTime:String(Date.UTC(new Date(realNow).getUTCFullYear(),new Date(realNow).getUTCMonth(),new Date(realNow).getUTCDate()+7,8)-1000)};
  const liveContract={strike:90000,expires:normalizeSettlement(liveProduct.settlementTime)};
  t.mock.method(globalThis,'fetch',async url=>({ok:true,status:200,json:async()=>{if(String(url).includes('product-extra-info')){quoteCalls++;return{retCode:0,time:Date.now(),result:{list:[{productId:'p1',buyLowPrice:[{...quote,expiredAt:String(Date.now()+30000)}]}]}};}metadataCalls++;return{retCode:0,time:Date.now(),result:{list:[{...liveProduct,baseCoin:'ETH'},liveProduct]}};}}));
  const first=await mod.loadDual(liveContract,'USDT'),second=await mod.loadDual(liveContract,'USDT');
  assert.equal(first.status,'ready');assert.equal(second.status,'ready');assert.equal(metadataCalls,1);assert.equal(quoteCalls,2);assert.equal(first.quote.source,'Bybit Dual Asset');
});
test('loadDual rejects expired exact quotes and never substitutes another currency',async t=>{
  const mod=await import('./web/dual.js?load-expired-test');const realNow=Date.now();
  const liveProduct={...product,subscribeStartAt:String(realNow-1000),subscribeEndAt:String(realNow+3600000),settlementTime:String(realNow+86400000)};
  const liveContract={strike:90000,expires:Number(liveProduct.settlementTime)};
  t.mock.method(globalThis,'fetch',async url=>({ok:true,status:200,json:async()=>({retCode:0,time:Date.now(),result:{list:String(url).includes('product-extra-info')?[{productId:'p1',buyLowPrice:[{...quote,expiredAt:String(Date.now()-1)}]}]:[liveProduct]}})}));
  const expired=await mod.loadDual(liveContract,'USDT');assert.equal(expired.status,'unavailable');assert.match(expired.reason,/失效/);
  const missingCurrency=await mod.loadDual(liveContract,'USDC');assert.equal(missingCurrency.status,'unavailable');assert.match(missingCurrency.reason,/不能用其他稳定币/);
});

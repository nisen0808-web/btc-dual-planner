import test from 'node:test';
import assert from 'node:assert/strict';
import {compareOKXDual,loadOKXDual} from './web/okx-dual.js';

// Real anonymous upstream snapshot, 2026-10-22. Amount constraints are ABSENT.
const stamp=1792667395439,expiry=1793347200000;
const product={absYield:'0.00738479',annualYield:'0.344',annualYieldPercentage:'34.40',alternativeCurrency:'USDT',currency:'BTC',currencyId:0,dcdTerm:'188',dcdType:'Standard',expiryTime:expiry,interestAccrualTime:1792670400000,launchTime:1787296721000,matchCurrency:'USDT',matchCurrencyId:7,ndBrokerProductId:'BTC-USDT-261030-80000-P',productType:'DualCurrencyDeposit',protectionProduct:false,quoteResponseTime:stamp,settlementTime:expiry,status:1,stopTradingTime:1793332800000,strike:'80000',type:'PUT',version:'SIMPLE'};
const quote={source:'OKX Dual Investment',selectPrice:'80000',apr:.344,periodRate:.00738479,expiredAt:stamp+30000};
const data={status:'ready',product,quote,currency:'USDT',contract:{strike:80000,expires:expiry},serverTime:stamp,receivedAt:stamp};
const put={valid:true,netIncome:90,days:7.8,strike:80000,expires:expiry,currency:'USDT',expiryPrice:90000,assets:10090};
// Synthetic constraints test only the verified-rules adapter; not exchange facts.
const rules={verified:true,source:'synthetic test fixture',productId:product.ndBrokerProductId,currency:'USDT',min:'20',max:'20000',step:'0.01'};
const complete={...data,amountRules:rules};
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);

test('real snapshot provides a clearly conditional amount-times-official-rate estimate',()=>{
  const result=compareOKXDual(10000,put,data,stamp);assert.equal(result.valid,true);assert.equal(result.estimateOnly,true);assert.equal(result.eligibilityVerified,false);assert.match(result.note,/在该金额可实际申购的条件下成立/);near(result.quoteApr,.344);near(result.quotePeriodRate,.00738479);near(result.quoteDays,188/24);near(result.income,73.8479);near(result.difference,16.1521);
});
test('uses exact absYield, not rounded displayed percentage or recomputed APR',()=>{
  const m=compareOKXDual(10000,put,complete,stamp);assert.equal(m.valid,true);near(m.income,73.8479);near(m.difference,16.1521);near(m.apr,.344);near(m.days,188/24);near(m.yearDifference,16.1521/10000*365/7.8);
});
test('quote is invalid exactly at 30 seconds and cannot be future dated',()=>{
  assert.equal(compareOKXDual(10000,put,complete,stamp+29999).valid,true);
  assert.equal(compareOKXDual(10000,put,complete,stamp+30000).valid,false);
  assert.equal(compareOKXDual(10000,put,{...complete,product:{...product,quoteResponseTime:stamp+1001}},stamp).valid,false);
});
test('currency strike and expiry must match exactly',()=>{
  for(const patch of [{currency:'USDC'},{currency:undefined},{strike:80000.01},{expires:expiry+1}])assert.equal(compareOKXDual(10000,{...put,...patch},complete,stamp).valid,false);
});
test('stopped products, unavailable statuses and contradictory accrual periods fail closed',()=>{
  for(const patch of [{stopTradingTime:stamp},{status:2},{dcdTerm:'7'},{interestAccrualTime:null},{absYield:''},{annualYield:-1},{settlementTime:expiry+1}])assert.equal(compareOKXDual(10000,put,{...complete,product:{...product,...patch}},stamp).valid,false);
});
test('min max and precision are applied after rounding with no silent clipping',()=>{
  const m=compareOKXDual(20.019,put,complete,stamp);assert.equal(m.valid,true);near(m.amount,20.01);near(m.leftover,.009);
  assert.equal(compareOKXDual(19.999,put,complete,stamp).valid,false);
  assert.equal(compareOKXDual(20001,put,complete,stamp).valid,false);
  for(const patch of [{verified:false},{max:null},{step:null},{source:''},{currency:'USDC'},{productId:'another'}]){const r=compareOKXDual(10000,put,{...complete,amountRules:{...rules,...patch}},stamp);assert.equal(r.valid,true);assert.equal(r.eligibilityVerified,false);assert.equal(r.estimateOnly,true);near(r.amount,10000);}
});
test('converted equality and crash compare whole assets separately from income',()=>{
  const equal=compareOKXDual(10000,{...put,expiryPrice:80000},complete,stamp);assert.equal(equal.settledAsBTC,true);near(equal.dualBtc,10073.8479/80000);near(equal.dualAssets,10073.8479);
  const zero=compareOKXDual(10000,{...put,expiryPrice:0},complete,stamp);near(zero.dualAssets,0);near(zero.difference,16.1521);
});
test('loader consumes the anonymous same-origin proxy and retains an actual quote without inventing amount constraints',async t=>{
  t.mock.method(Date,'now',()=>stamp);
  let calls=0;t.mock.method(globalThis,'fetch',async(url,options)=>{calls++;assert.equal(url,'/api/okx-dual');assert.equal(options.credentials,'same-origin');return {ok:true,status:200,headers:{get:()=>new Date(stamp).toUTCString()},json:async()=>({code:0,data:{responseTime:0,products:[{...product,alternativeCurrency:'USDC'},product]}})};});
  const result=await loadOKXDual({strike:80000,expires:expiry},'USDT');assert.equal(result.status,'ready');assert.equal(result.product.ndBrokerProductId,product.ndBrokerProductId);assert.equal(result.amountRules,null);const estimate=compareOKXDual(10000,put,result,stamp);assert.equal(estimate.valid,true);assert.equal(estimate.eligibilityVerified,false);assert.equal(estimate.estimateOnly,true);assert.equal(calls,1);
});
test('invalid amounts remain invalid even for a quote-only estimate',()=>{
  for(const amount of [0,-1,'',null,NaN,Infinity,1e16])assert.equal(compareOKXDual(amount,put,data,stamp).valid,false);
});
test('loader never replaces a missing exact quote with nearest strike or currency',async t=>{
  t.mock.method(Date,'now',()=>stamp);
  t.mock.method(globalThis,'fetch',async()=>({ok:true,headers:{get:()=>new Date(stamp).toUTCString()},json:async()=>({code:0,data:{products:[product]}})}));
  assert.equal((await loadOKXDual({strike:80001,expires:expiry},'USDT')).status,'unavailable');
  assert.equal((await loadOKXDual({strike:80000,expires:expiry},'USDC')).status,'unavailable');
});

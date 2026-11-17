import test from 'node:test';
import assert from 'node:assert/strict';
import { calculatePutQuote, priceFilterProblem, matchesStrike, findLiveCandidates, rankLiveQuotes } from './web/live-quotes.js';

const now=Date.UTC(2026,9,22,8),expiry=now+7*86400000;
const near=(a,b,t=1e-8)=>assert.ok(Math.abs(a-b)<=t,`${a} != ${b}`);
const contract={symbol:'BTC-29OCT26-80000-P-USDT',strike:80000,expires:expiry,bid:1000,step:.01,min:.01,
  taker:.0003,cap:.07,delivery:.00015,spot:.001,spotDeductBase:true};
const book={time:now,bids:[{price:1000,qty:3}]};
function entry(id='bybit',{platform='bybit',K=80000,T=expiry,apr=.365,max=20000}={}){
  const common={status:'ready',currency:'USDT',serverTime:now,receivedAt:now,contract:{strike:K,expires:T}};
  let data;
  if(platform==='bybit')data={...common,product:{productId:id,baseCoin:'BTC',quoteCoin:'USDT',duration:'7d',status:'Available',isVipProduct:false,
    subscribeStartAt:String(now-1000),subscribeEndAt:String(now+3600000),applyStartAt:String(now-86400000),settlementTime:String(T-1000),
    minPurchaseQuoteAmount:'20',remainingAmountQuote:'4000000',orderPrecisionDigitalQuote:4},
    quote:{selectPrice:String(K),apyE8:String(apr*1e8),maxInvestmentAmount:String(max),expiredAt:String(now+20000)}};
  else if(platform==='binance')data={...common,fetchedAt:now,product:{id,investCoin:'USDT',exercisedCoin:'BTC',strikePrice:String(K),duration:7,
    settleDate:T,purchaseDecimal:2,purchaseEndTime:now+86400000,canPurchase:true,apr:String(apr),minAmount:'20',maxAmount:String(max),optionType:'PUT'},quote:{}};
  else data={...common,product:{currency:'BTC',alternativeCurrency:'USDT',type:'PUT',productType:'DualCurrencyDeposit',dcdType:'Standard',status:1,
    launchTime:now-1000,stopTradingTime:T-3600000,expiryTime:T,settlementTime:T,quoteResponseTime:now,dcdTerm:'168',interestAccrualTime:now,
    absYield:String(apr*7/365),annualYield:String(apr),strike:String(K),ndBrokerProductId:id},quote:{},
    amountRules:{verified:true,source:'synthetic test limits',currency:'USDT',productId:id,min:20,max,step:.01}};
  return{id,platform,currency:'USDT',strike:K,expires:T,data};
}
function fixture(entries=[entry()],overrides={}){
  return{amount:10000,currency:'USDT',now,markets:[{platform:'bybit',spot:85000,time:now,receivedAt:now,contracts:[{...contract}]}],
    entries,books:[{platform:'bybit',symbol:contract.symbol,receivedAt:now,book:structuredClone(book)}],...overrides};
}

test('quotes use full visible bid VWAP and each fill fee cap, with real top-of-book/depth fields',()=>{
  const b={time:now,bids:[{price:100,qty:.05},{price:50,qty:.2},{price:0,qty:100}]};
  const q=calculatePutQuote(10000,contract,b,85000,now);assert.equal(q.valid,true);
  near(q.q,.12);near(q.gross,8.5);near(q.openFee,.595);near(q.averagePrice,8.5/.12);
  near(q.bestBid,100);near(q.bestBidQty,.05);near(q.depthQty,.25);assert.equal(q.levelsUsed,2);
});

test('PUT size stays fully funded and only the opening fee reduces quoted income',()=>{
  for(const base of [false,true]){
    const c={...contract,spotDeductBase:base},q=calculatePutQuote(10000,c,book,85000,now);
    assert.equal(q.valid,true);near(q.q,.12);assert.ok(q.capital+q.feeReserve<=10000);
    near(q.netIncome,q.gross-q.openFee);near(q.feeReserve,q.openFee+q.deliveryFeeReserve+q.spotFeeReserve);
    near(q.unused,10000-q.capital);near(q.freeCash,10000-q.reserve);near(q.annual,q.term*365/7);
  }
  const rich=calculatePutQuote(10000,contract,{time:now,bids:[{price:100000,qty:3}]},85000,now);
  assert.equal(rich.valid,true);assert.ok(rich.capital<=10000);assert.ok(rich.reserve<=10000);
});

test('quote APIs never return hypothetical fixing, delivery, BTC or future wealth results',()=>{
  const m=rankLiveQuotes(fixture());assert.equal(m.rows.length,1);
  const forbidden=['expiryPrice','scenarioPrice','btcReceived','payout','assets','cash','basisCost','limits','comparison','dropRate','gapRate'];
  for(const row of m.rows){for(const value of [row.quote,row.model,row.dual,row.precheck])for(const key of forbidden)assert.equal(key in value,false,key);
    for(const key of ['dualBtc','dualCash','dualAssets','settledAsBTC'])assert.equal(key in row.dual,false,key);
    assert.equal(row.quoteOnly,true);assert.equal(row.quote.executionStatus,'quoted');}
});

test('price filters support exact, inclusive range and one empty end with strict validation',()=>{
  assert.equal(priceFilterProblem({}),null);assert.equal(matchesStrike(contract,{strike:80000}),true);
  assert.equal(matchesStrike(contract,{minStrike:80000,maxStrike:80000}),true);
  assert.equal(matchesStrike(contract,{minStrike:79999,maxStrike:null}),true);
  assert.equal(matchesStrike(contract,{minStrike:null,maxStrike:80000}),true);
  assert.equal(matchesStrike(contract,{strike:80000.00000001}),false);
  for(const filter of [{strike:0},{strike:'80000'},{strike:NaN},{minStrike:Infinity},{minStrike:90000,maxStrike:80000},
    {strike:80000,minStrike:81000},{strike:''}])assert.ok(priceFilterProblem(filter));
  assert.equal(findLiveCandidates({...fixture(),strike:80000.00000001}).candidates.length,0);
  assert.equal(findLiveCandidates({...fixture(),minStrike:90000,maxStrike:80000}).valid,false);
});

test('three real product comparators retain the same complete amount and highest-income benchmark',()=>{
  const f=fixture([entry('weak',{apr:.1}),entry('strong',{platform:'binance',apr:3}),entry('okx',{platform:'okx'})]);f.amount=10000.019;
  const m=rankLiveQuotes(f);assert.equal(m.rows.length,3);assert.ok(m.rows[0].incomeDifference>0);assert.ok(m.rows.at(-1).incomeDifference<0);
  for(const row of m.rows){near(row.quote.amount,10000.019);near(row.dual.amount+row.dual.leftover,10000.019);near(row.incomeDifference,row.quote.netIncome-row.dual.income);}
  const best=m.rows.find(row=>row.bestForContract);assert.equal(best.entry.id,'strong');
  assert.equal(m.coverage.completeMarketCoverage,false);
});

test('no dual source still shows real PUT prices, including USDC, without a fabricated zero APR',()=>{
  const f=fixture([]);const m=rankLiveQuotes(f);assert.equal(m.rows.length,1);const row=m.rows[0];
  assert.equal(row.dual,null);assert.equal(row.incomeDifference,null);assert.equal(row.entry,null);assert.equal(row.bestForContract,true);near(row.quote.bestBid,1000);
  assert.ok(row.unmatchedReason);
  const usdc=fixture([],{currency:'USDC'});usdc.markets[0].platform='deribit';usdc.markets[0].contracts[0].spotDeductBase=false;usdc.books[0].platform='deribit';
  const result=rankLiveQuotes(usdc);assert.equal(result.rows.length,1);assert.equal(result.rows[0].quote.settleCoin,'USDC');assert.equal(result.rows[0].dual,null);
});

test('amount rules reject comparisons without hiding the PUT and failed budgets keep the actual best bid',()=>{
  const high=rankLiveQuotes(fixture([entry('limited',{max:9999})]));assert.equal(high.rows.length,1);assert.equal(high.rows[0].dual,null);
  assert.ok(high.errors.some(e=>e.code==='dual_precheck_failed'));
  const small=rankLiveQuotes({...fixture([]),amount:100});assert.equal(small.rows.length,0);assert.equal(small.unavailableQuotes.length,1);near(small.unavailableQuotes[0].bestBid,1000);
  const insufficient=fixture([]);insufficient.books[0].book.bids=[{price:1000,qty:.01}];
  const depth=rankLiveQuotes(insufficient);assert.equal(depth.rows.length,0);assert.ok(depth.errors.some(e=>e.code==='depth_insufficient'));near(depth.unavailableQuotes[0].bestBid,1000);
});

test('expiry, book TTL and source skew keep invalid duals from becoming a comparison, while PUT stays visible',()=>{
  const expired=rankLiveQuotes({...fixture(),now:now+20000});assert.equal(expired.rows.length,1);assert.equal(expired.rows[0].dual,null);
  const f=fixture();f.books[0].book.time=now-30001;const skew=rankLiveQuotes(f);assert.equal(skew.rows.length,1);assert.equal(skew.rows[0].dual,null);
  const stale=fixture();stale.books[0].receivedAt=now-30000;assert.equal(rankLiveQuotes(stale).rows.length,0);
  const market=fixture();market.markets[0].receivedAt=now-30000;assert.equal(rankLiveQuotes(market).rows.length,0);
});

test('currency/exact expiry/default seven-day range remain guarded even when unpaired quotes are allowed',()=>{
  const wrong=entry('wrong',{K:80000.01});assert.equal(rankLiveQuotes(fixture([wrong])).rows[0].dual,null);
  const cross=fixture();cross.entries[0].currency='USDC';assert.equal(rankLiveQuotes(cross).rows[0].dual,null);
  const farT=expiry+1,far=fixture([entry('far',{platform:'binance',T:farT})]);far.markets[0].contracts[0].expires=farT;
  assert.equal(findLiveCandidates(far).candidates.length,0);assert.equal(findLiveCandidates({...far,maxDays:null}).candidates.length,1);
  assert.equal(rankLiveQuotes({...far,maxDays:null}).rows.length,1);
});

test('paired signed differences sort before unpaired quotes and no network or account operation occurs',t=>{
  t.mock.method(globalThis,'fetch',()=>{throw Error('network must not be used');});
  const f=fixture([entry('negative',{apr:3})]),c={...contract,symbol:'unpaired-lower',strike:70000};
  f.markets[0].contracts.push(c);f.books.push({platform:'bybit',symbol:c.symbol,receivedAt:now,book:structuredClone(book)});
  const before=structuredClone(f),m=rankLiveQuotes(f);assert.equal(m.rows.length,2);
  assert.ok(m.rows[0].incomeDifference<0);assert.equal(m.rows[1].incomeDifference,null);assert.deepEqual(f,before);
  for(const A of [0,-1,NaN,Infinity,''])assert.equal(calculatePutQuote(A,contract,book,85000,now).valid,false);
  assert.equal(calculatePutQuote(10000,{...contract,expires:now},book,85000,now).valid,false);
  assert.equal(calculatePutQuote(10000,contract,{time:now,bids:[{price:0,qty:3}]},85000,now).valid,false);
});

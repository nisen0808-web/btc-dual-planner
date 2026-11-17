import test from 'node:test';
import assert from 'node:assert/strict';
import { findScanCandidates, rankScanCombinations } from './web/combination-scan.js';

// The standard fixture expires at the exact inclusive seven-day server-clock boundary.
const now=Date.UTC(2026,9,22,8), expiry=now+7*86400000;
const near=(a,b,t=1e-8)=>assert.ok(Math.abs(a-b)<=t,`${a} != ${b}`);
function entry(platform='bybit',{id=platform,K=80000,T=expiry,currency='USDT',apr=.365,period=.007,max=20000,quoteLife=20000}={}) {
  const common={status:'ready',serverTime:now,receivedAt:now,currency,contract:{strike:K,expires:T}};
  let data;
  if(platform==='bybit')data={...common,
    product:{productId:id,baseCoin:'BTC',quoteCoin:currency,duration:'7d',status:'Available',isVipProduct:false,
      subscribeStartAt:String(now-1000),subscribeEndAt:String(now+3600000),applyStartAt:String(now-86400000),
      settlementTime:String(T-1000),minPurchaseQuoteAmount:'20',remainingAmountQuote:'4000000',orderPrecisionDigitalQuote:4},
    quote:{selectPrice:String(K),apyE8:String(apr*1e8),maxInvestmentAmount:String(max),expiredAt:String(now+quoteLife),source:'Bybit Dual Asset'}};
  else if(platform==='binance')data={...common,fetchedAt:now,
    product:{id,investCoin:currency,exercisedCoin:'BTC',strikePrice:String(K),duration:7,settleDate:T,purchaseDecimal:2,
      purchaseEndTime:now+86400000,canPurchase:true,apr:String(apr),minAmount:'20',maxAmount:String(max),optionType:'PUT'},quote:{source:'Binance 普通双币'}};
  else data={...common,
    product:{currency:'BTC',alternativeCurrency:currency,type:'PUT',productType:'DualCurrencyDeposit',dcdType:'Standard',status:1,
      launchTime:now-86400000,stopTradingTime:T-3600000,expiryTime:T,settlementTime:T,quoteResponseTime:now,
      dcdTerm:String((T-now)/3600000),interestAccrualTime:now,absYield:String(period),annualYield:String(apr),strike:String(K),ndBrokerProductId:id},
    quote:{source:'OKX Dual Investment'},amountRules:{verified:true,source:'synthetic test rules',currency,productId:id,min:20,max,step:.01}};
  return {id,platform,currency,strike:K,expires:T,data};
}
function fixture({currency='USDT',K=80000,T=expiry,spot=85000,contracts,entries,step=.0001}={}) {
  const platform=currency==='USDT'?'bybit':'deribit';
  const c={symbol:`${platform}-${K}-${T}-P`,strike:K,expires:T,bid:1000,step:.01,min:.01,taker:.0003,
    cap:platform==='bybit'?.07:.125,delivery:.00015,deliveryCap:.125,spot:platform==='bybit'?.001:.0005,
    spotDeductBase:platform==='bybit',spotStep:step};
  const all=contracts||[c];
  return {amount:10000,currency,now,dropRate:.05,markets:[{platform,spot,time:now,receivedAt:now,contracts:all}],
    entries:entries||[entry('bybit',{K,T,currency})],
    books:all.map(x=>({platform,symbol:x.symbol,receivedAt:now,book:{time:now,bids:[{price:1000,qty:3}]}}))};
}
const has=(result,code)=>result.reasons.some(reason=>reason.code===code);

test('exact K/canonical T/currency pairs are matched with the same complete amount',()=>{
  const f=fixture({entries:[entry('bybit'),entry('binance'),entry('okx')]});f.amount=10000.019;
  const found=findScanCandidates(f);assert.equal(found.valid,true);assert.equal(found.candidates.length,3);
  const ranked=rankScanCombinations(f);assert.equal(ranked.rows.length,3);
  for(const row of ranked.rows) {
    near(row.model.amount,10000.019);near(row.dual.amount+row.dual.leftover,10000.019);
    near(row.btcDifference,row.model.btcReceived-row.dual.dualBtc,1e-14);
    assert.notEqual(row.model.btcReceived,row.model.q);assert.equal(row.estimateOnly,true);
    assert.equal(row.comparison.valid,true);assert.equal(row.limits.valid,true);
  }
  assert.equal(ranked.coverage.completeMarketCoverage,false);assert.equal(ranked.coverage.scope,'provided_snapshots');
});

test('nearby strike, one-millisecond expiry, raw unnormalized expiry and mixed currency do not match',()=>{
  const f=fixture({entries:[entry('bybit',{id:'strike',K:80000.00000001}),entry('bybit',{id:'time',T:expiry+1}),
    {...entry('bybit',{id:'raw'}),expires:expiry-1000},entry('bybit',{id:'currency',currency:'USDC'})]});
  const m=findScanCandidates(f);assert.equal(m.candidates.length,0);assert.ok(has(m,'no_exact_quote'));
  assert.ok(has(m,'entry_currency_mismatch'));
});

test('USDC uses Deribit only and never borrows the USDT option market',()=>{
  const f=fixture({currency:'USDC'}),m=rankScanCombinations(f);assert.equal(m.rows.length,1);
  assert.equal(m.rows[0].optionPlatform,'deribit');assert.equal(m.rows[0].currency,'USDC');
  const wrong={...f,markets:fixture().markets};assert.equal(findScanCandidates(wrong).candidates.length,0);
});

test('inactive/no-bid contracts, RFQ, and above-spot strikes are excluded by default',()=>{
  const f=fixture(),c=f.markets[0].contracts[0];
  f.markets[0].contracts=[{...c,bid:0},{...c,symbol:'inactive',active:false}];
  f.entries.push({...entry(),id:'rfq',platform:'binance_rfq'});
  const m=findScanCandidates(f);assert.equal(m.candidates.length,0);assert.ok(has(m,'contract_inactive'));assert.ok(has(m,'unsupported_dual'));
  const high=fixture({K:90000});assert.equal(findScanCandidates(high).candidates.length,0);
  assert.equal(rankScanCombinations({...high,onlyBelowSpot:false}).rows.length,1);
});

test('original comparators enforce amount limits and preserve zero APR as a real quote',()=>{
  for(const platform of ['bybit','binance','okx']) {
    const high=fixture({entries:[entry(platform,{max:9999})]});const m=findScanCandidates(high);
    assert.equal(m.candidates.length,0);assert.ok(has(m,'dual_precheck_failed'));
  }
  const zero=rankScanCombinations(fixture({entries:[entry('bybit',{apr:0})]}));assert.equal(zero.rows.length,1);near(zero.rows[0].dual.income,0);
  const absent=entry();delete absent.data.quote.apyE8;
  assert.equal(findScanCandidates(fixture({entries:[absent]})).candidates.length,0);
});

test('missing and insufficient bid depth never use the directory bid as an executable fill',()=>{
  const f=fixture();assert.ok(has(rankScanCombinations({...f,books:[]}),'book_missing'));
  f.books[0].book.bids=[{price:1000,qty:.01}];const m=rankScanCombinations(f);
  assert.equal(m.rows.length,0);assert.ok(has(m,'depth_insufficient'));
});

test('market/book/source receipt ages and raw source skew have strict freshness boundaries',()=>{
  const f=fixture();
  const oldMarket=structuredClone(f);oldMarket.markets[0].receivedAt=now-30000;
  assert.ok(has(rankScanCombinations(oldMarket),'market_stale'));
  const oldBook=structuredClone(f);oldBook.books[0].receivedAt=now-30000;
  assert.ok(has(rankScanCombinations(oldBook),'book_stale'));
  const oldQuote=structuredClone(f);oldQuote.entries[0].data.receivedAt=now-30000;
  assert.ok(has(rankScanCombinations(oldQuote),'quote_stale'));
  const skew=structuredClone(f);skew.books[0].book.time=now-30001;
  assert.ok(has(rankScanCombinations(skew),'quote_skew'));
  const future=structuredClone(f);future.markets[0].receivedAt=now+1;
  assert.equal(rankScanCombinations(future).rows.length,0);
});

test('re-ranking at a new now removes quotes exactly when their actual validity expires',()=>{
  const f=fixture();assert.equal(rankScanCombinations({...f,now:now+19999}).rows.length,1);
  const expired=rankScanCombinations({...f,now:now+20000});assert.equal(expired.rows.length,0);
  assert.ok(has(expired,'dual_precheck_failed'));
});

test('negative differences remain signed and best benchmark is the highest final dual BTC, not the easiest opponent',()=>{
  const f=fixture({entries:[entry('bybit',{id:'weak',apr:.1}),entry('bybit',{id:'strong',apr:3})]});
  const m=rankScanCombinations(f);assert.equal(m.rows.length,2);
  assert.ok(m.rows[0].btcDifference>0);assert.ok(m.rows[1].btcDifference<0);
  assert.equal(m.rows[0].bestForContract,false);assert.equal(m.rows[1].bestForContract,true);
  assert.equal(m.rows[1].entry.id,'strong');assert.equal(m.stats.negativeRows,1);
});

test('default drop and execution gap are zero, so the default fixing is exactly at each strike',()=>{
  const f=fixture();delete f.dropRate;
  const m=rankScanCombinations(f);assert.equal(m.rows.length,1);assert.equal(m.dropRate,0);assert.equal(m.gapRate,0);
  const row=m.rows[0];near(row.scenarioPrice,row.contract.strike);near(row.model.purchasePrice,row.contract.strike);
  near(row.model.payout,0);near(row.model.deliveryFee,0);
});

test('an expired stronger quote cannot imply full-market best or suppress a currently valid source',()=>{
  const expired=entry('bybit',{id:'expired-strong',apr:3,quoteLife:0});
  const valid=entry('binance',{id:'current-weaker',apr:.1});
  const m=rankScanCombinations(fixture({entries:[expired,valid]}));assert.equal(m.rows.length,1);
  assert.equal(m.rows[0].entry.id,'current-weaker');assert.equal(m.rows[0].bestForContract,true);
  assert.equal(m.rows[0].benchmarkScope,'current_valid_quotes');assert.equal(m.coverage.completeMarketCoverage,false);
  assert.ok(has(m,'dual_precheck_failed'));
});

test('one failed source leaves other valid quotes eligible with an incomplete-sample scope',()=>{
  const failed=entry('bybit');failed.data={...failed.data,status:'error',reason:'公开源暂时不可用'};
  const m=rankScanCombinations(fixture({entries:[failed,entry('okx')]}));
  assert.equal(m.valid,true);assert.equal(m.rows.length,1);assert.equal(m.rows[0].dualPlatform,'okx');
  assert.equal(m.coverage.benchmarkScope,'current_valid_quotes');assert.equal(m.coverage.completeMarketCoverage,false);
  assert.ok(m.errors.some(error=>error.reason==='公开源暂时不可用'));
});

test('same PUT ties are deterministic under input permutation and only one highest benchmark is selected',()=>{
  const quotes=[entry('bybit',{id:'z'}),entry('bybit',{id:'a'})];
  const a=rankScanCombinations(fixture({entries:quotes})),b=rankScanCombinations(fixture({entries:quotes.slice().reverse()}));
  assert.deepEqual(a.rows.map(row=>row.id),b.rows.map(row=>row.id));
  assert.equal(a.rows[0].entry.id,'a');assert.equal(a.rows.filter(row=>row.bestForContract).length,1);
});

test('each strike uses the same relative decline and its own actual execution gap/step/cash limits',()=>{
  const f=fixture(),c=f.markets[0].contracts[0],other={...c,symbol:'lower-put',strike:70000};
  f.markets[0].contracts.push(other);f.entries.push(entry('binance',{K:70000}));
  f.books.push({platform:'bybit',symbol:other.symbol,receivedAt:now,book:{time:now,bids:[{price:1000,qty:3}]}});
  const m=rankScanCombinations({...f,dropRate:.1,gapRate:.002});assert.equal(m.rows.length,2);
  for(const row of m.rows) {
    near(row.scenarioPrice,row.contract.strike*.9);near(row.model.purchasePrice,row.scenarioPrice*1.002);
    assert.ok(row.model.cash>0);assert.equal(row.limits.roundingKnown,true);
    near(row.limits.headroom,row.scenarioPrice*row.btcDifference);
  }
});

test('zero fixing and below-minimum purchases remain pending and never enter BTC ranking',()=>{
  const zero=rankScanCombinations({...fixture(),dropRate:1});assert.equal(zero.rows.length,0);assert.ok(has(zero,'purchase_pending'));
  const f=fixture();f.markets[0].contracts[0].spotMin=1;
  const minimum=rankScanCombinations(f);assert.equal(minimum.rows.length,0);assert.ok(has(minimum,'purchase_pending'));
});

test('if the strongest comparable benchmark has unverified limits, a weaker one is not relabelled best',()=>{
  const f=fixture({step:1e-14,entries:[entry('bybit',{id:'weak',apr:.1}),entry('bybit',{id:'unverifiable',apr:1e15})]});
  const m=rankScanCombinations(f);assert.equal(m.rows.length,1);assert.equal(m.rows[0].entry.id,'weak');
  assert.equal(m.rows[0].bestForContract,false);assert.ok(has(m,'limits_unavailable'));assert.ok(has(m,'best_benchmark_unavailable'));
});

test('invalid scenarios and malformed inputs fail closed without mutating shared snapshots',()=>{
  const f=fixture(),before=structuredClone(f);rankScanCombinations(f);assert.deepEqual(f,before);
  for(const patch of [{amount:Infinity},{currency:'USD'},{dropRate:-.01},{dropRate:1.01},{gapRate:-1},{onlyBelowSpot:'false'}]) {
    const m=rankScanCombinations({...f,...patch});assert.equal(m.valid,false);assert.deepEqual(m.rows,[]);
  }
  const malformed=structuredClone(f);malformed.books[0].book.bids=[null];
  assert.equal(rankScanCombinations(malformed).rows.length,0);
  const unknown={...entry(),platform:'__proto__'};
  assert.equal(findScanCandidates(fixture({entries:[unknown]})).candidates.length,0);
});

test('the default seven-day boundary is inclusive and one extra millisecond is excluded by both APIs',()=>{
  const exact=fixture({entries:[entry('binance')]});
  const found=findScanCandidates(exact),ranked=rankScanCombinations(exact);
  assert.equal(found.candidates.length,1);assert.equal(ranked.rows.length,1);
  assert.equal(found.maxDays,7);assert.equal(ranked.maxDays,7);near(found.candidates[0].remainingDays,7);
  const beyond=fixture({T:expiry+1,entries:[entry('binance',{T:expiry+1})]});
  for(const m of [findScanCandidates(beyond),rankScanCombinations(beyond)]) {
    assert.equal(m.valid,true);assert.equal(m.candidates.length,0);
    assert.equal(m.stats.expirationOutsideRange,1);assert.ok(has(m,'expiration_outside_range'));
  }
  assert.equal(rankScanCombinations(beyond).rows.length,0);
});

test('remaining expiry time, rather than the product accrual duration, controls the day filter',()=>{
  const withinT=now+6*86400000,farT=now+8*86400000;
  const within=entry('binance',{T:withinT});within.data.product.duration=30;
  const far=entry('binance',{T:farT});far.data.product.duration=1;
  assert.equal(findScanCandidates(fixture({T:withinT,entries:[within]})).candidates.length,1);
  const excluded=findScanCandidates(fixture({T:farT,entries:[far]}));
  assert.equal(excluded.candidates.length,0);assert.ok(has(excluded,'expiration_outside_range'));
});

test('null explicitly allows far-dated expiry while still excluding already-expired contracts',()=>{
  const T=now+30*86400000,f=fixture({T,entries:[entry('binance',{T})]});
  assert.equal(findScanCandidates(f).candidates.length,0);
  const all=findScanCandidates({...f,maxDays:null}),ranked=rankScanCombinations({...f,maxDays:null});
  assert.equal(all.candidates.length,1);assert.equal(ranked.rows.length,1);
  assert.equal(all.maxDays,null);assert.equal(ranked.coverage.maxDays,null);near(all.candidates[0].remainingDays,30);
  const expired=fixture({T:now,entries:[entry('binance',{T:now})]});
  const old=findScanCandidates({...expired,maxDays:null});assert.equal(old.candidates.length,0);assert.ok(has(old,'contract_inactive'));
});

test('only null or positive finite day limits no greater than 3650 are accepted',()=>{
  const f=fixture();
  for(const maxDays of [0,-1,NaN,Infinity,-Infinity,3650.00001,'7','all',true,false,{}]) {
    for(const fn of [findScanCandidates,rankScanCombinations]) {
      const m=fn({...f,maxDays});assert.equal(m.valid,false);assert.equal(m.candidates.length,0);
      assert.ok(has(m,'input_invalid'));
    }
  }
  assert.equal(findScanCandidates({...f,maxDays:3650}).valid,true);
  const T=now+12*3600000,half=fixture({T,entries:[entry('binance',{T})]});
  assert.equal(findScanCandidates({...half,maxDays:.5}).candidates.length,1);
  assert.equal(findScanCandidates({...half,maxDays:.5-1/86400000}).candidates.length,0);
});

test('the range uses market server time plus local elapsed receipt time, not the local absolute clock',()=>{
  const serverTime=now+3600000,elapsed=5000,T=serverTime+elapsed+7*86400000;
  const quote=entry('binance',{T});quote.data.serverTime=serverTime;
  const f=fixture({T,entries:[quote]});f.markets[0].time=serverTime;f.books[0].book.time=serverTime;
  const found=findScanCandidates({...f,now:now+elapsed}),ranked=rankScanCombinations({...f,now:now+elapsed});
  assert.ok(T-(now+elapsed)>7*86400000); // The local wall clock would wrongly exclude it.
  assert.equal(found.candidates.length,1);near(found.candidates[0].remainingDays,7);
  assert.equal(ranked.rows.length,1);near(ranked.rows[0].model.days,7);
  const over=structuredClone(f);over.markets[0].time=serverTime-1;
  const excluded=findScanCandidates({...over,now:now+elapsed});
  assert.equal(excluded.candidates.length,0);assert.ok(has(excluded,'expiration_outside_range'));
});

test('candidate horizon and model annualization share the market clock when the book is five seconds older',()=>{
  const f=fixture({entries:[entry('binance')]});
  f.books[0].book.time=now-5000;f.entries[0].data.serverTime=now-5000;
  const found=findScanCandidates(f),ranked=rankScanCombinations(f);
  assert.equal(found.candidates.length,1);assert.equal(ranked.rows.length,1);
  const row=ranked.rows[0];near(found.candidates[0].remainingDays,7);
  assert.equal(row.scanClock,now);near(row.model.days,7);near(row.model.annual,row.model.term*365/7,1e-12);
  const beyond=fixture({T:expiry+1,entries:[entry('binance',{T:expiry+1})]});
  beyond.books[0].book.time=now-5000;beyond.entries[0].data.serverTime=now-5000;
  assert.equal(findScanCandidates(beyond).candidates.length,0);
  const rejected=rankScanCombinations(beyond);assert.equal(rejected.rows.length,0);assert.ok(has(rejected,'expiration_outside_range'));
});

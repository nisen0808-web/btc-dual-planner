import assert from 'node:assert/strict';
import test from 'node:test';
import {quoteSpotPut, spotPutOutcome} from '../web/spot-put-math.js';

const now = Date.UTC(2026,10,14,10,35,22), expiry = Date.UTC(2026,10,16,8);
const near = (a,b) => assert.ok(Math.abs(a-b) < 1e-6,`${a} != ${b}`);
function inputs() {
  const symbol = 'BTC-261116-67000-P';
  const contract = {symbol,expires:expiry,optionType:'PUT',underlying:'BTCUSDT',settleCoin:'USDT',
    status:'TRADING',strike:67_000,unit:1,step:0.01,min:0.01,max:200,
    taker:0.00024,cap:0.1,delivery:0.00015,deliveryCap:0.1};
  const source = {status:'ready',platform:'binance',currency:'USDT',sourceType:'official_public_api',time:now,receivedAt:now};
  const market = {...source,contracts:[contract],metadataTime:now,indexTime:now,spot:67_244.06282609};
  const book = {...source,symbol,bids:[{price:605,qty:11}],asks:[{price:610,qty:11}]};
  return {market,book,contract,now,spotBTC:1.04,entryPrice:80_000,coverage:2};
}

test('overhedge splits historical cost, incremental performance, intrinsic, and exercise fees', () => {
  const q = quoteSpotPut(inputs());
  assert.equal(q.valid,true,q.reason);
  assert.equal(q.putBTC,2.08);
  near(q.cost,1302.3682361627841);
  const p = spotPutOutcome(q,65_000);
  near(p.spotPnl,-15600);
  near(p.putPnl,2837.3517638372155);
  near(p.exerciseFee,20.28);
  near(p.totalPnl,-12762.648236162785);
  near(p.totalFromNow,503.526424703618);
  assert.equal(q.downsideStatus,'threshold');
  assert.equal(q.downsideStatusFromNow,'threshold');
  near(spotPutOutcome(q,q.lowerBreakEven).totalPnl,0);
  near(q.lowerBreakEvenFromNow,65484.01481930767);
});

test('1:1 can protect against further declines without recovering past losses, including at zero', () => {
  const q = quoteSpotPut({...inputs(),coverage:1});
  assert.equal(q.downsideStatus,'unreachable');
  assert.equal(q.lowerBreakEven,null);
  const zero = spotPutOutcome(q,0);
  assert.equal(zero.exerciseFee,0);
  near(zero.totalPnl,1.04 * (67000-80000) - q.cost);
  const atStrike = spotPutOutcome(q,67000);
  near(atStrike.putPnl,-q.cost);
  near(spotPutOutcome(q,66999).exerciseFee,0.104);
});

test('prices all required ask levels, applying the published fee cap to each fill', () => {
  const a = inputs();
  a.book.bids = [{price:9,qty:100}];
  a.book.asks = [{price:10,qty:1},{price:610,qty:2}];
  const q = quoteSpotPut(a);
  assert.equal(q.levelsUsed,2);
  near(q.premium,10 + 1.08*610);
  near(q.openingFee,1 + 1.08*a.market.spot*0.00024);
  near(q.averageAsk,q.premium/2.08);
});

test('real lot sizing rounds decimal targets down without binary rounding moving a whole lot', () => {
  const a = inputs();
  const q = quoteSpotPut({...a,spotBTC:0.29,coverage:1.5});
  assert.equal(q.contracts,0.43);
  const q2 = quoteSpotPut({...a,spotBTC:0.29,coverage:2});
  assert.equal(q2.contracts,0.58);
});

test('declines crossed books, insufficient depth, mismatched or stale metadata, settlement input and contract limits', () => {
  const edits = [
    a => a.book.asks[0].qty = 2,
    a => a.book.bids[0].price = 610,
    a => a.book.time -= 30_000,
    a => a.market.indexTime -= 30_000,
    a => a.market.metadataTime += 3_000,
    a => a.contract.optionType = 'CALL',
    a => a.contract.expires += 86400000,
    a => a.book.platform = 'okx',
    a => a.contract.delivery = null,
    a => a.contract.max = 2
  ];
  for (const edit of edits) {
    const a = inputs(); edit(a);
    assert.equal(quoteSpotPut(a).valid,false);
  }
  assert.equal(spotPutOutcome(quoteSpotPut(inputs()),-1).valid,false);
});

test('separates already profitable downside from nonpositive recovery and roots on the zero boundary', () => {
  const a = inputs();
  Object.assign(a.contract,{delivery:0,taker:0});
  a.book.asks = [{price:625,qty:100}];
  const atZero = quoteSpotPut({...a,spotBTC:1,coverage:2,entryPrice:132750});
  assert.equal(atZero.downsideStatus,'zero_only');
  assert.equal(atZero.lowerBreakEven,null);
  const flat = quoteSpotPut({...a,spotBTC:1,coverage:1,entryPrice:66_375});
  assert.equal(flat.downsideStatus,'break_even_floor');
  const ahead = quoteSpotPut({...a,spotBTC:1,entryPrice:50000});
  assert.equal(ahead.downsideStatus,'already_profitable');
  const tooFar = quoteSpotPut({...a,spotBTC:1,entryPrice:140000});
  assert.equal(tooFar.downsideStatus,'unreachable');
});

function venueInputs(venue, friday = true) {
  const okx = venue === 'okx';
  const expires = Date.UTC(2026,10,friday ? 20 : 16,8);
  const prefix = okx ? 'BTC-USD-2611' : 'BTC_USDC-';
  const symbol = prefix + (friday ? '20' : '16') + (okx ? '' : 'NOV26') + '-67000-P';
  const coin = okx ? 'BTC' : 'USDC';
  const contract = {symbol,expires,direction:'PUT',strike:67000,unit:okx ? 0.01 : 1,min:okx ? 1 : 0.1,
    step:okx ? 1 : 0.1,coin,settleCoin:coin,taker:okx ? 0.0003 : 0.001,cap:okx ? 0.07 : 0.125,
    max:okx ? 1000 : undefined,delivery:okx ? 0.0002 : null,deliveryCap:okx ? 0.07 : null};
  const market = {status:'ready',platform:venue,contracts:[contract],spot:67500,indexCoin:okx ? 'USD' : 'USDC',
    time:now,indexTime:now,spotUSDT:okx ? 68175 : null,indexUSDTTime:okx ? now : null};
  const book = {status:'ready',platform:venue,time:now,symbol,currency:coin,quoteCoin:coin,settleCoin:coin,bids:[],
    asks:okx ? [{price:0.004,qty:100},{price:0.006,qty:120}] : [{price:400,qty:1},{price:800,qty:2}]};
  const fx = {usdcUSDT:1.02,usdcTime:now,usdcSource:'USDC/USDT order book',btcUSDT:70000,btcTime:now,btcSource:'BTC/USDT order book'};
  return {venue,market,contract,book,fx,now,spotBTC:1,entryPrice:80000,coverage:2};
}

test('OKX inverse Friday put fills in BTC, prices cash outlay at purchase and pays BTC at settlement', () => {
  const q = quoteSpotPut(venueInputs('okx'));
  assert.equal(q.valid,true,q.reason);
  assert.equal(q.valuationReady,true);
  assert.equal(q.contracts,200);
  near(q.strikeFx,1.01);
  near(q.nativePremium,0.010);
  near(q.nativeOpeningFee,0.00058);
  near(q.cost,0.01058*68175);
  const p = spotPutOutcome(q,60600); // native USD settlement 60,000.
  near(p.nativePayoff,2*7000/60000);
  near(p.nativeExerciseFee,0.0004);
  near(p.exerciseFee,24.24);
  near(p.putPnl,2*7000*1.01-24.24-q.cost);
  near(spotPutOutcome(q,q.lowerBreakEven).totalPnl,0);
  assert.equal(spotPutOutcome(q,0).valid,false);
  near(spotPutOutcome(q,67669).exerciseFee,0.14); // at 1 USDT below converted strike, 7% cap
});

test('Coinbase linear USDC put uses the App taker fee, live stablecoin FX and Deribit delivery rule', () => {
  const q = quoteSpotPut(venueInputs('coinbase'));
  assert.equal(q.valid,true,q.reason);
  assert.equal(q.contracts,2);
  near(q.index,68850);
  near(q.nativeCost,1200+50+67.5);
  near(q.cost,1317.5*1.02);
  const p = spotPutOutcome(q,61200);
  near(p.nativePayoff,14000);
  near(p.nativeExerciseFee,18);
  near(p.putPnl,(14000-18-1317.5)*1.02);
  near(p.spotPnl,61200-80000);
  near(spotPutOutcome(q,q.lowerBreakEvenFromNow).totalFromNow,0);
  near(spotPutOutcome(q,68339).exerciseFee,0.25);
  assert.equal(spotPutOutcome(q,0).valid,true);
});

test('non-Friday day options have no delivery fee on either venue', () => {
  for (const venue of ['coinbase','okx']) {
    const q = quoteSpotPut(venueInputs(venue,false));
    assert.equal(q.valuationReady,true,q.reason);
    assert.equal(spotPutOutcome(q,60000).exerciseFee,0);
  }
});

test('FX gaps preserve native premiums without using old FX or treating null as par; timestamped OKX fallback works', () => {
  for (const venue of ['coinbase','okx']) {
    const a = venueInputs(venue);
    a.market.indexUSDTTime = now-31000;
    if (venue === 'okx') near(quoteSpotPut(a).fxRate,70000);
    a.fx.usdcTime = now-31000;
    a.fx.btcTime = now-31000;
    const q = quoteSpotPut(a);
    assert.equal(q.valid,true,q.reason);
    assert.equal(q.valuationReady,false);
    assert.ok(q.nativeCost>0);
    for (const n of [q.cost,q.index,q.strike,q.lowerBreakEven]) assert.equal(n,null);
    assert.equal(spotPutOutcome(q,60000).valid,false);
  }
});

test('no use of price from a different venue or contract, missing fee and unilateral malformed depth', () => {
  const wrong = venueInputs('okx');
  wrong.book.platform = 'coinbase';
  assert.equal(quoteSpotPut(wrong).valid,false);
  wrong.book.platform = 'okx'; wrong.book.symbol = 'BTC-USD-261120-70000-P';
  assert.equal(quoteSpotPut(wrong).valid,false);
  const noFee = venueInputs('coinbase');
  noFee.contract.taker = null;
  const q = quoteSpotPut(noFee);
  assert.equal(q.valuationReady,false);
  assert.equal(q.nativePremium,1200);
  assert.equal(q.nativeCost,null);
  const noDepth = venueInputs('okx'); noDepth.book.asks[1].qty = 30;
  assert.equal(quoteSpotPut(noDepth).valid,false);
});

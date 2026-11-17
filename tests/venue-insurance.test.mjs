import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateVenueInsurance as insure} from '../web/venue-insurance.js';

const now = Date.UTC(2026,10,14,8), expires = Date.UTC(2026,10,16,8);
const strike = 70_000, spot = 67_500;
const near = (a,b) => assert.ok(Math.abs(a-b) < 1e-9, `${a} != ${b}`);
function symbol(venue, direction, strike, expiry = expires) {
  const day = new Date(expiry).getUTCDate();
  return (venue === 'binance' ? 'BTC-2611' + day : venue === 'okx' ? 'BTC-USD-2611' + day : 'BTC_USDC-' + day + 'NOV26') + '-' + strike + '-' + direction[0];
}
function setup(venue = 'okx', dualVenue = 'okx', direction = 'CALL') {
  const inverse = venue === 'okx';
  const coin = {okx:'BTC',coinbase:'USDC',binance:'USDT'}[venue];
  const amount = direction === 'CALL' ? 1.04 : 70_000;
  const investCoin = direction === 'CALL' ? 'BTC' : 'USDT';
  const id = symbol(venue,direction,strike);
  return {optionVenue:venue,dualVenue,source:'dual',direction,amount,strike,expires,now,
    fx:{btcUSDT:67_600,btcTime:now,usdcUSDT:0.997,usdcTime:now},
    market:{status:'ready',platform:venue,spot,indexTime:now,time:now},
    contract:{symbol:id,direction,settleCoin:coin,expires,strike,unit:inverse?.01:1,min:inverse?1:.01,step:inverse?1:.01,
      max:1_000,taker:inverse?.0003:venue==='coinbase'?.001:.00024,cap:inverse?.07:venue==='coinbase'?.125:.1},
    book:{status:'ready',platform:venue,symbol:id,time:now,
      bids:[{price:inverse?.0008:45,qty:5}],asks:[{price:inverse?.001:50,qty:inverse?60:.6},{price:inverse?.002:60,qty:inverse?180:1.8}]},
    dual:{valid:true,quoteTime:now,income:amount*.001,coin:investCoin,
      ...(dualVenue === 'binance' ? {ordinary:true,productExpiry:expires,rateExpiry:now+29_000,amount,
        product:{optionType:direction,investCoin,exercisedCoin:direction==='CALL'?'USDT':'BTC',strikePrice:String(strike),settleDate:expires}} :
        {productId:symbol('okx',direction,strike).replace('BTC-USD-','BTC-USDT-')})}};
}
function changeContract(i, k, expiry) {
  i.hedgeStrike=k; i.hedgeExpires=expiry;
  const id=symbol(i.optionVenue,i.direction,k,expiry);
  Object.assign(i.contract,{symbol:id,strike:k,expires:expiry});
  i.book.symbol=id;
}

test('both directions × all six pairs use the actual selected venue and cover the dual principal plus interest',()=>{
  for (const venue of ['binance','okx','coinbase']) for (const dual of ['binance','okx']) for (const side of ['CALL','PUT']) {
    const i=setup(venue,dual,side), a=insure(i);
    assert.equal(a.valid,true,a.reason);
    assert.equal(a.symbol,i.contract.symbol);
    assert.equal(a.netCoin,i.contract.settleCoin);
    near(a.targetBTC,side==='CALL'?1.04104:1.001);
    near(a.coveredBTC,side==='CALL'?1.04:1);
    near(a.uncoveredBTC,a.targetBTC-a.coveredBTC);
    assert.equal(a.levelsUsed,2);
    assert.ok(Number.isFinite(a.annual));
    assert.equal(a.maxExpiryLoss,null);
  }
});
test('OKX inverse quote is natively denominated in BTC and caps taker fee at each fill',()=>{
  const i=setup();
  i.fx={};
  const a=insure(i),premium=.60*.001+.44*.002;
  near(a.premium,premium);near(a.openingFee,premium*.07);near(a.cost,premium*1.07);
  near(a.netIncome,.00104-premium*1.07);
  near(a.term,a.netIncome/(1.04+a.cost));assert.equal(a.netIncomeUSDT,null);
  near(a.annual,a.term*365/2);
});
test('a partially subscribed dual earns and hedges on deployed funds while the comparison return includes idle funds',()=>{
  const i=setup('okx','binance');
  i.amount=1.05;i.dual.amount=1;i.dual.income=.001;
  const same=insure(i);assert.equal(same.valid,true,same.reason);
  near(same.targetBTC,1.001);near(same.coveredBTC,1);
  near(same.netIncome,.001-same.cost);near(same.term,same.netIncome/(1.05+same.cost));
  changeContract(i,strike,expires+DAY);
  const later=insure(i);assert.equal(later.valid,true,later.reason);
  near(later.netIncome,.001-later.cost);assert.equal(later.annual,null);assert.equal(later.term,null);
});
test('Coinbase/App uses its own USDC option fee and BTC/USDC index; no stablecoin par assumption',()=>{
  const i=setup('coinbase'),a=insure(i);
  near(a.cost,(.6*50+.44*60)*1.125);
  near(a.netIncome,i.dual.income*spot-a.cost);near(a.netIncomeUSDT,a.netIncome*.997);
  const p=setup('coinbase','binance','PUT');
  const put=insure(p);near(put.netIncome,p.dual.income/.997-put.cost);
  p.fx.usdcTime=now-30_000;
  const stale=insure(p);assert.equal(stale.valid,true);assert.equal(stale.netIncome,null);assert.equal(stale.annual,null);
  assert.ok(stale.cost>0);assert.match(stale.valuationReason,/汇率/);
});
test('missing source, wrong venue, stale/unsynced books, crossed books, insufficient depth or wrong expiry fail closed',()=>{
  for(const mutate of [
    i=>i.book.platform='binance', i=>i.market.platform='coinbase', i=>i.book.symbol='BTC-USD-261118-70000-C',
    i=>i.book.time=now-30_000, i=>{i.market.indexTime=now+1999; i.dual.quoteTime=now-29_000;},
    i=>i.book.asks=[], i=>i.book.asks=[{price:.001,qty:1}], i=>i.book.bids[0].price=.001,
    i=>i.contract.settleCoin='USDT', i=>i.dual.productId='BTC-USDT-261117-70000-C', i=>i.contract.max=1]) {
    const i=setup();mutate(i);
    assert.equal(insure(i).valid,false);
  }
});
test('undetermined fees preserve premium but suppress net and APR',()=>{
  const i=setup();i.contract.taker=null;
  const r=insure(i);assert.ok(r.premium>0);assert.equal(r.openingFee,null);assert.equal(r.cost,null);assert.equal(r.netIncome,null);assert.equal(r.annual,null);
});
test('the spread must be equal-sized, matched and on the same venue; original and later maturity yield different outputs',()=>{
  for (const v of ['binance','coinbase','okx']) {
    const i=setup(v);i.source='option';i.short={valid:true,coin:i.contract.settleCoin,coveredBTC:1.04,
      quoteTime:now,symbol:i.contract.symbol,income:v==='okx'?.003:150,conditional:true};
    assert.equal(insure(i).valid,false);
    changeContract(i,71_500,expires);
    const spread=insure(i);assert.equal(spread.valid,true,spread.reason);assert.equal(spread.conditional,true);
    near(spread.netIncome,i.short.income-spread.cost);
    if(v!=='okx') near(spread.maxExpiryLoss,1.04*1500-spread.netIncome); else assert.equal(spread.maxExpiryLoss,null);
    i.short.coveredBTC=.255;assert.equal(insure(i).valid,false);
    i.short.coveredBTC=1;changeContract(i,strike,expires+DAY);
    const later=insure(i);assert.equal(later.valid,true,later.reason);
    assert.equal(later.annual,null);assert.equal(later.term,null);assert.equal(later.maxExpiryLoss,null);
    assert.ok(Number.isFinite(later.netIncome));
    i.short.quoteTime=now-30_000;assert.equal(insure(i).valid,false);
  }
});
const DAY=86_400_000;

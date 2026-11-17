import test from 'node:test';
import assert from 'node:assert/strict';
import { calculate, calculateSimulation } from './web/calc.js';

const now = Date.UTC(2026, 9, 22, 8);
const contract = { symbol:'BTC-29OCT26-90000-P', strike:90000, expires:now+7*86400000,
  step:.01, min:.01, taker:.0003, cap:.125, delivery:.00015, spot:.0005 };
const book = { bids:[{price:900,qty:1}], time:now };
const sim = (A=10000, c=contract, ST=70000, gap=0, b=book, buffer=0) =>
  calculateSimulation(A,c,b,100000,now,ST,buffer,gap);
const near = (a,b,t=1e-7) => assert.ok(Math.abs(a-b)<t,`${a} != ${b}`);
function ledger(m) {
  assert.equal(m.valid,true);
  near(m.afterSettlementCash,m.amount+m.gross-m.openFee-m.payout-m.deliveryFee);
  near(m.cash+m.purchaseCash,m.afterSettlementCash);
  near(m.assets,m.cash+m.btcReceived*m.expiryPrice);
  near(m.pnl,m.scenarioNetIncome-m.payout);
  near(m.portfolioTerm,m.pnl/m.amount);
  assert.ok(m.capital+m.feeReserve+m.buyBufferReserve<=m.amount+1e-8);
}

test('triggered quote-fee simulation spends the whole settled strategy balance',()=>{
  const m=sim(); ledger(m);
  near(m.q,.11);near(m.payout,2200);near(m.openFee,3.3);near(m.deliveryFee,1.155);
  near(m.afterSettlementCash,7894.545);
  near(m.purchaseCash,7894.545);near(m.spotFee,7894.545*.0005/1.0005);
  near(m.btcReceived,7894.545/(70000*1.0005));near(m.cash,0);
  assert.ok(m.btcReceived>m.q);assert.equal(m.purchaseExecuted,true);
  near(m.actualCost,10000/m.btcReceived);assert.equal(m.roundingKnown,false);
  near(m.netIncome,95.7);near(m.term,.00957);near(m.annual,.00957*365/7);
});

test('base-deducted fees reduce all-balance net BTC and are not charged twice in cash',()=>{
  const m=sim(10000,{...contract,spot:.001,spotDeductBase:true});ledger(m);
  near(m.grossBtc,m.afterSettlementCash/70000);
  near(m.btcReceived,m.grossBtc*.999);near(m.spotFee,m.afterSettlementCash*.001);
  near(m.purchaseCash,m.afterSettlementCash);near(m.cash,0);
  near(m.assets,m.afterSettlementCash-m.spotFee);
  near(m.scenarioNetIncome,m.netIncome-m.deliveryFee-m.spotFee);
});

test('untriggered funds stay in cash without spot or delivery fees',()=>{
  const m=sim(10000,contract,100000,.02);ledger(m);
  assert.equal(m.triggered,false);assert.equal(m.purchaseStatus,'not_triggered');
  assert.equal(m.purchaseExecuted,false);near(m.cash,10095.7);
  near(m.btcReceived,0);near(m.purchaseCash,0);near(m.spotFee,0);near(m.deliveryFee,0);
  near(m.scenarioNetIncome,m.netIncome);assert.equal(m.actualCost,null);
});

test('ATM uses <= trigger, no payout/delivery, and converts principal plus net premium',()=>{
  const m=sim(10000,contract,90000);ledger(m);
  assert.equal(m.triggered,true);near(m.payout,0);near(m.deliveryFee,0);
  near(m.purchaseCash,10095.7);near(m.btcReceived,10095.7/(90000*1.0005));near(m.cash,0);
});

test('zero fixing preserves finite cash pending purchase rather than inventing BTC',()=>{
  const m=sim(10000,contract,0);ledger(m);
  assert.equal(m.triggered,true);assert.equal(m.purchaseExecuted,false);
  assert.equal(m.purchaseStatus,'zero_price');assert.equal(m.zeroPriceStress,true);
  near(m.btcReceived,0);near(m.purchaseCash,0);near(m.cash,195.7);near(m.spotFee,0);
  assert.equal(m.actualCost,null);
});

test('positive and negative execution gaps change net BTC, not all-in spending',()=>{
  for(const base of [false,true]) {
    const c={...contract,spot:.001,spotDeductBase:base};
    const low=sim(10000,c,70000,-.01), mid=sim(10000,c,70000), high=sim(10000,c,70000,.01);
    for(const m of [low,mid,high])ledger(m);
    assert.ok(low.btcReceived>mid.btcReceived&&mid.btcReceived>high.btcReceived);
    near(low.purchaseCash,high.purchaseCash);near(high.purchasePrice,70700);
    near(high.spotGapRate,.01);
    near(high.basisCost,high.btcReceived*700);assert.ok(low.basisCost<0);
  }
});

test('spot lot rounding keeps only the actual leftover, including when below the minimum',()=>{
  const c={...contract,spotStep:.0001,spotMin:.0001};
  const m=sim(10000,c);ledger(m);
  near(m.grossBtc,.1127);near(m.purchaseCash,.1127*70000*1.0005);
  near(m.cash,m.afterSettlementCash-m.purchaseCash);
  assert.ok(m.cash>=0&&m.cash<.0001*70000*1.0005);
  assert.equal(m.roundingKnown,true);
  const small=sim(10000,{...c,spotMin:.2});ledger(small);
  assert.equal(small.purchaseStatus,'below_spot_minimum');near(small.btcReceived,0);
  near(small.cash,small.afterSettlementCash);near(small.spotFee,0);
  const notional=sim(10000,{...c,spotMinNotional:8000});ledger(notional);
  assert.equal(notional.purchaseStatus,'below_spot_minimum');near(notional.btcReceived,0);
  near(notional.cash,notional.afterSettlementCash);near(notional.purchaseCash,0);
});

test('reserve covers full-balance fee upper bound and is not charged as another fee',()=>{
  for(const base of [false,true]) {
    const c={...contract,spot:.001,spotDeductBase:base};
    const m=sim(10000,c,90000);ledger(m);
    const alpha=base?.001:.001/1.001;
    near(m.spotFeeReserve,alpha*(10000+m.gross));
    near(m.feeReserve,m.openFee+m.deliveryFeeReserve+m.spotFeeReserve);
    assert.ok(m.spotFee<=m.spotFeeReserve);assert.ok(m.deliveryFee<=m.deliveryFeeReserve);
    near(m.afterSettlementCash,10000+m.netIncome);
    near(m.assets,10000+m.netIncome-m.spotFee);
  }
});

test('large premium never funds a larger-than-capital PUT and buffer only reduces size',()=>{
  const richBook={bids:[{price:100000,qty:10}],time:now};
  const m=sim(10000,contract,70000,0,richBook);ledger(m);
  assert.ok(m.capital<=10000);assert.ok(m.reserve<=10000);assert.ok(m.gross>10000);
  const buffered=sim(10000,contract,70000,0,book,.02);ledger(buffered);
  assert.ok(buffered.q<sim().q);near(buffered.buyBufferReserve,buffered.capital*.02);
  near(buffered.afterSettlementCash,10000+buffered.gross-buffered.openFee-buffered.payout-buffered.deliveryFee);
});

test('delivery cap is independent of the opening fee cap, defaults to 12.5%, and respects zero daily fee',()=>{
  const c={...contract,cap:.07};
  const m=sim(10000,c,89999);ledger(m);near(m.deliveryFee,.125*m.q);
  const explicit=sim(10000,{...c,deliveryCap:.2},89999);near(explicit.deliveryFee,.2*explicit.q);
  const daily=sim(10000,{...c,delivery:0},70000);ledger(daily);near(daily.deliveryFee,0);
});

test('uses each visible bid and per-fill opening cap, fails closed on missing depth',()=>{
  const m=sim(10000,contract,70000,0,{bids:[{price:100,qty:.05},{price:50,qty:.2}],time:now});
  ledger(m);near(m.gross,8);near(m.openFee,1);assert.equal(m.levelsUsed,2);
  const short=sim(10000,contract,70000,0,{bids:[{price:900,qty:.05}],time:now});
  assert.equal(short.valid,false);assert.match(short.errors[0],/深度不足/);
});

test('invalid, expired, stale, impossible fee and unsafe precision inputs are rejected',()=>{
  for(const gap of [-1,-2,NaN,Infinity])assert.equal(sim(10000,contract,70000,gap).valid,false);
  for(const A of ['',0,-1,Infinity,NaN,1e20])assert.equal(sim(A).valid,false);
  for(const c of [{...contract,expires:now},{...contract,deliveryCap:Infinity},{...contract,spotDeductBase:true,spot:1},
    {...contract,spotStep:0},{...contract,spotStep:1e-15},{...contract,spotMin:-1},
    {...contract,spotMinNotional:-1}])assert.equal(sim(10000,c).valid,false);
  assert.equal(sim(100).valid,false);
  assert.equal(sim(10000,contract,70000,0,{...book,time:now-181000}).valid,false);
  assert.equal(sim(10000,contract,70000,0,{...book,time:Infinity}).valid,false);
});

test('legacy fixed-quantity calculator remains unchanged for execution consumers',()=>{
  const m=calculate(10000,contract,book,100000,now,70000);
  near(m.q,.11);near(m.btcReceived,.11);near(m.cash,190.695);near(m.spotFee,3.85);
  assert.equal(m.simulationOnly,undefined);assert.equal(m.afterSettlementCash,undefined);
});

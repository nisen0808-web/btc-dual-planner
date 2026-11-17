import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateSimulation } from './web/calc.js';
import { compareBinanceDual } from './web/binance-dual.js';
import { computeSettlementLimits } from './web/settlement-limits.js';

const now=Date.UTC(2026,9,22,8),expiry=now+8*86400000;
const near=(a,b,t=1e-8)=>assert.ok(Math.abs(a-b)<=t,`${a} != ${b}`);
function fixture({A=10000,ST=75000,gap=0,base=true,fee,step,spotMin,spotMinNotional,apr='0.4761'}={}) {
  const contract={strike:80000,expires:expiry,step:.01,min:.01,taker:.0003,cap:.07,delivery:.00015,
    deliveryCap:.125,spot:fee??(base?.001:.0005),spotDeductBase:base,spotStep:step,spotMin,spotMinNotional};
  const book={bids:[{price:1065,qty:3}],time:now};
  const put={...calculateSimulation(A,contract,book,81272.84510255,now,ST,0,gap),expires:expiry,currency:'USDT'};
  assert.equal(put.valid,true);
  const product={id:'fixture',investCoin:'USDT',exercisedCoin:'BTC',strikePrice:'80000',duration:8,settleDate:expiry,
    purchaseDecimal:2,purchaseEndTime:now+86400000,canPurchase:true,apr,minAmount:'20',maxAmount:'20000',optionType:'PUT'};
  const data={status:'ready',product,quote:{source:'Binance 普通双币'},serverTime:now,fetchedAt:now,receivedAt:now,
    currency:'USDT',contract:{strike:80000,expires:expiry}};
  const dual=compareBinanceDual(A,put,data,now);assert.equal(dual.valid,true,dual.reason);
  return {put,dual,contract,book};
}
function checked(f) {
  const m=computeSettlementLimits(f.put,f.dual,f.contract);assert.equal(m.valid,true,m.reason);
  assert.equal(m.kind,'btc');near(m.headroom,f.put.expiryPrice*(f.put.btcReceived-f.dual.dualBtc));
  near(m.budgetGross,f.put.amount+f.put.gross-f.put.payout-f.dual.dualBtc*f.put.expiryPrice);
  near(m.actualFees,f.put.totalFee);near(m.currentCosts,f.put.totalFee+f.put.basisCost);
  near(m.currentUse,m.currentCosts+f.put.cash);near(m.cashOccupancy,f.put.cash);
  assert.ok(m.atLimitBtc>=f.dual.dualBtc-1e-14);
  assert.ok(m.aboveLimitBtc===null||m.aboveLimitBtc<f.dual.dualBtc);
  assert.ok(m.atFeeLimitBtc>=f.dual.dualBtc-1e-14);
  assert.ok(m.aboveFeeLimitBtc===null||m.aboveFeeLimitBtc<f.dual.dualBtc);
  assert.equal(m.feesAndGapShareHeadroom,true);assert.equal(m.priceThresholdEstimateOnly,true);
  return m;
}

test('zero-gap continuous base and quote fees give verified price and extra-fee limits',()=>{
  for(const base of [false,true]) {
    const f=fixture({base});const m=checked(f);
    assert.equal(m.roundingKnown,false);assert.equal(m.quantityEstimateOnly,true);near(m.currentGapRate,0);
    const beta=base?1-f.contract.spot:1,a=base?1:1+f.contract.spot;
    near(m.requiredGrossAtCurrentPrice,f.dual.dualBtc/beta,1e-14);
    near(m.extraFeeHeadroom,f.put.afterSettlementCash-a*f.put.purchasePrice*m.requiredGrossAtCurrentPrice);
    near(m.maxPurchasePrice,f.put.afterSettlementCash/(a*(f.dual.dualBtc/beta)),1e-7);
    near(m.maxGapRate,m.maxPurchasePrice/f.put.expiryPrice-1,1e-14);
  }
});

test('price boundary and slightly worse price reproduce the real calculator net BTC',()=>{
  for(const base of [false,true])for(const step of [undefined,.0001]) {
    const f=fixture({base,step,gap:.001}),m=checked(f);
    const recalc=price=>calculateSimulation(f.put.amount,f.contract,f.book,81272.84510255,now,f.put.expiryPrice,0,price/f.put.expiryPrice-1);
    const at=recalc(m.maxPurchasePrice),above=recalc(m.probePrice);
    assert.equal(at.valid,true);assert.equal(above.valid,true);
    near(at.btcReceived,m.atLimitBtc,1e-13);
    near(above.btcReceived,m.aboveLimitBtc??0,1e-13);
    assert.ok(at.btcReceived>=f.dual.dualBtc-1e-14);assert.ok(above.btcReceived<f.dual.dualBtc);
  }
});

test('step ceilings are sufficient and one less lot violates the target or minimum',()=>{
  for(const base of [false,true]) {
    const f=fixture({base,step:.0001,A:10000.019}),m=checked(f);
    assert.equal(m.roundingKnown,true);assert.ok(m.cashOccupancy>0);
    const beta=base?1-f.contract.spot:1,g=m.requiredGrossAtCurrentPrice;
    assert.ok(g*beta>=f.dual.dualBtc-1e-14);
    assert.ok((g-f.contract.spotStep)*beta<f.dual.dualBtc);
    near(m.headroom,m.budgetGross-m.actualFees-m.gapImpact-m.cashOccupancy);
    // A cash leftover is disclosed as occupancy, never charged again as a fee.
    near(m.actualFees,f.put.openFee+f.put.deliveryFee+f.put.spotFee);
  }
});

test('known minimum quantity can determine the maximum price and makes the worse probe unfillable',()=>{
  const f=fixture({base:false,step:.0001,spotMin:.1267});const m=checked(f);
  near(m.targetGrossAtPriceLimit,.1267);assert.equal(m.aboveLimitBtc,null);
  assert.equal(m.abovePriceLimit.purchaseExecuted,false);assert.ok(m.atLimitBtc>f.dual.dualBtc);
});

test('minimum notional constrains the current fee headroom and is checked at the price limit',()=>{
  const f=fixture({base:true,step:.0001,spotMinNotional:9500});const m=checked(f);
  assert.ok(m.requiredGrossAtCurrentPrice*f.put.purchasePrice>=9500);
  assert.ok((m.requiredGrossAtCurrentPrice-f.contract.spotStep)*f.put.purchasePrice<9500);
  assert.ok(m.atPriceLimit.grossBtc*m.maxPurchasePrice>=9500);
  assert.equal(m.aboveFeeLimitBtc,null);
});

test('an exact minimum-notional boundary permits no extra fee even with more current BTC',()=>{
  const contract={strike:100,expires:expiry,step:.01,min:.01,taker:0,cap:.125,delivery:0,spot:0,
    spotDeductBase:false,spotMinNotional:100};
  const put={...calculateSimulation(100,contract,{bids:[{price:10,qty:10}],time:now},100,now,90),currency:'USDT'};
  assert.equal(put.valid,true);assert.equal(put.purchaseExecuted,true);near(put.afterSettlementCash,100);
  // A hypothetical already-validated zero-income dual flow at the same K/T.
  const dual={valid:true,settledAsBTC:true,amount:100,leftover:0,income:0,
    dualBtc:1,dualCash:0,dualAssets:90,settleCoin:'USDT'};
  const m=checked({put,dual,contract});
  near(m.extraFeeHeadroom,0);near(m.maxPurchasePrice,100);near(m.atLimitBtc,1);
  assert.equal(m.aboveFeeLimitBtc,null);assert.ok(m.headroom>0);
});

test('a 1e-14 spot step is certified without a fixed 1e-12 BTC tolerance swallowing the boundary',()=>{
  for(const base of [false,true]) {
    const f=fixture({base,step:1e-14}),m=checked(f);
    assert.equal(m.roundingKnown,true);
    const beta=base?1-f.contract.spot:1;
    assert.ok(m.requiredGrossAtCurrentPrice*beta>=f.dual.dualBtc-Number.EPSILON);
    assert.ok((m.requiredGrossAtCurrentPrice-1e-14)*beta<f.dual.dualBtc);
    assert.ok(m.aboveLimitBtc!==null&&m.aboveLimitBtc<f.dual.dualBtc-1e-10);
  }
});

test('the strict target check never certifies one less tiny lot as sufficient',()=>{
  const f=fixture({A:10001.19,base:true,step:1e-14}),m=checked(f);
  assert.ok(m.atPriceLimit.grossBtc>=m.targetGrossAtPriceLimit);
  assert.ok(m.atLimitBtc>=f.dual.dualBtc);
  assert.ok(m.atFeeLimitBtc>=f.dual.dualBtc);
});

test('using the fee and price limits together exceeds their shared net-BTC budget',()=>{
  const f=fixture(),m=checked(f);assert.ok(m.extraFeeHeadroom>0);assert.ok(m.maxGapRate>0);
  const remainingCash=f.put.afterSettlementCash-m.extraFeeHeadroom;
  const atBoth=remainingCash/m.maxPurchasePrice*(1-f.contract.spot);
  assert.ok(atBoth<f.dual.dualBtc);
});

test('negative margins mean a required cost reduction or discounted buy price, never positive tolerance',()=>{
  const f=fixture({apr:'1',step:.0001});const m=checked(f);
  assert.ok(m.headroom<0);assert.ok(m.extraFeeHeadroom<0);assert.ok(m.maxGapRate<0);
  assert.equal(m.competitiveAtCurrentRules,false);
});

test('ATM triggers, and zero spot fees still have finite boundaries',()=>{
  for(const base of [false,true]) {
    const f=fixture({ST:80000,base,fee:0});const m=checked(f);
    near(f.put.payout,0);near(f.put.deliveryFee,0);near(m.gapImpact,0);
    near(m.maxPurchasePrice,f.put.afterSettlementCash/f.dual.dualBtc,1e-7);
  }
});

test('untriggered limits concern only cash income and additional opening fees',()=>{
  for(const apr of ['0.4761','1']) {
    const f=fixture({ST:90000,apr});const m=computeSettlementLimits(f.put,f.dual,f.contract);
    assert.equal(m.valid,true);assert.equal(m.kind,'income');
    near(m.budgetGross,f.put.gross-f.dual.income);
    near(m.extraFeeHeadroom,f.put.netIncome-f.dual.income);near(m.currentUse,f.put.openFee);
    near(m.cashOccupancy,0);near(m.gapImpact,0);
    for(const key of ['maxPurchasePrice','maxGapRate','atLimitBtc','aboveLimitBtc'])assert.equal(m[key],null);
  }
});

test('pending zero-price and minimum failures clear every threshold',()=>{
  for(const options of [{ST:0},{spotMin:.2},{spotMinNotional:10000}]) {
    const f=fixture(options);const m=computeSettlementLimits(f.put,f.dual,f.contract);
    assert.equal(m.valid,false);assert.ok(m.reason);
    for(const key of ['extraFeeHeadroom','maxPurchasePrice','maxGapRate','atLimitBtc','aboveLimitBtc'])assert.equal(m[key],null);
  }
});

test('changed or invalid fee/lot rules cannot certify limits for a different current model',()=>{
  const f=fixture({step:.0001});
  for(const rules of [null,{...f.contract,spot:NaN},{...f.contract,spot:1,spotDeductBase:true},
    {...f.contract,spotDeductBase:'false'},{...f.contract,spotStep:0},{...f.contract,spotStep:1e-15},
    {...f.contract,spotMin:-1},{...f.contract,spotMinNotional:Infinity},{...f.contract,spot:.002},
    {...f.contract,spotStep:undefined}]) {
    const m=computeSettlementLimits(f.put,f.dual,rules);assert.equal(m.valid,false);assert.equal(m.maxGapRate,null);
  }
});

test('missing/invalid dual data and broken money ledgers fail closed instead of implying unlimited room',()=>{
  const f=fixture();
  for(const [put,dual]of[[f.put,null],[f.put,{...f.dual,valid:false,reason:'报价过期'}],
    [{...f.put,afterSettlementCash:f.put.afterSettlementCash+1},f.dual],
    [{...f.put,basisCost:Infinity},f.dual],[f.put,{...f.dual,settleCoin:'USDC'}]]) {
    const m=computeSettlementLimits(put,dual,f.contract);assert.equal(m.valid,false);
    assert.equal(m.extraFeeHeadroom,null);assert.equal(m.maxPurchasePrice,null);assert.ok(m.reason);
  }
});

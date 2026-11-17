import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateSimulation } from './web/calc.js';
import { compareBinanceDual } from './web/binance-dual.js';
import { buildSettlementBreakdown } from './web/settlement-breakdown.js';

const now = Date.UTC(2026, 9, 22, 8), expiry = now + 8 * 86400000;
const near = (a, b, tolerance = 1e-8) => assert.ok(Math.abs(a-b) <= tolerance, `${a} != ${b}`);
function fixture({A=10000,ST=75000,gap=0,base=true,step,spotMin,spotMinNotional,apr='0.4761',precision=4}={}) {
  const contract = {strike:80000,expires:expiry,step:.01,min:.01,taker:.0003,cap:.07,delivery:.00015,
    deliveryCap:.125,spot:base?.001:.0005,spotDeductBase:base,spotStep:step,spotMin,spotMinNotional};
  const model = calculateSimulation(A,contract,{bids:[{price:1065,qty:3}],time:now},81272.84510255,now,ST,0,gap);
  assert.equal(model.valid,true);
  const put={...model,expires:expiry,currency:'USDT'};
  const product={id:'fixture',investCoin:'USDT',exercisedCoin:'BTC',strikePrice:'80000',duration:8,
    settleDate:expiry,purchaseDecimal:precision,purchaseEndTime:now+86400000,canPurchase:true,apr,
    minAmount:'20',maxAmount:'20000',optionType:'PUT'};
  const data={status:'ready',product,quote:{source:'Binance 普通双币'},serverTime:now,fetchedAt:now,receivedAt:now,
    currency:'USDT',ordinary:true,contract:{strike:80000,expires:expiry}};
  const dual=compareBinanceDual(A,put,data,now);assert.equal(dual.valid,true,dual.reason);
  return {put,dual};
}
function verified(put,dual) {
  const m=buildSettlementBreakdown(put,dual);assert.equal(m.valid,true,m.reason);
  assert.equal(m.balanceVerified,true);near(m.assetBridgeSum,put.assets-dual.dualAssets);
  near(m.rows.filter(row=>row.includeInAssetBridge).reduce((total,row)=>total+row.value,0),m.assetBridgeSum);
  assert.equal(m.rows.length,7);assert.equal(m.rows[6].includeInAssetBridge,false);
  if(m.kind==='btc') {
    near(m.btcBridgeSum,put.btcReceived-dual.dualBtc,1e-12);
    for(const row of m.rows)near(row.btcImpact,row.value/put.expiryPrice,1e-12);
  } else {
    assert.equal(m.btcBridgeSum,null);for(const row of m.rows)assert.equal(row.btcImpact,null);
  }
  return m;
}

test('positive and negative net BTC differences reconcile to the exact same six asset effects',()=>{
  const positive=fixture();const a=verified(positive.put,positive.dual);assert.ok(a.btcBridgeSum>0);
  const negative=fixture({apr:'1'});const b=verified(negative.put,negative.dual);assert.ok(b.btcBridgeSum<0);
  for(const [m,{put,dual}]of[[a,positive],[b,negative]]) {
    const row=id=>m.rows.find(x=>x.id===id);
    near(row('gross_income').value,put.gross-dual.income);near(row('open_fee').value,-put.openFee);
    near(row('delivery_fee').value,-put.deliveryFee);near(row('spot_fee').value,-put.spotFee);
    near(row('conversion').value,(dual.amount+dual.income-put.capital)*(1-put.expiryPrice/put.strike));
  }
});

test('untriggered results attribute income difference without converting it into fictitious BTC',()=>{
  const {put,dual}=fixture({ST:90000});const m=verified(put,dual);
  assert.equal(m.kind,'income');near(m.assetBridgeSum,put.netIncome-dual.income);
  for(const id of ['delivery_fee','spot_fee','execution_gap','conversion'])near(m.rows.find(x=>x.id===id).value,0);
  near(m.putFlow.endingCash,put.assets);near(m.dualFlow.endingCash,dual.dualAssets);
});

test('ATM still triggers but has zero conversion effect, payout and delivery fee',()=>{
  const {put,dual}=fixture({ST:80000});const m=verified(put,dual);
  assert.equal(m.kind,'btc');near(m.rows.find(x=>x.id==='conversion').value,0);
  near(m.putFlow.payout,0);near(m.putFlow.deliveryFee,0);
  near(m.dualFlow.conversionPrice,80000);
});

test('base and quote fees with step rounding, dual precision cash and signed price gaps all reconcile',()=>{
  for(const base of [false,true])for(const gap of [-.002,.002]) {
    const {put,dual}=fixture({A:10000.019,base,gap,step:.0001,precision:2});
    const m=verified(put,dual);assert.ok(put.cash>0);assert.ok(dual.dualCash>0);
    near(m.rows.find(x=>x.id==='cash_adjustment').value,dual.dualCash-put.cash);
    near(m.rows.find(x=>x.id==='execution_gap').value,-put.basisCost);
    assert.equal(Math.sign(m.rows.find(x=>x.id==='execution_gap').value),-Math.sign(gap));
    near(m.putFlow.purchaseCash,put.btcReceived*put.purchasePrice+put.spotFee);
    near(m.dualFlow.subscribedCash,10000.01);
  }
});

test('cash-shape adjustment explains cash leftovers without calling them an asset cost',()=>{
  const {put,dual}=fixture({step:.001,A:10000.019,precision:2});const m=verified(put,dual);
  const cash=m.rows.find(row=>row.id==='cash_adjustment');assert.equal(cash.includeInAssetBridge,false);
  assert.match(cash.note,/不是成本/);
  near(m.btcBridgeSum,(m.assetBridgeSum+dual.dualCash-put.cash)/put.expiryPrice,1e-12);
  assert.ok(Math.abs(m.rows.reduce((total,row)=>total+row.value,0)-m.assetBridgeSum)>1);
});

test('zero fixing still has an asset attribution but no division by zero or claimed BTC attribution',()=>{
  const {put,dual}=fixture({ST:0,A:10000.019,precision:2});const m=verified(put,dual);
  assert.equal(m.kind,'pending');assert.equal(m.btcAttributionAvailable,false);
  near(m.putFlow.netBtc,0);assert.ok(m.putFlow.endingCash>0);
  near(m.assetBridgeSum,put.cash-dual.dualCash);
});

test('below spot minimum amount or quantity stays pending with no charged spot fee',()=>{
  for(const constraints of [{spotMin:.2},{spotMinNotional:10000}]) {
    const {put,dual}=fixture(constraints);const m=verified(put,dual);
    assert.equal(m.kind,'pending');near(m.putFlow.spotFee,0);near(m.putFlow.purchaseCash,0);
    near(m.putFlow.endingCash,m.putFlow.afterSettlementCash);
  }
});

test('payout is shown as a separate cashflow, while reserves never become an extra bridge deduction',()=>{
  const {put,dual}=fixture();const before=verified(put,dual);
  const extra=put.feeReserve*.1;
  const after=verified({...put,feeReserve:put.feeReserve+extra,reserve:put.reserve+extra,freeCash:put.freeCash-extra},dual);
  near(before.assetBridgeSum,after.assetBridgeSum);near(before.btcBridgeSum,after.btcBridgeSum,1e-12);
  assert.equal(before.putFlow.payoutIsFee,false);assert.equal(before.putFlow.feeReserveIsCost,false);
  near(before.putFlow.payout,600);assert.ok(!before.rows.some(row=>row.id==='payout'||row.id==='fee_reserve'));
});

test('incorrect funding, notional, payout, spot cash and asset ledgers fail closed',()=>{
  const {put,dual}=fixture();
  const mutations=[
    [{...put,capital:put.capital+1},dual,'put_capital_mismatch'],
    [put,{...dual,amount:dual.amount+1},'funding_mismatch'],
    [{...put,payout:put.payout+1},dual,'payout_mismatch'],
    [{...put,afterSettlementCash:put.afterSettlementCash+1},dual,'settlement_cash_mismatch'],
    [{...put,purchaseCash:put.purchaseCash+1},dual,'purchase_cash_mismatch'],
    [{...put,spotFee:put.spotFee+1},dual,'put_asset_mismatch'],
    [{...put,netIncome:put.netIncome+1},dual,'premium_mismatch'],
  ];
  for(const [p,d,code]of mutations) {
    const m=buildSettlementBreakdown(p,d);assert.equal(m.valid,false);assert.equal(m.balanceVerified,false);
    assert.equal(m.validationCode,code);assert.equal(m.assetBridgeSum,null);
  }
});

test('unmodelled dual delivery rounding cannot be hidden inside a complete six-item attribution',()=>{
  const {put,dual}=fixture();const rounded={...dual,dualBtc:dual.dualBtc-.000001};
  rounded.dualAssets=rounded.dualCash+rounded.dualBtc*put.expiryPrice;
  const m=buildSettlementBreakdown(put,rounded);assert.equal(m.valid,false);
  assert.equal(m.validationCode,'dual_conversion_mismatch');assert.match(m.reason,/取整或扣费/);
});

test('invalid and missing quotes, branch/currency mismatches and nonfinite flows never become zero costs',()=>{
  const {put,dual}=fixture();
  for(const [p,d]of[[put,null],[{...put,valid:false},dual],[put,{...dual,settledAsBTC:false}],
    [put,{...dual,settleCoin:'USDC'}],[{...put,gross:Infinity},dual],[{...put,basisCost:NaN},dual],
    [put,{...dual,amount:undefined}]]) {
    const m=buildSettlementBreakdown(p,d);assert.equal(m.valid,false);assert.equal(m.balanceVerified,false);
    assert.equal(m.btcBridgeSum,null);assert.deepEqual(m.rows,[]);assert.ok(m.reason);
  }
});

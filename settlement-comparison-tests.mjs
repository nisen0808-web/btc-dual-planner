import test from 'node:test';
import assert from 'node:assert/strict';
import { compareSettlement } from './web/settlement-comparison.js';
import { calculateSimulation } from './web/calc.js';

const near=(a,b,t=1e-9)=>assert.ok(Math.abs(a-b)<t,`${a} != ${b}`);
function fixture({price=75000,strike=80000,putBtc=.125,dualBtc=.126,putCash=0,dualCash=0,putIncome=140,dualIncome=120,purchased=true}={}) {
  const triggered=price<=strike;
  return {
    put:{valid:true,expiryPrice:price,strike,triggered,purchaseExecuted:triggered&&purchased,
      btcReceived:triggered?putBtc:0,cash:putCash,assets:putCash+(triggered?putBtc:0)*price,
      netIncome:putIncome,settleCoin:'USDT'},
    dual:{valid:true,settledAsBTC:triggered,dualBtc:triggered?dualBtc:0,
      dualCash,dualAssets:dualCash+(triggered?dualBtc:0)*price,income:dualIncome,settleCoin:'USDT'},
  };
}

test('triggered comparison reports both positive and negative actual net BTC differences',()=>{
  for(const [btc,expected] of [[.127,.001],[.125,-.001]]) {
    const {put,dual}=fixture({putBtc:btc});const m=compareSettlement(put,dual);
    assert.equal(m.valid,true);assert.equal(m.triggered,true);assert.equal(m.kind,'btc');
    near(m.difference,expected);near(m.btcDifference,expected);
    near(m.assetDifference,expected*75000);near(m.incomeDifference,20);
    near(m.putBtc,btc);near(m.dualBtc,.126);
  }
});

test('equal net BTC remains equal even with meaningful or dust stablecoin leftovers',()=>{
  const {put,dual}=fixture({putBtc:.126,putCash:1e-7,dualCash:3});
  const m=compareSettlement(put,dual);assert.equal(m.valid,true);
  near(m.difference,0);near(m.putCash,1e-7);near(m.dualCash,3);
  near(m.cashDifference,1e-7-3);near(m.assetDifference,1e-7-3);
});

test('untriggered comparison uses net income difference and retains all cash and assets',()=>{
  for(const [putIncome,expected] of [[140,20],[100,-20],[120,0],[-5,-125]]) {
    const {put,dual}=fixture({price:90000,putCash:10000+putIncome,dualCash:10120,putIncome});
    const m=compareSettlement(put,dual);assert.equal(m.valid,true);
    assert.equal(m.triggered,false);assert.equal(m.kind,'income');near(m.difference,expected);
    near(m.incomeDifference,expected);near(m.cashDifference,expected);near(m.assetDifference,expected);
    near(m.putBtc,0);near(m.dualBtc,0);near(m.putAssets,10000+putIncome);
  }
});

test('ATM uses <= and reports BTC rather than unconverted income difference',()=>{
  const {put,dual}=fixture({price:80000,putBtc:.127});const m=compareSettlement(put,dual);
  assert.equal(m.valid,true);assert.equal(m.triggered,true);assert.equal(m.kind,'btc');near(m.difference,.001);
});

test('zero-price and below-minimum pending outcomes never claim more or less delivered BTC',()=>{
  for(const price of [0,75000]) {
    const {put,dual}=fixture({price,putBtc:0,putCash:200,purchased:false});
    const m=compareSettlement(put,dual);assert.equal(m.valid,true);
    assert.equal(m.kind,'pending');assert.equal(m.difference,null);
    near(m.putBtc,0);near(m.dualBtc,.126);near(m.putCash,200);
    near(m.putAssets,200);near(m.dualAssets,.126*price);
  }
});

test('zero total assets are valid, and absent execution confirmation remains pending',()=>{
  const {put,dual}=fixture({price:0,putBtc:0,putCash:0,dualCash:0,purchased:false});
  delete put.purchaseExecuted;
  const m=compareSettlement(put,dual);assert.equal(m.valid,true);assert.equal(m.kind,'pending');
  near(m.putAssets,0);near(m.dualAssets,0);
});

test('real all-balance calculator output compares final BTC rather than original PUT quantity',()=>{
  const now=Date.UTC(2026,9,22,8);
  const contract={strike:80000,expires:now+7*86400000,step:.01,min:.01,taker:.0003,cap:.07,
    delivery:.00015,deliveryCap:.125,spot:.001,spotDeductBase:true};
  const put=calculateSimulation(10000,contract,{bids:[{price:1065,qty:3}],time:now},81272.84510255,now,75000,0,.001);
  const income=104,dualBtc=(10000+income)/80000;
  const dual={valid:true,settledAsBTC:true,dualBtc,dualCash:0,dualAssets:dualBtc*75000,income};
  const m=compareSettlement(put,dual);assert.equal(m.valid,true);assert.equal(m.kind,'btc');
  near(m.difference,put.btcReceived-dualBtc);assert.notEqual(m.putBtc,put.q);
  near(m.assetDifference,m.btcDifference*75000);
});

test('missing or invalid quotes fail closed with their reason instead of a zero-yield alternative',()=>{
  const {put}=fixture();
  for(const dual of [null,{}, {valid:false,reason:'双币报价已过期'}]) {
    const m=compareSettlement(put,dual);assert.equal(m.valid,false);assert.equal(m.difference,undefined);
    assert.ok(m.reason);if(dual?.reason)assert.equal(m.reason,dual.reason);
  }
  assert.equal(compareSettlement({...put,valid:false},{}).valid,false);
});

test('mismatched fixing branches and currencies cannot be compared',()=>{
  const {put,dual}=fixture();
  for(const changed of [{...dual,settledAsBTC:false},{...dual,settleCoin:'USDC'},{...dual,settledAsBTC:undefined}]) {
    assert.equal(compareSettlement(put,changed).valid,false);
  }
  assert.equal(compareSettlement({...put,triggered:false},dual).valid,false);
  assert.equal(compareSettlement({...put,purchaseExecuted:'true'},dual).valid,false);
  assert.equal(compareSettlement({...put,purchaseExecuted:'false'},dual).valid,false);
  const atm=fixture({price:80000});atm.dual.settledAsBTC=false;
  assert.equal(compareSettlement(atm.put,atm.dual).valid,false);
});

test('nonfinite, missing, negative quantity, and inconsistent asset values are rejected',()=>{
  const {put,dual}=fixture();
  for(const key of ['btcReceived','cash','assets','netIncome','expiryPrice','strike']) {
    for(const value of [NaN,Infinity,undefined,'0'])assert.equal(compareSettlement({...put,[key]:value},dual).valid,false,`put ${key}`);
  }
  for(const key of ['dualBtc','dualCash','dualAssets','income']) {
    for(const value of [NaN,Infinity,undefined,'0'])assert.equal(compareSettlement(put,{...dual,[key]:value}).valid,false,`dual ${key}`);
  }
  assert.equal(compareSettlement({...put,btcReceived:-1},dual).valid,false);
  assert.equal(compareSettlement(put,{...dual,dualCash:-1}).valid,false);
  assert.equal(compareSettlement({...put,assets:put.assets+1},dual).valid,false);
  assert.equal(compareSettlement(put,{...dual,dualAssets:dual.dualAssets+1}).valid,false);
  assert.equal(compareSettlement({...put,purchaseExecuted:true,btcReceived:0,assets:put.cash},dual).valid,false);
});

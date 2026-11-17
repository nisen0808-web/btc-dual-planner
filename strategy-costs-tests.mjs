import test from 'node:test';
import assert from 'node:assert/strict';
import { calculatePutQuote } from './web/live-quotes.js';
import { deriveStrategyCosts } from './web/strategy-costs.js';

const now=Date.UTC(2026,9,22,8),expiry=now+7*86400000;
const near=(a,b,t=1e-8)=>assert.ok(Math.abs(a-b)<=t,`${a} != ${b}`);
const contract={strike:80000,expires:expiry,step:.01,min:.01,taker:.0003,cap:.07,delivery:.00015,
  deliveryCap:.125,deliveryExemptionConfirmed:false,spot:.001,spotDeductBase:true};
const book={time:now,bids:[{price:1065,qty:3}]};
const quote=calculatePutQuote(10000,contract,book,81272.84510255,now);
assert.equal(quote.valid,true);

test('untriggered income deducts only quoted opening fees and future actual fees remain unknown',()=>{
  const m=deriveStrategyCosts(quote,contract,'bybit');assert.equal(m.valid,true);
  near(m.untriggeredNetIncome,quote.gross-quote.openFee);near(m.untriggeredTotalFees,quote.openFee);
  near(m.untriggeredDeliveryFee,0);near(m.untriggeredSpotFee,0);
  assert.equal(m.deliveryFeeActual,null);assert.equal(m.spotFeeActual,null);
  assert.equal(m.quoteOnly,true);assert.equal(m.reserveIsExpense,false);
});

test('the independent intrinsic delivery cap supplies a strict wide bound without assuming I equals S',()=>{
  const m=deriveStrategyCosts(quote,contract,'bybit');
  near(m.deliveryFeeUpper,.125*quote.q*contract.strike);
  assert.notEqual(m.deliveryFeeUpper,contract.cap*quote.capital);
  assert.ok(m.deliveryFeeUpper>contract.delivery*quote.capital);
  assert.match(m.rows.find(r=>r.id==='delivery_fee').note,/不假定 I=S/);
});

test('base and quote spot fees use the whole available-cash upper bound exactly once',()=>{
  const base=deriveStrategyCosts(quote,contract,'bybit');near(base.spotFeeUpper,.001*(quote.amount+quote.netIncome));
  const c={...contract,spot:.0005,spotDeductBase:false};
  const other=deriveStrategyCosts(quote,c,'deribit');near(other.spotFeeUpper,.0005/1.0005*(quote.amount+quote.netIncome));
  near(base.futureFeeUpper,base.deliveryFeeUpper+base.spotFeeUpper);
  near(base.totalFeeUpper,quote.openFee+base.futureFeeUpper);
  near(base.triggeredFeeNetLower,quote.netIncome-base.futureFeeUpper);
});

test('unconfirmed zero delivery does not masquerade as a verified Bybit daily exemption',()=>{
  const m=deriveStrategyCosts(quote,{...contract,delivery:0},'bybit');assert.equal(m.valid,true);
  assert.equal(m.deliveryRuleKnown,false);assert.equal(m.deliveryFeeUpper,null);
  assert.equal(m.futureFeeUpper,null);assert.equal(m.triggeredFeeNetLower,null);assert.equal(m.feeReserveCoverage,null);
  near(m.untriggeredNetIncome,quote.netIncome);
});

test('only an explicit confirmed exemption permits a zero delivery upper bound',()=>{
  const m=deriveStrategyCosts(quote,{...contract,delivery:0,deliveryCap:undefined,deliveryExemptionConfirmed:true,spotDeductBase:false},'deribit');
  assert.equal(m.deliveryRuleKnown,true);near(m.deliveryFeeUpper,0);assert.equal(m.feeBoundsAvailable,true);
  near(m.triggeredFeeNetLower,quote.netIncome-m.spotFeeUpper);
  assert.equal(m.rows.find(r=>r.id==='delivery_fee').status,'confirmed_exempt');
});

test('missing or invalid delivery caps keep the full-fee lower bound unknown instead of assuming zero',()=>{
  for(const deliveryCap of [undefined,null,NaN,Infinity,-1,1.01,'']){
    const m=deriveStrategyCosts(quote,{...contract,deliveryCap},'bybit');assert.equal(m.valid,true);
    assert.equal(m.deliveryFeeUpper,null);assert.equal(m.feeBoundsAvailable,false);assert.equal(m.triggeredFeeNetLower,null);
  }
});

test('negative fee-only income floors are retained and insufficient reserve/funding is disclosed',()=>{
  const m=deriveStrategyCosts(quote,contract,'bybit');assert.ok(m.triggeredFeeNetLower<0);
  assert.equal(m.feeReserveCoverage,false);assert.ok(m.feeReserveShortfall>0);
  assert.equal(m.fullyFundedForFeeUpper,false);assert.ok(m.fundingShortfall>0);
  near(m.requiredFundingUpper,quote.capital+m.totalFeeUpper);
  near(m.feeReserveShortfall,m.totalFeeUpper-quote.feeReserve);
});

test('zero spot fees are valid while missing or impossible spot rules prevent complete bounds',()=>{
  const zero=deriveStrategyCosts(quote,{...contract,spot:0},'bybit');near(zero.spotFeeUpper,0);assert.equal(zero.feeBoundsAvailable,true);
  for(const patch of [{spot:undefined},{spot:NaN},{spot:-1},{spot:Infinity},{spot:1,spotDeductBase:true},{spotDeductBase:undefined},{spotDeductBase:'true'}]){
    const m=deriveStrategyCosts(quote,{...contract,...patch},'bybit');assert.equal(m.spotRuleKnown,false);
    assert.equal(m.spotFeeUpper,null);assert.equal(m.triggeredFeeNetLower,null);near(m.untriggeredNetIncome,quote.netIncome);
  }
});

test('a sufficient reserve stays an asset and is never deducted again from fee-only income',()=>{
  const A=11000,q={...quote,amount:A,feeReserve:1500};
  const m=deriveStrategyCosts(q,contract,'bybit');assert.equal(m.valid,true);
  assert.equal(m.feeReserveCoverage,true);near(m.feeReserveShortfall,0);assert.equal(m.fullyFundedForFeeUpper,true);
  near(m.triggeredFeeNetLower,q.gross-q.openFee-m.deliveryFeeUpper-m.spotFeeUpper);
  assert.equal(m.payoutIsFee,false);assert.equal(m.rows.find(r=>r.id==='settlement_payout').isFee,false);
  assert.equal(m.rows.find(r=>r.id==='execution_price_difference').isFee,false);
  for(const key of ['btcReceived','assets','expiryPrice','scenarioPrice','payout','incomeDifference'])assert.equal(key in m,false,key);
});

test('invalid quote ledgers fail closed and fee derivation neither mutates inputs nor uses an account',t=>{
  t.mock.method(globalThis,'fetch',()=>{throw Error('no network');});const before=structuredClone(quote);
  deriveStrategyCosts(quote,contract,'bybit');assert.deepEqual(quote,before);
  for(const q of [null,{...quote,valid:false},{...quote,amount:Infinity},{...quote,q:0},{...quote,capital:quote.capital+1},{...quote,netIncome:quote.netIncome+1}]){
    const m=deriveStrategyCosts(q,contract,'bybit');assert.equal(m.valid,false);assert.equal(m.triggeredFeeNetLower,null);
  }
  assert.equal(deriveStrategyCosts(quote,contract,'unknown').valid,false);
});

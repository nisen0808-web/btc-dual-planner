import test from 'node:test';
import assert from 'node:assert/strict';
import {calculate} from './web/calc.js';
import {prepareExecutionIntent,executionFingerprint,validateExecutionConfirmation,transitionExecutionIntent} from './web/execution-plan.js';

const now=Date.UTC(2026,9,22,12),expiry=now+7*86400000;
const contract={symbol:'BTC-29OCT26-80000-P',strike:80000,expires:expiry,step:.01,min:.01,taker:.0003,cap:.125,delivery:.00015,spot:.001,spotDeductBase:true,priceTick:'0.1'};
const book={time:now,bids:[{price:1000,qty:.04},{price:800,qty:1}]};
const market={platform:'bybit',spot:85000,time:now};
const id='put_0123456789abcdef0123456789abcdef';
function prepare(extra={}){
  const c=extra.contract??contract,b=extra.book??book,m=extra.market??market,amount=extra.amount??'8100.0000';
  const model=extra.model??calculate(Number(amount),c,b,m.spot,now,79000,.005);
  return prepareExecutionIntent({model,contract:c,book:b,market:m,amount,now,orderLinkId:id,...extra});
}
const identity=(source,more={})=>({source,accountId:'dedicated-account',platform:'bybit',symbol:contract.symbol,currency:'USDT',...more});
function step(plan,event,at=now,context={}){
  const outcome=transitionExecutionIntent(plan,event,{now:at,currentFingerprint:plan.fingerprint,...context});
  assert.equal(outcome.ok,true,outcome.errors.join(' '));return outcome.plan;
}
function ready(){
  const plan=prepare();assert.equal(plan.valid,true,plan.errors?.join(' '));
  return step(plan,{type:'ACCOUNT_VERIFIED',proof:{source:'execution_adapter',accountId:'dedicated-account',platform:'bybit',currency:'USDT',tradingEnabled:true,spotEnabled:true,executorOnline:true,checkedAt:now,availableBalance:'8100',reservedAmount:plan.fullFundReserve,reservationId:'reservation-1'}});
}
const putFill=(fillId,qty,more={})=>({fillId,qty,price:'800',fee:'0.1',feeCurrency:'USDT',...more});
function reconcilePut(plan,fills,status='cancelled',at=now){
  const filledQty=String([...new Map(fills.map(row=>[row.fillId,row])).values()].reduce((sum,row)=>sum+Number(row.qty),0));
  return step(plan,{type:'PUT_RECONCILED',proof:identity('exchange_order_and_fills',{clientOrderId:id,orderId:'put-order-1',fills,filledQty,status})},at);
}
function held(q='0.05'){
  let plan=step(ready(),{type:'SUBMIT'});
  plan=reconcilePut(plan,[putFill('put-fill-1',q)]);
  return step(plan,{type:'WAIT_SETTLEMENT'});
}
function settle(plan,price='79000',availableCash='8000',more={}){
  return step(plan,{type:'SETTLEMENT_CONFIRMED',proof:identity('exchange_settlement',{settlementId:'settlement-1',expiry,settledQty:plan.put.filledQty,settlementPrice:price,availableCash,settledAt:expiry,final:true,...more})},expiry);
}
function spotSubmit(plan,qty='0.05',more={},at=expiry){
  return step(plan,{type:'SPOT_SUBMIT',quote:{clientOrderId:'spot_order_1',qty,price:'79000',feeReserve:'5',availableCash:'8000',checkedAt:at,...more}},at);
}
const spotFill=(fillId,qty,more={})=>({fillId,qty,price:'79000',fee:'0',feeCurrency:'BTC',...more});
function reconcileSpot(plan,fills,status='cancelled',at=expiry){
  const filledQty=String(fills.reduce((sum,row)=>sum+Number(row.qty),0));
  return step(plan,{type:'SPOT_RECONCILED',proof:identity('exchange_order_and_fills',{clientOrderId:plan.spot.activeOrder.clientOrderId,orderId:'spot-order-'+plan.spot.orders.length,fills,filledQty,status})},at);
}

test('real calculator model produces an inspectable IOC floor, not the sweep average',()=>{
  const p=prepare();assert.equal(p.valid,true);assert.equal(p.q,'0.1');assert.equal(Number(p.estimatedGross),88);assert.equal(p.limitPrice,'800');assert.equal(Number(p.minimumGrossAtLimit),80);
  assert.deepEqual(p.orderPayload,{category:'option',symbol:contract.symbol,side:'Sell',orderType:'Limit',timeInForce:'IOC',qty:'0.1',price:'800',orderLinkId:id});
  assert.equal(p.state,'account_required');assert.equal(p.canSubmit,false);assert.equal(p.fundsLocked,false);assert.equal(p.fundsReservationScope,'not_reserved');assert.equal(Number(p.spotEstimate.netBtc),.0999);
  assert.equal(Number(p.buyBufferReserve),40);assert.equal(Number(p.fullFundReserve),Number(p.capital)+Number(p.feeReserve)+40);assert.equal(p.settlementRule.requiresFinalExchangeProof,true);
});
test('missing or incompatible official price tick never generates a trade payload',()=>{
  for(const priceTick of [undefined,0,'invalid','0.3']){
    const p=prepare({contract:{...contract,priceTick}});assert.equal(p.valid,true);assert.equal(p.payloadReady,false);assert.equal(p.orderPayload,null);assert.ok(p.blockers.some(row=>row.code.startsWith('price_tick')));
  }
  const p=prepare({orderLinkId:'x'.repeat(37)});assert.equal(p.orderPayload,null);assert.ok(p.blockers.some(row=>row.code==='order_link_id_invalid'));
});
test('Deribit preparation uses only its own instrument and IOC payload and still needs account verification',()=>{
  const symbol='BTC_USDC-30OCT26-80000-P',p=prepare({market:{...market,platform:'deribit'},contract:{...contract,symbol,spotDeductBase:false}});
  assert.equal(p.valid,true);assert.equal(p.currency,'USDC');assert.equal(p.payloadReady,true);assert.equal(p.canSubmit,false);
  assert.deepEqual(p.orderPayload,{instrument_name:symbol,amount:.1,price:800,type:'limit',time_in_force:'immediate_or_cancel',label:id});
  const wrong=prepare({market:{...market,platform:'deribit'}});assert.equal(wrong.payloadReady,false);assert.ok(wrong.blockers.some(row=>row.code==='instrument_mismatch'));
});
test('funding, depth, step and buffer inconsistencies fail before preparation',()=>{
  const base=calculate(8100,contract,book,85000,now,79000,.005);
  assert.equal(prepare({model:{...base,reserve:8100.00001}}).valid,false);
  assert.equal(prepare({model:{...base,buyBufferReserve:0}}).valid,false);
  assert.equal(prepare({model:{...base,q:.105}}).valid,false);
  assert.equal(prepare({book:{...book,bids:[{price:800,qty:.01}]},model:base}).valid,false);
  assert.equal(prepare({book:{...book,time:now-30000}}).valid,false);
  const old=calculate(8100,contract,book,85000,now,79000);delete old.buyBufferRate;delete old.buyBufferReserve;
  const legacy=prepare({model:old});assert.equal(legacy.valid,true);assert.equal(legacy.buyBufferRate,'0');assert.equal(legacy.buyBufferReserve,'0');
});
test('fingerprint canonicalizes economic decimals and includes every execution condition',()=>{
  const f=executionFingerprint({platform:'bybit',amount:'8100.0000',strike:'80000',expiry,symbol:contract.symbol});
  assert.equal(f,executionFingerprint({platform:'bybit',amount:'8.1e3',strike:80000,expiry,symbol:contract.symbol}));
  for(const patch of [{amount:'8100.00001'},{strike:80001},{expiry:expiry+1},{symbol:'other'},{platform:'deribit'}])assert.notEqual(f,executionFingerprint({platform:'bybit',amount:8100,strike:80000,expiry,symbol:contract.symbol,...patch}));
  assert.equal(executionFingerprint({platform:'bybit',currency:'USDC',amount:8100,strike:80000,expiry,symbol:contract.symbol}),null);
});
test('confirmation expires at 30 seconds and cannot reuse changed parameters',()=>{
  const p=ready();assert.equal(validateExecutionConfirmation(p,{now:now+29999,currentFingerprint:p.fingerprint}).valid,true);
  assert.equal(validateExecutionConfirmation(p,{now:now+30000,currentFingerprint:p.fingerprint}).valid,false);
  assert.equal(validateExecutionConfirmation(p,{now,currentFingerprint:'changed'}).valid,false);
  assert.equal(transitionExecutionIntent(p,{type:'SUBMIT'},{now:now+30000,currentFingerprint:p.fingerprint}).ok,false);
  assert.equal(p.state,'ready');
});
test('account and strategy reservation must be verified without claiming exchange locking',()=>{
  const p=prepare();assert.equal(transitionExecutionIntent(p,{type:'SUBMIT'},{now,currentFingerprint:p.fingerprint}).ok,false);
  const proof={source:'execution_adapter',accountId:'a',platform:'bybit',currency:'USDT',tradingEnabled:true,spotEnabled:true,executorOnline:true,checkedAt:now,availableBalance:'8100',reservedAmount:p.fullFundReserve,reservationId:'r'};
  for(const patch of [{source:'browser'},{currency:'USDC'},{reservedAmount:'1'},{availableBalance:'1'},{executorOnline:false},{checkedAt:now-30000}])assert.equal(transitionExecutionIntent(p,{type:'ACCOUNT_VERIFIED',proof:{...proof,...patch}},{now,currentFingerprint:p.fingerprint}).ok,false);
  const r=ready();assert.equal(r.canSubmit,true);assert.equal(r.fundsLocked,false);assert.equal(r.fundsReservationScope,'strategy_ledger');
});
test('submission and acknowledgement are not fills; uncertain submission cannot be retried',()=>{
  let p=step(ready(),{type:'SUBMIT'});assert.equal(p.state,'submitting');assert.equal(p.put.filledQty,'0');assert.equal(p.pendingAction.clientOrderId,id);
  p=step(p,{type:'ORDER_ACCEPTED',proof:identity('exchange_order',{clientOrderId:id,orderId:'put-order-1',accepted:true})});assert.equal(p.state,'awaiting_confirmation');assert.equal(p.put.filledQty,'0');
  p=step(p,{type:'ORDER_UNKNOWN'});assert.equal(p.state,'unknown');assert.equal(p.requiresReconciliation,true);
  assert.equal(p.pendingAction,null);
  assert.equal(transitionExecutionIntent(p,{type:'SUBMIT'},{now,currentFingerprint:p.fingerprint}).ok,false);
  const restored=JSON.parse(JSON.stringify(p));assert.equal(restored.state,'unknown');assert.equal(restored.id,id);
});
test('PUT partial fills deduplicate and scale only actual exposure and buffer',()=>{
  const submitted=step(ready(),{type:'SUBMIT'}),fills=[putFill('a','.03'),putFill('b','.02')];
  let p=reconcilePut(submitted,fills);assert.equal(p.state,'partially_filled');assert.equal(Number(p.put.filledQty),.05);assert.equal(Number(p.activeBuyBufferReserve),20);assert.equal(Number(p.activeFullFundReserve),Number(p.fullFundReserve)/2);
  p=reconcilePut(p,[...fills,putFill('a','.03')]);assert.equal(Number(p.put.filledQty),.05);
  const changed=identity('exchange_order_and_fills',{clientOrderId:id,orderId:'put-order-1',status:'cancelled',filledQty:'.05',fills:[putFill('a','.04'),putFill('b','.01')]});
  assert.equal(transitionExecutionIntent(p,{type:'PUT_RECONCILED',proof:changed},{now}).ok,false);
  const tooMuch=identity('exchange_order_and_fills',{clientOrderId:id,orderId:'put-order-1',status:'cancelled',filledQty:'.11',fills:[putFill('c','.11')]});
  assert.equal(transitionExecutionIntent(submitted,{type:'PUT_RECONCILED',proof:tooMuch},{now}).ok,false);
  assert.equal(p.state,'partially_filled');
});
test('terminal PUT state cannot regress and nonterminal orders cannot arm settlement',()=>{
  const p=reconcilePut(step(ready(),{type:'SUBMIT'}),[putFill('a','.05')],'open');
  assert.equal(transitionExecutionIntent(p,{type:'WAIT_SETTLEMENT'},{now}).ok,false);
  assert.equal(Number(p.activeFullFundReserve),Number(p.fullFundReserve));assert.equal(Number(p.activeBuyBufferReserve),40);assert.equal(Number(p.exposureBuyBufferReserve),20);
  assert.equal(transitionExecutionIntent(p,{type:'PAUSE'},{now}).ok,false);
  const final=reconcilePut(p,[putFill('a','.05')]);
  const old=identity('exchange_order_and_fills',{clientOrderId:id,orderId:'put-order-1',status:'open',filledQty:'.05',fills:[putFill('a','.05')]});
  assert.equal(transitionExecutionIntent(final,{type:'PUT_RECONCILED',proof:old},{now}).ok,false);
  const allFilledButOpen=reconcilePut(step(ready(),{type:'SUBMIT'}),[putFill('all','.1')],'open');assert.equal(allFilledButOpen.state,'holding');assert.equal(allFilledButOpen.put.terminal,false);assert.equal(transitionExecutionIntent(allFilledButOpen,{type:'PAUSE'},{now}).ok,false);
});
test('pausing a filled plan preserves real settlement accounting without arming a buy',()=>{
  const p=step(held(),{type:'PAUSE'});assert.equal(p.state,'attention_required');assert.equal(p.paused,true);
  const settled=settle(p);assert.equal(settled.state,'attention_required');assert.equal(settled.settlement.settlementId,'settlement-1');assert.equal(settled.put.filledQty,'0.05');
});
test('spot ticker and timer cannot substitute for final exchange settlement evidence',()=>{
  const p=held();
  const proof=identity('exchange_settlement',{settlementId:'s',expiry,settledQty:'.05',settlementPrice:'79000',availableCash:'8000',settledAt:expiry,final:true});
  for(const patch of [{source:'spot_ticker'},{final:false},{expiry:expiry+1},{settledQty:'.1'},{accountId:'other'},{availableCash:'9000'}])assert.equal(transitionExecutionIntent(p,{type:'SETTLEMENT_CONFIRMED',proof:{...proof,...patch}},{now:expiry}).ok,false);
  assert.equal(transitionExecutionIntent(p,{type:'SPOT_SUBMIT',quote:{}},{now:expiry}).ok,false);
});
test('equality triggers another spot purchase; higher settlement retains cash and permits proceeds',()=>{
  const equal=settle(held(),'80000','8139.9');assert.equal(equal.state,'spot_ready');assert.equal(Number(equal.spot.targetQty),.05);assert.equal(Number(equal.spot.maxPrice),80400);
  const out=settle(held(),'80001','8139.9');assert.equal(out.state,'hold_cash');assert.equal(step(out,{type:'COMPLETE'},expiry).state,'complete');
  const proof=identity('exchange_settlement',{settlementId:'settlement-1',expiry,settledQty:'.05',settlementPrice:'80000',availableCash:'8139.9',settledAt:expiry,final:true});
  assert.equal(transitionExecutionIntent(equal,{type:'SETTLEMENT_CONFIRMED',proof},{now:expiry+100}).plan,equal);
});
test('real spot price, cash and five-minute boundary constrain each buy',()=>{
  const p=settle(held());assert.equal(Number(p.spot.maxPrice),79395);
  const quote={clientOrderId:'spot_1',qty:'.05',price:'79395',feeReserve:'5',availableCash:'8000',checkedAt:expiry};
  for(const patch of [{price:'79395.01'},{availableCash:'3900'},{qty:'.06'},{checkedAt:expiry-10000}])assert.equal(transitionExecutionIntent(p,{type:'SPOT_SUBMIT',quote:{...quote,...patch}},{now:expiry}).ok,false);
  assert.equal(transitionExecutionIntent(p,{type:'SPOT_SUBMIT',quote:{...quote,checkedAt:expiry+300000}},{now:expiry+300000}).ok,false);
  assert.equal(spotSubmit(p).state,'spot_submitting');
});
test('spot partial recovery buys only remaining gross quantity, not BTC fee differences',()=>{
  let p=spotSubmit(settle(held()));
  p=step(p,{type:'ORDER_UNKNOWN'},expiry);assert.equal(p.phase,'spot');assert.equal(p.pendingAction,null);assert.equal(transitionExecutionIntent(p,{type:'SPOT_SUBMIT',quote:{}},{now:expiry}).ok,false);
  p=reconcileSpot(p,[spotFill('spot-a','.02',{fee:'.00002'})]);assert.equal(p.state,'spot_partially_filled');assert.equal(Number(p.spot.filledQty),.02);assert.equal(Number(p.spot.netBtc),.01998);
  assert.equal(transitionExecutionIntent(p,{type:'SPOT_SUBMIT',quote:{clientOrderId:'spot_2',qty:'.05',price:'79000',feeReserve:'3',availableCash:'6000',checkedAt:expiry}},{now:expiry}).ok,false);
  p=spotSubmit(p,'.03',{clientOrderId:'spot_2',availableCash:'6000'});
  p=reconcileSpot(p,[spotFill('spot-b','.03',{fee:'.00003'})],'filled');assert.equal(p.state,'complete');assert.equal(Number(p.spot.filledQty),.05);assert.equal(Number(p.spot.netBtc),.04995);assert.equal(Number(p.spot.spent),3950);
});
test('zero settlement and delayed recovery do not assume BTC can be bought at zero or indefinitely late',()=>{
  assert.equal(settle(held(),'0','4000').state,'attention_required');
  const p=held(),proof=identity('exchange_settlement',{settlementId:'late',expiry,settledQty:'.05',settlementPrice:'79000',availableCash:'8000',settledAt:expiry,final:true});
  const late=step(p,{type:'SETTLEMENT_CONFIRMED',proof},expiry+300000);assert.equal(late.state,'attention_required');assert.equal(late.put.filledQty,'0.05');
});
test('unexpected actual fees are recorded as assets and cost while further trading is halted',()=>{
  let p=spotSubmit(settle(held()));
  p=reconcileSpot(p,[spotFill('cost-overrun','.05',{fee:'6',feeCurrency:'USDT'})],'filled');
  assert.equal(p.state,'attention_required');assert.equal(p.riskViolation,'actual_spot_spend_exceeded');assert.equal(Number(p.spot.filledQty),.05);assert.equal(Number(p.spot.netBtc),.05);assert.equal(Number(p.spot.spent),3956);assert.equal(p.pendingAction,null);
  assert.equal(transitionExecutionIntent(p,{type:'SPOT_SUBMIT',quote:{}},{now:expiry}).ok,false);
});

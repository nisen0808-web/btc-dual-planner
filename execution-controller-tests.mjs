import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ExecutionJournal} from './execution/journal.mjs';
import {ExecutionController} from './execution/controller.mjs';

const now=1792675000000;
function fixture({path=':memory:',liveEnabled=true,submit}={}){
  let time=now,calls=0,spotCalls=0;const journal=new ExecutionJournal(path);
  const intent={id:'plan-1',account:'dedicated-account',platform:'bybit',currency:'USDT',amount:10000,fingerprint:'parameters-v1',expiresAt:now+30000,expiry:now+60000,strike:78000,buyBufferRate:.005,fullFundReserve:7900,orderPayload:{symbol:'BTC-30OCT26-78000-P-USDT',qty:'0.1',price:'400',orderLinkId:'put-plan-1'}};
  const preflight=async()=>({verified:true,account:intent.account,currency:intent.currency,checkedAt:time,dedicatedSubaccount:true,noOtherPositions:true,noOtherOrders:true,noBorrowing:true,availableFunds:10000});
  const exchange={createSellPut:async(...args)=>{calls++;return submit?submit(...args):{ok:true,data:{orderId:'put-1'}};},createSpotBuy:async()=>{spotCalls++;return {ok:true,data:{orderId:'spot-1'}};}};
  const controller=new ExecutionController({journal,exchange,preflight,now:()=>time,liveEnabled});
  const fill={execId:'fill-1',orderLinkId:'put-plan-1',symbol:intent.orderPayload.symbol,execQty:'0.04',execPrice:'410',execFee:'0.5'};
  const putOrder={orderLinkId:'put-plan-1',symbol:fill.symbol,cumExecQty:'0.04',orderStatus:'Cancelled'};
  const proof={final:true,account:intent.account,currency:intent.currency,positionEmpty:true,balanceVerified:true,checkedAt:intent.expiry+1000,symbol:fill.symbol,side:'Sell',position:.04,strike:78000,deliveryTime:intent.expiry,deliveryPrice:74000,deliveryFee:.4,strategyCash:7700};
  return {journal,controller,intent,fill,putOrder,proof,confirm:()=>controller.confirm(intent,{confirmed:true,account:intent.account,currency:intent.currency,fingerprint:intent.fingerprint}),setTime:t=>time=t,get calls(){return calls;},get spotCalls(){return spotCalls;}};
}

test('live gate, explicit confirmation and fresh account checks must precede any order',async()=>{
  const f=fixture({liveEnabled:false});await assert.rejects(f.confirm(),/disabled/);assert.equal(f.calls,0);f.journal.close();
  const a=fixture();await assert.rejects(a.controller.confirm(a.intent,{confirmed:true,fingerprint:'changed'}));assert.equal(a.calls,0);
  a.controller.preflight=async()=>({verified:true});await assert.rejects(a.confirm(),/funding/);assert.equal(a.calls,0);a.journal.close();
});

test('intent is durable before sending, unknown submission never sends a duplicate, and one account has one active plan',async()=>{
  const f=fixture({submit:async()=>{assert.equal(f.journal.get('plan-1').phase,'put_submitting');throw Error('network');}});
  assert.equal((await f.confirm()).phase,'unknown');assert.equal((await f.confirm()).phase,'unknown');assert.equal(f.calls,1);
  assert.throws(()=>f.journal.create({...f.intent,id:'second'}));f.journal.close();
});

test('restart recovers the same submitted ID instead of placing another order',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'put-execution-'));const path=join(directory,'orders.sqlite');
  try{const first=fixture({path});await first.confirm();first.journal.close();const second=fixture({path});const old=await second.confirm();assert.equal(old.phase,'put_reconciling');assert.equal(second.calls,0);second.journal.close();}finally{await rm(directory,{recursive:true,force:true});}
});

test('cancelled IOC with a partial fill follows only actual size and deduplicates fills',async()=>{
  const f=fixture();await f.confirm();const p=f.controller.reconcilePut('plan-1',f.putOrder,[f.fill,f.fill]);assert.equal(p.phase,'holding');assert.equal(p.filledQty,.04);assert.equal(p.gross,16.4);assert.equal(p.openFee,.5);f.journal.close();
});

test('a missing or mismatched order remains unknown and cannot become a holding',async()=>{
  const f=fixture();await f.confirm();assert.equal(f.controller.reconcilePut('plan-1',null,[]).phase,'unknown');assert.throws(()=>f.controller.reconcilePut('plan-1',f.putOrder,[]),/reconciled/);f.journal.close();
});

test('settlement needs exact final evidence, empty position and verified cash; a clock or spot tick is insufficient',async()=>{
  const f=fixture();await f.confirm();f.controller.reconcilePut('plan-1',f.putOrder,[f.fill]);f.setTime(f.intent.expiry+1000);
  for(const patch of [{final:false},{positionEmpty:false},{balanceVerified:false},{symbol:'OTHER'},{position:.1},{deliveryTime:f.intent.expiry-1}])assert.throws(()=>f.controller.recordSettlement('plan-1',{...f.proof,...patch}),/settlement/);
  assert.equal(f.controller.recordSettlement('plan-1',f.proof).phase,'spot_ready');assert.equal(f.spotCalls,0);f.journal.close();
});

test('out of the money retains cash; late final settlement does not restart its five-minute window',async()=>{
  for(const [price,time,phase] of [[80000,61000,'complete_cash'],[74000,361000,'needs_attention']]){const f=fixture();await f.confirm();f.controller.reconcilePut('plan-1',f.putOrder,[f.fill]);f.setTime(now+time);assert.equal(f.controller.recordSettlement('plan-1',{...f.proof,checkedAt:now+time,deliveryPrice:price}).phase,phase);assert.equal(f.spotCalls,0);f.journal.close();}
});

test('spot respects settlement-based price cap, actual PUT size, known cash and no duplicate submission',async()=>{
  const f=fixture();await f.confirm();f.controller.reconcilePut('plan-1',f.putOrder,[f.fill]);f.setTime(f.intent.expiry+1000);f.controller.recordSettlement('plan-1',f.proof);
  const proposal={order:{symbol:'BTCUSDT',qty:'0.04',price:'74300',orderLinkId:'spot-plan-1'},feeReserve:5,authorization:{}};
  await assert.rejects(f.controller.buySpot('plan-1',{...proposal,order:{...proposal.order,price:'75000'}}));
  await assert.rejects(f.controller.buySpot('plan-1',{...proposal,order:{...proposal.order,qty:'.1'}}));assert.equal(f.spotCalls,0);
  assert.equal((await f.controller.buySpot('plan-1',proposal)).phase,'spot_reconciling');await assert.rejects(f.controller.buySpot('plan-1',proposal));assert.equal(f.spotCalls,1);
  const order={orderLinkId:'spot-plan-1',symbol:'BTCUSDT',cumExecQty:'.04',orderStatus:'Filled'},fill={execId:'spot-fill-1',orderLinkId:'spot-plan-1',symbol:'BTCUSDT',execQty:'.04',execPrice:'74200',execFee:'.00004',feeCurrency:'BTC'};
  const done=f.controller.reconcileSpot('plan-1',order,[fill,fill]);assert.equal(done.phase,'complete_btc');assert.equal(done.receivedBTC,.03996);assert.equal(done.spentUSDT,2968);f.journal.close();
});

test('journal refuses credential fields and stale writers without exposing values',()=>{
  const f=fixture();assert.throws(()=>f.journal.create({...f.intent,apiSecret:'never-save'}),/Credentials/);const plan=f.journal.create(f.intent);f.journal.update(plan.id,plan.version,{phase:'holding'});assert.throws(()=>f.journal.update(plan.id,plan.version,{phase:'ready'}),/state changed/);f.journal.close();
});

test('missing cash, NaN cash and a different account never pass funding checks',async()=>{
  for(const patch of [{availableFunds:undefined},{availableFunds:NaN},{availableFunds:-1},{verified:'true'},{account:'other'},{currency:'USDC'}]){
    const f=fixture();f.controller.preflight=async()=>({verified:true,account:f.intent.account,currency:'USDT',checkedAt:now,dedicatedSubaccount:true,noOtherPositions:true,noOtherOrders:true,noBorrowing:true,availableFunds:10000,...patch});
    await assert.rejects(f.confirm());assert.equal(f.calls,0);f.journal.close();
  }
});

test('settlement cannot import another account or unrelated new cash',async()=>{
  const f=fixture();await f.confirm();f.controller.reconcilePut('plan-1',f.putOrder,[f.fill]);f.setTime(f.intent.expiry+1000);
  assert.throws(()=>f.controller.recordSettlement('plan-1',{...f.proof,account:'other'}));
  assert.throws(()=>f.controller.recordSettlement('plan-1',{...f.proof,strategyCash:10000}),/outside/);f.journal.close();
});

test('actual fills outside the approved spot limit remain recorded and require attention',async()=>{
  const f=fixture();await f.confirm();f.controller.reconcilePut('plan-1',f.putOrder,[f.fill]);f.setTime(f.intent.expiry+1000);f.controller.recordSettlement('plan-1',f.proof);
  await f.controller.buySpot('plan-1',{order:{symbol:'BTCUSDT',qty:'.04',price:'74300',orderLinkId:'spot-plan-1'},feeReserve:5,authorization:{}});
  const result=f.controller.reconcileSpot('plan-1',{orderLinkId:'spot-plan-1',symbol:'BTCUSDT',cumExecQty:'.04',orderStatus:'Filled'},[{execId:'real-fill',orderLinkId:'spot-plan-1',symbol:'BTCUSDT',execQty:'.04',execPrice:'74500',execFee:'5',feeCurrency:'USDT'}]);
  assert.equal(result.phase,'needs_attention');assert.equal(result.closed,false);assert.equal(result.receivedBTC,.04);assert.equal(result.spentUSDT,2985);assert.equal(result.outOfBounds,true);f.journal.close();
});

test('an exact decimal settlement cap accepts the boundary and rejects the next tick',async()=>{
  const f=fixture();f.intent.strike=80000;f.intent.fullFundReserve=8100;
  await f.confirm();f.controller.reconcilePut('plan-1',f.putOrder,[f.fill]);f.setTime(f.intent.expiry+1000);
  f.controller.recordSettlement('plan-1',{...f.proof,deliveryPrice:79000,strike:80000});
  const order={symbol:'BTCUSDT',qty:'0.04',price:'79395.1',orderLinkId:'spot-plan-1'};
  await assert.rejects(f.controller.buySpot('plan-1',{order,feeReserve:5,authorization:{}}));
  assert.equal(f.spotCalls,0);
  assert.equal((await f.controller.buySpot('plan-1',{order:{...order,price:'79395'},feeReserve:5,authorization:{}})).phase,'spot_reconciling');
  assert.equal(f.spotCalls,1);f.journal.close();
});

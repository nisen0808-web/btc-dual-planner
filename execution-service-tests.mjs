import test from 'node:test';
import assert from 'node:assert/strict';
import {ExecutionJournal} from './execution/journal.mjs';
import {createExecutionService} from './execution/service.mjs';

const START=Date.UTC(2026,9,22,12),EXPIRY=START+60000,SYMBOL='BTC-22OCT26-80000-P-USDT';
const result=data=>({ok:true,data});
function fixture({liveEnabled=true}={}){
  const journal=new ExecutionJournal(':memory:');
  const f={journal,now:START,putCalls:[],spotCalls:[],reads:[],factoryCalls:0,settled:false,sourceBalance:'10000',btc:'0',borrow:'0',unsafe:false,readOnly:0,isMaster:false,permissionOptions:['OptionsTrade'],spotRate:'0.001',positionExtra:false,cursorLoop:false,historyOnly:false,unknown:false,clearSucceeds:true,autoPutUnknown:false};
  const optionSpec={validated:true,category:'option',status:'Trading',symbol:SYMBOL,baseCoin:'BTC',quoteCoin:'USDT',settleCoin:'USDT',optionsType:'Put',strike:'80000',deliveryTime:String(EXPIRY),priceFilter:{minPrice:'0.1',maxPrice:'100000',tickSize:'0.1'},lotSizeFilter:{qtyStep:'0.01',minOrderQty:'0.01',maxOrderQty:'100'}};
  const spotSpec={validated:true,category:'spot',status:'Trading',symbol:'BTCUSDT',baseCoin:'BTC',quoteCoin:'USDT',priceFilter:{tickSize:'0.1'},lotSizeFilter:{basePrecision:'0.000001',maxLimitOrderQty:'100',minOrderAmt:'5',maxOrderAmt:'10000000'}};
  const contract={symbol:SYMBOL,strike:80000,expires:EXPIRY,step:.01,min:.01,taker:.0003,cap:.125,delivery:.00015,spot:.001,spotDeductBase:true,priceTick:'0.1'};
  f.marketProvider={prepare:async()=>({market:{platform:'bybit',spot:85000,time:f.now},contract,book:{time:f.now,bids:[{price:1000,qty:.04},{price:800,qty:1}]},spec:optionSpec}),spot:async()=>({spec:spotSpec,ask:'79000',time:f.now})};
  const page=(category,list,nextPageCursor='')=>result({category,list,nextPageCursor});
  f.exchange={
    getApiInfo:async()=>{f.reads.push('api');return result({isMaster:f.isMaster,readOnly:f.readOnly,unsafePermissions:f.unsafe,permissions:{ContractTrade:[],Spot:['SpotTrade'],Wallet:[],Options:f.permissionOptions,Derivatives:[]}});},
    getAccountInfo:async()=>result({unifiedMarginStatus:6,marginMode:'REGULAR_MARGIN'}),
    getWalletBalance:async()=>{const coins=[{coin:'USDT',walletBalance:f.sourceBalance,equity:f.sourceBalance,locked:'0',borrowAmount:f.borrow,spotBorrow:'0'},{coin:'BTC',walletBalance:f.btc,equity:f.btc,locked:'0',borrowAmount:'0',spotBorrow:'0'}];if(f.missingBorrow)delete coins[0].borrowAmount;return result({list:[{accountType:'UNIFIED',totalAvailableBalance:'999999',coin:coins}]});},
    getPositions:async params=>{
      f.reads.push(['positions',params]);
      if(f.cursorLoop&&params.category==='option')return page(params.category,[{symbol:'BTC-OTHER',side:'',size:'0'}],'loop');
      if(f.positionExtra&&params.category==='option')return params.cursor?page(params.category,[{symbol:'ETH-OTHER',side:'Sell',size:'1'}]):page(params.category,[{symbol:'BTC-OTHER',side:'',size:'0'}],'next');
      return page(params.category,params.category==='option'&&f.putOrder&&!f.settled?[{symbol:SYMBOL,side:'Sell',size:'0.05'}]:[]);
    },
    getOrders:async params=>{
      f.reads.push(['orders',params]);
      if(!params.orderLinkId)return page(params.category,[]);
      const order=params.category==='option'?f.putOrder:f.spotOrder;
      return page(params.category,f.historyOnly&&params.category==='option'?[]:order?[order]:[]);
    },
    getOrderHistory:async params=>{f.reads.push(['history',params]);return page(params.category,f.putOrder?[f.putOrder]:[]);},
    getExecutions:async params=>{f.reads.push(['executions',params]);return page(params.category,params.category==='option'?f.putFills||[]:f.spotFills||[]);},
    getDeliveryRecords:async params=>{f.reads.push(['delivery',params]);return page('option',f.settled?[{symbol:SYMBOL,side:'Sell',position:f.deliveryPosition||'0.05',strike:'80000',deliveryTime:String(EXPIRY),deliveryPrice:'79000',fee:'0.05',deliveryRpl:'-50'}]:[]);},
    getFeeRates:async params=>{f.reads.push(['fees',params]);return result({category:params.category,list:params.category==='option'?[{baseCoin:'BTC',takerFeeRate:f.optionRate||'0.0003',makerFeeRate:'0'}]:[{symbol:'BTCUSDT',takerFeeRate:f.spotRate,makerFeeRate:'0'}]});},
    createSellPut:async(order,auth)=>{
      f.putCalls.push({order,auth});assert.deepEqual(Object.keys(order).sort(),['orderLinkId','price','qty','symbol']);assert.equal(auth.confirmedIntent.action,'sell_put');assert.equal(auth.spec.validated,true);
      f.putOrder={...order,orderId:'put-order',side:'Sell',orderType:'Limit',timeInForce:'IOC',orderStatus:'PartiallyFilledCanceled',cumExecQty:'0.05'};
      f.putFills=[{symbol:SYMBOL,orderId:'put-order',orderLinkId:order.orderLinkId,side:'Sell',execId:'p1',execType:'Trade',execQty:'0.03',execPrice:'800',execFee:'0.06',feeCurrency:'USDT',execTime:String(f.now)},{symbol:SYMBOL,orderId:'put-order',orderLinkId:order.orderLinkId,side:'Sell',execId:'p2',execType:'Trade',execQty:'0.02',execPrice:'800',execFee:'0.04',feeCurrency:'USDT',execTime:String(f.now)}];
      if(f.autoPutUnknown){f.unknown=true;return {ok:false,error:{unknown:true}};}return {ok:true,data:{orderId:'put-order'}};
    },
    createSpotBuy:async(order,auth)=>{
      f.spotCalls.push({order,auth});assert.equal(auth.confirmedIntent.action,'spot_buy');assert.equal(auth.confirmedIntent.isLeverage,0);
      f.spotOrder={...order,orderId:'spot-order',side:'Buy',orderType:'Limit',timeInForce:'IOC',orderStatus:'Filled',cumExecQty:'0.05'};
      f.spotFills=[{symbol:'BTCUSDT',orderId:'spot-order',orderLinkId:order.orderLinkId,side:'Buy',execId:'s1',execType:'Trade',execQty:'0.05',execPrice:'79000',execFee:'0.00005',feeCurrency:'BTC',execTime:String(f.now)}];if(f.autoSpotUnknown){f.unknown=true;return {ok:false,error:{unknown:true}};}return {ok:true,data:{orderId:'spot-order'}};
    },
    getExecutionState:()=>({reconciliationRequired:f.unknown}),
    reconcileUnknownOrder:async()=>{f.reads.push('clear');if(!f.clearSucceeds)return {ok:false};f.unknown=false;return {ok:true,status:'reconciled'};}
  };
  f.makeService=()=>createExecutionService({journal,exchangeFactory:()=>{f.factoryCalls++;return f.exchange;},marketProvider:f.marketProvider,now:()=>f.now,liveEnabled,accountLabel:'dedicated'});
  f.service=f.makeService();
  f.prepare=()=>f.service.prepare({amount:'8100',symbol:SYMBOL,buyBufferRate:.005});
  f.confirm=async()=>{await f.service.tick();const p=await f.prepare();f.prepared=p;return f.service.confirm({id:p.id,fingerprint:p.fingerprint,account:'dedicated',currency:'USDT',confirmed:true});};
  f.toHolding=async()=>{const p=await f.confirm();await f.service.tick();return journal.get(p.id);};
  f.settle=()=>{f.now=EXPIRY;f.settled=true;f.sourceBalance='9989.85';};
  return f;
}

test('disabled service prepares server-owned drafts without private reads or a connected claim',async()=>{
  const f=fixture({liveEnabled:false});try{
    const s=await f.service.status();assert.equal(s.connected,false);assert.equal(s.canSubmit,false);assert.equal(s.accountVerified,false);assert.equal(s.runnerOnline,false);
    const p=await f.prepare();assert.equal(p.account,'dedicated');assert.equal(p.q,'0.1');assert.equal(p.currency,'USDT');assert.equal(p.state,'account_required');assert.equal(f.factoryCalls,0);
    await assert.rejects(f.service.confirm({id:p.id,fingerprint:p.fingerprint,account:'dedicated',currency:'USDT',confirmed:true}),/尚未配置/);
    await assert.rejects(f.service.prepare({amount:'8100',symbol:SYMBOL,model:{valid:true}}),/只接受/);
  }finally{f.journal.close();}
});
test('status requires real permission/wallet verification and a fresh runner heartbeat',async()=>{
  const f=fixture();try{
    let status=await f.service.status();assert.equal(status.accountVerified,true);assert.equal(status.runnerOnline,false);assert.equal(status.canSubmit,false);
    await f.service.tick();status=await f.service.status();assert.equal(status.runnerOnline,true);assert.equal(status.canSubmit,true);
    f.now+=15000;assert.equal((await f.service.status()).runnerOnline,false);
    for(const key of ['isMaster','unsafe']){f[key]=true;f.service=f.makeService();assert.equal((await f.service.status()).connected,false);f[key]=false;}
  }finally{f.journal.close();}
});
test('missing borrow fields, read-only permission and USDT shortage never submit',async()=>{
  for(const mutate of [f=>f.missingBorrow=true,f=>f.readOnly=1,f=>f.permissionOptions=[],f=>f.borrow='0.1',f=>f.sourceBalance='100']){
    const f=fixture();try{mutate(f);await assert.rejects(f.confirm());assert.equal(f.putCalls.length,0);}finally{f.journal.close();}
  }
});
test('second pages and repeated cursors cannot falsely prove an isolated account',async()=>{
  for(const key of ['positionExtra','cursorLoop']){const f=fixture();try{f[key]=true;await assert.rejects(f.confirm());assert.equal(f.putCalls.length,0);assert.ok(f.reads.some(row=>Array.isArray(row)&&row[1].cursor));}finally{f.journal.close();}}
});
test('confirmation binds server draft and posts four fields once; retries are idempotent',async()=>{
  const f=fixture();try{
    const p=await f.confirm();assert.equal(p.phase,'put_reconciling');assert.equal(f.putCalls.length,1);
    const confirm={id:p.id,fingerprint:p.fingerprint,account:'dedicated',currency:'USDT',confirmed:true};
    assert.equal((await f.service.confirm(confirm)).id,p.id);assert.equal(f.putCalls.length,1);
    for(const patch of [{fingerprint:'other'},{currency:'USDC'},{account:'other'},{confirmed:'true'}])await assert.rejects(f.service.confirm({...confirm,...patch}));
    f.now+=30000;const fresh=await f.prepare();f.now+=30000;await assert.rejects(f.service.confirm({...confirm,id:fresh.id,fingerprint:fresh.fingerprint}));assert.equal(f.putCalls.length,1);
  }finally{f.journal.close();}
});
test('history lookup and duplicate executions reconcile actual PUT partials without resend',async()=>{
  const f=fixture();try{
    const p=await f.confirm();f.historyOnly=true;f.putFills.push({...f.putFills[0]});await f.service.tick();
    const held=f.journal.get(p.id);assert.equal(held.phase,'holding');assert.equal(held.filledQty,.05);assert.equal(held.gross,40);assert.equal(held.openFee,.1);assert.equal(f.putCalls.length,1);assert.ok(f.reads.some(row=>Array.isArray(row)&&row[0]==='history'));
  }finally{f.journal.close();}
});
test('unknown recovery after restart reads original order and clears only through adapter reconciliation',async()=>{
  const f=fixture();try{
    f.autoPutUnknown=true;const p=await f.confirm();assert.equal(p.phase,'unknown');f.clearSucceeds=false;f.service=f.makeService();await f.service.tick();assert.equal(f.spotCalls.length,0);assert.equal(f.putCalls.length,1);
    f.settle();await f.service.tick();f.now+=1000;await f.service.tick();assert.equal(f.spotCalls.length,0);
    f.clearSucceeds=true;await f.service.tick();f.now+=1000;await f.service.tick();assert.equal(f.spotCalls.length,1);assert.equal(f.putCalls.length,1);assert.ok(f.reads.includes('clear'));
  }finally{f.journal.close();}
});
test('final settlement needs two cash-identical observations at least a second apart',async()=>{
  const f=fixture();try{
    const p=await f.toHolding();f.settle();await f.service.tick();assert.equal(f.journal.get(p.id).phase,'settlement_pending');assert.equal(f.spotCalls.length,0);
    f.now+=999;await f.service.tick();assert.equal(f.spotCalls.length,0);f.now++;await f.service.tick();assert.equal(f.spotCalls.length,1);
    const sent=f.spotCalls[0];assert.equal(sent.order.qty,'0.05');assert.equal(sent.order.price,'79395');assert.equal(sent.auth.confirmedIntent.feeReserve,'3.96975');
    await f.service.tick();const done=f.journal.get(p.id);assert.equal(done.phase,'complete_btc');assert.equal(done.receivedBTC,.04995);assert.equal(done.spentUSDT,3950);
  }finally{f.journal.close();}
});
test('cash contamination resets the stability observation and never buys from unproved funds',async()=>{
  const f=fixture();try{
    const p=await f.toHolding();f.settle();await f.service.tick();f.now+=1000;f.sourceBalance='9990.85';await f.service.tick();assert.equal(f.spotCalls.length,0);assert.equal(f.journal.get(p.id).settlementObservation,null);
    f.sourceBalance='9989.85';f.now+=1000;await f.service.tick();assert.equal(f.spotCalls.length,0);f.now+=1000;await f.service.tick();assert.equal(f.spotCalls.length,1);
  }finally{f.journal.close();}
});
test('actual account spot fee is used instead of a public default',async()=>{
  const f=fixture();try{await f.toHolding();f.spotRate='0.002';f.settle();await f.service.tick();f.now+=1000;await f.service.tick();assert.equal(f.spotCalls[0].auth.confirmedIntent.feeReserve,'7.9395');}finally{f.journal.close();}
});
test('live preparation uses actual option and spot fees before fixing quantity and reserves',async()=>{
  const f=fixture();try{
    f.optionRate='0.0007';f.spotRate='0.002';const p=await f.prepare();assert.equal(p.optionTakerRate,'0.0007');assert.equal(p.spotEstimate.feeRate,'0.002');assert.equal(Number(p.estimatedNetIncome),82.05);assert.equal(Number(p.feeReserve),23.15);assert.equal(Number(p.fullFundReserve),8063.15);
    await f.service.tick();await f.service.confirm({id:p.id,fingerprint:p.fingerprint,account:'dedicated',currency:'USDT',confirmed:true});assert.equal(f.putCalls.length,1);
  }finally{f.journal.close();}
});
test('an incomplete spot or recovery capability cannot enable status or submit a PUT',async()=>{
  for(const remove of [f=>delete f.marketProvider.spot,f=>delete f.exchange.createSpotBuy,f=>delete f.exchange.reconcileUnknownOrder]){
    const f=fixture();try{remove(f);const s=await f.service.status();assert.equal(s.connected,false);assert.equal(s.canSubmit,false);await assert.rejects(f.confirm());assert.equal(f.putCalls.length,0);}finally{f.journal.close();}
  }
});
test('terminal unknown spot remains durable and blocks new plans until its original adapter gate clears',async()=>{
  const f=fixture();try{
    const p=await f.toHolding();f.autoSpotUnknown=true;f.settle();await f.service.tick();f.now+=1000;await f.service.tick();assert.equal(f.journal.get(p.id).phase,'spot_unknown');
    f.clearSucceeds=false;await f.service.tick();let plan=f.journal.get(p.id);assert.equal(plan.closed,false);assert.equal(plan.phase,'spot_unknown');assert.equal(plan.receivedBTC,.04995);assert.equal(f.spotCalls.length,1);
    f.btc='0.04995';f.sourceBalance='6039.85';assert.equal((await f.service.status()).canSubmit,false);
    f.clearSucceeds=true;await f.service.tick();plan=f.journal.get(p.id);assert.equal(plan.phase,'complete_btc');assert.equal(plan.closed,true);assert.equal(f.spotCalls.length,1);
  }finally{f.journal.close();}
});
test('a terminal unknown no-fill remains active until the original adapter gate clears',async()=>{
  const f=fixture();try{
    f.autoPutUnknown=true;const p=await f.confirm();f.putOrder.orderStatus='Cancelled';f.putOrder.cumExecQty='0';f.putFills=[];f.clearSucceeds=false;
    await f.service.tick();assert.equal(f.journal.get(p.id).closed,false);assert.equal(f.journal.get(p.id).phase,'unknown');assert.equal((await f.service.status()).canSubmit,false);
    f.clearSucceeds=true;await f.service.tick();assert.equal(f.journal.get(p.id).phase,'no_fill');assert.equal(f.journal.get(p.id).closed,true);assert.equal(f.putCalls.length,1);
  }finally{f.journal.close();}
});
test('actual partial quantity comes from decimal fills rather than binary accumulated numbers',async()=>{
  const f=fixture();try{
    const p=await f.confirm();f.putFills[0].execQty='0.07';f.putOrder.cumExecQty='0.09';await f.service.tick();assert.equal(f.journal.get(p.id).filledQty,.07+.02);
    f.settle();f.deliveryPosition='0.09';f.sourceBalance='9981.85';await f.service.tick();f.now+=1000;await f.service.tick();assert.equal(f.spotCalls[0].order.qty,'0.09');
  }finally{f.journal.close();}
});
test('pause still reconciles submitted orders and final settlement but prevents future POST',async()=>{
  const f=fixture();try{
    const p=await f.confirm();const paused=f.service.pause({id:p.id});assert.equal(paused.automationPaused,true);assert.equal(paused.closed,false);
    await f.service.tick();assert.equal(f.journal.get(p.id).phase,'holding');f.settle();await f.service.tick();f.now+=1000;await f.service.tick();
    const plan=f.journal.get(p.id);assert.equal(plan.phase,'spot_ready');assert.equal(plan.automationPaused,true);assert.equal(f.spotCalls.length,0);assert.equal(f.putCalls.length,1);
  }finally{f.journal.close();}
});
test('pause during public spot reads is checked again before creating any order',async()=>{
  const f=fixture();try{
    const p=await f.toHolding();f.settle();await f.service.tick();f.now+=1000;
    let release,entered;const started=new Promise(resolve=>entered=resolve),wait=new Promise(resolve=>release=resolve);
    const normal=f.marketProvider.spot;f.marketProvider.spot=async input=>{entered();await wait;return normal(input);};
    const pending=f.service.tick();await started;f.service.pause({id:p.id});release();await pending;assert.equal(f.spotCalls.length,0);assert.equal(f.journal.get(p.id).automationPaused,true);
  }finally{f.journal.close();}
});
test('five-minute recovery deadline and unknown fee metadata both prevent spot submission',async()=>{
  for(const late of [true,false]){const f=fixture();try{
    const p=await f.toHolding();f.settle();await f.service.tick();f.now=late?EXPIRY+300000:EXPIRY+1000;if(!late)f.spotRate=undefined;await f.service.tick();assert.equal(f.spotCalls.length,0);assert.notEqual(f.journal.get(p.id).phase,'spot_submitting');
  }finally{f.journal.close();}}
});

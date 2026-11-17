import test from 'node:test';
import assert from 'node:assert/strict';
import {ExecutionJournal} from './execution/journal.mjs';
import {createDeribitExecutionService} from './execution/deribit-service.mjs';
import {createDeribitPublicMarket} from './execution/deribit-market.mjs';

const EXPIRY=Date.UTC(2026,9,23,8),START=EXPIRY-60000,SYMBOL='BTC_USDC-23OCT26-80000-P';
const good=data=>({ok:true,data});
const clone=x=>JSON.parse(JSON.stringify(x));
const SCALE=10n**18n;
const decimal=value=>{const source=/e/i.test(String(value))?Number(value).toFixed(18):String(value);const [whole,fraction='']=source.split('.');return BigInt(whole)*SCALE+BigInt(fraction.padEnd(18,'0'));};
const text=value=>{const digits=value.toString().padStart(19,'0');return (digits.slice(0,-18)+'.'+digits.slice(-18)).replace(/\.?0+$/,'');};
function fixture(liveEnabled=true){
  const f={now:START,balance:'10000',btc:'0',accountId:10,putCalls:[],spotCalls:[],reads:[],unknown:false,clear:true,settled:false,deliveryPrice:'79000',spotAsk:'79000',logs:[],positions:[],extraOrders:[],factoryCalls:0};
  f.journal=new ExecutionJournal(':memory:');
  f.spec={validated:true,instrument_name:SYMBOL,kind:'option',state:'open',is_active:true,base_currency:'BTC',quote_currency:'USDC',settlement_currency:'USDC',instrument_type:'linear',contract_size:1,min_trade_amount:.01,tick_size:5,tick_size_steps:[{above_price:1000,tick_size:20}],option_type:'put',strike:80000,expiration_timestamp:EXPIRY,price_index:'btc_usdc',taker_commission:.0003,taker_max_commission:.125};
  f.spotSpec={validated:true,instrument_name:'BTC_USDC',kind:'spot',state:'open',is_active:true,base_currency:'BTC',quote_currency:'USDC',instrument_type:'linear',contract_size:1,min_trade_amount:.00000001,tick_size:.01,tick_size_steps:[],price_index:'btc_usdc',taker_commission:.0005,is_csr:true};
  f.marketProvider={environment:'testnet',prepare:async()=>({spec:clone(f.spec),spotSpec:clone(f.spotSpec),book:{time:f.now,bids:f.bids||[{price:1000,qty:.04},{price:800,qty:1}]},market:{platform:'deribit',spot:85000,time:f.now},environment:'testnet'}),spot:async()=>{if(f.spotReadHook)await f.spotReadHook();return {spec:clone(f.spotSpec),ask:f.spotAsk,time:f.now};},settlement:async({symbol,expiry,indexName})=>({symbol,expiry,indexName,price:f.deliveryPrice,final:true,checkedAt:f.now})};
  const row=(currency,balance)=>({currency,balance,equity:balance,margin_balance:balance,available_funds:balance,available_withdrawal_funds:balance,initial_margin:0,maintenance_margin:0,spot_reserve:0,additional_reserve:0,locked_balance:0,cross_collateral_enabled:false,portfolio_margining_enabled:false,margin_model:'segregated_sm'});
  f.exchange={
    getApiInfo:async()=>good({isMaster:false,readOnly:false,unsafePermissions:false,keyEnabled:true,keyScopeKnown:true,permissions:{account:'read',trade:'read_write',wallet:'none'},...f.apiPatch}),
    getAccountSummaries:async()=>{f.reads.push('wallet');const cash={...row('USDC',f.balance),...f.cashPatch};if(f.fees!==undefined)cash.fees=f.fees;return good({id:f.accountId,type:'subaccount',summaries:[cash,row('BTC',f.btc),...(f.extraCurrency?[row('ETH','1')]:[])]});},
    getPositions:async params=>{f.reads.push(['positions',params]);return good(f.positions);},
    getOpenOrders:async params=>{f.reads.push(['orders',params]);return good(f.extraOrders);},
    getOrderStateByLabel:async({label})=>good(f.historyOnly?[]:[f.putOrder,f.spotOrder].filter(r=>r?.label===label)),
    getOrderHistory:async params=>{f.reads.push(['history',params]);return good({orders:[f.putOrder,f.spotOrder].filter(r=>r?.instrument_name===params.instrument_name),continuation:null});},
    getTradesByOrder:async params=>{f.reads.push(['trades',params]);return good(params.order_id==='put-id'?f.putTrades||[]:f.spotTrades||[]);},
    getTransactionLog:async params=>{f.reads.push(['ledger',params]);return good({logs:f.logs,continuation:f.ledgerLoop?42:null});},
    getExecutionState:()=>({reconciliationRequired:f.unknown,finalGateSupported:true}),
    reconcileUnknownOrder:async params=>{f.reads.push(['clear',params]);if(!f.clear)return {ok:false};f.unknown=false;return {ok:true};},
    createSellPut:async(order,auth)=>{
      if(f.putPreSubmitHook)await f.putPreSubmitHook();if(auth.beforeSubmit()!==true)return {ok:false,error:{code:'final_gate_refused',unknown:false}};
      f.putCalls.push({order,auth});assert.deepEqual(Object.keys(order).sort(),['amount','instrument_name','label','price']);assert.equal(auth.confirmedIntent.type,'limit');assert.equal(auth.confirmedIntent.time_in_force,'immediate_or_cancel');assert.equal(auth.confirmedIntent.currency,'USDC');
      f.putOrder={...order,order_id:'put-id',order_type:'limit',direction:'sell',time_in_force:'immediate_or_cancel',order_state:'cancelled',filled_amount:'0.05',post_only:false,creation_timestamp:f.now};
      f.putTrades=[{trade_id:'p1',order_id:'put-id',instrument_name:SYMBOL,direction:'sell',amount:'0.03',price:'800',fee:'0.06',fee_currency:'USDC',timestamp:f.now},{trade_id:'p2',order_id:'put-id',instrument_name:SYMBOL,direction:'sell',amount:'0.02',price:'800',fee:'0.04',fee_currency:'USDC',timestamp:f.now}];
      f.positions=[{instrument_name:SYMBOL,direction:'sell',size:'-0.05'}];
      if(f.putUnknown){f.unknown=true;return {ok:false,error:{unknown:true}};}return good({order:clone(f.putOrder)});
    },
    createSpotBuy:async(order,auth)=>{
      if(f.spotPreSubmitHook)await f.spotPreSubmitHook();if(auth.beforeSubmit()!==true)return {ok:false,error:{code:'final_gate_refused',unknown:false}};
      const quantity=order.amount,price=f.spotFillPrice||'79000',notional=decimal(quantity)*decimal(price)/SCALE,fee=text(notional*decimal(f.spotActualFeeRate||'0.0005')/SCALE);
      f.spotCalls.push({order,auth});f.spotOrder={...order,order_id:'spot-id',order_type:'limit',direction:'buy',time_in_force:'immediate_or_cancel',order_state:'filled',filled_amount:quantity,post_only:false,creation_timestamp:f.now};
      f.spotTrades=[{trade_id:'s1',order_id:'spot-id',instrument_name:'BTC_USDC',direction:'buy',amount:quantity,price,fee,fee_currency:'USDC',timestamp:f.now}];f.btc=quantity;
      if(f.spotUnknown){f.unknown=true;return {ok:false,error:{unknown:true}};}return good({order:clone(f.spotOrder)});
    }
  };
  f.create=()=>createDeribitExecutionService({journal:f.journal,exchangeFactory:()=>{f.factoryCalls++;return f.exchange;},marketProvider:f.marketProvider,now:()=>f.now,liveEnabled,accountLabel:'dedicated'});
  f.service=f.create();f.prepare=()=>f.service.prepare({amount:'8100',symbol:SYMBOL,buyBufferRate:.005});
  f.confirm=async()=>{await f.service.tick();const p=await f.prepare();f.prepared=p;return f.service.confirm({id:p.id,fingerprint:p.fingerprint,account:'dedicated',currency:'USDC',confirmed:true});};
  f.holding=async()=>{const p=await f.confirm();await f.service.tick();return f.journal.get(p.id);};
  f.settle=()=>{f.now=EXPIRY;f.positions=[];f.balance='9989.85';f.logs=[{id:1,currency:'USDC',timestamp:START,type:'trade',instrument_name:SYMBOL,order_id:'put-id',trade_id:'p1',amount:.03,change:23.94,commission:.06},{id:2,currency:'USDC',timestamp:START,type:'trade',instrument_name:SYMBOL,order_id:'put-id',trade_id:'p2',amount:.02,change:15.96,commission:.04},{id:3,currency:'USDC',timestamp:EXPIRY,type:'assignment',instrument_name:SYMBOL,amount:.05,position:0,change:-.05,commission:.05},{id:4,currency:'USDC',timestamp:EXPIRY,type:'future creation',instrument_name:'BTC_USDC-23OCT26',amount:.05,position:.05,change:0,commission:0},{id:5,currency:'USDC',timestamp:EXPIRY,type:'delivery',instrument_name:'BTC_USDC-23OCT26',amount:.05,position:0,settlement_price:79000,change:-50,commission:0}];};
  f.buy=async()=>{const p=await f.holding();f.settle();await f.service.tick();f.now+=1000;await f.service.tick();return f.journal.get(p.id);};
  return f;
}

test('default-off drafts never authenticate, claim a connection or submit',async()=>{const f=fixture(false);try{const p=await f.prepare();assert.equal(p.currency,'USDC');assert.equal(p.q,'0.1');assert.equal(p.canSubmit,false);assert.equal(p.fundsLocked,false);assert.equal(f.factoryCalls,0);const status=await f.service.status();for(const key of ['connected','canSubmit','accountVerified','runnerOnline'])assert.equal(status[key],false);await assert.rejects(f.service.confirm({id:p.id}),/尚未配置/);assert.equal(f.putCalls.length,0);}finally{f.journal.close();}});
test('account verification, full-cash budget and runner heartbeat gate confirmation',async()=>{const f=fixture();try{let s=await f.service.status();assert.equal(s.accountVerified,true);assert.equal(s.canSubmit,false);await f.service.tick();assert.equal((await f.service.status()).canSubmit,true);const p=await f.prepare();assert.ok(Number(p.fullFundReserve)<=8100);assert.equal(p.buyBufferReserve,'40');f.balance='8099';await assert.rejects(f.service.confirm({id:p.id,fingerprint:p.fingerprint,account:'dedicated',currency:'USDC',confirmed:true}),/USDC 不足/);assert.equal(f.putCalls.length,0);f.now+=15000;assert.equal((await f.service.status()).runnerOnline,false);}finally{f.journal.close();}});
test('unknown permissions, negative/other funds, nonstandard mode and missing fields fail closed',async()=>{for(const mutate of [f=>f.apiPatch={unsafePermissions:true},f=>f.apiPatch={isMaster:true},f=>f.apiPatch={permissions:{account:'read',trade:'read_write',wallet:'read_write'}},f=>f.cashPatch={balance:'-1'},f=>f.extraCurrency=true,f=>f.cashPatch={cross_collateral_enabled:true},f=>f.cashPatch={locked_balance:undefined},f=>f.cashPatch={margin_model:'cross_pm'}]){const f=fixture();try{mutate(f);assert.equal((await f.service.status()).connected,false);await assert.rejects(f.confirm());assert.equal(f.putCalls.length,0);}finally{f.journal.close();}}});
test('actual fixed and relative fees update canonical reserves; ambiguous spot discount blocks',async()=>{const f=fixture();try{f.fees={btc_usdc:{option:{default:{type:'relative',taker:2}},spot:{default:{type:'fixed',taker:.002}}}};const p=await f.prepare();assert.equal(p.optionTakerRate,'0.0006');assert.equal(p.spotTakerRate,'0.002');assert.ok(Number(p.feeReserve)>20);delete f.fees.btc_usdc.spot;await assert.rejects(f.prepare(),/费率无法唯一/);}finally{f.journal.close();}});
test('frozen exact economics, account and expiry bind confirmation; durable retry never resends',async()=>{const f=fixture();try{const p=await f.confirm();assert.equal(f.putCalls.length,1);assert.equal(p.phase,'put_reconciling');assert.equal(JSON.parse(p.fingerprint).buffer,'0.005');const c={id:p.id,fingerprint:p.fingerprint,account:'dedicated',currency:'USDC',confirmed:true};assert.equal((await f.service.confirm(c)).id,p.id);assert.equal(f.putCalls.length,1);await assert.rejects(f.service.confirm({...c,currency:'USDT'}));f.accountId=11;await f.service.tick();assert.equal((await f.service.status()).connected,false);}finally{f.journal.close();}});
test('last swept bid sets IOC floor and dynamic tick/quantity units are enforced',async()=>{const f=fixture(false);try{let p=await f.prepare();assert.equal(p.limitPrice,'800');assert.equal(p.q,'0.1');f.bids=[{price:1020,qty:1}];p=await f.prepare();assert.equal(p.priceTick,'20');f.bids=[{price:1010,qty:1}];await assert.rejects(f.prepare(),/分档步长/);f.spec.contract_size=10;await assert.rejects(f.prepare(),/单位为 BTC/);}finally{f.journal.close();}});
test('partial IOC is reconciled from recent+historical trades with dedup and no resend',async()=>{const f=fixture();try{const p=await f.confirm();f.historyOnly=true;f.putTrades.push(clone(f.putTrades[0]));await f.service.tick();const held=f.journal.get(p.id);assert.equal(held.phase,'holding');assert.equal(held.filledQty,'0.05');assert.equal(held.gross,'40');assert.equal(held.openFee,'0.1');assert.equal(held.activeBuyBufferReserve,'20');assert.ok(Number(held.activeFundReserve)<Number(held.fullFundReserve));assert.equal(f.putCalls.length,1);assert.ok(f.reads.some(r=>Array.isArray(r)&&r[0]==='history'&&r[1].historical===true));}finally{f.journal.close();}});
test('nonterminal partial, duplicate label orders and incomplete fills cannot settle or reissue',async()=>{for(const mutate of [f=>f.putOrder.order_state='open',f=>f.putTrades.pop(),f=>{f.exchange.getOrderStateByLabel=async()=>good([f.putOrder,{...f.putOrder,order_id:'duplicate'}]);}]){const f=fixture();try{const p=await f.confirm();mutate(f);await f.service.tick();assert.notEqual(f.journal.get(p.id).phase,'holding');assert.equal(f.putCalls.length,1);assert.equal(f.spotCalls.length,0);}finally{f.journal.close();}}});
test('restart unknown results keep durable plan open until adapter reconciliation clears',async()=>{const f=fixture();try{f.putUnknown=true;const p=await f.confirm();f.clear=false;f.service=f.create();await f.service.tick();assert.equal(f.journal.get(p.id).phase,'unknown');assert.equal(f.journal.get(p.id).closed,false);assert.equal((await f.service.status()).canSubmit,false);f.clear=true;await f.service.tick();assert.equal(f.journal.get(p.id).phase,'holding');assert.equal(f.putCalls.length,1);}finally{f.journal.close();}});
test('unknown terminal zero-fill cannot close while adapter gate remains blocked',async()=>{const f=fixture();try{f.putUnknown=true;const p=await f.confirm();f.putOrder.filled_amount='0';f.putTrades=[];f.positions=[];f.clear=false;await f.service.tick();assert.equal(f.journal.get(p.id).closed,false);assert.equal(f.journal.get(p.id).phase,'unknown');f.clear=true;await f.service.tick();assert.equal(f.journal.get(p.id).phase,'no_fill');assert.equal(f.journal.get(p.id).closed,true);}finally{f.journal.close();}});
test('two-step settlement spends only confirmed strategy cash, with durable recovery and actual residual',async()=>{
  const f=fixture();try{
    const p=await f.holding();f.settle();f.logs.pop();await f.service.tick();assert.equal(f.spotCalls.length,0);assert.equal(f.journal.get(p.id).lastError.code,'settlement_pending');
    f.settle();await f.service.tick();assert.equal(f.journal.get(p.id).phase,'settlement_pending');f.service=f.create();f.now+=999;await f.service.tick();assert.equal(f.spotCalls.length,0);f.now++;await f.service.tick();assert.equal(f.spotCalls.length,1);
    const {order,auth}=f.spotCalls[0],pending=f.journal.get(p.id);
    assert.equal(order.amount,'0.10184277');assert.equal(order.price,'79395');assert.equal(auth.confirmedIntent.feeReserve,'4.042903362075');
    assert.equal(pending.strategyCash,'8089.85');assert.equal(pending.spotCashCap,'8089.85');assert.equal(auth.confirmedIntent.maxFunds,'8089.85');
    assert.equal(pending.spotPlannedQty,order.amount);assert.equal(pending.spotBudgetMode,'remaining_strategy_cash');assert.ok(Number(order.amount)>Number(p.filledQty));
    // The wallet also contains 1,900 USDC that was never allocated to this plan.
    const cash=decimal(pending.strategyCash),price=decimal(order.price),step=decimal(f.spotSpec.min_trade_amount),rate=decimal(pending.spotAppliedFeeRate);
    const expense=q=>{const cost=(q*price+SCALE-1n)/SCALE;return cost+(cost*rate+SCALE-1n)/SCALE;};
    assert.ok(expense(decimal(order.amount))<=cash);assert.ok(expense(decimal(order.amount)+step)>cash);assert.ok(Number(pending.spotLimitNotional)+Number(pending.spotFeeReserve)<Number(f.balance));
    f.service=f.create();await f.service.tick();const done=f.journal.get(p.id);
    assert.equal(done.phase,'complete_btc');assert.equal(done.receivedBTC,'0.10184277');assert.equal(done.spentUSDC,'8045.57883');assert.equal(done.spotFeeUSDC,'4.022789415');assert.equal(done.remainingStrategyCash,'40.248380585');
    await f.service.tick();assert.equal(f.spotCalls.length,1);
  }finally{f.journal.close();}
});
test('foreign cash movement, incomplete pagination, residual future and inconsistent wallet stop buy',async()=>{for(const mutate of [f=>f.logs.push({id:6,currency:'USDC',timestamp:EXPIRY,type:'transfer',change:0,commission:0}),f=>f.ledgerLoop=true,f=>f.positions=[{instrument_name:'BTC_USDC-23OCT26',size:.05,direction:'buy'}],f=>f.balance='9989.86']){const f=fixture();try{const p=await f.holding();f.settle();mutate(f);await f.service.tick();f.now+=1000;await f.service.tick();assert.equal(f.spotCalls.length,0);assert.ok(f.journal.get(p.id).lastError);}finally{f.journal.close();}}});
test('pause wins during async reads and still permits settlement reconciliation',async()=>{const f=fixture();try{const p=await f.holding();f.settle();await f.service.tick();f.now+=1000;f.spotReadHook=async()=>f.service.pause({id:p.id});await f.service.tick();const paused=f.journal.get(p.id);assert.equal(paused.automationPaused,true);assert.equal(paused.settlement.final,true);assert.equal(f.spotCalls.length,0);assert.equal(f.putCalls.length,1);}finally{f.journal.close();}});
test('buffer cap and five minute deadline never become a market/top-up order',async()=>{for(const mutate of [f=>f.spotAsk='79395.01',f=>f.now=EXPIRY+300000]){const f=fixture();try{const p=await f.holding();f.settle();await f.service.tick();f.now+=1000;mutate(f);await f.service.tick();assert.equal(f.spotCalls.length,0);assert.equal(f.putCalls.length,1);if(f.now>=EXPIRY+300000)assert.equal(f.journal.get(p.id).phase,'needs_attention');}finally{f.journal.close();}}});
test('partial/unknown spot records actual fills and never sends a second buy',async()=>{const f=fixture();try{f.spotUnknown=true;const p=await f.buy();assert.equal(f.spotCalls.length,1);f.spotOrder.filled_amount='0.02';f.spotOrder.order_state='cancelled';f.spotTrades[0].amount='0.02';f.spotTrades[0].fee='0.79';f.btc='0.02';f.clear=false;await f.service.tick();assert.equal(f.journal.get(p.id).phase,'spot_unknown');f.clear=true;await f.service.tick();assert.equal(f.journal.get(p.id).phase,'needs_attention');assert.equal(f.journal.get(p.id).receivedBTC,'0.02');await f.service.tick();assert.equal(f.spotCalls.length,1);}finally{f.journal.close();}});
test('missing spot/recovery adapter chain never allows a PUT',async()=>{for(const key of ['createSpotBuy','reconcileUnknownOrder']){const f=fixture();try{delete f.exchange[key];assert.equal((await f.service.status()).connected,false);await assert.rejects(f.confirm());assert.equal(f.putCalls.length,0);}finally{f.journal.close();}}});
test('official response without commission cap and tiny spot contract size uses disclosed fee policy',async()=>{const f=fixture(false);try{delete f.spec.taker_max_commission;f.spotSpec.contract_size=1e-8;const p=await f.prepare();assert.equal(p.q,'0.1');assert.equal(p.feePolicy.optionFeeCap,'0.125');assert.equal(p.feePolicy.capSource,'official published fee policy');assert.match(p.feePolicy.source,/support\.deribit\.com/);}finally{f.journal.close();}});
test('high precision official fixed fee is conservatively rounded only for reserve rates',async()=>{const f=fixture();try{f.fees={btc_usdc:{option:{default:{type:'fixed',taker:.00035000000000000005}},spot:{default:{type:'fixed',taker:.0005}}}};const p=await f.prepare();assert.equal(p.optionTakerRate,'0.000350000000000001');assert.ok(Number(p.fullFundReserve)<=8100);}finally{f.journal.close();}});
test('ATM expiry proof triggers bounded buy; OTM expiry retains USDC after two observations',async()=>{for(const ST of ['80000','80001']){const f=fixture();try{const p=await f.holding();f.settle();f.deliveryPrice=ST;f.balance='10039.9';f.logs=f.logs.slice(0,2).concat({id:3,currency:'USDC',timestamp:EXPIRY,type:'expiry',instrument_name:SYMBOL,amount:.05,position:0,change:0,commission:0});await f.service.tick();f.now+=1000;await f.service.tick();if(ST==='80000'){assert.equal(f.spotCalls.length,1);assert.equal(f.spotCalls[0].order.price,'80400');}else{const done=f.journal.get(p.id);assert.equal(done.phase,'complete_cash');assert.equal(done.closed,true);assert.equal(done.strategyCash,'8139.9');assert.equal(f.spotCalls.length,0);}}finally{f.journal.close();}}});
test('fees beyond reserves and a changed actual PUT position retain fills and stop automation',async()=>{const f=fixture();try{const p=await f.confirm();f.putTrades[0].fee='100';await f.service.tick();assert.equal(f.journal.get(p.id).phase,'needs_attention');assert.equal(f.journal.get(p.id).filledQty,'0.05');assert.equal(f.spotCalls.length,0);}finally{f.journal.close();}const g=fixture();try{const p=await g.holding();g.positions=[];await g.service.tick();assert.equal(g.journal.get(p.id).phase,'needs_attention');assert.equal(g.spotCalls.length,0);}finally{g.journal.close();}});
test('late prepare and exact 30 second confirmation cutoff cannot refresh stale quote economics',async()=>{const f=fixture();try{await f.service.tick();const p=await f.prepare();f.now=p.expiresAt;await assert.rejects(f.service.confirm({id:p.id,fingerprint:p.fingerprint,account:'dedicated',currency:'USDC',confirmed:true}),/失效/);assert.equal(f.putCalls.length,0);}finally{f.journal.close();}});
test('abnormal nonterminal orders keep reconciling later fills until terminal without new orders',async()=>{const f=fixture();try{const p=await f.confirm();f.putOrder.order_state='open';f.putTrades[0].fee='100';await f.service.tick();let row=f.journal.get(p.id);assert.equal(row.phase,'put_reconciling');assert.equal(row.attentionRequired,true);assert.equal(row.lastOrderTerminal,false);f.putTrades.push({...f.putTrades[1],trade_id:'p3',amount:'0.01',fee:'0.02'});f.putOrder.filled_amount='0.06';f.putOrder.order_state='cancelled';await f.service.tick();row=f.journal.get(p.id);assert.equal(row.phase,'needs_attention');assert.equal(row.filledQty,'0.06');assert.equal(row.openFee,'100.06');assert.equal(row.lastOrderTerminal,true);assert.equal(f.putCalls.length,1);assert.equal(f.spotCalls.length,0);}finally{f.journal.close();}});
test('pause during adapter authentication or clock awaits wins at the final pre-POST gate',async()=>{const f=fixture();try{f.putPreSubmitHook=async()=>f.service.pause({id:f.journal.list()[0].id});const p=await f.confirm();assert.equal(f.putCalls.length,0);assert.equal(p.phase,'needs_attention');assert.equal(p.automationPaused,true);}finally{f.journal.close();}const g=fixture();try{const p=await g.holding();g.settle();await g.service.tick();g.now+=1000;g.spotPreSubmitHook=async()=>g.service.pause({id:p.id});await g.service.tick();assert.equal(g.spotCalls.length,0);assert.equal(g.journal.get(p.id).automationPaused,true);assert.equal(g.journal.get(p.id).phase,'needs_attention');}finally{g.journal.close();}});
test('public provider uses only anonymous official GET and exact final UTC delivery date',async()=>{
  const f=fixture(false),requests=[];const reply=result=>({ok:true,headers:new Headers({'content-type':'application/json'}),json:async()=>({jsonrpc:'2.0',result})});
  const fetchImpl=async(url,options)=>{requests.push({url,options});const p=new URL(url),method=p.pathname.split('/').at(-1),symbol=p.searchParams.get('instrument_name');if(method==='get_instruments')return reply(p.searchParams.get('kind')==='spot'?[f.spotSpec]:[f.spec]);if(method==='get_instrument')return reply(symbol==='BTC_USDC'?f.spotSpec:f.spec);if(method==='get_order_book')return reply({instrument_name:symbol,state:'open',timestamp:START,index_price:85000,bids:[[1000,.1]],asks:[[85001,.1]]});if(method==='get_delivery_prices')return reply({data:[{date:'2026-10-23',delivery_price:79000}],records_total:1});throw Error('Unexpected public method');};
  try{delete f.spec.taker_max_commission;f.spotSpec.contract_size=1e-8;const provider=createDeribitPublicMarket({fetchImpl,now:()=>f.now,baseUrl:'https://test.deribit.com'});const valid=await provider.prepare({symbol:SYMBOL});assert.equal(valid.contract.cap,.125);assert.equal(valid.spec.taker_max_commission,undefined);assert.equal(valid.spotSpec.contract_size,1e-8);const data=await provider.prepare({symbol:SYMBOL.replace('23OCT26','24OCT26')}).catch(()=>null);assert.equal(data,null);f.now=EXPIRY;const final=await provider.settlement({symbol:SYMBOL,expiry:EXPIRY,indexName:'btc_usdc'});assert.equal(final.price,'79000');assert.equal(final.final,true);assert.ok(requests.every(r=>r.options.method==='GET'&&r.options.credentials==='omit'&&!r.options.headers.Authorization));assert.throws(()=>createDeribitPublicMarket({baseUrl:'https://example.com'}));}finally{f.journal.close();}
});

test('remaining-cash authority is frozen in the draft and does not scale the budget after partial PUT fills',async()=>{
  const f=fixture();try{
    const p=await f.holding();assert.equal(p.spotBudgetMode,'remaining_strategy_cash');assert.equal(p.spotBudgetBasis,'confirmed_amount_plus_reconciled_cashflows');assert.equal(JSON.parse(p.fingerprint).spotBudgetMode,p.spotBudgetMode);
    assert.equal(p.amount,'8100');assert.equal(p.q,'0.1');assert.equal(p.filledQty,'0.05');assert.match(p.notes.join(' '),/部分成交也不按比例缩减/);
    f.settle();await f.service.tick();f.now+=1000;await f.service.tick();assert.equal(f.journal.get(p.id).strategyCash,'8089.85');assert.equal(f.spotCalls[0].auth.confirmedIntent.maxFunds,'8089.85');
  }finally{f.journal.close();}
});

test('legacy plans without remaining-cash authority retain their original fixed BTC quantity',async()=>{
  const f=fixture();try{
    const p=await f.holding();f.journal.update(p.id,p.version,{spotBudgetMode:undefined,spotBudgetBasis:undefined});
    f.settle();await f.service.tick();f.now+=1000;await f.service.tick();assert.equal(f.spotCalls[0].order.amount,'0.05');assert.equal(f.spotCalls[0].auth.confirmedIntent.feeReserve,'1.984875');
    await f.service.tick();assert.equal(f.journal.get(p.id).phase,'complete_btc');assert.equal(f.journal.get(p.id).receivedBTC,'0.05');assert.equal(f.journal.get(p.id).remainingStrategyCash,'4137.875');
  }finally{f.journal.close();}
});

test('expiry account spot fee and whole increments determine the maximum payable quantity',async()=>{
  const f=fixture();try{
    const p=await f.holding();f.settle();await f.service.tick();f.now+=1000;
    f.fees={btc_usdc:{option:{default:{type:'fixed',taker:.0003}},spot:{default:{type:'fixed',taker:.02}}}};f.spotActualFeeRate='0.02';f.spotSpec.min_trade_amount=.01;
    await f.service.tick();const pending=f.journal.get(p.id);assert.equal(f.spotCalls[0].order.amount,'0.09');assert.equal(pending.spotAppliedFeeRate,'0.02');assert.equal(pending.spotFeeReserve,'142.911');
    assert.ok(.09*79395*1.02<=Number(pending.strategyCash));assert.ok(.1*79395*1.02>Number(pending.strategyCash));
    await f.service.tick();assert.equal(f.journal.get(p.id).phase,'complete_btc');assert.equal(f.journal.get(p.id).receivedBTC,'0.09');
  }finally{f.journal.close();}
});

test('insufficient minimum, unavailable account fees and unsupported budget modes stop before any spot POST',async()=>{
  for(const mutate of [f=>f.spotSpec.min_trade_amount=1,f=>f.fees={},(f,p)=>f.journal.update(p.id,f.journal.get(p.id).version,{spotBudgetMode:'wallet_balance'})]){
    const f=fixture();try{const p=await f.holding();f.settle();await f.service.tick();f.now+=1000;mutate(f,p);await f.service.tick();assert.equal(f.spotCalls.length,0);assert.ok(f.journal.get(p.id).lastError);assert.equal(f.putCalls.length,1);}finally{f.journal.close();}
  }
});

test('expected opening cost applies the fee cap per actual depth level without reducing funding reserves',async()=>{
  const f=fixture();try{
    f.bids=[{price:1000,qty:.04},{price:5,qty:1}];const p=await f.prepare();
    assert.equal(p.q,'0.1');assert.equal(p.estimatedGross,'40.3');assert.equal(p.estimatedOpenFee,'1.0575');assert.equal(p.estimatedNetIncome,'39.2425');assert.equal(p.openingFeeReserve,'2.55');
    assert.ok(Number(p.estimatedNetIncome)>Number(p.estimatedGross)-Number(p.openingFeeReserve));assert.ok(Number(p.fullFundReserve)<=8100);assert.equal(p.optionFeeCap,'0.125');
    const fprint=JSON.parse(p.fingerprint);assert.equal(fprint.estimatedOpenFee,p.estimatedOpenFee);assert.equal(fprint.estimatedGross,p.estimatedGross);assert.equal(fprint.optionFeeCap,p.optionFeeCap);assert.equal(fprint.optionIndexPrice,'85000');
    f.bids=[{price:5,qty:1}];const low=await f.prepare();assert.equal(low.estimatedGross,'0.5');assert.equal(low.estimatedOpenFee,'0.0625');assert.equal(low.estimatedNetIncome,'0.4375');assert.equal(low.openingFeeReserve,p.openingFeeReserve);assert.equal(low.fullFundReserve,p.fullFundReserve);
  }finally{f.journal.close();}
});

test('zero actual option fee does not invent a nominal charge or reserve',async()=>{
  const f=fixture();try{
    f.fees={btc_usdc:{option:{default:{type:'fixed',taker:0}},spot:{default:{type:'fixed',taker:.0005}}}};f.bids=[{price:5,qty:1}];const p=await f.prepare();
    assert.equal(p.optionTakerRate,'0');assert.equal(p.estimatedOpenFee,'0');assert.equal(p.openingFeeReserve,'0');assert.equal(p.estimatedNetIncome,p.estimatedGross);assert.equal(JSON.parse(p.fingerprint).estimatedOpenFee,'0');
  }finally{f.journal.close();}
});

test('confirmation freezes the capped expected quote separately from the conservative opening reserve',async()=>{
  const f=fixture();try{
    await f.service.tick();f.bids=[{price:5,qty:1}];const p=await f.prepare(),confirmation={id:p.id,fingerprint:p.fingerprint,account:'dedicated',currency:'USDC',confirmed:true};
    const changed=JSON.stringify({...JSON.parse(p.fingerprint),estimatedOpenFee:'0'});await assert.rejects(f.service.confirm({...confirmation,fingerprint:changed}),/失效/);assert.equal(f.putCalls.length,0);
    f.bids=[{price:1000,qty:1}];const saved=await f.service.confirm(confirmation);assert.equal(saved.estimatedOpenFee,'0.0625');assert.equal(saved.estimatedGross,'0.5');assert.equal(saved.estimatedNetIncome,'0.4375');assert.equal(saved.openingFeeReserve,'2.55');assert.equal(f.putCalls.length,1);
    const retried=await f.service.confirm(confirmation);assert.equal(retried.estimatedOpenFee,saved.estimatedOpenFee);assert.equal(f.putCalls.length,1);
  }finally{f.journal.close();}
});

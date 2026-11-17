import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,createHash} from 'node:crypto';
import {createBinanceExecution} from './execution/binance.mjs';
import {validateBinanceOptionSpec,createBinancePublicMarket} from './execution/binance-market.mjs';
import {createBinanceExecutionService} from './execution/binance-service.mjs';
import {ExecutionJournal} from './execution/journal.mjs';
import {units as u,decimal as t} from './execution/binance-decimal.mjs';
import {calculatePutQuote} from './web/live-quotes.js';

const BASE=Date.UTC(2026,9,23,8),EXPIRY=Date.UTC(2026,9,24,8),SYMBOL='BTC-261024-79000-P',clone=v=>JSON.parse(JSON.stringify(v)),ok=data=>({ok:true,data:clone(data)});
const optionSpec=()=>({symbol:SYMBOL,side:'PUT',underlying:'BTCUSDT',quoteAsset:'USDT',settleAsset:'USDT',unit:1,strikePrice:'79000',expiryDate:EXPIRY,minQty:'0.01',maxQty:'100',stepSize:'0.01',tickSize:'1',status:'TRADING',nakedSell:true,sellPermission:{allowed:true,scope:'symbol',value:true,source:'https://eapi.binance.com/eapi/v1/exchangeInfo',underlying:'BTCUSDT'},validated:true});
const spotSpec=()=>({symbol:'BTCUSDT',status:'TRADING',baseAsset:'BTC',quoteAsset:'USDT',minQty:'0.00001',maxQty:'100',stepSize:'0.00001',tickSize:'0.01',minNotional:'5',validated:true});
function evidence(now=BASE){return {uid:'42',checkedAt:now,restriction:{ipRestrict:true,enableReading:true,enableWithdrawals:false,enableInternalTransfer:true,enableMargin:false,enableFutures:false,permitsUniversalTransfer:true,enableVanillaOptions:true,enableFixApiTrade:false,enableFixReadOnly:true,enableSpotAndMarginTrading:true,enablePortfolioMarginTrading:false},info:{isOptionsEnabled:true,isPortfolioMarginRetailEnabled:false},trading:{isLocked:false},option:{canTrade:true,reduceOnly:false,time:now,asset:[{asset:'USDT',marginBalance:'20000',equity:'20000',available:'20000',initialMargin:'0',maintMargin:'0',unrealizedPNL:'0'}]},spot:{uid:'42',accountType:'SPOT',canTrade:true,permissions:['SPOT'],balances:[{asset:'USDT',free:'123',locked:'0'},{asset:'BTC',free:'0',locked:'0'}]},optionFee:{underlying:'BTCUSDT',makerFee:'0.00024',takerFee:'0.00024'},spotFee:{takerBuyRate:'0.001',discountEnabled:false},positions:[],optionOrders:[],spotOrders:[]};}
function harness({mode='buy_btc',bidPrice='200',bidQty='2',optionRate='0.00024',live=true,amount='10000',strike='79000',index='80000'}={}){
  let time=BASE;const journal=new ExecutionJournal(':memory:'),state={e:evidence(),writes:[],putOrder:null,trades:[],bills:[],exercises:[],transfers:[],spotOrder:null,spotTrades:[],unknownPut:false,unknownTransfer:false,unknownSpot:false};
  const exchange={
    getExecutionState:()=>({finalGateSupported:true,reconciliationRequired:false}),acknowledgeReconciled:()=>true,
    async getAccountEvidence(){state.e.checkedAt=time;state.e.option.time=time;state.e.optionFee.takerFee=optionRate;return ok(state.e);},
    getOptionOrder:async()=>state.putOrder?ok(state.putOrder):{ok:false,error:{code:'not_found',message:'暂未找到实际订单。'}},getOptionTrades:async()=>ok(state.trades),getBills:async()=>ok(state.bills),getExerciseRecords:async()=>ok(state.exercises),getTransferHistory:async()=>ok({total:state.transfers.length,rows:state.transfers}),getSpotOrder:async()=>state.spotOrder?ok(state.spotOrder):{ok:false},getSpotTrades:async()=>ok(state.spotTrades),
    async createSellPut(payload,auth){assert.equal(journal.list()[0]?.phase,'put_submitting');assert.equal(auth.beforeSubmit(),true);state.writes.push({kind:'put',payload:clone(payload)});return state.unknownPut?{ok:false,error:{unknown:true}}:ok({accepted:true});},
    async transferToSpot(payload,auth){assert.equal(journal.list()[0]?.phase,'transfer_submitting');assert.equal(auth.beforeSubmit(),true);state.writes.push({kind:'transfer',payload:clone(payload)});return state.unknownTransfer?{ok:false,error:{unknown:true}}:ok({tranId:'888'});},
    async createSpotBuy(payload,auth){assert.equal(journal.list()[0]?.phase,'spot_submitting');assert.equal(auth.beforeSubmit(),true);state.writes.push({kind:'spot',payload:clone(payload)});return state.unknownSpot?{ok:false,error:{unknown:true}}:ok({accepted:true});}
  };
  const market={environment:'mainnet',spec:optionSpec(),ask:'78000',depthQty:'5',price:'78000',
    async prepare(){return {spec:clone(this.spec),spotSpec:spotSpec(),market:{platform:'binance',currency:'USDT',spot:index,time},book:{time,bids:[{price:bidPrice,qty:bidQty}]}};},
    async spot(){return {spec:spotSpec(),ask:this.ask,asks:this.asks??[{price:this.ask,qty:this.depthQty}],time};},
    async settlement(){return {symbol:SYMBOL,expiry:EXPIRY,strikePrice:'79000',price:this.price,final:true,checkedAt:time};}
  };
  market.spec.strikePrice=strike;market.spec.symbol=SYMBOL.replace('-79000-','-'+strike+'-');
  const service=createBinanceExecutionService({journal,exchangeFactory:()=>exchange,marketProvider:market,liveEnabled:live,now:()=>time});
  async function prepared(){await service.tick();return service.prepare({amount,symbol:market.spec.symbol,buyBufferRate:'0.005',settlementMode:mode});}
  async function confirmed(){const p=await prepared();await service.confirm({id:p.id,fingerprint:p.fingerprint,account:p.account,currency:'USDT',confirmed:true});return p;}
  async function filled(p,{quantity=p.q,price=bidPrice,fee='-1'}={}){
    const amount=t(u(quantity)*u(price)/(10n**18n));state.putOrder={...p.orderPayload,orderId:'999',status:quantity===p.q?'FILLED':'CANCELED',executedQty:quantity};state.trades=u(quantity)>0n?[{id:'1000',tradeId:'1000',orderId:'999',symbol:SYMBOL,price,quantity,fee,realizedProfit:'0',side:'SELL',type:'LIMIT',liquidity:'TAKER',time:BASE+100,quoteAsset:'USDT'}]:[];
    if(u(quantity)>0n){state.e.positions=[{symbol:SYMBOL,side:'SHORT',quantity:'-'+quantity}];const wallet=state.e.option.asset[0];wallet.marginBalance=t(u('20000')+u(amount)+u(fee,true));wallet.equity=wallet.marginBalance;wallet.available=wallet.marginBalance;}
    await service.tick();return service.list()[0];
  }
  function settled(plan,{price='78000',fee='0.1'}={}){
    time=EXPIRY+1000;market.price=price;const loss=u(price)<u(plan.strike)?t(u(plan.filledQty)*(u(plan.strike)-u(price))/(10n**18n)):'0',delivery=u(loss)>0n?fee:'0';state.e.positions=[];
    state.bills=[{id:'1',asset:'USDT',symbol:SYMBOL,type:'CONTRACT',amount:plan.gross,createDate:BASE+100},{id:'2',asset:'USDT',symbol:SYMBOL,type:'FEE',amount:t(-u(plan.openFee)),createDate:BASE+100}];
    if(u(loss)>0n){state.bills.push({id:'3',asset:'USDT',symbol:SYMBOL,type:'EXERCISE_PNL',amount:'-'+loss,createDate:EXPIRY},{id:'4',asset:'USDT',symbol:SYMBOL,type:'EXERCISE_FEE',amount:'-'+delivery,createDate:EXPIRY});state.exercises=[{id:'5',currency:'USDT',symbol:SYMBOL,exercisePrice:price,quantity:plan.filledQty,amount:'-'+loss,fee:delivery,positionSide:'SHORT',optionSide:'PUT',quoteAsset:'USDT',createDate:EXPIRY}];}
    const cash=t(u('20000')+u(plan.gross)-u(plan.openFee)-u(loss)-u(delivery));Object.assign(state.e.option.asset[0],{marginBalance:cash,equity:cash,available:cash});return {loss,delivery};
  }
  return {service,state,market,exchange,journal,prepared,confirmed,filled,settled,advance:n=>{time+=n;},setTime:n=>{time=n;},now:()=>time};
}
async function atSpot(h){const p=await h.confirmed(),held=await h.filled(p);h.settled(held);await h.service.tick();h.advance(1100);await h.service.tick();const plan=h.service.list()[0],amount=plan.transferPayload.amount;h.state.transfers=[{tranId:'888',type:'OPTION_MAIN',asset:'USDT',amount,status:'CONFIRMED',timestamp:h.now()}];const current=h.state.e.option.asset[0],balance=t(u(current.marginBalance)-u(amount));Object.assign(current,{marginBalance:balance,equity:balance,available:balance});h.state.e.spot.balances[0].free=t(u('123')+u(amount));return plan;}

test('Binance SELL permission preserves official schema scope and symbol false wins',()=>{
  const raw={...optionSpec(),filters:[{filterType:'PRICE_FILTER',tickSize:'1'},{filterType:'LOT_SIZE',minQty:'0.01',maxQty:'100',stepSize:'0.01'}]},parent={underlying:'BTCUSDT',baseAsset:'BTC',quoteAsset:'USDT',settleAsset:'USDT',nakedSell:true};
  delete raw.nakedSell;const scope=validateBinanceOptionSpec(raw,parent);assert.equal(scope.sellPermission.allowed,true);assert.equal(scope.sellPermission.scope,'underlying');assert.equal(scope.nakedSell,undefined);
  raw.nakedSell=false;assert.equal(validateBinanceOptionSpec(raw,parent).sellPermission.allowed,false);raw.nakedSell=true;assert.equal(validateBinanceOptionSpec(raw,parent).sellPermission.scope,'symbol');assert.throws(()=>validateBinanceOptionSpec(raw,{...parent,settleAsset:'USDC'}));
});
test('Binance prepare freezes cash/BTC mode, fee-net premium and exact IOC bid depth',async()=>{
  const h=harness(),p=await h.prepared();assert.equal(p.platform,'binance');assert.equal(p.currency,'USDT');assert.equal(p.settlementMode,'buy_btc');assert.equal(p.spotBudgetMode,'remaining_strategy_cash');assert.equal(p.orderPayload.side,'SELL');assert.equal(p.orderPayload.timeInForce,'IOC');assert.ok(u(p.fullFundReserve)<=u(p.amount));assert.equal(u(p.estimatedGross)-u(p.estimatedOpenFee),u(p.estimatedNetIncome));assert.equal(h.state.writes.length,0);
  const c=harness({mode:'cash'}),cash=await c.prepared();assert.equal(cash.spotFeeReserve,'0');assert.equal(cash.buyBufferReserve,'0');assert.ok(u(cash.q)>=u(p.q));assert.notEqual(cash.fingerprint,p.fingerprint);
});
test('Binance quoted opening fee applies the 10 percent premium cap and zero actual fees',async()=>{
  const h=harness({bidPrice:'1'}),p=await h.prepared();assert.equal(p.estimatedOpenFee,t(u(p.estimatedGross)/10n));assert.equal(p.openingFeeReserve,p.estimatedOpenFee);
  const zero=harness({optionRate:'0'}),free=await zero.prepared();assert.equal(free.estimatedOpenFee,'0');assert.equal(free.estimatedGross,free.estimatedNetIncome);
});
test('Binance public and private sizing agree at capped-fee capital boundary without cash price-buffer reserve',async()=>{
  for(const mode of ['cash','buy_btc']){
    const h=harness({mode,amount:'80128',strike:'80000',index:'81700',bidPrice:'180',bidQty:'5'}),p=await h.prepared();
    const quote=calculatePutQuote(80128,{strike:80000,expires:EXPIRY,step:.01,min:.01,taker:.00024,cap:.1,delivery:.00015,spot:mode==='cash'?0:.001,spotDeductBase:true},{time:BASE,bids:[{price:180,qty:5}]},81700,BASE);
    assert.equal(quote.valid,true);assert.equal(Number(p.q),quote.q);assert.ok(Math.abs(Number(p.fullFundReserve)-quote.reserve)<1e-8);assert.ok(Math.abs(Number(p.estimatedOpenFee)-quote.openFee)<1e-8);assert.equal(p.buyBufferReserve,'0');assert.equal(p.buyBufferRate,'0.005');assert.equal(p.q,'1');
  }
});
test('Binance prepare rejects insufficient depth, wrong currency, sell false and missing scoped permission',async()=>{
  await assert.rejects(()=>harness({bidQty:'0.01'}).prepared(),e=>e.code==='depth_insufficient');
  for(const edit of [s=>s.nakedSell=false,s=>delete s.sellPermission,s=>s.quoteAsset='USDC']){const h=harness();edit(h.market.spec);await assert.rejects(()=>h.prepared());assert.equal(h.state.writes.length,0);}
});
test('Binance identity, IP, withdrawal, options seller, actual fees and BNB discount gates',async()=>{
  for(const mutate of [e=>e.restriction.ipRestrict=false,e=>e.restriction.enableWithdrawals=true,e=>e.option.reduceOnly=true,e=>e.option.canTrade=false,e=>e.info.isPortfolioMarginRetailEnabled=true,e=>e.spot.uid='43',e=>e.optionFee.takerFee=undefined,e=>e.spotFee.discountEnabled=true,e=>e.restriction.permitsUniversalTransfer=false]){const h=harness();mutate(h.state.e);if(h.state.e.optionFee.takerFee===undefined)h.state.e.optionFee.underlying='ETHUSDT';const status=await h.service.status();assert.equal(status.buyBTCCanSubmit,false);await assert.rejects(()=>h.prepared());assert.equal(h.state.writes.length,0);}
});
test('Binance options-only key can confirm cash settlement without spot or transfer permissions',async()=>{
  const h=harness({mode:'cash'});for(const key of ['enableSpotAndMarginTrading','enableInternalTransfer','permitsUniversalTransfer'])h.state.e.restriction[key]=false;
  await h.service.tick();const status=await h.service.status();assert.equal(status.accountVerified,true);assert.equal(status.cashCanSubmit,true);assert.equal(status.canSubmit,true);assert.equal(status.buyBTCCanSubmit,false);assert.match(status.buyBTCReason,/现货交易及同账户内部划转/);
  const p=await h.confirmed();assert.equal(p.settlementMode,'cash');assert.deepEqual(h.state.writes.map(w=>w.kind),['put']);
  const buy=harness({mode:'buy_btc'});for(const key of ['enableSpotAndMarginTrading','enableInternalTransfer','permitsUniversalTransfer'])buy.state.e.restriction[key]=false;await assert.rejects(()=>buy.confirmed(),e=>e.code==='permission_invalid');assert.equal(buy.state.writes.length,0);
});
test('Binance confirm needs all original A in option wallet; never pre-funds by transfer',async()=>{
  const h=harness(),p=await h.prepared();Object.assign(h.state.e.option.asset[0],{marginBalance:'9999',equity:'9999',available:'9999'});await assert.rejects(()=>h.service.confirm({id:p.id,fingerprint:p.fingerprint,account:p.account,currency:'USDT',confirmed:true}),e=>e.code==='funding_shortfall');assert.deepEqual(h.state.writes,[]);
});
test('Binance explicit immutable confirmation journals once and duplicates never resend',async()=>{
  const h=harness(),p=await h.confirmed();assert.equal(h.state.writes.length,1);const again=await h.service.confirm({id:p.id,fingerprint:p.fingerprint,account:p.account,currency:'USDT',confirmed:true});assert.equal(again.phase,'put_reconciling');assert.equal(h.state.writes.length,1);
  await assert.rejects(()=>h.service.confirm({id:p.id,fingerprint:p.fingerprint+'x',account:p.account,currency:'USDT',confirmed:true}));h.advance(31000);assert.equal((await h.service.status()).canSubmit,false);
});
test('Binance unknown opening never retries, zero fill pays no premium and never buys BTC',async()=>{
  const unknown=harness();unknown.state.unknownPut=true;await unknown.confirmed();await unknown.service.tick();await unknown.service.tick();assert.equal(unknown.state.writes.length,1);assert.equal(unknown.service.list()[0].phase,'put_unknown');
  const h=harness(),p=await h.confirmed();const plan=await h.filled(p,{quantity:'0',fee:'0'});assert.equal(plan.phase,'complete_unfilled');assert.equal(plan.closed,true);h.setTime(EXPIRY+1000);await h.service.tick();assert.deepEqual(h.state.writes.map(w=>w.kind),['put']);
});
test('Binance cash mode settles actual losses and every fee, never transfers or buys',async()=>{
  const h=harness({mode:'cash'}),p=await h.confirmed(),held=await h.filled(p),{loss,delivery}=h.settled(held);await h.service.tick();h.advance(1100);await h.service.tick();const done=h.service.list()[0];assert.equal(done.phase,'complete_cash');assert.equal(done.closed,true);assert.equal(done.strategyCash,t(u(p.amount)+u(held.gross)-u(held.openFee)-u(loss)-u(delivery)));assert.deepEqual(h.state.writes.map(w=>w.kind),['put']);
});
test('Binance OTM retains capital and actual net premium, with no exercise fee or buy',async()=>{
  const h=harness(),p=await h.confirmed(),held=await h.filled(p);h.settled(held,{price:'80000'});await h.service.tick();h.advance(1100);await h.service.tick();const done=h.service.list()[0];assert.equal(done.phase,'complete_cash');assert.equal(done.strategyCash,t(u(p.amount)+u(held.gross)-u(held.openFee)));assert.equal(done.deliveryFee,'0');assert.equal(h.state.writes.length,1);
});
test('Binance partial PUT uses full original allocation after exact actual settlement',async()=>{
  const h=harness(),p=await h.confirmed(),held=await h.filled(p,{quantity:'0.01'});assert.equal(held.partialPut,true);const {loss,delivery}=h.settled(held);await h.service.tick();h.advance(1100);await h.service.tick();const plan=h.service.list()[0];assert.equal(plan.phase,'transfer_reconciling');assert.equal(plan.strategyCash,t(u('10000')+u(held.gross)-u(held.openFee)-u(loss)-u(delivery)));assert.ok(u(plan.transferPayload.amount)>u('9000'));assert.deepEqual(h.state.writes.map(w=>w.kind),['put','transfer']);
});
test('Binance settlement waits for final exercise, precise bill and wallet evidence twice',async()=>{
  const h=harness(),p=await h.confirmed(),held=await h.filled(p);h.settled(held);h.state.exercises=[];await h.service.tick();assert.equal(h.service.list()[0].phase,'holding');assert.equal(h.state.writes.length,1);
  h.settled(held);h.state.bills.push({id:'6',asset:'USDT',amount:'20',type:'TRANSFER',createDate:EXPIRY});await h.service.tick();assert.equal(h.state.writes.length,1);assert.equal(h.service.list()[0].lastError.code,'ledger_not_isolated');
});
test('Binance unknown internal transfer without actual tranId never resends or guesses wallet match',async()=>{
  const h=harness(),p=await h.confirmed(),held=await h.filled(p);h.state.unknownTransfer=true;h.settled(held);await h.service.tick();h.advance(1100);await h.service.tick();assert.equal(h.service.list()[0].phase,'transfer_unknown');h.state.transfers=[{tranId:'888',type:'OPTION_MAIN',asset:'USDT',amount:'9900',status:'CONFIRMED',timestamp:h.now()}];await h.service.tick();await h.service.tick();assert.equal(h.state.writes.filter(w=>w.kind==='transfer').length,1);assert.equal(h.state.writes.filter(w=>w.kind==='spot').length,0);
});
test('Binance transfer acknowledgement requires matching receipt and both wallets before ask-one IOC',async()=>{
  const h=harness(),p=await h.confirmed(),held=await h.filled(p);h.settled(held);await h.service.tick();h.advance(1100);await h.service.tick();let plan=h.service.list()[0];const amount=plan.transferPayload.amount;h.state.transfers=[{tranId:'888',type:'OPTION_MAIN',asset:'USDT',amount,status:'CONFIRMED',timestamp:h.now()}];await h.service.tick();assert.equal(h.state.writes.length,2);
  const current=h.state.e.option.asset[0],balance=t(u(current.marginBalance)-u(amount));Object.assign(current,{marginBalance:balance,equity:balance,available:balance});h.state.e.spot.balances[0].free=t(u('123')+u(amount));await h.service.tick();plan=h.service.list()[0];assert.equal(plan.phase,'spot_reconciling');assert.equal(plan.spotOrder.price,'78000');assert.equal(plan.spotOrder.timeInForce,'IOC');assert.ok(u(plan.spotOrder.quantity)>u(p.q));assert.deepEqual(h.state.writes.map(w=>w.kind),['put','transfer','spot']);
});
test('Binance partial spot fill records actual BTC and cash without chasing or duplicate',async()=>{
  const h=harness(),p=await h.confirmed(),held=await h.filled(p);h.settled(held);await h.service.tick();h.advance(1100);await h.service.tick();let plan=h.service.list()[0],amount=plan.transferPayload.amount;h.state.transfers=[{tranId:'888',type:'OPTION_MAIN',asset:'USDT',amount,status:'CONFIRMED',timestamp:h.now()}];const current=h.state.e.option.asset[0],balance=t(u(current.marginBalance)-u(amount));Object.assign(current,{marginBalance:balance,equity:balance,available:balance});h.state.e.spot.balances[0].free=t(u('123')+u(amount));await h.service.tick();plan=h.service.list()[0];
  h.state.spotOrder={symbol:'BTCUSDT',orderId:'777',clientOrderId:plan.spotOrder.newClientOrderId,status:'EXPIRED',side:'BUY',type:'LIMIT',timeInForce:'IOC',price:'78000',origQty:plan.spotOrder.quantity,executedQty:'0.01',cummulativeQuoteQty:'780'};
  h.state.spotTrades=[{symbol:'BTCUSDT',id:'9',orderId:'777',price:'78000',qty:'0.01',quoteQty:'780',commission:'0.00001',commissionAsset:'BTC',time:h.now(),isBuyer:true,isMaker:false}];h.state.e.spot.balances[1].free='0.00999';h.state.e.spot.balances[0].free=t(u('123')+u(amount)-u('780'));await h.service.tick();plan=h.service.list()[0];assert.equal(plan.phase,'needs_attention');assert.equal(plan.receivedBTC,'0.00999');assert.equal(plan.remainingCash,t(u(amount)-u('780')+u(plan.transferRoundingDust)));await h.service.tick();assert.equal(h.state.writes.filter(w=>w.kind==='spot').length,1);
});
test('Binance pause or protection breach stops future transfer and buys',async()=>{
  const h=harness(),p=await h.confirmed(),held=await h.filled(p);h.service.pause({id:p.id});h.settled(held);await h.service.tick();h.advance(1100);await h.service.tick();assert.equal(h.service.list()[0].phase,'transfer_ready');assert.equal(h.state.writes.length,1);
});
test('Binance spot sweeps asks inside confirmed protection, stops beyond it and never overspends',async()=>{
  const h=harness();await atSpot(h);h.market.asks=[{price:'78000',qty:'0.001'},{price:'78001',qty:'0.001'},{price:'78002',qty:'1'}];await h.service.tick();const p=h.service.list()[0];assert.equal(p.phase,'spot_reconciling');assert.equal(p.spotOrder.price,'78002');assert.equal(p.spotLevelsUsed,3);assert.ok(u(p.spotOrder.quantity)*u(p.spotOrder.price)/(10n**18n)<=u(p.transferredCash));assert.equal(p.spotFeeCurrency,'BTC');assert.equal(p.spotFeeReserve,'0');assert.ok(p.spotOrder.newClientOrderId.length<=36);
  const blocked=harness();await atSpot(blocked);blocked.market.asks=[{price:'78000',qty:'0.001'},{price:'79000',qty:'10'}];await blocked.service.tick();assert.equal(blocked.state.writes.filter(w=>w.kind==='spot').length,0);assert.equal(blocked.service.list()[0].lastError.code,'spot_depth_insufficient');
});
test('Binance full spot fill uses all affordable strategy cash and records net BTC after base fee',async()=>{
  const h=harness();await atSpot(h);await h.service.tick();let p=h.service.list()[0],q=p.spotOrder.quantity,cost=t(u(q)*u(p.spotOrder.price)/(10n**18n)),fee=t(u(q)/1000n),received=t(u(q)-u(fee));
  h.state.spotOrder={symbol:'BTCUSDT',orderId:'777',clientOrderId:p.spotOrder.newClientOrderId,status:'FILLED',side:'BUY',type:'LIMIT',timeInForce:'IOC',price:p.spotOrder.price,origQty:q,executedQty:q,cummulativeQuoteQty:cost};h.state.spotTrades=[{symbol:'BTCUSDT',id:'9',orderId:'777',price:p.spotOrder.price,qty:q,quoteQty:cost,commission:fee,commissionAsset:'BTC',time:h.now(),isBuyer:true,isMaker:false}];h.state.e.spot.balances[1].free=received;h.state.e.spot.balances[0].free=t(u('123')+u(p.transferredCash)-u(cost));await h.service.tick();p=h.service.list()[0];assert.equal(p.phase,'complete_btc');assert.equal(p.receivedBTC,received);assert.equal(p.spotFeeBTC,fee);assert.equal(p.spotFeeUSDT,'0');assert.ok(u(p.remainingCash)<u('0.79'));assert.equal(p.closed,true);assert.deepEqual(h.state.writes.map(w=>w.kind),['put','transfer','spot']);
});
test('Binance restart cannot resend unknown PUT, transfer or spot writes',async()=>{
  const h=harness();h.state.unknownPut=true;const p=await h.confirmed();const restarted=createBinanceExecutionService({journal:h.journal,exchangeFactory:()=>h.exchange,marketProvider:h.market,liveEnabled:true,now:h.now});await restarted.tick();await restarted.confirm({id:p.id,fingerprint:p.fingerprint,account:p.account,currency:'USDT',confirmed:true});assert.equal(h.state.writes.length,1);
  const s=harness();await atSpot(s);s.state.unknownSpot=true;await s.service.tick();assert.equal(s.service.list()[0].phase,'spot_unknown');const second=createBinanceExecutionService({journal:s.journal,exchangeFactory:()=>s.exchange,marketProvider:s.market,liveEnabled:true,now:s.now});await second.tick();await second.tick();assert.equal(s.state.writes.filter(w=>w.kind==='spot').length,1);
});

function httpResponse(body,status=200){return {ok:status>=200&&status<300,status,headers:new Headers({'content-type':'application/json'}),text:async()=>typeof body==='string'?body:JSON.stringify(body),json:async()=>body};}
function adapterFixture({postResult=null}={}){
  const calls=[],e=evidence(),fetchImpl=async(url,options)=>{calls.push({url,options});const path=new URL(url).pathname;if(options.method==='POST')return postResult?postResult(url,options):httpResponse({});const map={'/sapi/v1/account/apiRestrictions':e.restriction,'/sapi/v1/account/info':e.info,'/sapi/v1/account/apiTradingStatus':{data:e.trading},'/eapi/v1/marginAccount':e.option,'/api/v3/account':e.spot,'/eapi/v1/commission':{commissions:[e.optionFee]},'/api/v3/account/commission':{symbol:'BTCUSDT',standardCommission:{taker:'0.001',buyer:'0'},specialCommission:{taker:'0',buyer:'0'},taxCommission:{taker:'0',buyer:'0'},discount:{enabledForAccount:false,enabledForSymbol:false}},'/eapi/v1/position':[],'/eapi/v1/openOrders':[],'/api/v3/openOrders':[]};return httpResponse(map[path]);};
  const adapter=createBinanceExecution({apiKey:'synthetic_key_only',apiSecret:'synthetic_secret_only',fetchImpl,now:()=>BASE,liveEnabled:true});return {adapter,calls,e};
}
test('Binance adapter signs exact query/body with HMAC and never logs or redirects credentials',async()=>{
  const {adapter,calls}=adapterFixture();assert.equal((await adapter.getAccountEvidence()).ok,true);for(const c of calls){const url=new URL(c.url),signature=url.searchParams.get('signature');url.searchParams.delete('signature');assert.equal(signature,createHmac('sha256','synthetic_secret_only').update(url.searchParams.toString()).digest('hex'));assert.equal(c.options.headers['X-MBX-APIKEY'],'synthetic_key_only');assert.equal(c.options.redirect,'manual');assert.equal(c.options.credentials,'omit');assert.ok(!c.url.includes('synthetic_secret_only'));}
  let count=0;const disabled=createBinanceExecution({fetchImpl:async()=>{count++;throw Error('never');}});assert.equal((await disabled.getAccountEvidence()).ok,false);assert.equal(count,0);
});
test('Binance adapter executes one guarded write, preserves int64 IDs and locks unknowns',async()=>{
  const {adapter,calls}=adapterFixture({postResult:async()=>httpResponse('{"symbol":"BTC-261024-79000-P","orderId":4611875134427365000,"clientOrderId":"bp_test","side":"SELL","type":"LIMIT","timeInForce":"IOC","status":"FILLED","price":"200","quantity":"0.01","executedQty":"0.01"}')});await adapter.getAccountEvidence();const payload={symbol:SYMBOL,clientOrderId:'bp_test',side:'SELL',type:'LIMIT',timeInForce:'IOC',quantity:'0.01',price:'200',reduceOnly:false,postOnly:false,newOrderRespType:'RESULT'},auth={confirmed:true,account:'binance-dedicated-usdt',accountId:'42',currency:'USDT',checkedAt:BASE,expiresAt:BASE+10000,beforeSubmit:()=>true,spec:optionSpec(),feeReserve:'2',maxFunds:'1000'};
  auth.payloadHash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');const r=await adapter.createSellPut(payload,auth);assert.equal(r.ok,true);assert.equal(r.data.orderId,'4611875134427365000');assert.equal((await adapter.createSellPut(payload,auth)).ok,false);assert.equal(calls.filter(c=>c.options.method==='POST').length,1);
  const unknown=adapterFixture({postResult:async()=>{throw Error('synthetic_secret_only');}});await unknown.adapter.getAccountEvidence();const failed=await unknown.adapter.createSellPut(payload,auth);assert.equal(failed.error.unknown,true);assert.ok(!JSON.stringify(failed).includes('synthetic_secret_only'));assert.equal(unknown.adapter.getExecutionState().reconciliationRequired,true);assert.equal((await unknown.adapter.createSellPut({...payload,clientOrderId:'different'},auth)).ok,false);
});
test('Binance adapter requires a live final gate and actual scoped permission',async()=>{
  const {adapter,calls}=adapterFixture();await adapter.getAccountEvidence();const payload={symbol:SYMBOL,clientOrderId:'bp_test',side:'SELL',type:'LIMIT',timeInForce:'IOC',quantity:'0.01',price:'200',reduceOnly:false,postOnly:false,newOrderRespType:'RESULT'},auth={confirmed:true,account:'binance-dedicated-usdt',accountId:'42',currency:'USDT',checkedAt:BASE,expiresAt:BASE+10000,beforeSubmit:()=>false,spec:optionSpec(),feeReserve:'2',maxFunds:'1000'};assert.equal((await adapter.createSellPut(payload,auth)).ok,false);auth.beforeSubmit=()=>true;auth.spec.nakedSell=false;assert.equal((await adapter.createSellPut(payload,auth)).ok,false);assert.equal(calls.filter(c=>c.options.method==='POST').length,0);
});
test('Binance adapter rejects client IDs above the 36 character exchange limit before sending',async()=>{
  const {adapter,calls}=adapterFixture();await adapter.getAccountEvidence();const auth={confirmed:true,account:'binance-dedicated-usdt',accountId:'42',currency:'USDT',checkedAt:BASE,expiresAt:BASE+10000,beforeSubmit:()=>true,spec:optionSpec(),feeReserve:'0',maxFunds:'1000'},long='b'.repeat(37),put={symbol:SYMBOL,clientOrderId:long,side:'SELL',type:'LIMIT',timeInForce:'IOC',quantity:'0.01',price:'200',reduceOnly:false,postOnly:false,newOrderRespType:'RESULT'},spot={symbol:'BTCUSDT',newClientOrderId:long,side:'BUY',type:'LIMIT',timeInForce:'IOC',quantity:'0.01',price:'78000',newOrderRespType:'RESULT'};
  auth.payloadHash=createHash('sha256').update(JSON.stringify(put)).digest('hex');assert.equal((await adapter.createSellPut(put,auth)).ok,false);auth.payloadHash=createHash('sha256').update(JSON.stringify(spot)).digest('hex');assert.equal((await adapter.createSpotBuy(spot,auth)).ok,false);assert.equal(calls.filter(c=>c.options.method==='POST').length,0);
});
test('Binance real market parent identity must be unique before granting underlying permission',async()=>{
  const raw={...optionSpec(),filters:[{filterType:'PRICE_FILTER',tickSize:'1'},{filterType:'LOT_SIZE',minQty:'0.01',maxQty:'100',stepSize:'0.01'}]};delete raw.nakedSell;const parent={underlying:'BTCUSDT',baseAsset:'BTC',quoteAsset:'USDT',settleAsset:'USDT',nakedSell:true};
  const market=createBinancePublicMarket({now:()=>BASE,fetchImpl:async url=>{const path=new URL(url).pathname;const bodies={'/eapi/v1/exchangeInfo':{optionSymbols:[raw],optionContracts:[parent,parent]},'/eapi/v1/depth':{T:BASE,bids:[['200','1']]},'/eapi/v1/index':{time:BASE,indexPrice:'80000'},'/api/v3/exchangeInfo':{symbols:[{...spotSpec(),isSpotTradingAllowed:true,orderTypes:['LIMIT'],filters:[{filterType:'PRICE_FILTER',tickSize:'0.01'},{filterType:'LOT_SIZE',stepSize:'0.00001',minQty:'0.00001',maxQty:'100'},{filterType:'MIN_NOTIONAL',minNotional:'5'}]}]},'/api/v3/depth':{asks:[['78000','5']]},'/api/v3/time':{serverTime:BASE}};return httpResponse(bodies[path]);}});await assert.rejects(()=>market.prepare({symbol:SYMBOL}),/ambiguous/);
});

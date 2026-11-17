import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateCallQuote,calculateCallAskLimitQuote,calculateCallBidQuote} from './web/call-quote.js';

const now=Date.UTC(2026,10,13,8),day=86400000;
const contract={symbol:'BTC-261120-80000-C',strike:80000,expires:now+7*day,settleCoin:'USDT',unit:1,step:.01,min:.01,max:1000,priceTick:5,taker:.00024,cap:.1,delivery:.00015,deliveryCap:.1,spot:.001};
const book={symbol:contract.symbol,time:now,bids:[{price:100,qty:.4},{price:95,qty:.8}],asks:[{price:105,qty:.05},{price:110,qty:2}]};
const quote=(quantity=1,change={},changedBook=book,mode='ask_limit')=>calculateCallQuote(quantity,{...contract,...change},changedBook,70000,now,{quoteMode:mode});
test('CALL ask uses actual ask, conditional full-fill income, current holding value basis, no fabricated margin',()=>{
 const q=quote();assert.equal(q.valid,true);assert.equal(q.q,1);assert.equal(q.gross,105);assert.equal(q.openFee,10.5);assert.equal(q.netIncome,94.5);assert.equal(q.capitalBasis,70000);assert.equal(q.term,94.5/70000);assert.equal(q.annual,94.5/70000*365/7);
 assert.equal(q.bestAskQty,.05);assert.equal(q.depthQty,null);assert.equal(q.conditional,true);assert.equal(q.fillGuaranteed,false);assert.equal(q.canSubmit,false);assert.equal(q.requiredMargin,null);assert.equal(q.settlementLoss,null);assert.equal(q.deliveryFee,null);assert.equal(q.spotFee,null);
});
test('CALL taker sweeps real descending bids and caps opening fees per executed level',()=>{
 const q=quote(1,{},book,'bid_taker');assert.equal(q.valid,true);assert.equal(q.gross,97);assert.equal(q.openFee,9.7);assert.equal(q.netIncome,87.3);assert.equal(q.levelsUsed,2);assert.equal(q.averagePrice,97);assert.equal(q.depthQty,1.2000000000000002);assert.equal(q.conditional,false);
});
test('CALL bid quote refuses whole-quantity income for inadequate depth',()=>{assert.match(quote(1.21,{},book,'bid_taker').reason,/深度不足/);});
test('CALL ask quantity is not limited by displayed seller quantity',()=>{assert.equal(quote(1).valid,true);assert.equal(quote(1).q,1);});
test('CALL holding quantity rounds down to exchange step and preserves remainder',()=>{
 const q=quote(1.029);assert.equal(q.q,1.02);assert.ok(Math.abs(q.leftoverBTC-.009)<1e-12);assert.equal(q.capitalBasis,1.029*70000);
 assert.equal(quote(.009).valid,false);assert.equal(quote(1.03,{max:1}).valid,false);
});
test('CALL exact decimal lot edges do not sell beyond holdings',()=>{
 for(const input of [.03,.07,.14,.29,1.01,1.15]){const q=quote(input);assert.equal(q.valid,true);assert.equal(q.q,input);assert.ok(q.q<=input);}
});
test('CALL opening fee uses index-rate cap when premium is high',()=>{const q=quote(1,{}, {...book,bids:[{price:995,qty:1}],asks:[{price:1000,qty:1}]});assert.equal(q.openFee,16.8);});
test('CALL rejects stale/future/crossed/wrong-symbol books and invalid quantities',()=>{
 assert.equal(quote(1,{}, {...book,time:now-30000}).valid,false);assert.equal(quote(1,{}, {...book,time:now+2001}).valid,false);
 assert.equal(quote(1,{}, {...book,symbol:'BTC-261120-79000-C'}).valid,false);assert.equal(quote(1,{}, {...book,asks:[{price:100,qty:1}]}).valid,false);
 for(const q of ['',0,-1,Infinity,true])assert.equal(quote(q).valid,false);
});
test('CALL refuses missing book identity instead of trusting caller context',()=>{
 const {symbol,...withoutSymbol}=book;
 assert.match(quote(1,{},withoutSymbol).reason,/缺少合约标识/);
 for(const symbol of [null,'',false])assert.equal(quote(1,{}, {...book,symbol}).valid,false);
});
test('CALL symbol calendar must match exact UTC 08:00 expiry without date rollover',()=>{
 assert.match(quote(1,{expires:contract.expires+day}).reason,/代码日期/);
 assert.match(quote(1,{expires:contract.expires+1}).reason,/代码日期/);
 assert.match(quote(1,{symbol:'BTC-261119-80000-C'}).reason,/代码日期/);
 for(const [symbol,expires] of [['BTC-261332-80000-C',Date.UTC(2027,1,1,8)],['BTC-270229-80000-C',Date.UTC(2027,2,1,8)],['BTC-261100-80000-C',Date.UTC(2026,9,31,8)]])assert.equal(quote(1,{symbol,expires}, {...book,symbol}).valid,false);
 const leap={...contract,symbol:'BTC-280229-80000-C',expires:Date.UTC(2028,1,29,8)};
 assert.equal(calculateCallQuote(1,leap,{...book,symbol:leap.symbol},70000,now).valid,true);
});
test('CALL refuses PUT, unknown fee fields, incorrect unit and expired contract',()=>{
 for(const change of [{symbol:'BTC-261120-80000-P'},{unit:.1},{settleCoin:'USDC'},{expires:now},{deliveryCap:undefined},{spot:undefined},{taker:-1}])assert.equal(quote(1,change).valid,false);
});
test('CALL validates both order book sides and tick sizes',()=>{
 assert.equal(quote(1,{}, {...book,asks:[{price:107,qty:1}]}).valid,false);
 assert.equal(quote(1,{}, {...book,bids:[{price:95,qty:1},{price:100,qty:1}]}).valid,false);
 assert.equal(quote(1,{}, {...book,asks:[]}).valid,false);
 assert.equal(quote(1,{}, {...book,bids:[]},'bid_taker').valid,false);
 assert.equal(quote(1,{}, {...book,bids:[]}).valid,true);
});
test('CALL simple wrapper modes preserve actual quote side',()=>{assert.equal(calculateCallAskLimitQuote(1,contract,book,70000,now).gross,105);assert.equal(calculateCallBidQuote(1,contract,book,70000,now).gross,97);});

// Desk tests are loaded only after the public high-sell adapter exists in the source tree.
const {collectBinanceCallDesk,binanceCallRowFresh,binanceCallSelectedContractSymbol,compareBinanceCallDesk,binanceCallDualIncome}=await import('./web/call-desk.js');
const market={status:'ready',time:now,spot:70000,contracts:[contract],receivedAt:now};
const source={entries:[],sources:[{platform:'binance',status:'unavailable',reason:'高卖报价未读取'}]};
const collect=(input={},overrides={})=>collectBinanceCallDesk({quantity:1,targetPrice:80000,expiry:contract.expires,quoteMode:'ask_limit',...input},{marketLoader:async()=>market,bookLoader:async()=>book,catalogueLoader:async()=>source,clock:()=>now,...overrides});
test('CALL desk fetches exact chosen call and exposes contract even without valid depth',async()=>{
 const requests=[];const data=await collect({}, {marketLoader:async side=>{requests.push(side);return market;},bookLoader:async symbol=>{requests.push(symbol);return book;}});
 assert.deepEqual(requests,['CALL',contract.symbol]);assert.equal(data.row.quote.valid,true);assert.equal(binanceCallSelectedContractSymbol(data,now),contract.symbol);assert.equal(binanceCallRowFresh(data.row,now),true);assert.equal(binanceCallRowFresh(data.row,now+30000),false);
 assert.equal(compareBinanceCallDesk(data.row,[],now)[0].valid,false);
});
test('CALL desk rejects missing exact strike/expiry instead of substituting',async()=>{
 let count=0;const override={bookLoader:async()=>{count++;return book;}};
 assert.match((await collect({targetPrice:79000},override)).reason,/精确高卖价/);
 assert.match((await collect({expiry:contract.expires+day},override)).reason,/所选到期日/);assert.equal(count,0);
});
test('CALL desk discards cancelled generations and stale market, preserves unavailable source reason',async()=>{
 assert.equal(await collect({}, {isCurrent:()=>false}),null);
 const stale=await collect({}, {marketLoader:async()=>({...market,time:now-30000})});assert.equal(stale.row.quote.valid,false);
 const unavailable=await collect({}, {marketLoader:async()=>{throw Error('cloud 503');}});assert.equal(unavailable.row,null);assert.match(unavailable.reason,/cloud 503/);
});
const highProduct={id:'fixture-high',investCoin:'BTC',exercisedCoin:'USDT',strikePrice:'80000',duration:7,settleDate:contract.expires,purchaseDecimal:8,purchaseEndTime:now+day,canPurchase:true,apr:'0.365',minAmount:'0.01',maxAmount:'100',optionType:'CALL'};
const highData={status:'ready',product:highProduct,serverTime:now,fetchedAt:now,receivedAt:now,currency:'BTC',ordinary:true,contract:{strike:80000,expires:contract.expires}};
const highEntry={platform:'binance',currency:'BTC',strike:80000,expires:contract.expires,data:highData};
test('high-sell comparator retains BTC interest and labels USDT as current-index valuation only',async()=>{
 const data=await collect();const comparison=compareBinanceCallDesk(data.row,[highEntry],now)[0];
 assert.equal(comparison.valid,true);assert.equal(comparison.incomeBTC,.007);assert.ok(Math.abs(comparison.indicativeUSDT-490)<1e-10);
 assert.ok(Math.abs(comparison.incomeDifferenceUSDTIndicative-(94.5-490))<1e-10);assert.equal(comparison.valuationOnly,true);assert.equal(comparison.valuationSpot,70000);
 assert.equal(comparison.comparisonScope,'untriggered_current_index_valuation');assert.equal(Object.hasOwn(comparison,'extraBTCAtExpiry'),false);
});
test('high-sell comparison rejects nearby strike/expiry, wrong investment currency, stale snapshots and funding limits',async()=>{
 const data=await collect();
 for(const entry of [{...highEntry,strike:80001},{...highEntry,expires:contract.expires+1},{...highEntry,currency:'USDT'},{...highEntry,data:{...highData,fetchedAt:now-30000}},{...highEntry,data:{...highData,product:{...highProduct,minAmount:'2'}}}])assert.equal(compareBinanceCallDesk(data.row,[entry],now)[0].valid,false);
 assert.equal(compareBinanceCallDesk(data.row,[{...highEntry,data:{...highData,serverTime:now-30000}}],now)[0].valid,false);
});
test('real dual high-sell income remains readable when options source is absent without manufacturing a difference',()=>{
 const income=binanceCallDualIncome({quantity:1,targetPrice:80000,selectedExpiry:contract.expires,market:null,entries:[highEntry]},now);
 assert.equal(income.valid,true);assert.equal(income.incomeBTC,.007);assert.equal(income.indicativeUSDT,null);assert.equal(Object.hasOwn(income,'incomeDifferenceUSDTIndicative'),false);
});
test('dual fallback expiry does not claim a CALL is listed and carries source status',async()=>{
 const data=await collect({expiry:''},{marketLoader:async()=>{throw Error('CALL unavailable');},catalogueLoader:async()=>({entries:[highEntry],source:{platform:'binance',status:'ready'}})});
 assert.equal(data.expirySource,'dual');assert.deepEqual(data.expiries,[contract.expires]);assert.equal(data.row,null);assert.equal(data.sources[0].status,'ready');
});

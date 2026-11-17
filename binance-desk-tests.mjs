import test from 'node:test';
import assert from 'node:assert/strict';
import {collectBinanceDesk,compareBinanceDesk,binanceRowFresh,binanceComparableExpiries,binanceDualExpiries,binanceDualIncome} from './web/binance-desk.js';
const NOW=Date.UTC(2026,9,23,8),DAY=86400000,EXP=NOW+7*DAY;
const contract=(strike=79000,expires=EXP)=>({symbol:'BTC-'+expires+'-'+strike+'-P',strike,expires,settleCoin:'USDT',step:.01,min:.01,taker:.00024,cap:.1,delivery:.00015,deliveryCap:.1,spot:.001});
const deps=(contracts=[contract()],extra={})=>({clock:()=>NOW,marketLoader:async()=>({spot:80000,time:NOW,contracts}),bookLoader:async()=>({time:NOW,bids:[{price:100,qty:.05},{price:80,qty:2}]}),catalogueLoader:async()=>({entries:[],sources:[]}),...extra});
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
function entry(platform,{K=79000,T=EXP,apr=.3}={}){const product=platform==='binance'?{id:'b',investCoin:'USDT',exercisedCoin:'BTC',strikePrice:String(K),duration:7,settleDate:T,purchaseDecimal:4,purchaseEndTime:NOW+DAY,canPurchase:true,apr:String(apr),minAmount:'20',maxAmount:'20000',optionType:'PUT'}:{currency:'BTC',alternativeCurrency:'USDT',type:'PUT',productType:'DualCurrencyDeposit',dcdType:'Standard',status:1,launchTime:NOW-1000,stopTradingTime:T-3600000,expiryTime:T,settlementTime:T,quoteResponseTime:NOW,dcdTerm:'168',interestAccrualTime:T-7*DAY,absYield:String(apr*7/365),annualYield:String(apr),strike:String(K),ndBrokerProductId:'o'};return {id:platform,platform,currency:'USDT',strike:K,expires:T,data:{status:'ready',currency:'USDT',serverTime:NOW,receivedAt:NOW,fetchedAt:NOW,contract:{strike:K,expires:T},product,quote:{expiredAt:NOW+30000}}};}

test('unavailable options do not suppress independent actual dual income or selected maturity',async()=>{
 const selected=NOW+3*DAY,product=entry('binance',{K:78000,T:selected});product.data.product.maxAmount='100000';
 let productReads=0,depthReads=0;
 const result=await collectBinanceDesk({amount:80000,targetPrice:'78000',expiry:selected},deps([],{marketLoader:async()=>{throw Error('cloud HTTP 403');},catalogueLoader:async()=>{productReads++;return {entries:[product,entry('binance',{K:79000,T:EXP})],sources:[{platform:'binance',status:'ready'}]};},bookLoader:async()=>{depthReads++;}}));
 assert.equal(productReads,1);assert.equal(depthReads,0);assert.equal(result.market,null);assert.equal(result.row,null);
 assert.equal(result.amount,80000);assert.equal(result.targetPrice,78000);assert.equal(result.selectedExpiry,selected);assert.equal(result.expirySource,'dual');assert.deepEqual(result.expiries,[selected]);
 const dual=binanceDualIncome(result,NOW);assert.equal(dual.valid,true);near(dual.income,456);near(dual.term,.0057);near(dual.apr,.3);assert.equal(dual.incomeDifference,undefined);assert.equal(dual.optionIncome,undefined);
 assert.deepEqual(binanceComparableExpiries(result,NOW),[]);assert.match(result.reason,/期权云端盘口未接通/);
 assert.equal(binanceDualIncome(result,NOW+30000).valid,false);assert.deepEqual(binanceDualExpiries(result,NOW+30000),[]);
 assert.equal(binanceDualIncome({...result,amount:100001},NOW).valid,false);
});

test('product discovery starts before a pending options source finishes',async()=>{
 let rejectMarket,productReads=0;
 const pending=collectBinanceDesk({amount:10000,targetPrice:79000},deps([],{marketLoader:()=>new Promise((resolve,reject)=>{rejectMarket=reject;}),catalogueLoader:async()=>{productReads++;return {entries:[entry('binance')],sources:[]};}}));
 await Promise.resolve();assert.equal(productReads,1);rejectMarket(Error('unavailable'));const result=await pending;assert.equal(binanceDualIncome(result,NOW).valid,true);
});

test('a source failure preserves its concrete reason without probing another book or hiding independent dual quotes',async()=>{
 const product=entry('binance'),reads=[];
 const data=await collectBinanceDesk({amount:10000,targetPrice:79000,expiry:EXP},deps([],{marketLoader:async()=>{throw Error('期权公开行情读取超过 22 秒，请刷新');},catalogueLoader:async()=>({entries:[product],sources:[{platform:'binance',status:'ready'}]}),bookLoader:async symbol=>{reads.push(symbol);assert.fail('failed source must not fetch depth');}}));
 assert.equal(data.market,null);assert.equal(data.row,null);assert.deepEqual(reads,[]);assert.equal(data.marketReason,'期权公开行情读取超过 22 秒，请刷新');assert.match(data.reason,/超过 22 秒/);assert.equal(binanceDualIncome(data,NOW).valid,true);
});

test('a listed market without the exact target price stays distinct from a failed source',async()=>{
 const price=77750,product=entry('binance',{K:price}),reads=[];
 const data=await collectBinanceDesk({amount:10000,targetPrice:price,expiry:EXP},deps([contract(77500),contract(78000)],{catalogueLoader:async()=>({entries:[product],sources:[{platform:'binance',status:'ready'}]}),bookLoader:async symbol=>{reads.push(symbol);assert.fail('no nearby strike substitution');}}));
 assert.ok(data.market);assert.equal(data.row,null);assert.equal(data.marketReason,'');assert.match(data.reason,/没有这个精确接币价/);assert.doesNotMatch(data.reason,/未接通|来源不可用/);assert.equal(data.expirySource,'dual');assert.deepEqual(data.expiries,[EXP]);assert.deepEqual(reads,[]);assert.equal(data.targetPrice,price);assert.equal(binanceDualIncome(data,NOW).valid,true);
});

test('initial 1263ms market age survives receipt and cannot extend the original thirty-second deadline',async()=>{
 const data=await collectBinanceDesk({amount:80000,targetPrice:78000,expiry:EXP},deps([contract(78000)],{marketLoader:async()=>({spot:80704.45086957,time:NOW-1263,contracts:[contract(78000)]}),bookLoader:async()=>({time:NOW,bids:[{price:100,qty:2}]})}));
 assert.equal(data.row.quote.valid,true);near(data.row.quote.days,(EXP-NOW)/DAY);
 assert.equal(binanceRowFresh(data.row,NOW+28736),true);assert.equal(binanceRowFresh(data.row,NOW+28737),false);
 assert.equal(data.row.market.time,NOW-1263);assert.equal(data.row.book.time,NOW);
 const originalBook={...data.row,book:{...data.row.book,time:NOW-1679}};
 assert.equal(binanceRowFresh(originalBook,NOW+28320),true);assert.equal(binanceRowFresh(originalBook,NOW+28321),false);
 const knownOlder={...data.row,market:{...data.row.market,sourceAgeAtReceive:25000}};
 assert.equal(binanceRowFresh(knownOlder,NOW+4999),true);assert.equal(binanceRowFresh(knownOlder,NOW+5000),false);
});

test('a fresh later book does not renew an eighteen-second-old market or remaining term',async()=>{
 let clock=NOW;
 const data=await collectBinanceDesk({amount:10000,targetPrice:79000},deps(undefined,{clock:()=>clock,catalogueLoader:async()=>{clock=NOW+18000;return {entries:[],sources:[]};},bookLoader:async()=>({time:clock,bids:[{price:100,qty:2}]})}));
 assert.equal(data.row.quote.valid,true);near(data.row.quote.days,(EXP-(NOW+18000))/DAY);
 assert.equal(binanceRowFresh(data.row,NOW+29999),true);assert.equal(binanceRowFresh(data.row,NOW+30000),false);
 const stale=await collectBinanceDesk({amount:10000,targetPrice:79000},deps(undefined,{clock:()=>clock,marketLoader:async()=>({spot:80000,time:NOW,contracts:[contract()]}),catalogueLoader:async()=>({entries:[],sources:[]}),bookLoader:async()=>{clock=NOW+31000;return {time:clock,bids:[{price:100,qty:2}]};}}));
 assert.equal(stale.row.quote.valid,false);assert.match(stale.row.quote.reason,/合约或指数来源已超过 30 秒/);
});

test('dropdown selects one exact expiry and strike; never fetches another expiry or adjacent strike',async()=>{const contracts=[contract(79000,NOW+DAY),contract(),contract(80000)],reads=[],scopes=[];const result=await collectBinanceDesk({amount:10000,targetPrice:79000,expiry:EXP,settlementMode:'buy_btc'},deps(contracts,{bookLoader:async symbol=>{reads.push(symbol);return {time:NOW,bids:[{price:100,qty:2}]};},catalogueLoader:async(currency,scope)=>{assert.equal(currency,'USDT');scopes.push(scope);return{entries:[],sources:[]};}}));assert.deepEqual(result.expiries,[NOW+DAY,EXP]);assert.equal(result.row.contract.expires,EXP);assert.deepEqual(reads,[contract().symbol]);assert.deepEqual(scopes[0],[],'dual discovery must not depend on option contracts');
 const missing=await collectBinanceDesk({amount:10000,targetPrice:79500},deps(contracts,{bookLoader:()=>assert.fail('no adjacent strike') }));assert.equal(missing.row,null);assert.match(missing.reason,/没有这个精确接币价/);
 const invalidExpiry=await collectBinanceDesk({amount:10000,targetPrice:79000,expiry:EXP+1},deps(contracts,{bookLoader:()=>assert.fail('invalid expiry must not fetch')}));assert.match(invalidExpiry.reason,/重新选择/);
});
test('first selection uses nearest actual expiry while blank price causes no depth request',async()=>{const contracts=[contract(),contract(79000,NOW+DAY)];const result=await collectBinanceDesk({amount:10000,targetPrice:79000},deps(contracts));assert.equal(result.selectedExpiry,NOW+DAY);assert.equal(result.row.contract.expires,NOW+DAY);const blank=await collectBinanceDesk({amount:10000,targetPrice:''},deps(contracts,{bookLoader:()=>assert.fail('blank strike')}));assert.equal(blank.row,null);assert.match(blank.reason,/精确价格/);});
test('SELL PUT sweeps bids, caps actual fee estimate, and does not fabricate settlement outcomes',async()=>{const data=await collectBinanceDesk({amount:10000,targetPrice:79000},deps()),q=data.row.quote;assert.equal(q.valid,true);assert.equal(q.levelsUsed,2);near(q.gross,.05*100+(q.q-.05)*80);near(q.openFee,q.gross*.1);near(q.netIncome,q.gross-q.openFee);near(q.term,q.netIncome/10000);near(q.annual,q.term*365/7);for(const key of ['expiryPrice','receivedBTC','settlementLoss','finalCash'])assert.equal(key in q,false);const shallow=await collectBinanceDesk({amount:10000,targetPrice:79000},deps(undefined,{bookLoader:async()=>({time:NOW,bids:[{price:100,qty:.01}]})}));assert.equal(shallow.row.quote.valid,false);assert.match(shallow.row.quote.reason,/深度不足/);});
test('cash mode does not reserve a spot fee; automatic buy mode does',async()=>{const cash=await collectBinanceDesk({amount:10000,targetPrice:79000,settlementMode:'cash'},deps()),buy=await collectBinanceDesk({amount:10000,targetPrice:79000,settlementMode:'buy_btc'},deps());assert.equal(cash.settlementMode,'cash');assert.equal(cash.row.quote.spotFeeReserve,0);assert.ok(buy.row.quote.spotFeeReserve>0);assert.ok(cash.row.quote.q>=buy.row.quote.q);});
test('same USDT comparisons show real income differences and each actual accrual period',async()=>{const {row}=await collectBinanceDesk({amount:10000,targetPrice:79000},deps());const rates=compareBinanceDesk(row,[entry('binance'),entry('okx')],NOW);assert.equal(rates.length,1);assert.equal(rates[0].platform,'binance');assert.ok(rates.every(c=>c.valid));for(const c of rates){near(c.incomeDifference,row.quote.netIncome-c.income);near(c.spreadPoints,(row.quote.annual-c.apr)*100);assert.equal(c.currency,'USDT');assert.equal(c.days,7);assert.match(c.comparisonNote,/平台 7 天计息/);assert.ok(c.income>0);}assert.ok(rates.every(c=>c.incomeDifference<0));for(const wrong of [[entry('binance',{K:79001})],[entry('okx',{T:EXP+1})],[]])assert.ok(compareBinanceDesk(row,wrong,NOW).every(c=>!c.valid));});
test('source quote age accumulates; stale comparison and cancelled generations fail closed',async()=>{const result=await collectBinanceDesk({amount:10000,targetPrice:79000},deps(undefined,{bookLoader:async()=>({time:NOW-29000,bids:[{price:100,qty:2}]})}));assert.equal(binanceRowFresh(result.row,NOW+999),true);assert.equal(binanceRowFresh(result.row,NOW+1000),false);assert.ok(compareBinanceDesk(result.row,[entry('binance')],NOW+1000).every(c=>!c.valid));let books=0;assert.equal(await collectBinanceDesk({amount:10000,targetPrice:79000},deps(undefined,{isCurrent:()=>false,bookLoader:async()=>{books++;}})),null);assert.equal(books,0);});

test('comparable dates require a listed exact-price PUT, fresh Binance product and this investment limits',async()=>{
 const first=NOW+DAY,second=NOW+3*DAY,third=NOW+7*DAY;
 const a=entry('binance',{T:second}),b=entry('binance',{T:third});
 const data=await collectBinanceDesk({amount:10000,targetPrice:79000,expiry:first},deps([contract(79000,first),contract(79000,second),contract(79000,third)],{catalogueLoader:async()=>({entries:[b,a,a,entry('binance',{K:80000,T:second}),entry('binance',{T:NOW+2*DAY}),entry('okx',{T:first})],sources:[]})}));
 assert.equal(data.selectedExpiry,first);
 assert.deepEqual(binanceComparableExpiries(data,NOW),[second,third]);
 assert.equal(compareBinanceDesk(data.row,data.entries,NOW)[0].valid,false,'alternative maturities must never supply current income');
 assert.deepEqual(binanceComparableExpiries({...data,amount:20001},NOW),[]);
 assert.deepEqual(binanceComparableExpiries({...data,amount:19},NOW),[]);
 a.data.product.canPurchase=false;
 assert.deepEqual(binanceComparableExpiries(data,NOW),[third]);
 b.data.receivedAt=NOW-30000;b.data.fetchedAt=NOW-30000;
 assert.deepEqual(binanceComparableExpiries(data,NOW),[]);
});
test('comparable-date labels disappear at the original public quote deadline',async()=>{
 const e=entry('binance'),data=await collectBinanceDesk({amount:10000,targetPrice:79000},deps(undefined,{catalogueLoader:async()=>({entries:[e],sources:[]})}));
 assert.deepEqual(binanceComparableExpiries(data,NOW+29999),[EXP]);
 assert.deepEqual(binanceComparableExpiries(data,NOW+30000),[]);
 assert.deepEqual(binanceComparableExpiries({...data,market:{...data.market,time:NOW-30000}},NOW),[]);
});
test('default desk catalogue fetches only Binance and injected foreign products never become comparison rows',async t=>{
 const now=Date.now(),expires=now+7*DAY,c=contract(79000,expires),requests=[],oldFetch=globalThis.fetch;
 t.after(()=>{globalThis.fetch=oldFetch;});
 globalThis.fetch=async(url,options)=>{
  requests.push({url:String(url),options});
  assert.equal(url,'/api/binance-dual','no other platform request is permitted');
  return Response.json({status:'ready',serverTime:now,fetchedAt:now,sourceType:'sapi',items:[{...entry('binance').data.product,settleDate:expires,purchaseEndTime:now+DAY}]},{headers:{date:new Date(now).toUTCString()}});
 };
 const result=await collectBinanceDesk({amount:10000,targetPrice:79000,expiry:expires},{clock:()=>now,marketLoader:async()=>({spot:80000,time:now,contracts:[c]}),bookLoader:async()=>({time:now,bids:[{price:100,qty:2}]})});
 assert.deepEqual(requests.map(r=>r.url),['/api/binance-dual']);
 assert.deepEqual(result.sources.map(s=>s.platform),['binance']);
 assert.equal(result.entries.length,1);assert.equal(result.entries[0].platform,'binance');
 const foreign=entry('okx',{T:expires});foreign.data.serverTime=now;foreign.data.receivedAt=now;foreign.data.fetchedAt=now;
 const comparison=compareBinanceDesk(result.row,[...result.entries,foreign],now);
 assert.equal(comparison.length,1);assert.equal(comparison[0].platform,'binance');assert.equal(comparison[0].valid,true);
});

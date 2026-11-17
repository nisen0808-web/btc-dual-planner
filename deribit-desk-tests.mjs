import test from 'node:test';
import assert from 'node:assert/strict';
import {collectDeribitDesk,compareDeskRates,deskRowFresh,expiryLabel,timestamp,timeLeft,money} from './web/deribit-desk.js';

// Synthetic public-quote fixtures only. No exchange account, order or network is used.
const NOW=Date.UTC(2026,9,23,8),DAY=86400000,EXPIRY=NOW+7*DAY;
const near=(a,b,tolerance=1e-8)=>assert.ok(Math.abs(a-b)<=tolerance,`${a} != ${b}`);
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const nextTurn=()=>new Promise(resolve=>setImmediate(resolve));
async function until(predicate){for(let i=0;i<30&&!predicate();i++)await nextTurn();assert.ok(predicate(),'expected asynchronous collector progress');}
function contract(strike=80000,expires=EXPIRY,extra={}){
 return {symbol:`BTC-${expires}-${strike}-P_USDC`,strike,expires,settleCoin:'USDC',step:.01,min:.01,taker:.0003,cap:.125,delivery:.00015,spot:0,spotDeductBase:false,...extra};
}
const book=()=>({time:NOW,bids:[{price:1000,qty:3}]});
const market=contracts=>({platform:'deribit',spot:85000,time:NOW,contracts});
function dependencies(contracts,extra={}){
 return {clock:()=>NOW,marketLoader:async platform=>{assert.equal(platform,'deribit');return market(contracts);},bookLoader:async platform=>{assert.equal(platform,'deribit');return book();},catalogueLoader:async(currency,scoped)=>{assert.equal(currency,'USDT');assert.ok(scoped.every(c=>c.strike===80000));return{entries:[],sources:[]};},...extra};
}
async function rowFixture(){return(await collectDeribitDesk({amount:10000,targetPrice:80000},dependencies([contract()]))).rows[0];}
function dualEntry(platform,{K=80000,T=EXPIRY,apr=.365,id=platform,stamp=NOW,currency='USDT'}={}){
 const common={status:'ready',currency,serverTime:stamp,receivedAt:NOW,contract:{strike:K,expires:T}};
 const product=platform==='binance'?{id,investCoin:currency,exercisedCoin:'BTC',strikePrice:String(K),duration:7,settleDate:T,purchaseDecimal:4,purchaseEndTime:NOW+DAY,canPurchase:true,apr:String(apr),minAmount:'20',maxAmount:'20000',optionType:'PUT'}:
  {currency:'BTC',alternativeCurrency:currency,type:'PUT',productType:'DualCurrencyDeposit',dcdType:'Standard',status:1,launchTime:NOW-1000,stopTradingTime:T-3600000,expiryTime:T,settlementTime:T,quoteResponseTime:stamp,dcdTerm:'168',interestAccrualTime:T-7*DAY,absYield:String(apr*7/365),annualYield:String(apr),strike:String(K),ndBrokerProductId:id};
 const data={...common,product,quote:{},...(platform==='binance'?{fetchedAt:NOW}:{})};
 return{id,platform,currency,strike:K,expires:T,data};
}

test('two user values select only the exact target price; missing and adjacent strikes never silently substitute',async t=>{
 t.mock.method(globalThis,'fetch',()=>assert.fail('public dependencies must be mocked'));
 const contracts=[contract(79000),contract(),contract(81000)],reads=[],deps=dependencies(contracts,{bookLoader:async(platform,symbol)=>{reads.push(symbol);return book();}});
 const result=await collectDeribitDesk({amount:'10000',targetPrice:'80000'},deps);
 assert.equal(result.amount,10000);assert.equal(result.targetPrice,80000);assert.equal(result.rows.length,1);assert.equal(result.rows[0].contract.strike,80000);assert.deepEqual(reads,[contract().symbol]);
 reads.length=0;const missing=await collectDeribitDesk({amount:10000,targetPrice:80500},deps);assert.equal(missing.targetPrice,80500);assert.equal(missing.rows.length,0);assert.match(missing.reason,/没有这个精确接币价/);assert.match(missing.reason,/80,000/);assert.equal(reads.length,0);
 const blank=await collectDeribitDesk({amount:10000,targetPrice:''},deps);assert.equal(blank.targetPrice,null);assert.match(blank.reason,/填入你想接 BTC 的价格/);assert.equal(blank.rows.length,0);assert.equal(reads.length,0);
 for(const amount of [0,-1,NaN,Infinity])assert.match((await collectDeribitDesk({amount,targetPrice:80000},deps)).reason,/投入/);
 for(const targetPrice of [0,-1,NaN,Infinity])assert.match((await collectDeribitDesk({amount:10000,targetPrice},deps)).reason,/接币价须/);
});

test('real expiry cards use the exact target, seven inclusive server-clock days and explicit expanded ranges',async()=>{
 const expiries=[NOW-1,NOW,NOW+DAY,NOW+7*DAY,NOW+7*DAY+1,NOW+30*DAY,NOW+90*DAY];
 const contracts=expiries.map(t=>contract(80000,t));contracts.push(contract(81000,NOW+2*DAY),contract(80000,NOW+3*DAY,{active:false}),contract(80000,NOW+4*DAY,{is_active:false}));
 const scoped=[];const deps=dependencies(contracts,{catalogueLoader:async(currency,rows)=>{assert.equal(currency,'USDT');scoped.push(rows);return{entries:[],sources:[]};}});
 const seven=await collectDeribitDesk({amount:10000,targetPrice:80000},deps);assert.deepEqual(seven.expiries,[NOW+DAY,NOW+7*DAY]);assert.deepEqual(seven.allExpiries,expiries.slice(2));assert.deepEqual(seven.rows.map(r=>r.contract.expires),seven.expiries);assert.deepEqual(scoped[0].map(c=>c.expires),seven.expiries);
 const thirty=await collectDeribitDesk({amount:10000,targetPrice:80000,maxDays:30},deps);assert.deepEqual(thirty.expiries,expiries.slice(2,6));
 const ninety=await collectDeribitDesk({amount:10000,targetPrice:80000,maxDays:90},deps);assert.deepEqual(ninety.expiries,expiries.slice(2));
 assert.match(expiryLabel(NOW),/10月23日/);assert.match(expiryLabel(NOW),/16:00/);assert.match(timestamp(NOW),/2026\/10\/23 16:00:00 SGT/);assert.equal(expiryLabel(NaN),'—');assert.equal(timestamp(0),'—');assert.equal(timeLeft(NOW,NOW),'已到期');assert.equal(timeLeft(NOW+DAY+2*3600000+3*60000,NOW),'1天 2小时 3分钟');
});

test('a failed expiry book or unavailable dual source preserves other real expiry quotes',async()=>{
 const contracts=[contract(80000,NOW+DAY),contract(80000,NOW+2*DAY),contract(80000,NOW+3*DAY)];
 const result=await collectDeribitDesk({amount:10000,targetPrice:80000},dependencies(contracts,{bookLoader:async(platform,symbol)=>{if(symbol===contracts[1].symbol)throw Error('synthetic public feed unavailable');return book();},catalogueLoader:async()=>{throw Error('synthetic dual catalogue unavailable');}}));
 assert.equal(result.rows.length,3);assert.deepEqual(result.rows.map(r=>r.contract.expires),contracts.map(c=>c.expires));assert.equal(result.rows[0].quote.valid,true);assert.equal(result.rows[2].quote.valid,true);assert.equal(result.rows[1].quote.valid,false);assert.match(result.rows[1].quote.reason,/真实买盘暂不可读/);assert.deepEqual(result.entries,[]);assert.deepEqual(result.sources,[]);
});

test('visible bid VWAP, quantity, fee caps and untriggered principal plus net premium use the actual quote',async()=>{
 const result=await collectDeribitDesk({amount:10000,targetPrice:80000},dependencies([contract()],{bookLoader:async()=>({time:NOW,bids:[{price:100,qty:.05},{price:50,qty:.2}]})}));
 const q=result.rows[0].quote;assert.equal(q.valid,true);near(q.q,.12);near(q.capital,9600);near(q.gross,8.5);near(q.openFee,1.0625);near(q.netIncome,7.4375);near(q.bestBid,100);near(q.bestBidQty,.05);near(q.depthQty,.25);near(q.averagePrice,8.5/.12);assert.equal(q.levelsUsed,2);near(q.term,7.4375/10000);near(q.annual,q.term*365/7);near(q.amount+q.netIncome,10007.4375);assert.ok(q.reserve<=q.amount);assert.equal(q.executionStatus,'quoted');
 for(const key of ['expiryPrice','scenarioPrice','btcReceived','finalBtc','payout'])assert.equal(key in q,false,key);
 const shallow=await collectDeribitDesk({amount:10000,targetPrice:80000},dependencies([contract()],{bookLoader:async()=>({time:NOW,bids:[{price:100,qty:.01}]})}));assert.equal(shallow.rows[0].quote.valid,false);assert.match(shallow.rows[0].quote.reason,/深度不足/);
});

test('cancelling an old generation stops its queued books and returns no snapshot to overwrite the new selection',async()=>{
 const pending=deferred(),started=[],contracts=Array.from({length:9},(_,i)=>contract(80000,NOW+(i+1)*DAY/2));let current=true;
 const obsolete=collectDeribitDesk({amount:10000,targetPrice:80000},dependencies(contracts,{isCurrent:()=>current,bookLoader:async(platform,symbol)=>{started.push(symbol);await pending.promise;return book();}}));
 await until(()=>started.length===4);current=false;
 const latest=await collectDeribitDesk({amount:20000,targetPrice:80000},dependencies([contract()]));assert.equal(latest.amount,20000);assert.equal(latest.rows[0].quote.valid,true);
 pending.resolve();assert.equal(await obsolete,null);assert.equal(started.length,4);assert.equal(new Set(started).size,4);
 let afterMarket=0;const cancelled=await collectDeribitDesk({amount:10000,targetPrice:80000},dependencies([contract()],{isCurrent:()=>false,onMarket:()=>afterMarket++,bookLoader:()=>assert.fail('cancelled market cannot launch books')}));assert.equal(cancelled,null);assert.equal(afterMarket,0);
});

test('Binance and OKX exact nominal price/time return real USDT APR observations and signed percentage-point spreads only',async t=>{
 t.mock.method(globalThis,'fetch',()=>assert.fail('APR comparisons cannot access an account or network'));
 const row=await rowFixture(),entries=[dualEntry('binance',{apr:.2,id:'lower'}),dualEntry('binance',{apr:.4,id:'higher'}),dualEntry('okx',{apr:1.5})],before=structuredClone(entries);
 const results=compareDeskRates(row,entries,NOW);assert.equal(results.length,2);assert.equal(results[0].valid,true);near(results[0].apr,.4);assert.equal(results[1].valid,true);near(results[1].apr,1.5);
 for(const rate of results){assert.equal(rate.currency,'USDT');assert.equal(rate.optionCurrency,'USDC');assert.equal(rate.sameCurrency,false);assert.equal(rate.differenceUnit,'percentage_points');near(rate.optionApr,row.quote.annual);near(rate.spreadPoints,(row.quote.annual-rate.apr)*100);assert.match(rate.note,/USDT 双币与 USDC 期权/);assert.match(rate.note,/不计算同币种金额差/);for(const key of ['incomeDifference','difference','income','amount','dualBtc','dualCash','fakeUSDC'])assert.equal(key in rate,false,key);}
 assert.ok(results[0].spreadPoints>0);assert.ok(results[1].spreadPoints<0);assert.deepEqual(entries,before);
});

test('missing, adjacent, different-time and wrong-currency products remain absent rather than zero-APR or fake USDC matches',async()=>{
 const row=await rowFixture();
 for(const entries of [[],[dualEntry('binance',{K:80000.01}),dualEntry('okx',{K:79999})],[dualEntry('binance',{T:EXPIRY+1}),dualEntry('okx',{T:EXPIRY-1})],[dualEntry('binance',{currency:'USDC'}),dualEntry('okx',{currency:'USDC'})]]){
  const rates=compareDeskRates(row,entries,NOW);assert.ok(rates.every(rate=>rate.valid===false));for(const rate of rates){assert.equal(rate.sameCurrency,false);assert.equal('apr' in rate,false);assert.equal('spreadPoints' in rate,false);assert.match(rate.reason,/暂无同名义接币价、同到期时刻/);}
 }
});

test('30-second expiry, source skew and stale catalogues fail closed without erasing a fresh PUT',async()=>{
 const row=await rowFixture();assert.equal(deskRowFresh(row,NOW+29999),true);assert.equal(deskRowFresh(row,NOW+30000),false);assert.equal(deskRowFresh({...row,receivedAt:NOW+1},NOW),false);assert.equal(deskRowFresh({...row,contract:{...row.contract,expires:NOW}},NOW),false);
 const entries=[dualEntry('binance'),dualEntry('okx')];assert.ok(compareDeskRates(row,entries,NOW+29999).every(r=>r.valid));assert.ok(compareDeskRates(row,entries,NOW+30000).every(r=>!r.valid&&/期权报价已失效/.test(r.reason)));
 const skewed=entries.map(e=>({...e,data:{...e.data,serverTime:NOW-30000}}));assert.ok(compareDeskRates(row,skewed,NOW).every(r=>!r.valid&&/来源时间相差/.test(r.reason)));assert.equal(deskRowFresh(row,NOW),true);
 const freshRow={...row,receivedAt:NOW+30000,market:{...row.market,time:NOW+30000,receivedAt:NOW+30000},book:{...row.book,time:NOW+30000}};
 const stale=entries.map(e=>({...e,data:{...e.data,serverTime:NOW+30000}}));const invalid=compareDeskRates(freshRow,stale,NOW+30000);assert.ok(invalid.every(r=>!r.valid));assert.ok(invalid.every(r=>!('apr' in r)));
 const staleBook=await collectDeribitDesk({amount:10000,targetPrice:80000},dependencies([contract()],{bookLoader:async()=>({time:NOW-30000,bids:[{price:1000,qty:2}]})}));assert.equal(staleBook.rows[0].quote.valid,false);assert.match(staleBook.rows[0].quote.reason,/买盘来源已过期/);
});

test('source age accumulates after receipt and absent numeric fields never render as a zero quote',async()=>{
 const result=await collectDeribitDesk({amount:10000,targetPrice:80000},dependencies([contract()],{bookLoader:async()=>({time:NOW-29000,bids:[{price:1000,qty:2}]})}));
 const row=result.rows[0];assert.equal(row.quote.valid,true);assert.equal(deskRowFresh(row,NOW),true);assert.equal(deskRowFresh(row,NOW+999),true);assert.equal(deskRowFresh(row,NOW+1000),false);assert.equal(deskRowFresh(row,NOW+2000),false);
 assert.ok(compareDeskRates(row,[dualEntry('binance'),dualEntry('okx')],NOW+2000).every(r=>!r.valid&&/期权报价已失效/.test(r.reason)));
 for(const absent of [null,undefined,'',' ',true,false,NaN,Infinity,-Infinity])assert.equal(money(absent),'—',String(absent));
 assert.equal(money(0),'0');assert.equal(money('0'),'0');assert.equal(money(1000.126),'1,000.13');
});

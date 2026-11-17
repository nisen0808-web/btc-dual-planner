import test from 'node:test';
import assert from 'node:assert/strict';
import {collectBinanceDesk,compareBinanceDesk} from './web/binance-desk.js';
const NOW=Date.UTC(2026,9,27,8),EXP=NOW+7*86400000;
const contract={symbol:'BTC-261103-79000-P',strike:79000,expires:EXP,settleCoin:'USDT',step:.01,min:.01,max:100,priceTick:5,taker:.00024,cap:.1,delivery:.00015,deliveryCap:.1,spot:.001};
function fixture({book={time:NOW,bids:[{price:100,qty:2}],asks:[{price:250,qty:.001}]}}={}){
 const reads=[],deps={clock:()=>NOW,marketLoader:async()=>({spot:80000,time:NOW,receivedAt:NOW,contracts:[contract]}),catalogueLoader:async()=>({entries:[],sources:[]}),bookLoader:async symbol=>{reads.push(symbol);return book;}};
 return {deps,reads,input:{amount:10000,targetPrice:79000,expiry:EXP,settlementMode:'cash'}};
}
test('explicit ask mode projects one actual ask without inventing sell-side liquidity, while bid mode retains immediate sale depth',async()=>{
 const f=fixture(),ask=await collectBinanceDesk({...f.input,quoteMode:'ask_limit'},f.deps),bid=await collectBinanceDesk({...f.input,quoteMode:'bid_taker'},f.deps);
 assert.equal(ask.row.quote.valid,true);assert.equal(ask.row.quote.averagePrice,250);assert.equal(ask.row.quote.quoteMode,'ask_limit');assert.equal(ask.row.quote.conditional,true);assert.equal(ask.row.quote.fillGuaranteed,false);assert.equal(ask.row.quote.executionStatus,'unfilled_limit_quote');assert.ok(ask.row.quote.q>.001);assert.equal(ask.row.quote.depthQty,null);assert.equal(ask.row.quote.levelsUsed,0);
 assert.equal(bid.row.quote.valid,true);assert.equal(bid.row.quote.averagePrice,100);assert.ok(ask.row.quote.netIncome>bid.row.quote.netIncome);assert.deepEqual(f.reads,[contract.symbol,contract.symbol]);assert.equal(ask.selectedExpiry,EXP);assert.equal(ask.targetPrice,79000);
});
test('unavailable ask never falls back to bid and an invalid quote mode never requests depth',async()=>{
 const f=fixture({book:{time:NOW,bids:[{price:100,qty:2}],asks:[]}}),ask=await collectBinanceDesk({...f.input,quoteMode:'ask_limit'},f.deps);
 assert.equal(ask.row.quote.valid,false);assert.match(ask.row.quote.reason,/卖一|卖盘/);const bad=await collectBinanceDesk({...f.input,quoteMode:'unknown'},f.deps);assert.equal(bad.row,null);assert.match(bad.reason,/报价方式/);assert.deepEqual(f.reads,[contract.symbol]);
});
test('strict dual comparison keeps the ask premium difference conditional on full future fill',async()=>{
 const f=fixture(),r=await collectBinanceDesk({...f.input,quoteMode:'ask_limit'},f.deps);
 const product={id:'fixture-dual',optionType:'PUT',investCoin:'USDT',exercisedCoin:'BTC',strikePrice:'79000',duration:7,settleDate:EXP,purchaseDecimal:4,purchaseEndTime:NOW+3600000,canPurchase:true,apr:'0.2',minAmount:'10',maxAmount:'20000'};
 const entry={platform:'binance',currency:'USDT',strike:79000,expires:EXP,data:{status:'ready',currency:'USDT',sourceType:'sapi',serverTime:NOW,receivedAt:NOW,fetchedAt:NOW,snapshotAgeAtReceive:0,contract:{strike:79000,expires:EXP},product,quote:{expiredAt:NOW+30000}}};
 const d=compareBinanceDesk(r.row,[entry],NOW)[0];assert.equal(d.valid,true);assert.equal(d.conditional,true);assert.equal(d.quoteMode,'ask_limit');assert.equal(d.incomeDifference,r.row.quote.netIncome-d.income);assert.match(d.comparisonNote,/全部成交.*未触发/);
 const wrong={...entry,strike:78000};assert.equal(compareBinanceDesk(r.row,[wrong],NOW)[0].valid,false);
});

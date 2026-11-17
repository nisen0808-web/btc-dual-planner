import test from 'node:test';
import assert from 'node:assert/strict';
import {calculatePutAskLimitQuote,calculatePutQuote} from './web/put-quote.js';

// Synthetic unit fixtures only. No API credential, exchange request or order.
const NOW=Date.UTC(2026,9,27,8),DAY=86400000;
const contract=extra=>({strike:100000,expires:NOW+7*DAY,step:.01,min:.01,max:100,priceTick:5,taker:.00024,cap:.1,delivery:.00015,spot:0,settleCoin:'USDT',...extra});
const book=extra=>({time:NOW,bids:[{price:90,qty:10},{price:80,qty:20}],asks:[{price:500,qty:.001},{price:600,qty:.002}],...extra});
const quote=(A=100100,c=contract(),b=book(),spot=100000,now=NOW)=>calculatePutAskLimitQuote(A,c,b,spot,now);
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);

test('best ask is a single proposed limit price, not the bid sweep or ask-side available buyers',()=>{
 const q=quote();assert.equal(q.valid,true);assert.equal(q.q,1);assert.equal(q.bestAsk,500);assert.equal(q.bestAskQty,.001);assert.equal(q.averagePrice,500);assert.equal(q.gross,500);assert.equal(q.openFee,24);assert.equal(q.netIncome,476);
 assert.equal(q.quoteMode,'ask_limit');assert.equal(q.executionStatus,'unfilled_limit_quote');assert.equal(q.conditional,true);assert.equal(q.fillGuaranteed,false);assert.equal(q.canSubmit,false);assert.equal(q.depthQty,null);assert.equal(q.levelsUsed,0);assert.equal(q.bestBid,90);assert.ok(q.q>q.bestAskQty);
 const bid=calculatePutQuote(100100,contract(),book(),100000,NOW);assert.equal(bid.valid,true);assert.equal(bid.averagePrice,90);assert.notEqual(q.netIncome,bid.netIncome);
 const changedAskSize=quote(100100,contract(),book({asks:[{price:500,qty:1000}]}));assert.equal(changedAskSize.q,q.q);assert.equal(changedAskSize.gross,q.gross);
});

test('absence of buyers does not fabricate a fill, and absence of a real ask never falls back',()=>{
 const q=quote(100100,contract(),book({bids:[]}));assert.equal(q.valid,true);assert.equal(q.bestBid,null);assert.equal(q.fillGuaranteed,false);assert.equal(q.netIncome,476);
 for(const asks of [undefined,[],[{price:0,qty:1}],[{price:500,qty:0}]]){const bad=quote(100100,contract(),book({asks}));assert.equal(bad.valid,false);assert.equal(bad.quoteMode,'ask_limit');assert.equal(bad.fillGuaranteed,false);assert.equal(bad.gross,undefined);}
});

test('only opening fee is deducted from income; reserves stay assets and full amount is the yield denominator',()=>{
 const q=quote(100100,contract({spot:.001,spotDeductBase:true}));assert.equal(q.valid,true);assert.equal(q.q,.99);near(q.gross,495);near(q.openFee,23.76);near(q.netIncome,471.24);near(q.deliveryFeeReserve,14.85);near(q.spotFeeReserve,.001*(100100+495));near(q.feeReserve,q.openFee+q.deliveryFeeReserve+q.spotFeeReserve);near(q.reserve,q.capital+q.feeReserve);assert.ok(q.reserve<=q.amount);near(q.freeCash,q.amount-q.reserve);near(q.term,q.netIncome/100100);near(q.annual,q.term*365/7);assert.equal(q.feeEstimateOnly,true);assert.equal(q.feeRateBasis,'published_standard');
 const nextQ=q.q+.01,nextGross=nextQ*500,nextReserve=nextQ*100000+nextQ*24+nextQ*15+.001*(100100+nextGross);assert.ok(nextReserve>100100);
});

test('opening fees obey the option-value cap rather than assuming a free maker rate',()=>{
 const q=quote(100100,contract({priceTick:1}),book({bids:[],asks:[{price:1,qty:.001}]}));assert.equal(q.valid,true);assert.equal(q.q,1);near(q.gross,1);near(q.openFee,.1);near(q.netIncome,.9);
});

test('minimum funding and single-order maximum reject rather than clipping a full investment',()=>{
 assert.equal(quote(1000).valid,false);assert.match(quote(1000).reason,/最小/);
 const over=quote(1000000,contract({max:2}));assert.equal(over.valid,false);assert.match(over.reason,/单笔上限 2 BTC/);assert.equal(over.q,undefined);
 assert.equal(quote(100100,contract({max:undefined})).valid,false);assert.equal(quote(100100,contract({min:.1,max:.01})).valid,false);
});

test('lot arithmetic supports exact decimal minimums without the floating-point ceil boundary',()=>{
 const c=contract({strike:1000,min:.07,step:.01,taker:0,delivery:0,priceTick:1});
 const q=quote(70,c,book({bids:[],asks:[{price:1,qty:1}]}),1000);assert.equal(q.valid,true);assert.equal(q.q,.07);assert.equal(q.capital,70);assert.equal(q.reserve,70);
});

test('original thirty-second quote lifetime, future tolerance and expiry remain strict',()=>{
 assert.equal(quote(100100,contract(),book({time:NOW-29999})).valid,true);
 for(const time of [NOW-30000,NOW+2001,NaN,Infinity,null,0])assert.equal(quote(100100,contract(),book({time})).valid,false,String(time));
 assert.equal(quote(100100,contract(),book({time:NOW+2000})).valid,true);assert.equal(quote(100100,contract({expires:NOW})).valid,false);
});

test('invalid or crossed depth and off-tick ask prices fail closed instead of being sorted into an alternative quote',()=>{
 for(const b of [book({asks:[{price:600,qty:1},{price:500,qty:1}]}),book({asks:[{price:500,qty:1},{price:500,qty:2}]}),book({bids:[{price:80,qty:1},{price:90,qty:1}]}),book({bids:[{price:500,qty:1}]}),book({asks:[{price:501,qty:1}]}),book({bids:undefined}),book({asks:[{price:500,qty:Infinity}]})])assert.equal(quote(100100,contract(),b).valid,false);
 const decimal=quote(100100,contract({priceTick:.1}),book({bids:[],asks:[{price:.3,qty:1}]}));assert.equal(decimal.valid,true);assert.equal(decimal.bestAsk,.3);
});

test('nonfinite funding, fees or contract metadata never become a zero-income limit quote',()=>{
 for(const A of [0,-1,NaN,Infinity,'',null,true])assert.equal(quote(A).valid,false);
 for(const fields of [{taker:NaN},{cap:-.1},{delivery:Infinity},{spot:2},{spot:1,spotDeductBase:true},{step:0},{priceTick:0},{strike:Infinity},{expires:NaN}])assert.equal(quote(100100,contract(fields)).valid,false,JSON.stringify(fields));
});

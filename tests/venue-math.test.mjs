import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateVenueOption as quote, calculateOkxDual as dual} from '../web/venue-math.js';

const now=Date.UTC(2026,10,14,8), expires=now+2*86400000;
const fx={btcUSDT:60_600,btcTime:now,usdcUSDT:0.99,usdcTime:now};
function input(venue='okx', direction='CALL'){
  const okx=venue==='okx',symbol=venue+direction;
  return {direction,amount:direction==='CALL'?1:60_600,strike:60_000,expires,quoteMode:'bid_taker',now,fx,
    market:{status:'ready',time:now,spot:60_000,indexCoin:okx?'USD':'USDC'},
    contract:{direction,symbol,strike:60_000,expires,unit:okx?.01:1,min:.01,step:okx?1:.01,coin:okx?'BTC':'USDC',maker:okx?.0003:.001,taker:okx?.0003:.001,cap:okx?.07:.125},
    book:{status:'ready',symbol,time:now,bids:okx?[{price:.002,qty:40},{price:.001,qty:60}]:[{price:200,qty:10}],asks:okx?[{price:.0025,qty:1}]:[{price:205,qty:.1}]}};
}
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
test('OKX prices BTC inverse contracts per BTC with 0.01 BTC per lot, and caps fee at each level',()=>{
  const r=quote(input()); assert.equal(r.valid,true);near(r.contracts,100);near(r.coveredBTC,1);near(r.gross,.0014);
  near(r.openFee,.0014*.07);near(r.incomeUSDT,.0014*.93*60600);near(r.term,.0014*.93);
});
test('USD strike uses BTCUSD and BTCUSDT for the low-buy notional',()=>{
  const r=quote(input('okx','PUT'));near(r.contracts,100);near(r.capitalBasis,1);
});
test('USDC is valued at the actual FX rate; missing/stale FX retains high-sell native quote only',()=>{
  const i=input('coinbase');let r=quote(i);near(r.gross,200);near(r.openFee,25);near(r.incomeUSDT,175*.99);near(r.term,175/60000);
  r=quote({...i,fx:{...fx,usdcTime:now-30000}});assert.equal(r.incomeUSDT,null);near(r.income,175);
  assert.equal(quote({...input('coinbase','PUT'),fx:{}}).valid,false);
});
test('missing fees retain gross; ask is conditional, low depth and wrong terms suppress estimates',()=>{
  const i=input(),r=quote({...i,quoteMode:'ask_limit',contract:{...i.contract,maker:null}});near(r.gross,.0025);
  assert.equal(r.conditional,true);assert.equal(r.income,null);assert.equal(r.term,null);
  assert.equal(quote({...i,book:{...i.book,bids:[{price:.001,qty:1}]}}).valid,false);
  assert.equal(quote({...i,expires:expires+1}).valid,false);
  assert.equal(quote({...i,book:{...i.book,time:now-30_000}}).valid,false);
});
test('OKX dual uses published period yield and reports unpublished amount limits; expired purchase window fails closed',()=>{
  const product={direction:'CALL',coin:'BTC',strike:60_000,expires,apr:.31,term:.0017,time:now,purchaseEnd:expires-1000,min:null,max:null};
  const i={direction:'CALL',amount:2,strike:60_000,expires,catalogue:{status:'ready',time:now,products:[product]},fx,now};
  const r=dual(i);assert.equal(r.valid,true);near(r.income,.0034);near(r.incomeUSDT,.0034*60600);assert.equal(r.estimateOnly,true);
  assert.equal(dual({...i,catalogue:{...i.catalogue,products:[{...product,purchaseEnd:now}]}}).valid,false);
});

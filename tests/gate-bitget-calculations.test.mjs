import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateVenueOption, calculateVenueDual } from '../web/venue-math.js';
import { calculateVenueInsurance } from '../web/venue-insurance.js';
import { quoteSpotPut, spotPutOutcome } from '../web/spot-put-math.js';
import { exerciseFeeText } from '../web/venue-details.js';

const now = Date.UTC(2026,10,16,8), expires = now + 3*86_400_000, strike = 65_000;
const fx = { btcUSDT:65_100, btcTime:now };
const close = (a,b) => assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
function gate(direction='PUT') {
  const symbol = 'BTC_USDT-20261119-65000-'+direction[0];
  const contract = {symbol,direction,expires,strike,unit:.01,min:1,step:1,max:10_000,coin:'USDT',settleCoin:'USDT',
    maker:.0002,taker:.0003,cap:.125,delivery:.00015,deliveryCap:.125};
  const book = {status:'ready',platform:'gate',symbol,time:now,currency:'USDT',
    bids:[{price:200,qty:50},{price:100,qty:50}],asks:[{price:210,qty:100},{price:215,qty:1}]};
  const market = {status:'ready',platform:'gate',time:now,indexTime:now,indexCoin:'USDT',spot:65_000,contracts:[contract]};
  return {direction,now,amount:direction==='PUT'?65_000:1,strike,expires,quoteMode:'bid_taker',contract,market,book};
}
function catalogue(venue,direction='PUT') {
  return {platform:venue,status:'ready',time:now,products:[{
    id:'p-123',direction,coin:direction==='CALL'?'BTC':'USDT',strikeCurrency:'USDT',
    strike,expires,time:now,purchaseEnd:expires-1_000,min:.001,max:null,term:.003,apr:.365,termEstimated:true
  }]};
}
test('Gate USDT calls and puts retain original contract lots, fee caps and denomination',()=>{
  for (const direction of ['PUT','CALL']) {
    const input=gate(direction), r=calculateVenueOption(input);
    assert.equal(r.valid,true,r.reason); assert.equal(r.coin,'USDT');
    close(r.coveredBTC,1); close(r.contracts,100); close(r.gross,150);
    close(r.openFee,.5*19.5+.5*12.5); close(r.incomeUSDT,134); close(r.term,134/65_000);
    const ask=calculateVenueOption({...input,quoteMode:'ask_limit'}); close(ask.income,210-13);
    assert.equal(ask.conditional,true);
    assert.equal(calculateVenueOption({...input,book:{...input.book,platform:'bitget'}}).valid,false);
  }
});
test('Gate and Bitget dual products match exact platform, date, strike, currency, balance and subscription window',()=>{
  for(const venue of ['gate','bitget']) {
    const input={venue,direction:'PUT',amount:65_000,strike,expires,fx,now,catalogue:catalogue(venue)};
    const dual=calculateVenueDual(input);
    assert.equal(dual.valid,true,dual.reason); close(dual.income,195); assert.equal(dual.termEstimated,true);
    assert.equal(calculateVenueDual({...input,venue:'okx'}).valid,false);
    assert.equal(calculateVenueDual({...input,strike:strike+1}).valid,false);
    assert.equal(calculateVenueDual({...input,expires:expires+1}).valid,false);
    const product=input.catalogue.products[0];
    for(const change of [{coin:'USDC'},{strikeCurrency:'USD'},{min:65_001},{max:1},{purchaseEnd:now},{time:now-30_000}]) {
      assert.equal(calculateVenueDual({...input,catalogue:{...input.catalogue,products:[{...product,...change}]}}).valid,false);
    }
    const base=gate();
    const d=calculateVenueInsurance({...base,optionVenue:'gate',dualVenue:venue,source:'dual',dual,fx});
    assert.equal(d.valid,true,d.reason);close(d.premium,210);close(d.openingFee,19.5);close(d.netIncome,195-229.5);
    assert.equal(calculateVenueInsurance({...base,optionVenue:'gate',dualVenue:venue,source:'dual',dual:{...dual,strike:66_000}}).valid,false);
  }
});
test('Gate spot insurance reads the selected contract exercise rate; a weekday does not imply fee-free delivery',()=>{
  const i={...gate(),spotBTC:1,entryPrice:80_000,coverage:1};
  const q=quoteSpotPut(i);assert.equal(q.valid,true,q.reason);assert.equal(q.valuationReady,true);
  close(q.cost,229.5);close(q.strike,65_000);
  const out=spotPutOutcome(q,60_000);
  close(out.nativePayoff,5_000);close(out.exerciseFee,9);close(out.totalPnl,-15_238.5);
  assert.match(exerciseFeeText('gate',i.contract),/0.015%/);
  i.contract.delivery=0;close(spotPutOutcome(quoteSpotPut(i),60_000).exerciseFee,0);
  i.contract.delivery=null;assert.equal(quoteSpotPut(i).valuationReady,false);
});
test('a listed Bitget offer expires at its short verification window when subscription cutoff is unpublished',()=>{
  const cat=catalogue('bitget'), p=cat.products[0];
  Object.assign(p,{purchaseEnd:null,subscriptionOpen:true,availabilityUntil:now+5_000});
  const opts={venue:'bitget',direction:'PUT',amount:65_000,strike,expires,fx,now,catalogue:cat};
  assert.equal(calculateVenueDual(opts).valid,true);
  assert.equal(calculateVenueDual({...opts,now:now+5_000}).valid,false);
  p.subscriptionOpen=false;assert.equal(calculateVenueDual(opts).valid,false);
  p.subscriptionOpen=true;p.availabilityUntil=expires;assert.equal(calculateVenueDual(opts).valid,false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {rankSelections, netDifference, venueUniverse} from '../web/venue-comparison.js';

test('preselect broadest available price and expiry; duplicate listings cannot inflate coverage',()=>{
  const near={strike:71000,expires:3000},wide={strike:72000,expires:4000};
  const options=[near,near,...['binance','okx','coinbase'].map(venue=>({...wide,venue}))];
  const duals=[near,{...wide,venue:'okx'},wide];
  assert.equal(rankSelections(options,duals,70000,'CALL')[0].strike,72000);
  assert.equal(rankSelections([{...wide,venue:'okx'},near],[near,wide],70000,'CALL')[0].strike,71000);
});

test('original BTC income is compared in BTC, cross-currency needs timely real FX for both sides',()=>{
  const now=100000;
  const base={valid:true,income:.001,quoteTime:now,coin:'BTC'};
  assert.deepEqual(netDifference(base,{...base,income:.0005},{},now),{amount:.0005,coin:'BTC'});
  const usdc={...base,income:10,coin:'USDC'};
  assert.equal(netDifference(usdc,base,{},now),null);
  assert.deepEqual(netDifference(usdc,base,{btcUSDT:80000,btcTime:now,usdcUSDT:.999,usdcTime:now},now),{amount:-70.01,coin:'USDT',fx:true});
  assert.equal(netDifference(usdc,{...base,quoteTime:now-30000},{},now),null);
});

test('alternative venues supply price/expiry independent of Binance; omit stale products and closed offer windows',()=>{
  const now=100000;
  const c={strike:72000,expires:now+80000,direction:'CALL'};
  const source={status:'ready',time:now};
  const p={...c,time:now, purchaseEnd:now+1,min:null,max:null};
  const result=venueUniverse({okx:{...source,contracts:[c]},coinbase:{...source,time:now-30000,contracts:[c]},okxDual:{...source,products:[p,{...p,purchaseEnd:now}]}},'CALL',1,now);
  assert.equal(result.contracts.length,1);
  assert.equal(result.contracts[0].venue,'okx');
  assert.equal(result.products.length,1);
});

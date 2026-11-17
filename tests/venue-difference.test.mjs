import test from 'node:test';
import assert from 'node:assert/strict';
import {netDifference} from '../web/venue-comparison.js';

test('only timestamped FX money values can bridge a USDC premium to BTC or USDT rewards', () => {
  const now = Date.now();
  const option = {valid:true, coin:'USDC', income:100, quoteTime:now};
  const dual = {valid:true, coin:'BTC', income:0.001, quoteTime:now};
  const fx = {usdcUSDT:0.98, usdcTime:now, btcUSDT:60_000, btcTime:now};
  assert.deepEqual(netDifference(option, dual, fx, now), {amount:38, coin:'USDT', fx:true});
  assert.equal(netDifference(option, dual, {...fx, usdcTime:now-30_000}, now), null);
  assert.equal(netDifference(option, {...dual, quoteTime:now-30_000}, fx, now), null);
  assert.equal(netDifference({...option,income:null},dual,fx,now), null);
  assert.deepEqual(netDifference({...option,coin:'BTC',income:0.001},dual,{},now), {amount:0,coin:'BTC'});
});

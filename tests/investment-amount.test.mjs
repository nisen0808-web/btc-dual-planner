import test from 'node:test';
import assert from 'node:assert/strict';
import { investmentAmounts } from '../web/investment-amount.js';
import { currentFx } from '../web/venue-comparison.js';

const now = 1_800_000_000_000;
const fx = {btcTime:now, btcUSDT:64_500};

test('switching display units preserves the entered amount for both sizing directions', () => {
  const btc = {amount:'1.04', enteredUnit:'BTC', amountUnit:'USDT'};
  const usdt = {amount:'67,080', enteredUnit:'USDT', amountUnit:'BTC'};
  assert.equal(investmentAmounts(btc,'BTC',fx,now).display, '67,080');
  assert.equal(investmentAmounts(btc,'BTC',fx,now).native, 1.04);
  assert.equal(investmentAmounts(btc,'USDT',fx,now).native, 67_080);
  assert.equal(investmentAmounts(usdt,'USDT',fx,now).native, 67_080);
  assert.equal(investmentAmounts(usdt,'BTC',fx,now).native, 1.04);
  assert.equal(investmentAmounts(usdt,'BTC',fx,now).display, '1.04');
  // Display rounding must not change the position sized from the original input.
  const odd = {amount:'1,000', enteredUnit:'USDT', amountUnit:'BTC'};
  assert.equal(investmentAmounts(odd,'USDT',fx,now).native, 1_000);
  assert.equal(investmentAmounts(odd,'BTC',fx,now).native, 0.01550387);
  assert.equal(investmentAmounts({...odd,amountUnit:'USDT'},'USDT',fx,now).display, '1,000');
  assert.equal(investmentAmounts(btc,'USDT',{btcTime:now,btcUSDT:70_000},now).native, 72_800);
});

test('converted order budgets and displayed amounts agree without rounding up the spend', () => {
  const call = {amount:'120,000', enteredUnit:'USDT', amountUnit:'BTC'};
  const at = price => ({btcTime:now, btcUSDT:price});
  const buy = investmentAmounts(call,'BTC',at(79_500),now);
  assert.equal(buy.native,1.50943396);
  assert.equal(buy.display,'1.50943396');
  assert.ok(buy.native * 79_500 <= 120_000);
  const put = {amount:'0.123456789', enteredUnit:'BTC', amountUnit:'USDT'};
  const sized = investmentAmounts(put,'USDT',at(65_432.11),now);
  assert.equal(sized.native,8_078.038198);
  assert.equal(sized.display,'8,078.038198');
  assert.equal(investmentAmounts({...call,amount:'0.3'},'BTC',at(3),now).native,0.1);
});

test('missing conversion preserves manual amounts and suppresses stale or unavailable conversions', () => {
  const btc = {amount:'1.04', enteredUnit:'BTC', amountUnit:'BTC'};
  for (const input of [{}, {btcTime:now-30_000,btcUSDT:64_500}, {btcTime:now+2_001,btcUSDT:64_500}]) {
    const direct = investmentAmounts(btc,'BTC',input,now);
    assert.equal(direct.native,1.04);
    assert.equal(direct.missingRate,false);
    const cross = investmentAmounts(btc,'USDT',input,now);
    assert.equal(cross.display,'1.04');
    assert.equal(cross.missingRate,true);
    assert.ok(Number.isNaN(cross.native));
    const displayed = investmentAmounts({...btc,amountUnit:'USDT'},'BTC',input,now);
    assert.equal(displayed.display,'');
    assert.ok(Number.isNaN(displayed.native));
  }
  const otherVenues = {okx:{spot:64_200,indexCoin:'USD',indexTime:now},coinbase:{spot:64_300,indexCoin:'USDC',indexTime:now}};
  const noBtcUsdt = currentFx({venues:otherVenues},now);
  assert.equal(investmentAmounts(btc,'USDT',noBtcUsdt,now).missingRate,true);
  for (const amount of ['', '1,2', '0', '-1']) {
    assert.ok(Number.isNaN(investmentAmounts({...btc,amount},'BTC',fx,now).native));
  }
});

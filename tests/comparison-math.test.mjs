import assert from 'node:assert/strict';
import test from 'node:test';
import {calculateDualInsurance, calculateOptionInsurance, calculateLaterInsurance} from '../web/comparison-math.js';
import {deriveBinanceDualIncome} from '../web/binance-dual.js';
import {deriveBinanceHighDualIncome} from '../web/binance-high-dual.js';

const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 13, 8);
const expiry = now + 3 * DAY;

function inputs(direction) {
  const high = direction === 'CALL';
  const strike = 72_000;
  const symbol = 'BTC-261116-72000-' + (high ? 'C' : 'P');
  const product = {
    id: 'test-product', optionType: direction, investCoin: high ? 'BTC' : 'USDT',
    exercisedCoin: high ? 'USDT' : 'BTC', strikePrice: '72000', settleDate: expiry,
    apr: '0.853', duration: 2, canPurchase: true, minAmount: '0.001', maxAmount: '1000000',
    purchaseDecimal: null, purchaseEndTime: null
  };
  const amount = high ? 1 : 72_000;
  const raw = {
    status: 'ready', sourceType: 'public_web', currency: product.investCoin, product,
    eligibility: {precisionKnown: false, purchaseWindowKnown: false},
    serverTime: now, fetchedAt: now, receivedAt: now, snapshotAgeAtReceive: 0
  };
  const calculateIncome = high ? deriveBinanceHighDualIncome : deriveBinanceDualIncome;
  const dual = {...calculateIncome(amount, {strike, expires: expiry, settleCoin: raw.currency}, raw, now), quoteTime: now};
  const contract = {
    symbol, optionType: direction, settleCoin: 'USDT', underlying: 'BTCUSDT', status: 'TRADING',
    strike, expires: expiry, unit: 1, min: 0.01, step: 0.01, max: 1_000,
    taker: 0.00024, cap: 0.10, delivery: 0.00015, deliveryCap: 0.10
  };
  const book = {
    symbol, time: now, asks: [{price: 15, qty: 0.3}, {price: 25, qty: 0.7}, {price: 30, qty: 1}],
    bids: [{price: 10, qty: 10}]
  };
  const data = {
    amount: high ? null : amount, quantity: high ? amount : null, targetPrice: strike,
    selectedExpiry: expiry, market: {spot: 70_000, time: now, indexTime: now, receivedAt: now},
    row: {contract, book, receivedAt: now}
  };
  return {direction, data, dual, now};
}

for (const direction of ['CALL', 'PUT']) {
  test(direction + ' prices covered maturity proceeds from ask depth and publicly quoted dual income', () => {
    const args = inputs(direction);
    assert.equal(args.dual.valid, true);
    assert.equal(args.dual.periodRate, 0.0046);
    const q = calculateDualInsurance(args);
    assert.equal(q.valid, true, q.reason);
    assert.equal(q.targetBTC, 1.0046);
    assert.equal(q.coveredBTC, 1);
    assert.equal(q.uncoveredBTC, 0.0046);
    assert.equal(q.contracts, 1);
    assert.equal(q.premiumUSDT, 22);
    assert.equal(q.avgAsk, 22);
    assert.equal(q.openingFeeUSDT, 2.2);
    assert.equal(q.costUSDT, 24.2);
    assert.equal(q.levelsUsed, 2);
    const high = direction === 'CALL';
    assert.equal(q.capitalUSDT, high ? 70_000 : 72_000);
    const income = high ? 0.0046 * 70_000 : 331.2;
    assert.equal(q.dualIncomeUSDT, income);
    assert.equal(q.netIncomeUSDT, income - 24.2);
    assert.equal(q.term, (income - 24.2) / (q.capitalUSDT + 24.2));
    assert.equal(q.annual, q.term * 365 / 3);
    assert.equal(q.deliveryRate, 0.00015);
    assert.equal(q.deliveryCap, 0.1);
  });
}

test('an unaffordable insurance premium remains a negative yield', () => {
  const args = inputs('CALL');
  args.data.row.book.asks = [{price: 500, qty: 4}];
  const q = calculateDualInsurance(args);
  assert.equal(q.valid, true);
  assert.ok(q.netIncomeUSDT < 0 && q.term < 0 && q.annual < 0);
  assert.equal(q.openingFeeUSDT, 16.8);
});

test('minimum, contract step and maximum do not round coverage above maturity exposure', () => {
  const args = inputs('CALL');
  Object.assign(args.dual, {amount: 0.29, income: 0.01});
  args.data.quantity = 0.29;
  const q = calculateDualInsurance(args);
  assert.equal(q.contracts, 0.3);
  assert.equal(q.uncoveredBTC, 0);
  args.data.row.contract.min = 0.31;
  assert.equal(calculateDualInsurance(args).valid, false);
  Object.assign(args.data.row.contract, {min: 0.01, max: 0.29});
  assert.equal(calculateDualInsurance(args).valid, false);
});

test('multi-level cost uses per-fill fee caps and a non-unit contract multiplier', () => {
  const args = inputs('CALL');
  Object.assign(args.data.row.contract, {unit: 0.1});
  args.data.row.book.asks = [{price: 10, qty: 6}, {price: 100, qty: 30}];
  args.data.row.book.bids = [];
  const q = calculateDualInsurance(args);
  assert.equal(q.contracts, 10.04);
  assert.equal(q.coveredBTC, 1.004);
  assert.equal(q.uncoveredBTC, 0.0006);
  assert.ok(Math.abs(q.openingFeeUSDT - (6 + 4.04 * 1.68)) < 1e-12);
});

test('a missing or stale source, expired quote, crossed book or insufficient ask depth suppresses the package', () => {
  for (const mutate of [
    a => { a.dual.valid = false; }, a => { a.now += 30_000; },
    a => { a.dual.rateExpiry = now; }, a => { a.data.market.indexTime -= 30_000; },
    a => { a.data.row.book.time += 3_000; }, a => { a.dual.quoteTime -= 29_000; a.data.row.book.time += 1_000; },
    a => { a.data.row.book.bids[0].price = 15; }, a => { a.data.row.book.asks.length = 1; },
    a => { a.data.row.book.asks.length = 0; }, a => { a.data.row.contract.deliveryCap = null; },
    a => { a.data.selectedExpiry += DAY; }, a => { a.dual.product.exercisedCoin = 'USDC'; },
    a => { a.data.row.book.symbol = 'BTC-261116-72000-P'; }, a => { a.dual.product.strikePrice = '72500'; }
  ]) {
    const args = inputs('CALL');
    mutate(args);
    const bad = calculateDualInsurance(args);
    assert.equal(bad.valid, false, mutate.toString());
    assert.ok(bad.reason);
    assert.equal(bad.netIncomeUSDT, undefined);
  }
});

function spreadInputs(direction) {
  const args = inputs(direction);
  const high = direction === 'CALL';
  const short = args.data.row.contract;
  const strike = high ? 74_000 : 70_000;
  args.data.row.quote = {
    valid: true, q: 1, amount: high ? 70_000 : 72_000, netIncome: 89,
    conditional: true, strike: short.strike, expires: short.expires, quoteTime: now
  };
  const symbol = 'BTC-261116-' + strike + (high ? '-C' : '-P');
  args.protectionContract = {...short, symbol, strike};
  args.protectionBook = {...args.data.row.book, symbol};
  return args;
}

for (const direction of ['CALL', 'PUT']) {
  test(direction + ' protected short keeps exact matched size and subtracts both quoted costs', () => {
    const q = calculateOptionInsurance(spreadInputs(direction));
    assert.equal(q.valid, true, q.reason);
    assert.equal(q.coveredBTC, 1);
    assert.equal(q.contracts, 1);
    assert.equal(q.premiumUSDT, 22);
    assert.equal(q.openingFeeUSDT, 2.2);
    assert.equal(q.netIncomeUSDT, 64.8);
    assert.equal(q.maxExpiryPnlUSDT, 64.8);
    assert.equal(q.maxExpiryLossUSDT, 1_935.2);
    assert.equal(q.strikeWidth, 2_000);
    assert.equal(q.conditional, true);
    assert.equal(q.term, 64.8 / (q.capitalUSDT + 24.2));
  });
}

test('same contract offsets, adjacent maturity cannot be substituted, entire short must be covered', () => {
  const same = spreadInputs('CALL');
  same.protectionContract = same.data.row.contract;
  const offset = calculateOptionInsurance(same);
  assert.equal(offset.offsetting, true);
  assert.equal(offset.valid, false);
  for (const mutate of [
    a => { a.protectionContract.expires += DAY; },
    a => { a.protectionContract.optionType = 'PUT'; },
    a => { a.protectionContract.strike = 70_000; },
    a => { a.protectionBook.symbol = 'BTC-261116-74000-P'; },
    a => { a.protectionBook.time -= 30_000; },
    a => { a.protectionBook.asks = []; },
    a => { a.data.row.quote.q = 1.005; },
    a => { a.data.row.book.symbol = 'BTC-261116-72500-C'; },
    a => { a.data.row.quote.valid = false; },
    a => { a.data.row.quote.strike = 73_000; }
  ]) {
    const args = spreadInputs('CALL');
    mutate(args);
    assert.equal(calculateOptionInsurance(args).valid, false, mutate.toString());
  }
});

test('expensive upside protection can turn the best expiry outcome into a net loss', () => {
  const args = spreadInputs('CALL');
  args.protectionBook.asks = [{price: 500, qty: 2}];
  const q = calculateOptionInsurance(args);
  assert.equal(q.valid, true);
  assert.ok(Math.abs(q.maxExpiryPnlUSDT + 427.8) < 1e-10);
  assert.ok(Math.abs(q.maxExpiryLossUSDT - 2_427.8) < 1e-10);
});

function laterInputs(direction, source) {
  const args = spreadInputs(direction);
  args.source = source;
  const strike = args.data.targetPrice;
  const symbol = 'BTC-261117-72000-' + (direction === 'CALL' ? 'C' : 'P');
  Object.assign(args.protectionContract, {strike, symbol, expires: expiry + DAY});
  args.protectionBook.symbol = symbol;
  return args;
}

for (const direction of ['CALL', 'PUT']) {
  for (const source of ['dual', 'option']) {
    test(direction + ' later protection of ' + source + ' provides cost and exposure without first-expiry result', () => {
      const args = laterInputs(direction, source);
      if (source === 'dual') args.data.row = null;
      const q = calculateLaterInsurance(args);
      assert.equal(q.valid, true, q.reason);
      assert.equal(q.baseExpiry, expiry);
      assert.equal(q.expires, expiry + DAY);
      assert.equal(q.strike, 72_000);
      assert.equal(q.coveredBTC, 1);
      assert.equal(q.uncoveredBTC, source === 'dual' ? 0.0046 : 0);
      assert.equal(q.costUSDT, 24.2);
      assert.equal(q.baseIncomeUSDT, source === 'option' ? 89 : args.dual.income * (direction === 'CALL' ? 70_000 : 1));
      assert.equal(q.initialNetUSDT, q.baseIncomeUSDT - q.costUSDT);
      assert.equal(q.conditional, source === 'option');
      for (const field of ['annual', 'term', 'maxExpiryLossUSDT', 'maxExpiryPnlUSDT', 'firstExpiryPnlUSDT']) {
        assert.equal(q[field], undefined);
      }
    });
  }
}

test('later protection enforces base and protection dates, quantity, direction, book identity and age', () => {
  for (const mutate of [
    a => { a.protectionContract.expires = expiry; },
    a => { a.protectionContract.expires = expiry - DAY; },
    a => { a.protectionContract.expires += 1; },
    a => { a.protectionContract.strike += 1_000; },
    a => { a.protectionContract.optionType = 'PUT'; },
    a => { a.protectionBook.symbol = 'BTC-261115-72000-C'; },
    a => { a.protectionContract.symbol = a.protectionBook.symbol = 'BTC-261119-72000-C'; },
    a => { a.protectionBook.time -= 30_000; },
    a => { a.protectionBook.asks.length = 1; },
    a => { a.source = 'option'; a.data.row.quote.q = 1.005; },
    a => { a.source = 'option'; a.data.row.quote.quoteTime -= 30_000; },
    a => { a.source = 'option'; a.data.row.contract.symbol = a.data.row.book.symbol = 'BTC-261115-72000-C'; },
    a => { a.dual.product.strikePrice = '73000'; }, a => { a.dual.quoteTime -= 30_000; },
    a => { a.dual.amount = 3; }, a => { a.data.market = null; }, a => { a.source = 'other'; }
  ]) {
    const args = laterInputs('CALL', 'dual');
    mutate(args);
    const q = calculateLaterInsurance(args);
    assert.equal(q.valid, false, mutate.toString());
    assert.equal(q.initialNetUSDT, undefined);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createBybitExecution, BybitExecution, signV5 } from './execution/bybit.mjs';

const T = Date.UTC(2026, 9, 22, 12);
const KEY = 'mock-key-never-real', SECRET = 'mock-secret-never-real';
const SYMBOL = 'BTC-6NOV26-80000-P-USDT';
const json = (result = {}, extra = {}, status = 200) => new Response(JSON.stringify({ retCode: 0, result, time: T, ...extra }), { status, headers: { 'Content-Type': 'application/json' } });
function mockAdapter(handler, options = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (new URL(url).pathname === '/v5/market/time') return json({ timeNano: `${T}000000`, timeSecond: `${T / 1000}` });
    return handler(url, init);
  };
  return { api: createBybitExecution({ apiKey: KEY, apiSecret: SECRET, fetchImpl, now: () => T, ...options }), calls };
}
function putFixture() {
  const order = { symbol: SYMBOL, qty: '0.10', price: '500', orderLinkId: 'put-order-1' };
  const spec = { validated: true, category: 'option', symbol: SYMBOL, status: 'Trading', baseCoin: 'BTC', quoteCoin: 'USDT', settleCoin: 'USDT', optionsType: 'Put', strike: '80000', deliveryTime: String(T + 86400000), priceFilter: { tickSize: '5', minPrice: '5', maxPrice: '1000000' }, lotSizeFilter: { qtyStep: '0.01', minOrderQty: '0.01', maxOrderQty: '100' } };
  const confirmedIntent = { confirmed: true, intentId: 'intent-put-1', action: 'sell_put', category: 'option', symbol: SYMBOL, side: 'Sell', orderType: 'Limit', timeInForce: 'IOC', ...order, expiresAt: T + 20000, maxFunds: '8010', feeReserve: '10', strike: '80000' };
  return { order, options: { spec, confirmedIntent } };
}
function spotFixture() {
  const order = { symbol: 'BTCUSDT', qty: '0.1', price: '80000', orderLinkId: 'spot-order-1' };
  const spec = { validated: true, category: 'spot', symbol: 'BTCUSDT', status: 'Trading', baseCoin: 'BTC', quoteCoin: 'USDT', priceFilter: { tickSize: '0.1' }, lotSizeFilter: { basePrecision: '0.000001', minOrderAmt: '5', maxOrderAmt: '1000000', maxLimitOrderQty: '100' } };
  const confirmedIntent = { confirmed: true, intentId: 'intent-spot-1', action: 'spot_buy', category: 'spot', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Limit', timeInForce: 'IOC', ...order, isLeverage: 0, expiresAt: T + 20000, maxFunds: '8010', feeReserve: '10' };
  return { order, options: { spec, confirmedIntent } };
}
const ack = (_url, init) => { const p = JSON.parse(init.body); return json({ orderId: 'order-123', orderLinkId: p.orderLinkId, apiKey: 'must-strip' }); };

test('live defaults off, credentials are never read, and arbitrary hosts are refused', async () => {
  let called = 0;
  const api = new BybitExecution({ fetchImpl: () => { called++; throw new Error('unexpected'); } });
  const f = putFixture();
  assert.equal((await api.createSellPut(f.order, f.options)).error.code, 'live_disabled');
  assert.equal((await api.getApiInfo()).error.code, 'authorization_required');
  assert.equal(called, 0);
  assert.equal('withdraw' in api, false);
  assert.equal('transfer' in api, false);
  assert.throws(() => createBybitExecution({ baseUrl: 'https://example.com' }));
  assert.throws(() => createBybitExecution({ baseUrl: 'https://api.bybit.com/evil' }));
});

test('calibrated signed GET uses exact query bytes and strips key, UID and KYC fields', async () => {
  const { api, calls } = mockAdapter(() => json({ isMaster: false, readOnly: 0, apiKey: KEY, secret: SECRET, userID: 7, kycRegion: 'secret', permissions: { Options: ['OptionsTrade'], Spot: ['SpotTrade'], Wallet: [], arbitrary: ['account-secret'] } }));
  const result = await api.getApiInfo();
  assert.deepEqual(Object.keys(result.data).sort(), ['isMaster', 'permissions', 'readOnly', 'unsafePermissions']);
  assert.equal(result.data.unsafePermissions, true);
  assert.equal(JSON.stringify(result).includes(KEY), false);
  assert.equal(JSON.stringify(result).includes('account-secret'), false);
  assert.equal(calls[0].init.headers['X-BAPI-API-KEY'], undefined);
  const request = calls[1];
  assert.equal(request.url, 'https://api.bybit.com/v5/user/query-api');
  assert.equal(request.init.headers['X-BAPI-SIGN'], createHmac('sha256', SECRET).update(`${T}${KEY}5000`).digest('hex'));
  assert.equal(request.init.redirect, 'manual');
  assert.equal(request.init.credentials, 'omit');
  assert.equal(signV5({ apiKey: KEY, apiSecret: SECRET, timestamp: T, payload: '' }), request.init.headers['X-BAPI-SIGN']);
});

test('clock offset comes from server midpoint; old calibration is refreshed before signing', async () => {
  let local = T - 1000, syncs = 0, signedAt;
  const api = createBybitExecution({ apiKey: KEY, apiSecret: SECRET, now: () => local, fetchImpl: async (url, init) => {
    if (url.endsWith('/v5/market/time')) { syncs++; local += 100; return json({}); }
    signedAt = Number(init.headers['X-BAPI-TIMESTAMP']);
    return json({ marginMode: 'REGULAR_MARGIN', unifiedMarginStatus: 6 });
  } });
  assert.equal((await api.getAccountInfo()).ok, true);
  assert.equal(signedAt, T + 50);
  local += 31000;
  await api.getAccountInfo();
  assert.equal(syncs, 2);
});

test('readonly route and parameter allowlist rejects injected URLs, headers and impossible categories', async () => {
  const { api, calls } = mockAdapter(() => json({ category: 'option', nextPageCursor: '', list: [] }));
  for (const params of [{ category: 'option', url: 'https://evil.test' }, { category: 'option', headers: {} }, { category: 'wallet' }, { category: 'linear' }, { category: 'option', limit: 1000 }]) {
    assert.equal((await api.getPositions(params)).error.code, 'invalid_parameters');
  }
  assert.equal(calls.length, 0);
  assert.equal((await api.getOrders({ category: 'option', orderLinkId: 'put-1', cursor: 'x%3Ay' })).ok, true);
  const req = calls.at(-1), query = new URL(req.url).search.slice(1);
  assert.equal(new URL(req.url).pathname, '/v5/order/realtime');
  assert.equal(new URL(req.url).searchParams.get('cursor'), 'x%3Ay');
  assert.equal(req.init.headers['X-BAPI-SIGN'], signV5({ apiKey: KEY, apiSecret: SECRET, timestamp: T, payload: query }));
});

test('order history, executions and delivery proof preserve actual data with whitelisted fields', async () => {
  const { api, calls } = mockAdapter(url => {
    const path = new URL(url).pathname;
    const row = path.includes('execution') ? { symbol: SYMBOL, orderId: 'o1', execId: 'e1', execQty: '0.03', execPrice: '500', execTime: String(T), execFee: '0.1', feeCurrency: 'USDT', execType: 'Trade' }
      : path.includes('delivery') ? { symbol: SYMBOL, side: 'Sell', position: '0.03', deliveryTime: T, deliveryPrice: '79000', strike: '80000', fee: '0.5', deliveryRpl: '-30' }
      : { symbol: SYMBOL, orderId: 'o1', orderStatus: 'Cancelled', cumExecQty: '0.03', qty: '0.1', cumFeeDetail: { USDT: '0.1' } };
    return json({ category: 'option', nextPageCursor: 'next-1', list: [{ ...row, userID: 'private', apiKey: KEY, unknown: { secret: SECRET } }] });
  });
  const order = await api.getOrderHistory({ category: 'option', orderLinkId: 'put-1' });
  assert.equal(order.data.list[0].orderStatus, 'Cancelled');
  assert.equal(order.data.list[0].cumExecQty, '0.03');
  const execution = await api.getExecutions({ category: 'option', orderLinkId: 'put-1' });
  assert.equal(execution.data.list[0].execQty, '0.03');
  const delivery = await api.getDeliveryRecords({ category: 'option', symbol: SYMBOL });
  assert.equal(delivery.data.list[0].deliveryPrice, '79000');
  assert.equal(delivery.data.list[0].position, '0.03');
  assert.equal(delivery.data.nextPageCursor, 'next-1');
  for (const result of [order, execution, delivery]) assert.equal(JSON.stringify(result).includes('private'), false);
  assert.deepEqual(calls.slice(1).map(c => new URL(c.url).pathname), ['/v5/order/history', '/v5/execution/list', '/v5/asset/delivery-record']);
});

test('valid PUT is exactly BTC USDT Sell Limit IOC, signed once, and ACK is never treated as filled', async () => {
  const { api, calls } = mockAdapter(ack, { liveEnabled: true });
  const f = putFixture(), result = await api.createSellPut(f.order, f.options);
  assert.equal(result.status, 'accepted');
  assert.deepEqual(result.data, { orderId: 'order-123', orderLinkId: 'put-order-1' });
  const req = calls.at(-1), body = JSON.parse(req.init.body);
  assert.deepEqual(body, { category: 'option', symbol: SYMBOL, side: 'Sell', orderType: 'Limit', timeInForce: 'IOC', qty: '0.10', price: '500', orderLinkId: 'put-order-1' });
  assert.equal(req.init.headers['X-BAPI-SIGN'], signV5({ apiKey: KEY, apiSecret: SECRET, timestamp: T, payload: req.init.body }));
  assert.equal((await api.createSellPut(f.order, f.options)).error.code, 'intent_already_attempted');
  assert.equal(calls.filter(c => c.init.method === 'POST').length, 1);
});

test('missing confirmation, mismatched scope, CALL/USDC/expiry and unvalidated specs cannot submit', async () => {
  const changes = [
    f => { f.options.confirmedIntent.confirmed = false; },
    f => { f.options.confirmedIntent.side = 'Buy'; },
    f => { f.options.confirmedIntent.timeInForce = 'GTC'; },
    f => { f.options.confirmedIntent.qty = '0.11'; },
    f => { f.options.confirmedIntent.expiresAt = T; },
    f => { f.options.confirmedIntent.expiresAt = T + 60001; },
    f => { f.options.spec.validated = false; },
    f => { f.options.spec.optionsType = 'Call'; },
    f => { f.options.spec.settleCoin = 'USDC'; },
    f => { f.options.spec.deliveryTime = T; },
    f => { f.options.spec.strike = '81000'; },
    f => { f.order.isLeverage = 1; },
  ];
  for (const change of changes) {
    const { api, calls } = mockAdapter(ack, { liveEnabled: true });
    const f = putFixture(); change(f);
    assert.equal((await api.createSellPut(f.order, f.options)).error.code, 'invalid_intent');
    assert.equal(calls.some(c => c.init.method === 'POST'), false);
  }
});

test('step, tick, minimum, nonfinite decimals and full strike funding are enforced without float rounding', async () => {
  const changes = [
    f => { f.order.qty = f.options.confirmedIntent.qty = '0.015'; },
    f => { f.order.qty = f.options.confirmedIntent.qty = '0.001'; },
    f => { f.order.price = f.options.confirmedIntent.price = '501'; },
    f => { f.order.qty = f.options.confirmedIntent.qty = 'Infinity'; },
    f => { f.options.spec.lotSizeFilter.qtyStep = undefined; },
    f => { f.options.confirmedIntent.maxFunds = '8009.999999999999999999'; },
    f => { f.options.confirmedIntent.feeReserve = undefined; },
  ];
  for (const change of changes) {
    const { api, calls } = mockAdapter(ack, { liveEnabled: true });
    const f = putFixture(); change(f);
    assert.equal((await api.createSellPut(f.order, f.options)).ok, false);
    assert.equal(calls.some(c => c.init.method === 'POST'), false);
  }
});

test('spot order requires BTCUSDT, base precision and amount limits; it always disables borrowing', async () => {
  const { api, calls } = mockAdapter(ack, { liveEnabled: true });
  const f = spotFixture();
  assert.equal((await api.createSpotBuy(f.order, f.options)).status, 'accepted');
  const body = JSON.parse(calls.at(-1).init.body);
  assert.equal(body.isLeverage, 0);
  assert.equal(body.side, 'Buy');
  assert.equal(body.category, 'spot');
  assert.equal(body.timeInForce, 'IOC');
  const mutations = [
    f => { f.options.confirmedIntent.isLeverage = 1; },
    f => { f.options.spec.lotSizeFilter.minOrderAmt = '9000'; },
    f => { f.options.spec.lotSizeFilter.maxOrderAmt = '7000'; },
    f => { f.options.spec.lotSizeFilter.basePrecision = undefined; },
    f => { f.order.qty = f.options.confirmedIntent.qty = '0.1000001'; },
    f => { f.options.confirmedIntent.maxFunds = '8000'; },
  ];
  for (const change of mutations) {
    const run = mockAdapter(ack, { liveEnabled: true }), f = spotFixture(); change(f);
    assert.equal((await run.api.createSpotBuy(f.order, f.options)).ok, false);
    assert.equal(run.calls.some(c => c.init.method === 'POST'), false);
  }
});

test('POST timeout is unknown, is not retried, and blocks a fresh intent until external reconciliation', async () => {
  let aborted = false;
  const { api, calls } = mockAdapter((_url, init) => new Promise(() => { init.signal.addEventListener('abort', () => { aborted = true; }); }), { liveEnabled: true, timeoutMs: 15 });
  const f = putFixture(), result = await api.createSellPut(f.order, f.options);
  assert.equal(result.status, 'unknown');
  assert.equal(result.error.code, 'timeout');
  assert.equal(aborted, true);
  const next = putFixture(); next.order.orderLinkId = next.options.confirmedIntent.orderLinkId = 'different-order'; next.options.confirmedIntent.intentId = 'different-intent';
  assert.equal((await api.createSellPut(next.order, next.options)).error.code, 'reconciliation_required');
  assert.equal(calls.filter(c => c.init.method === 'POST').length, 1);
  assert.equal(api.getExecutionState().attempts[0].status, 'unknown');
});

test('ambiguous ACK, duplicate-id and exchange timeout all require reconciliation', async () => {
  for (const handler of [() => json({ orderId: 'order-123', orderLinkId: 'wrong' }), () => json({}, { retCode: 10014 }), () => json({}, { retCode: 10000 })]) {
    const { api } = mockAdapter(handler, { liveEnabled: true });
    const f = putFixture(), result = await api.createSellPut(f.order, f.options);
    assert.equal(result.error.unknown, true);
    assert.equal(api.getExecutionState().reconciliationRequired, true);
  }
});

test('two concurrent confirmations cannot send simultaneous orders', async () => {
  let release;
  const { api, calls } = mockAdapter((_url, init) => new Promise(resolve => { release = () => resolve(ack(_url, init)); }), { liveEnabled: true });
  await api.syncTime();
  const first = putFixture(), second = putFixture();
  second.order.orderLinkId = second.options.confirmedIntent.orderLinkId = 'second-order';
  second.options.confirmedIntent.intentId = 'second-intent';
  const pending = api.createSellPut(first.order, first.options);
  const duplicate = await api.createSellPut(second.order, second.options);
  assert.equal(duplicate.error.code, 'order_in_flight');
  assert.equal(calls.filter(c => c.init.method === 'POST').length, 1);
  release();
  assert.equal((await pending).status, 'accepted');
});

test('missing cursor/category and incomplete settlement records are never proof of an empty or settled account', async () => {
  for (const result of [
    { category: 'option', list: [] },
    { category: 'spot', nextPageCursor: '', list: [] },
    { category: 'option', nextPageCursor: '', list: [{ symbol: SYMBOL, side: 'Sell', position: '0.1' }] },
  ]) {
    const { api } = mockAdapter(() => json(result));
    assert.equal((await api.getDeliveryRecords({ category: 'option', symbol: SYMBOL })).error.code, 'invalid_response');
  }
});

test('authentication errors never expose retMsg, response bodies, credentials or location headers', async () => {
  const { api } = mockAdapter(() => json({}, { retCode: 10004, retMsg: `${KEY} ${SECRET} private-account` }, 400));
  const result = await api.getApiInfo();
  assert.equal(result.error.code, 'authorization_required');
  assert.equal(result.exchangeCode, 10004);
  assert.equal(JSON.stringify(result).includes(KEY), false);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(JSON.stringify(result).includes('private-account'), false);
});

test('redirects, HTML, malformed JSON and missing private schemas fail closed', async () => {
  const responses = [
    () => new Response(null, { status: 302, headers: { location: 'https://other.test/key' } }),
    () => new Response(`<html>${KEY}</html>`, { status: 403, headers: { 'Content-Type': 'text/html' } }),
    () => new Response('{broken', { headers: { 'Content-Type': 'application/json' } }),
    () => json({ readOnly: 0, permissions: {} }),
  ];
  for (const handler of responses) {
    const { api, calls } = mockAdapter(handler);
    const result = await api.getApiInfo();
    assert.equal(result.ok, false);
    assert.equal(calls.length, 2);
    assert.equal(JSON.stringify(result).includes(KEY), false);
    assert.equal(calls.at(-1).init.redirect, 'manual');
  }
});

test('entire response body has a deadline and signed GET timeouts never become fill evidence', async () => {
  const { api } = mockAdapter(() => new Response(new ReadableStream({ start() {} }), { headers: { 'Content-Type': 'application/json' } }), { timeoutMs: 15 });
  const result = await api.getOrders({ category: 'option' });
  assert.equal(result.error.code, 'timeout');
  assert.equal(result.error.unknown, false);
  assert.equal(result.data, undefined);
});

test('oversized private JSON is rejected before parsing or exposing data', async () => {
  const { api } = mockAdapter(() => new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '1048577' } }));
  assert.equal((await api.getApiInfo()).error.code, 'invalid_response');
});

test('account fee queries are fixed to BTC option or BTCUSDT spot, with real decimal rates and no invented cursor', async () => {
  const { api, calls } = mockAdapter(url => {
    const category = new URL(url).searchParams.get('category');
    return json({ category, list: [{ symbol: category === 'spot' ? 'BTCUSDT' : '', ...(category === 'option' ? { baseCoin: 'BTC' } : {}), makerFeeRate: '-0.00001', takerFeeRate: '0.0008', apiKey: KEY, userID: 88 }] });
  });
  const spot = await api.getFeeRates({ category: 'spot', symbol: 'BTCUSDT' });
  assert.equal(spot.data.list[0].takerFeeRate, '0.0008');
  assert.equal('nextPageCursor' in spot.data, false);
  assert.equal(JSON.stringify(spot).includes(KEY), false);
  const option = await api.getFeeRates({ category: 'option', baseCoin: 'BTC' });
  assert.equal(option.data.list[0].baseCoin, 'BTC');
  assert.equal(option.data.list[0].makerFeeRate, '-0.00001');
  const before = calls.length;
  for (const params of [{ category: 'linear', symbol: 'BTCUSDT' }, { category: 'spot', symbol: 'ETHUSDT' }, { category: 'option', baseCoin: 'ETH' }, { category: 'option', baseCoin: 'BTC', symbol: 'BTCUSDT' }, { category: 'spot' }]) assert.equal((await api.getFeeRates(params)).error.code, 'invalid_parameters');
  assert.equal(calls.length, before);
  assert.equal(new URL(calls.at(-1).url).pathname, '/v5/account/fee-rate');
});

test('fee rates missing, nondecimal, negative taker or from another symbol cannot default to a fee estimate', async () => {
  for (const row of [
    { symbol: 'BTCUSDT', makerFeeRate: '0' },
    { symbol: 'BTCUSDT', makerFeeRate: '0', takerFeeRate: '-0.001' },
    { symbol: 'BTCUSDT', makerFeeRate: '0', takerFeeRate: 'Infinity' },
    { symbol: 'BTCUSDT', makerFeeRate: '0', takerFeeRate: 0.001 },
    { symbol: 'ETHUSDT', makerFeeRate: '0', takerFeeRate: '0.001' },
  ]) {
    const { api } = mockAdapter(() => json({ category: 'spot', list: [row] }));
    assert.equal((await api.getFeeRates({ category: 'spot', symbol: 'BTCUSDT' })).error.code, 'invalid_response');
  }
  const { api } = mockAdapter(() => json({ category: 'spot', list: [{ symbol: 'BTCUSDT', makerFeeRate: '0', takerFeeRate: '0' }] }));
  assert.equal((await api.getFeeRates({ category: 'spot', symbol: 'BTCUSDT' })).data.list[0].takerFeeRate, '0');
});

function reconciledOrder(overrides = {}) {
  return { symbol: SYMBOL, orderId: 'original-order', orderLinkId: 'put-order-1', side: 'Sell', orderType: 'Limit', timeInForce: 'IOC', price: '500', qty: '0.1', cumExecQty: '0.03', orderStatus: 'Cancelled', createdTime: String(T), ...overrides };
}
function reconciledFill(id = 'fill1', qty = '0.03', overrides = {}) {
  return { symbol: SYMBOL, orderId: 'original-order', orderLinkId: 'put-order-1', side: 'Sell', execId: id, execQty: qty, execPrice: '500', execFee: '0.01', feeCurrency: 'USDT', execType: 'Trade', execTime: String(T), ...overrides };
}
function unknownAdapter(responder) {
  return mockAdapter((url, init) => init.method === 'POST' ? json({}, { retCode: 10000 }) : responder(new URL(url), init), { liveEnabled: true });
}
async function markUnknown(api) {
  const f = putFixture();
  assert.equal((await api.createSellPut(f.order, f.options)).status, 'unknown');
  return f;
}
const reconcileParams = () => ({ category: 'option', symbol: SYMBOL, orderLinkId: 'put-order-1' });

test('unknown recovery reads realtime/history and ALL execution pages, then permits progress but never reuses the attempted intent', async () => {
  const { api, calls } = unknownAdapter(url => {
    if (url.pathname === '/v5/execution/list') {
      const second = url.searchParams.get('cursor') === 'page-2';
      return json({ category: 'option', nextPageCursor: second ? '' : 'page-2', list: [reconciledFill(second ? 'fill2' : 'fill1', second ? '0.02' : '0.01')] });
    }
    return json({ category: 'option', nextPageCursor: '', list: [reconciledOrder()] });
  });
  const f = await markUnknown(api), result = await api.reconcileUnknownOrder(reconcileParams());
  assert.equal(result.status, 'reconciled');
  assert.equal(result.data.filledQty, '0.03');
  assert.equal(result.data.executions.length, 2);
  assert.equal(api.getExecutionState().reconciliationRequired, false);
  assert.equal((await api.createSellPut(f.order, f.options)).error.code, 'intent_already_attempted');
  assert.equal(calls.filter(c => c.init.method === 'POST').length, 1);
  assert.deepEqual(calls.slice(2).map(c => new URL(c.url).pathname), ['/v5/order/realtime', '/v5/order/history', '/v5/execution/list', '/v5/execution/list']);
  assert.equal((await api.reconcileUnknownOrder(reconcileParams())).error.code, 'unknown_order_not_tracked');
});

test('zero-fill cancelled unknown can recover only after a terminal original order is actually found', async () => {
  const { api } = unknownAdapter(url => json({ category: 'option', nextPageCursor: '', list: url.pathname === '/v5/order/history' ? [reconciledOrder({ cumExecQty: '0' })] : [] }));
  await markUnknown(api);
  const result = await api.reconcileUnknownOrder(reconcileParams());
  assert.equal(result.ok, true);
  assert.equal(result.data.filledQty, '0');
  assert.deepEqual(result.data.executions, []);
});

test('caller cannot unlock an unrelated, mismatched, merely accepted or untracked order by supplying a boolean', async () => {
  const { api, calls } = unknownAdapter(() => { throw new Error('should not query'); });
  await markUnknown(api);
  const count = calls.length;
  for (const params of [{ ...reconcileParams(), confirmed: true }, { ...reconcileParams(), orderLinkId: 'other' }, { ...reconcileParams(), symbol: 'BTCUSDT' }, { ...reconcileParams(), category: 'spot' }]) assert.equal((await api.reconcileUnknownOrder(params)).ok, false);
  assert.equal(calls.length, count);
  assert.equal(api.getExecutionState().reconciliationRequired, true);
  const accepted = mockAdapter(ack, { liveEnabled: true }), f = putFixture();
  await accepted.api.createSellPut(f.order, f.options);
  assert.equal((await accepted.api.reconcileUnknownOrder(reconcileParams())).error.code, 'unknown_order_not_tracked');
});

test('unknown remains blocked for missing orders, active state, conflicting identities, old records or wrong filled quantity', async () => {
  const mutations = [
    () => [],
    () => [reconciledOrder({ orderStatus: 'New' })],
    () => [reconciledOrder({ orderLinkId: 'another-link' })],
    () => [reconciledOrder({ createdTime: String(T - 86400000) })],
    () => [reconciledOrder({ cumExecQty: '0.04' })],
    () => [reconciledOrder({ orderStatus: 'Filled', cumExecQty: '0.03' })],
  ];
  for (const orders of mutations) {
    const { api } = unknownAdapter(url => json({ category: 'option', nextPageCursor: '', list: url.pathname === '/v5/execution/list' ? [reconciledFill()] : orders() }));
    await markUnknown(api);
    assert.equal((await api.reconcileUnknownOrder(reconcileParams())).error.code, 'reconciliation_incomplete');
    assert.equal(api.getExecutionState().reconciliationRequired, true);
  }
});

test('unknown reconciliation rejects unrelated fills, repeated pagination and contradictory duplicate executions', async () => {
  const mutations = [
    () => ({ nextPageCursor: '', list: [reconciledFill('fill1', '0.03', { orderId: 'other-order' })] }),
    () => ({ nextPageCursor: '', list: [reconciledFill('fill1', '0.03', { side: 'Buy' })] }),
    () => ({ nextPageCursor: '', list: [reconciledFill('fill1', '0.03', { execPrice: '495' })] }),
    () => ({ nextPageCursor: 'repeat', list: [reconciledFill()] }),
    () => ({ nextPageCursor: '', list: [reconciledFill('fill1', '0.01'), reconciledFill('fill1', '0.02')] }),
  ];
  for (const execution of mutations) {
    const { api } = unknownAdapter(url => json({ category: 'option', ...(url.pathname === '/v5/execution/list' ? execution() : { nextPageCursor: '', list: [reconciledOrder()] }) }));
    await markUnknown(api);
    assert.equal((await api.reconcileUnknownOrder(reconcileParams())).ok, false);
    assert.equal(api.getExecutionState().reconciliationRequired, true);
  }
});

test('a failed private reconciliation read cannot unlock an unknown POST', async () => {
  const { api } = unknownAdapter(() => json({}, { retCode: 10004 }));
  await markUnknown(api);
  assert.equal((await api.reconcileUnknownOrder(reconcileParams())).error.unknown, true);
  assert.equal(api.getExecutionState().reconciliationRequired, true);
});

test('unknown wallet permissions and unknown nonempty scopes remain visibly unsafe without exposing their values', async () => {
  for (const permissions of [{ Wallet: ['Transfer'] }, { NewWalletScope: ['SecretTransferScope'] }, { Spot: ['SpotTrade', 'UnrecognizedTrade'] }]) {
    const { api } = mockAdapter(() => json({ isMaster: false, readOnly: 0, permissions }));
    const result = await api.getApiInfo();
    assert.equal(result.ok, true);
    assert.equal(result.data.unsafePermissions, true);
    assert.equal(JSON.stringify(result.data.permissions).includes('Transfer'), false);
    assert.equal(JSON.stringify(result.data).includes('SecretTransferScope'), false);
    assert.equal(JSON.stringify(result.data).includes('UnrecognizedTrade'), false);
  }
});

test('empty unrecognized scopes are harmless but malformed permission containers fail closed', async () => {
  const safe = mockAdapter(() => json({ isMaster: false, readOnly: 0, permissions: { Spot: ['SpotTrade'], Options: ['OptionsTrade'], Wallet: [], FutureEmptyScope: [] } }));
  assert.equal((await safe.api.getApiInfo()).data.unsafePermissions, false);
  for (const permissions of [{ Wallet: 'Transfer' }, { NewScope: {} }, { NewScope: [9] }]) {
    const { api } = mockAdapter(() => json({ isMaster: false, readOnly: 0, permissions }));
    assert.equal((await api.getApiInfo()).error.code, 'invalid_response');
  }
});

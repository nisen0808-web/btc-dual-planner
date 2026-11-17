import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeribitExecution, DeribitExecution } from './execution/deribit.mjs';

const T = Date.UTC(2026, 9, 23, 8), CLIENT = 'mock-client', SECRET = 'mock-secret', TOKEN = 'ephemeral-mock-token';
const SYMBOL = 'BTC_USDC-6NOV26-80000-P';
const response = (request, result, extra = {}, status = 200) => new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result, usOut: T * 1000, ...extra }), { status, headers: { 'Content-Type': 'application/json' } });
function setup(handler = () => [], options = {}) {
  const calls = [];
  const api = createDeribitExecution({ clientId: CLIENT, clientSecret: SECRET, liveEnabled: true, now: () => T, ...options, fetchImpl: async (url, init) => {
    const request = JSON.parse(init.body); calls.push({ url, init, request });
    if (request.method === 'public/auth') return response(request, { access_token: TOKEN, refresh_token: 'not-returned', expires_in: 600, token_type: 'bearer', scope: `connection ${request.params.scope}` });
    if (request.method === 'public/time') return response(request, T);
    if (request.method === 'private/list_api_keys') return response(request, [{ client_id: CLIENT, client_secret: SECRET, enabled: true, max_scope: ['account:read', 'trade:read_write', 'wallet:none', 'block_trade:none'] }, { client_id: 'someone-else', client_secret: 'other-secret', enabled: true, max_scope: ['wallet:read_write'] }]);
    const result = await handler(request, init);
    return result instanceof Response ? result : response(request, result);
  } });
  return { api, calls };
}
function fixture(spot = false) {
  const order = { instrument_name: spot ? 'BTC_USDC' : SYMBOL, amount: '0.1', price: spot ? '80000' : '500', label: spot ? 'spot-label-1' : 'put-label-1' };
  const spec = { validated: true, instrument_name: order.instrument_name, kind: spot ? 'spot' : 'option', instrument_type: 'linear', base_currency: 'BTC', quote_currency: 'USDC', is_active: true, state: 'open', min_trade_amount: spot ? 0.00000001 : 0.01, tick_size: spot ? 0.01 : 5, tick_size_steps: [], contract_size: 1, ...(spot ? {} : { strike: 80000, option_type: 'put', settlement_currency: 'USDC', expiration_timestamp: T + 86400000 }) };
  const confirmedIntent = { confirmed: true, intentId: spot ? 'spot-intent-1' : 'put-intent-1', action: spot ? 'spot_buy' : 'sell_put', currency: 'USDC', ...order, direction: spot ? 'buy' : 'sell', type: 'limit', time_in_force: 'immediate_or_cancel', post_only: false, expiresAt: T + 20000, maxFunds: '8010', feeReserve: '10', ...(spot ? {} : { strike: '80000' }) };
  return { order, options: { spec, confirmedIntent, beforeSubmit: () => true } };
}
function orderRow(overrides = {}) {
  return { order_id: 'USDC-order-1', instrument_name: SYMBOL, label: 'put-label-1', direction: 'sell', order_type: 'limit', time_in_force: 'immediate_or_cancel', post_only: false, order_state: 'cancelled', amount: 0.1, filled_amount: 0.03, price: 500, average_price: 505, creation_timestamp: T, last_update_timestamp: T, ...overrides };
}
function tradeRow(overrides = {}) { return { trade_id: 'USDC-trade-1', trade_seq: 1, order_id: 'USDC-order-1', instrument_name: SYMBOL, label: 'put-label-1', direction: 'sell', amount: 0.03, price: 505, fee: 0.1, fee_currency: 'USDC', timestamp: T, ...overrides }; }
const accepted = request => ({ order: orderRow({ instrument_name: request.params.instrument_name, label: request.params.label, direction: request.method.endsWith('/buy') ? 'buy' : 'sell', amount: request.params.amount, price: request.params.price, filled_amount: 0, order_state: 'open' }), trades: [] });
async function preflight(api) { const result = await api.getApiInfo(); assert.equal(result.ok, true); assert.equal(result.data.unsafePermissions, false); }

test('default-off never authenticates or submits, and only exact official hosts are allowed', async () => {
  let count = 0;
  const api = new DeribitExecution({ fetchImpl: async () => { count++; throw new Error('no'); } });
  const f = fixture();
  assert.equal((await api.createSellPut(f.order, f.options)).error.code, 'live_disabled');
  assert.equal((await api.getApiInfo()).error.code, 'authorization_required');
  assert.equal(count, 0);
  for (const baseUrl of ['https://deribit.com', 'https://www.deribit.com/evil', 'https://evil.test']) assert.throws(() => createDeribitExecution({ baseUrl }));
  assert.equal('withdraw' in api, false);
  assert.equal('transfer' in api, false);
});

test('auth requests a narrow ephemeral scope, preserves no refresh token and exposes no credentials', async () => {
  const { api, calls } = setup();
  const auth = await api.authenticate();
  assert.equal(auth.data.isMaster, false);
  assert.equal(auth.data.permissions.wallet, 'none');
  assert.equal(JSON.stringify(auth).includes(TOKEN), false);
  assert.equal(JSON.stringify(auth).includes('refresh_token'), false);
  assert.equal(calls[0].request.params.scope, 'account:read trade:read_write wallet:none expires:600');
  assert.equal(calls[0].url.includes(SECRET), false);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.credentials, 'omit');
  const info = await api.getApiInfo();
  assert.equal(info.data.readOnly, false);
  assert.equal(info.data.keyEnabled, true);
  assert.equal(info.data.keyScopeKnown, true);
  assert.equal(JSON.stringify(info).includes(CLIENT), false);
  assert.equal(JSON.stringify(info).includes(SECRET), false);
  assert.equal(JSON.stringify(info).includes('someone-else'), false);
  assert.equal(calls.at(-1).init.headers.Authorization, `Bearer ${TOKEN}`);
});

test('default-off authenticated inspection requests trade:read rather than trade:read_write', async () => {
  const { api, calls } = setup(undefined, { liveEnabled: false });
  await api.authenticate();
  assert.equal(calls[0].request.params.scope.includes('trade:read '), true);
});

test('unsafe original-key permission and main account cannot submit; unknown scope contents are not returned', async () => {
  for (const scope of [['account:read', 'trade:read_write', 'wallet:read_write'], ['account:read', 'trade:read_write', 'wallet:none', 'future_cash:read_write']]) {
    const calls = [];
    const api = createDeribitExecution({ clientId: CLIENT, clientSecret: SECRET, liveEnabled: true, now: () => T, fetchImpl: async (url, init) => {
      const req = JSON.parse(init.body); calls.push(req);
      return req.method === 'public/auth' ? response(req, { access_token: TOKEN, token_type: 'bearer', expires_in: 600, scope: 'account:read trade:read_write wallet:none' }) : response(req, [{ client_id: CLIENT, client_secret: SECRET, enabled: true, max_scope: scope }]);
    } });
    const info = await api.getApiInfo();
    assert.equal(info.data.unsafePermissions, true);
    assert.equal(JSON.stringify(info).includes('future_cash'), false);
    const f = fixture(); assert.equal((await api.createSellPut(f.order, f.options)).error.code, 'account_preflight_required');
    assert.equal(calls.some(r => r.method === 'private/sell'), false);
  }
});

test('account summaries keep settled funds, margin flags and fee type without leaking identity or inventing rates', async () => {
  const summary = { currency: 'USDC', type: 'subaccount', balance: 10000, equity: 10000, margin_balance: 10000, available_funds: 9900, available_withdrawal_funds: 9800, initial_margin: 0, maintenance_margin: 0, cross_collateral_enabled: false, portfolio_margining_enabled: false, margin_model: 'segregated_sm', spot_reserve: 0, additional_reserve: 0, email: 'private@example.com', id: 1, fees: { btc_usdc: { option: { default: { type: 'relative', maker: 0.625, taker: 0.625 } } } } };
  const { api } = setup(req => req.method.endsWith('get_account_summaries') ? { id: 1, type: 'subaccount', summaries: [summary, { ...summary, currency: 'BTC', balance: 0.1 }] } : summary);
  const result = await api.getAccountSummary({ currency: 'USDC', extended: true });
  assert.equal(result.data.available_withdrawal_funds, 9800);
  assert.equal(result.data.fees.btc_usdc.option.default.type, 'relative');
  assert.equal(result.data.fees.btc_usdc.option.default.taker, 0.625);
  assert.equal('spot' in result.data.fees.btc_usdc, false);
  assert.equal(JSON.stringify(result).includes('private@example.com'), false);
  assert.equal(result.data.id, 1);
  const all = await api.getAccountSummaries({ extended: true });
  assert.equal(all.data.summaries.length, 2);
  assert.equal(all.data.id, 1);
  assert.equal(all.data.type, 'subaccount');
});

test('read allowlist rejects subaccount switching, URLs, wallets, extra headers and invalid filters', async () => {
  const { api, calls } = setup();
  for (const [method, params] of [
    ['getAccountSummary', { currency: 'USDC', subaccount_id: 5 }], ['getOpenOrders', { url: 'https://evil.test' }],
    ['getOpenOrders', { type: 'limit' }], ['getPositions', { currency: 'wallet' }],
    ['getOrderHistory', { instrument_name: 'ETH_USDC-6NOV26-2000-P' }],
    ['getTransactionLog', { currency: 'BTC', start_timestamp: T - 1, end_timestamp: T }],
  ]) assert.equal((await api[method](params)).error.code, 'invalid_parameters');
  assert.equal(calls.length, 0);
});

test('all-kind account position/open-order reads are exact fixed methods and preserve actual quantities', async () => {
  const { api, calls } = setup(req => req.method.endsWith('get_positions') ? [{ instrument_name: SYMBOL, direction: 'sell', kind: 'option', size: -0.03, user_id: 22 }] : [orderRow()]);
  const positions = await api.getPositions({ currency: 'any' });
  assert.equal(positions.data[0].size, -0.03);
  assert.equal('user_id' in positions.data[0], false);
  assert.equal((await api.getOpenOrders({ type: 'all' })).data[0].filled_amount, 0.03);
  assert.deepEqual(calls.at(-1).request.params, { type: 'all' });
});

test('transaction logs preserve the two settlement stages, actual USDC cash changes and pagination without account IDs', async () => {
  const logs = ['assignment', 'future creation', 'delivery'].map((type, i) => ({ id: i + 1, timestamp: T, currency: 'USDC', instrument_name: i ? 'BTC_USDC-6NOV26' : SYMBOL, type, amount: 0.1, change: i === 2 ? -100 : 0, commission: 0.1, cashflow: i === 2 ? -100 : 0, ...(i === 2 ? { settlement_price: 79000, index_price: 79001 } : {}), username: 'private-user', user_id: 44 }));
  const { api } = setup(req => req.method.endsWith('get_transaction_log') ? { logs, continuation: null } : { settlements: [{ type: 'delivery', timestamp: T, instrument_name: 'BTC_USDC-6NOV26', position: 0.1, index_price: 79000, profit_loss: 999999 }], continuation: null });
  const result = await api.getTransactionLog({ currency: 'USDC', start_timestamp: T - 1000, end_timestamp: T });
  assert.equal(result.data.logs[0].type, 'assignment');
  assert.equal(result.data.logs[2].change, -100);
  assert.equal(result.data.logs[2].settlement_price, 79000);
  assert.equal(result.data.logs[2].index_price, 79001);
  assert.equal(result.data.continuation, null);
  assert.equal(JSON.stringify(result).includes('private-user'), false);
  const settlement = await api.getSettlementHistory({ currency: 'USDC', type: 'delivery' });
  assert.equal('profit_loss' in settlement.data.settlements[0], false);
});

test('valid sell PUT is exact Limit IOC with finite numeric amount and server-calibrated valid_until; ACK is acceptance only', async () => {
  const { api, calls } = setup(accepted); await preflight(api);
  const f = fixture(), result = await api.createSellPut(f.order, f.options);
  assert.equal(result.status, 'accepted');
  assert.equal(result.data.order.order_state, 'open');
  const req = calls.at(-1).request;
  assert.equal(req.method, 'private/sell');
  assert.deepEqual(req.params, { instrument_name: SYMBOL, amount: 0.1, price: 500, label: 'put-label-1', type: 'limit', time_in_force: 'immediate_or_cancel', post_only: false, valid_until: T + 20000 });
  assert.equal((await api.createSellPut(f.order, f.options)).error.code, 'intent_already_attempted');
  assert.equal(calls.filter(c => c.request.method === 'private/sell').length, 1);
});

test('missing preflight, non-open instruments, wrong currency/type, absent tick steps and precision-losing amounts cannot submit', async () => {
  const before = setup(accepted), f = fixture();
  assert.equal((await before.api.createSellPut(f.order, f.options)).error.code, 'account_preflight_required');
  const changes = [
    f => { f.options.confirmedIntent.confirmed = false; }, f => { f.options.confirmedIntent.expiresAt = T; },
    f => { f.options.confirmedIntent.time_in_force = 'good_til_cancelled'; }, f => { f.options.confirmedIntent.post_only = true; },
    f => { f.options.spec.state = 'locked'; }, f => { f.options.spec.settlement_currency = 'BTC'; },
    f => { f.options.spec.option_type = 'call'; }, f => { f.options.spec.tick_size_steps = undefined; },
    f => { f.options.spec.contract_size = 10; }, f => { f.options.spec.strike = 81000; },
    f => { f.order.amount = f.options.confirmedIntent.amount = '0.100000000000000001'; f.options.spec.min_trade_amount = '0.000000000000000001'; },
  ];
  for (const change of changes) {
    const { api, calls } = setup(accepted); await preflight(api); const f = fixture(); change(f);
    assert.equal((await api.createSellPut(f.order, f.options)).ok, false);
    assert.equal(calls.some(c => c.request.method === 'private/sell'), false);
  }
});

test('quantity increments, stepped ticks and full strike capital plus fees are exact decimal checks', async () => {
  const changes = [
    f => { f.order.amount = f.options.confirmedIntent.amount = '0.015'; },
    f => { f.order.price = f.options.confirmedIntent.price = '1010'; f.options.spec.tick_size_steps = [{ above_price: 1000, tick_size: 20 }]; },
    f => { f.options.confirmedIntent.maxFunds = '8009.999999999999999999'; },
    f => { f.options.confirmedIntent.feeReserve = undefined; },
  ];
  for (const change of changes) {
    const { api } = setup(accepted); await preflight(api); const f = fixture(); change(f);
    assert.equal((await api.createSellPut(f.order, f.options)).error.code, 'invalid_intent');
  }
  const { api } = setup(accepted); await preflight(api); const f = fixture();
  f.order.price = f.options.confirmedIntent.price = '1020'; f.options.spec.tick_size_steps = [{ above_price: 1000, tick_size: 20 }];
  assert.equal((await api.createSellPut(f.order, f.options)).status, 'accepted');
});

test('BTC_USDC spot buy uses native private/buy with full cash and no invented borrow parameter; real fee currency is preserved', async () => {
  const { api, calls } = setup(accepted); await preflight(api); const f = fixture(true);
  assert.equal((await api.createSpotBuy(f.order, f.options)).status, 'accepted');
  const req = calls.at(-1).request;
  assert.equal(req.method, 'private/buy');
  assert.equal(req.params.instrument_name, 'BTC_USDC');
  assert.equal('isLeverage' in req.params, false);
  assert.equal(req.params.post_only, false);
  const trades = setup(() => [tradeRow({ instrument_name: 'BTC_USDC', direction: 'buy', fee_currency: 'BTC', fee: 0.0000001 })]);
  assert.equal((await trades.api.getTradesByOrder({ order_id: 'USDC-order-1' })).data[0].fee_currency, 'BTC');
});

test('timeout and incomplete acknowledgements become unknown, never retry, and block another confirmation', async () => {
  const { api, calls } = setup(() => new Promise(() => {}), { timeoutMs: 15 }); await preflight(api);
  const f = fixture(), result = await api.createSellPut(f.order, f.options);
  assert.equal(result.error.code, 'timeout'); assert.equal(result.error.unknown, true);
  const next = fixture(); next.order.label = next.options.confirmedIntent.label = 'different-label'; next.options.confirmedIntent.intentId = 'different-intent';
  assert.equal((await api.createSellPut(next.order, next.options)).error.code, 'reconciliation_required');
  assert.equal(calls.filter(c => c.request.method === 'private/sell').length, 1);
});

test('JSON-RPC id mismatch, unsafe auth scope, HTML and redirect never leak bodies or credentials', async () => {
  for (const makeResponse of [
    request => response(request, {}, { id: request.id + 1 }),
    request => response(request, { access_token: TOKEN, token_type: 'bearer', expires_in: 600, scope: 'account:read_write trade:read_write wallet:none' }),
    () => new Response(`<html>${SECRET}</html>`, { status: 403, headers: { 'Content-Type': 'text/html' } }),
    () => new Response(null, { status: 302, headers: { location: 'https://evil.test' } }),
  ]) {
    let count = 0;
    const api = createDeribitExecution({ clientId: CLIENT, clientSecret: SECRET, fetchImpl: async (_url, init) => { count++; return makeResponse(JSON.parse(init.body)); } });
    const result = await api.authenticate();
    assert.equal(result.ok, false); assert.equal(count, 1); assert.equal(JSON.stringify(result).includes(SECRET), false);
  }
});

test('history forces inclusion of unfilled orders and explicit continuation; missing pagination proof fails closed', async () => {
  const { api, calls } = setup(() => ({ orders: [orderRow()], continuation: null }));
  const result = await api.getOrderHistory({ instrument_name: SYMBOL, historical: true });
  assert.equal(result.data.orders.length, 1);
  assert.deepEqual(calls.at(-1).request.params, { instrument_name: SYMBOL, historical: true, count: 100, include_old: true, include_unfilled: true, with_continuation: true });
  const missing = setup(() => ({ orders: [] }));
  assert.equal((await missing.api.getOrderHistory({ instrument_name: SYMBOL })).error.code, 'invalid_response');
});

function unknownSetup(change = {}) {
  return setup(request => {
    if (request.method === 'private/sell') return response(request, undefined, { error: { code: 10000, message: `${SECRET}:unknown` } });
    if (request.method.endsWith('get_order_state_by_label')) return change.labels ?? [orderRow()];
    if (request.method.endsWith('get_order_history_by_instrument')) return { orders: change.orders ?? [orderRow()], continuation: change.continuation ?? null };
    if (request.method.endsWith('get_user_trades_by_order')) return request.params.historical ? [] : change.trades ?? [tradeRow()];
    return [];
  });
}
async function unknown(api) { await preflight(api); const f = fixture(); assert.equal((await api.createSellPut(f.order, f.options)).status, 'unknown'); return f; }
const recovery = () => ({ currency: 'USDC', instrument_name: SYMBOL, label: 'put-label-1' });

test('unknown recovery checks recent AND historical orders/trades, terminal state and exact actual fill before unlocking', async () => {
  const { api, calls } = unknownSetup(); const f = await unknown(api);
  const result = await api.reconcileUnknownOrder(recovery());
  assert.equal(result.status, 'reconciled'); assert.equal(result.data.filled_amount, 0.03);
  assert.equal(result.data.trades[0].fee_currency, 'USDC');
  assert.equal(api.getExecutionState().reconciliationRequired, false);
  assert.equal((await api.createSellPut(f.order, f.options)).error.code, 'intent_already_attempted');
  const histories = calls.filter(c => c.request.method.endsWith('get_order_history_by_instrument')).map(c => c.request.params.historical);
  assert.deepEqual(histories, [false, true]);
  const trades = calls.filter(c => c.request.method.endsWith('get_user_trades_by_order')).map(c => c.request.params.historical);
  assert.deepEqual(trades, [false, true]);
});

test('unknown label reuse, conflicting orders, incomplete pagination and fill mismatches stay blocked', async () => {
  for (const change of [
    { labels: [], orders: [] }, { orders: [orderRow({ order_id: 'another-id' })] },
    { labels: [orderRow({ order_state: 'open' })] }, { trades: [tradeRow({ amount: 0.02 })] },
    { labels: [orderRow({ creation_timestamp: T - 10000 })] }, { continuation: 'repeats' },
    { labels: [orderRow(), orderRow({ order_id: 'same-label-second-order' })] },
  ]) {
    const { api } = unknownSetup(change); await unknown(api);
    assert.equal((await api.reconcileUnknownOrder(recovery())).error.code, 'reconciliation_incomplete');
    assert.equal(api.getExecutionState().reconciliationRequired, true);
  }
});

test('caller cannot clear unknown with a boolean or unrelated label', async () => {
  const { api, calls } = unknownSetup(); await unknown(api); const count = calls.length;
  assert.equal((await api.reconcileUnknownOrder({ ...recovery(), confirmed: true })).error.code, 'invalid_parameters');
  assert.equal((await api.reconcileUnknownOrder({ ...recovery(), label: 'other-label' })).error.code, 'unknown_order_not_tracked');
  assert.equal(calls.length, count); assert.equal(api.getExecutionState().reconciliationRequired, true);
});

test('documented floating fee renderings stay numeric, while settlement price NaN strings fail closed', async () => {
  const summary = { id: 1, type: 'subaccount', currency: 'USDC', balance: 10000.000000000002, equity: 10000, available_funds: 10000, available_withdrawal_funds: 10000, initial_margin: 0, maintenance_margin: 0, fees: { btc_usdc: { option: { default: { type: 'fixed', maker: -0.0001, taker: 0.00035000000000000005 } } } } };
  const { api } = setup(() => summary);
  assert.equal((await api.getAccountSummary({ currency: 'USDC' })).data.fees.btc_usdc.option.default.taker, 0.00035000000000000005);
  const bad = setup(() => ({ logs: [{ id: 1, timestamp: T, currency: 'USDC', type: 'delivery', settlement_price: 'NaN' }], continuation: null }));
  assert.equal((await bad.api.getTransactionLog({ currency: 'USDC', start_timestamp: T - 1, end_timestamp: T })).error.code, 'invalid_response');
});

test('main-account session cannot submit even if its key permission scope is otherwise narrow', async () => {
  const api = createDeribitExecution({ clientId: CLIENT, clientSecret: SECRET, liveEnabled: true, now: () => T, fetchImpl: async (_url, init) => {
    const req = JSON.parse(init.body);
    return req.method === 'public/auth' ? response(req, { access_token: TOKEN, token_type: 'bearer', expires_in: 600, scope: 'connection mainaccount account:read trade:read_write wallet:none' }) : response(req, [{ client_id: CLIENT, enabled: true, max_scope: ['account:read', 'trade:read_write', 'wallet:none'] }]);
  } });
  assert.equal((await api.getApiInfo()).data.isMaster, true);
  const f = fixture();
  assert.equal((await api.createSellPut(f.order, f.options)).error.code, 'account_preflight_required');
});

test('ACK trades from another order are unknown rather than accepted as actual fills', async () => {
  const { api } = setup(() => ({ order: orderRow(), trades: [tradeRow({ order_id: 'other-order' })] }));
  await preflight(api); const f = fixture();
  assert.equal((await api.createSellPut(f.order, f.options)).error.code, 'invalid_acknowledgement');
  assert.equal(api.getExecutionState().reconciliationRequired, true);
});

test('mandatory final gate is synchronous, fails closed and never consumes or sends the denied intent', async () => {
  for (const gate of [undefined, () => false, () => { throw new Error('pause'); }, () => Promise.resolve(true)]) {
    const { api, calls } = setup(accepted); await preflight(api);
    const f = fixture(); f.options.beforeSubmit = gate;
    const result = await api.createSellPut(f.order, f.options);
    assert.equal(result.error.code, 'final_gate_refused');
    assert.equal(result.error.unknown, false);
    assert.equal(calls.some(call => call.request.method === 'private/sell'), false);
    assert.equal(api.getExecutionState().attempts.length, 0);
    assert.equal(api.getExecutionState().finalGateSupported, true);
  }
});

test('pause while create awaits authentication continuation is re-read before sending spot', async () => {
  const { api, calls } = setup(accepted); await preflight(api); await api.syncTime();
  let paused = false;
  const f = fixture(true); f.options.beforeSubmit = () => !paused;
  const pending = api.createSpotBuy(f.order, f.options);
  paused = true;
  assert.equal((await pending).error.code, 'final_gate_refused');
  assert.equal(calls.some(call => call.request.method === 'private/buy'), false);
});

test('pause during delayed server-time calibration wins the last gate and prevents every trading POST', async () => {
  let releaseTime, reachedTime;
  const reached = new Promise(resolve => { reachedTime = resolve; });
  const writes = [];
  const api = createDeribitExecution({ clientId: CLIENT, clientSecret: SECRET, liveEnabled: true, now: () => T, fetchImpl: async (_url, init) => {
    const req = JSON.parse(init.body);
    if (req.method === 'public/auth') return response(req, { access_token: TOKEN, token_type: 'bearer', expires_in: 600, scope: 'connection account:read trade:read_write wallet:none' });
    if (req.method === 'private/list_api_keys') return response(req, [{ client_id: CLIENT, enabled: true, max_scope: ['account:read', 'trade:read_write', 'wallet:none'] }]);
    if (req.method === 'public/time') return new Promise(resolve => { releaseTime = () => resolve(response(req, T)); reachedTime(); });
    writes.push(req); return response(req, accepted(req));
  } });
  await preflight(api); let paused = false;
  const f = fixture(true); f.options.beforeSubmit = () => !paused;
  const pending = api.createSpotBuy(f.order, f.options);
  await reached; paused = true; releaseTime();
  const result = await pending;
  assert.equal(result.error.code, 'final_gate_refused');
  assert.equal(result.error.unknown, false);
  assert.equal(writes.length, 0);
});

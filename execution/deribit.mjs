// Local-only Deribit adapter. Credentials and ephemeral OAuth tokens stay in closures.
// JSON-RPC id and label are correlation fields, NOT exchange idempotency guarantees.
// Durable write-ahead intents and restart reconciliation remain the caller's duty.
const HOSTS = new Set(['https://www.deribit.com', 'https://test.deribit.com']);
const UNIT = 10n ** 18n;
const READ = Object.freeze({
  getAccountSummary: 'private/get_account_summary', getAccountSummaries: 'private/get_account_summaries',
  getPositions: 'private/get_positions', getOpenOrders: 'private/get_open_orders',
  getOrderStateByLabel: 'private/get_order_state_by_label', getOrderState: 'private/get_order_state',
  getOrderHistory: 'private/get_order_history_by_instrument', getTradesByOrder: 'private/get_user_trades_by_order',
  getSettlementHistory: 'private/get_settlement_history_by_currency', getTransactionLog: 'private/get_transaction_log',
});
const ORDER_FIELDS = ['order_id', 'order_state', 'instrument_name', 'label', 'direction', 'order_type', 'time_in_force', 'amount', 'filled_amount', 'price', 'average_price', 'creation_timestamp', 'last_update_timestamp', 'post_only', 'reduce_only', 'is_liquidation', 'is_rebalance', 'cancel_reason'];
const TRADE_FIELDS = ['trade_id', 'trade_seq', 'order_id', 'instrument_name', 'label', 'direction', 'amount', 'price', 'fee', 'fee_currency', 'timestamp', 'liquidity', 'state', 'order_type', 'reduce_only'];
const CASH_FIELDS = ['balance', 'equity', 'margin_balance', 'available_funds', 'available_withdrawal_funds', 'initial_margin', 'maintenance_margin', 'session_rpl', 'session_upl', 'spot_reserve', 'additional_reserve', 'locked_balance', 'options_value', 'futures_session_rpl', 'futures_session_upl', 'fee_balance'];
const AREAS = ['account', 'trade', 'wallet', 'block_trade', 'block_rfq'];
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const failure = (code, message, unknown = false) => ({ ok: false, status: unknown ? 'unknown' : 'error', error: { code, message, unknown } });
const identifier = (v, max = 128) => typeof v === 'string' && v.length > 0 && v.length <= max && /^[A-Za-z0-9_.:-]+$/.test(v);
const instrument = v => typeof v === 'string' && /^[A-Z0-9_]+(?:-[A-Z0-9.]+){0,5}$/.test(v) && v.length <= 100;
function plainNumber(v) {
  if (typeof v === 'string') return v;
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e12) throw new Error('decimal');
  const s = String(v);
  if (!/[eE]/.test(s)) return s;
  const [mantissa, exponent] = s.toLowerCase().split('e'), exp = Number(exponent);
  const negative = mantissa.startsWith('-'), [whole, fraction = ''] = mantissa.replace('-', '').split('.');
  const digits = whole + fraction, point = whole.length + exp;
  const expanded = point <= 0 ? `0.${'0'.repeat(-point)}${digits}` : point >= digits.length ? digits + '0'.repeat(point - digits.length) : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return (negative ? '-' : '') + expanded;
}
function units(v, zero = false, signed = false) {
  let s = plainNumber(v), negative = false;
  if (signed && s.startsWith('-')) { negative = true; s = s.slice(1); }
  if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,18})?$/.test(s)) throw new Error('decimal');
  const [whole, fraction = ''] = s.split('.');
  const n = BigInt(whole) * UNIT + BigInt(fraction.padEnd(18, '0'));
  if (!zero && n === 0n) throw new Error('decimal');
  return negative ? -n : n;
}
function rpcNumber(v) {
  const exact = units(v, true), n = Number(v);
  if (!Number.isFinite(n) || units(n, true) !== exact) throw new Error('precision');
  return n;
}
function finiteAmount(v, signed = false) {
  // Official read responses use JSON numbers; preserve them, including harmless
  // binary-float renderings such as 0.00035000000000000005 in documented fees.
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e12 || (!signed && v < 0)) throw new Error('number');
  return v;
}
function pick(row, keys) {
  if (!isObject(row)) throw new Error('schema');
  const out = {};
  for (const key of keys) {
    const v = row[key];
    if (v === undefined || v === null) continue;
    if ((typeof v === 'string' && v.length <= 512) || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[key] = v;
    else throw new Error('schema');
  }
  return out;
}
function array(v, max = 2000) { if (!Array.isArray(v) || v.length > max) throw new Error('schema'); return v; }
function safeOrder(row) {
  const out = pick(row, ORDER_FIELDS);
  if (!identifier(out.order_id) || !instrument(out.instrument_name) || !['open', 'filled', 'rejected', 'cancelled', 'untriggered', 'triggered'].includes(out.order_state) || !['buy', 'sell'].includes(out.direction)) throw new Error('schema');
  units(out.amount); units(out.filled_amount, true);
  if (units(out.filled_amount, true) > units(out.amount)) throw new Error('schema');
  return out;
}
function safeTrade(row) {
  const out = pick(row, TRADE_FIELDS);
  if (!identifier(out.order_id) || !identifier(out.trade_id) || !instrument(out.instrument_name) || !['buy', 'sell'].includes(out.direction) || !Number.isSafeInteger(out.timestamp) || out.timestamp <= 0 || !/^[A-Z0-9]{2,12}$/.test(out.fee_currency)) throw new Error('schema');
  units(out.amount); units(out.price); units(out.fee, true, true);
  return out;
}
function feeStructures(raw) {
  if (!isObject(raw) || Object.keys(raw).length > 100) throw new Error('schema');
  const out = {};
  for (const [index, kinds] of Object.entries(raw)) {
    if (!/^[a-z0-9]+_[a-z0-9]+$/.test(index) || !isObject(kinds)) throw new Error('schema');
    const safeKinds = {};
    for (const kind of ['option', 'future', 'perpetual', 'spot']) {
      if (kinds[kind] === undefined) continue;
      const rate = kinds[kind]?.default;
      if (!isObject(rate) || !['fixed', 'relative'].includes(rate.type)) throw new Error('schema');
      finiteAmount(rate.taker); finiteAmount(rate.maker, true);
      if (rate.taker > 100 || Math.abs(rate.maker) > 100) throw new Error('fee');
      safeKinds[kind] = { default: { type: rate.type, taker: rate.taker, maker: rate.maker } };
    }
    out[index] = safeKinds;
  }
  return out;
}
function safeSummary(raw) {
  const out = pick(raw, ['id', 'currency', 'type', 'cross_collateral_enabled', 'portfolio_margining_enabled', 'margin_model', ...CASH_FIELDS]);
  if (typeof out.currency !== 'string' || !/^[A-Z0-9]{2,12}$/.test(out.currency)) throw new Error('schema');
  for (const field of ['balance', 'equity', 'available_funds', 'available_withdrawal_funds', 'initial_margin', 'maintenance_margin']) finiteAmount(out[field], true);
  for (const field of CASH_FIELDS) if (out[field] !== undefined) finiteAmount(out[field], true);
  if (out.type !== undefined && !['main', 'subaccount'].includes(out.type)) throw new Error('schema');
  if (out.id !== undefined && (!Number.isSafeInteger(out.id) || out.id <= 0)) throw new Error('schema');
  if (raw.fees !== undefined) out.fees = feeStructures(raw.fees);
  return out;
}
function cursor(v, numeric = false) {
  if (v === null || v === '') return v;
  if (numeric) { if (!Number.isSafeInteger(v) || v <= 0) throw new Error('cursor'); }
  else if (typeof v !== 'string' || v.length > 2048 || /[\u0000-\u001f]/.test(v)) throw new Error('cursor');
  return v;
}
function safeResult(name, raw) {
  if (name === 'getAccountSummary') {
    const out = safeSummary(raw);
    if (!Number.isSafeInteger(out.id) || out.id <= 0 || !['main', 'subaccount'].includes(out.type)) throw new Error('schema');
    return out;
  }
  if (name === 'getAccountSummaries') {
    if (!Number.isSafeInteger(raw?.id) || raw.id <= 0 || !['main', 'subaccount'].includes(raw.type)) throw new Error('schema');
    const summaries = array(raw.summaries, 200).map(safeSummary);
    if (summaries.some(row => (row.id !== undefined && row.id !== raw.id) || (row.type !== undefined && row.type !== raw.type))) throw new Error('identity');
    return { id: raw.id, type: raw.type, summaries };
  }
  if (name === 'getPositions') return array(raw).map(row => {
    const out = pick(row, ['instrument_name', 'kind', 'direction', 'size', 'size_currency', 'average_price', 'mark_price', 'initial_margin', 'maintenance_margin', 'open_orders_margin', 'realized_profit_loss', 'floating_profit_loss']);
    if (!instrument(out.instrument_name) || !['buy', 'sell', 'zero'].includes(out.direction)) throw new Error('schema');
    units(out.size, true, true); return out;
  });
  if (name === 'getOpenOrders' || name === 'getOrderStateByLabel') return array(raw).map(safeOrder);
  if (name === 'getOrderState') return safeOrder(raw);
  if (name === 'getTradesByOrder') return array(raw).map(safeTrade);
  if (name === 'getOrderHistory') return { orders: array(raw?.orders).map(safeOrder), continuation: cursor(raw.continuation) };
  if (name === 'getSettlementHistory') return { settlements: array(raw?.settlements).map(row => {
    const out = pick(row, ['type', 'timestamp', 'instrument_name', 'position', 'index_price', 'mark_price']);
    if (!['settlement', 'delivery', 'bankruptcy'].includes(out.type) || !Number.isSafeInteger(out.timestamp) || !instrument(out.instrument_name)) throw new Error('schema');
    return out;
  }), continuation: cursor(raw.continuation) };
  if (name === 'getTransactionLog') return { logs: array(raw?.logs).map(row => {
    const out = pick(row, ['id', 'user_seq', 'type', 'timestamp', 'currency', 'instrument_name', 'side', 'amount', 'position', 'price', 'settlement_price', 'index_price', 'price_currency', 'cashflow', 'change', 'commission', 'balance', 'equity', 'order_id', 'trade_id', 'profit_as_cashflow']);
    if (!Number.isSafeInteger(out.id) || !Number.isSafeInteger(out.timestamp) || out.currency !== 'USDC' || typeof out.type !== 'string') throw new Error('schema');
    for (const key of ['amount', 'position', 'price', 'cashflow', 'change', 'commission', 'balance', 'equity']) if (out[key] !== undefined) finiteAmount(out[key], true);
    for (const key of ['settlement_price', 'index_price']) if (out[key] !== undefined) finiteAmount(out[key]);
    return out;
  }), continuation: cursor(raw.continuation, true) };
  throw new Error('schema');
}
function checkedParams(name, input = {}) {
  if (!isObject(input)) throw new Error('params');
  const allowed = {
    getAccountSummary: ['currency', 'extended'], getAccountSummaries: ['extended'],
    getPositions: ['currency', 'kind'], getOpenOrders: ['kind', 'type'],
    getOrderStateByLabel: ['currency', 'label'], getOrderState: ['order_id'],
    getOrderHistory: ['instrument_name', 'count', 'continuation', 'historical'],
    getTradesByOrder: ['order_id', 'historical'],
    getSettlementHistory: ['currency', 'type', 'count', 'continuation', 'search_start_timestamp'],
    getTransactionLog: ['currency', 'start_timestamp', 'end_timestamp', 'count', 'continuation'],
  }[name];
  if (Object.keys(input).some(k => !allowed.includes(k))) throw new Error('params');
  const p = { ...input };
  if (name === 'getAccountSummary') { if (!['USDC', 'BTC'].includes(p.currency)) throw new Error('params'); if (p.extended !== undefined && p.extended !== true) throw new Error('params'); p.extended = true; }
  if (name === 'getAccountSummaries') { if (p.extended !== undefined && p.extended !== true) throw new Error('params'); p.extended = true; }
  if (name === 'getPositions' && !['USDC', 'BTC', 'any'].includes(p.currency)) throw new Error('params');
  if (name === 'getOrderStateByLabel' && (p.currency !== 'USDC' || !identifier(p.label, 64))) throw new Error('params');
  if (['getSettlementHistory', 'getTransactionLog'].includes(name) && p.currency !== 'USDC') throw new Error('params');
  for (const [key, value] of Object.entries(p)) {
    if (key === 'instrument_name' && (!instrument(value) || !/^BTC_USDC(?:-|$)/.test(value))) throw new Error('params');
    if (key === 'order_id' && !identifier(value)) throw new Error('params');
    if (key === 'kind' && !['future', 'option', ...(name === 'getOpenOrders' ? ['spot'] : []), 'future_combo', 'option_combo'].includes(value)) throw new Error('params');
    if (key === 'type' && (name === 'getOpenOrders' ? value !== 'all' : !['delivery', 'settlement', 'bankruptcy'].includes(value))) throw new Error('params');
    if (key === 'count' && (!Number.isInteger(value) || value < 1 || value > 1000)) throw new Error('params');
    if (key === 'historical' && typeof value !== 'boolean') throw new Error('params');
    if (key === 'continuation') cursor(value, name === 'getTransactionLog');
    if (key.endsWith('_timestamp') && (!Number.isSafeInteger(value) || value <= 0)) throw new Error('params');
  }
  if (name === 'getOpenOrders') p.type = 'all';
  if (name === 'getOrderHistory') {
    if (!p.instrument_name) throw new Error('params');
    Object.assign(p, { count: p.count ?? 100, include_old: true, include_unfilled: true, with_continuation: true, historical: p.historical ?? false });
  }
  if (name === 'getTradesByOrder' && !p.order_id) throw new Error('params');
  if (name === 'getOrderState' && !p.order_id) throw new Error('params');
  if (name === 'getTransactionLog' && (!p.start_timestamp || !p.end_timestamp || p.start_timestamp > p.end_timestamp || p.end_timestamp - p.start_timestamp > 7 * 86400000)) throw new Error('params');
  return p;
}
function parseScope(raw) {
  const tokens = typeof raw === 'string' ? raw.trim().split(/\s+/).filter(Boolean) : array(raw, 50);
  const permissions = {}, seen = new Set();
  let unsafePermissions = false, isMaster = false;
  for (const token of tokens) {
    if (typeof token !== 'string') throw new Error('scope');
    if (token === 'mainaccount') { isMaster = true; continue; }
    if (token === 'connection' || /^session:[A-Za-z0-9_-]{1,64}$/.test(token) || /^expires:\d+$/.test(token) || /^ip:[0-9a-fA-F.*:/]+$/.test(token)) continue;
    const [area, level, extra] = token.split(':');
    if (!AREAS.includes(area) || !['read', 'read_write', 'none'].includes(level) || extra || seen.has(area)) { unsafePermissions = true; continue; }
    seen.add(area); permissions[area] = level;
    if (level === 'read_write' && area !== 'trade') unsafePermissions = true;
  }
  return { isMaster, readOnly: permissions.trade !== 'read_write', unsafePermissions, permissions };
}

export function createDeribitExecution({ clientId = '', clientSecret = '', fetchImpl = globalThis.fetch, liveEnabled = false,
  baseUrl = 'https://www.deribit.com', timeoutMs = 8000, now = Date.now } = {}) {
  if (!HOSTS.has(baseUrl) || typeof fetchImpl !== 'function' || typeof now !== 'function' || typeof liveEnabled !== 'boolean' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) throw new Error('Invalid adapter configuration');
  if (typeof clientId !== 'string' || typeof clientSecret !== 'string' || /[\r\n]/.test(clientId + clientSecret)) throw new Error('Invalid credentials');
  let sequence = 0, token = null, tokenExpires = 0, sessionInfo = null, keyInfo = null, authenticating = null;
  let offset = 0, synchronizedAt = null, posting = false, unknownBlocked = false, reconciling = false;
  const attempts = new Map(), labels = new Set(), submitted = new Map();
  const serverNow = () => now() + offset;
  async function rpc(method, params = {}, { auth = true, mutation = false } = {}) {
    if (!Object.values(READ).includes(method) && !['public/auth', 'public/time', 'private/list_api_keys', 'private/sell', 'private/buy'].includes(method)) return failure('method_refused', '该交易接口未获允许');
    const id = ++sequence, controller = new AbortController();
    let timer;
    const task = async () => {
      const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
      if (auth) { if (!token) return failure('authorization_required', '需要本机账户授权'); headers.Authorization = `Bearer ${token}`; }
      const response = await fetchImpl(`${baseUrl}/api/v2/${method}`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), redirect: 'manual', credentials: 'omit', cache: 'no-store', signal: controller.signal });
      if (response.status >= 300 && response.status < 400) return failure('redirect_refused', '交易所重定向已拒绝', mutation);
      if (!(response.headers?.get('content-type') || '').toLowerCase().includes('application/json') || Number(response.headers?.get('content-length')) > 1048576) return failure('invalid_response', '交易所返回数据无法验证', mutation);
      let text = '';
      if (response.body?.getReader) {
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let size = 0;
        try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 1048576) { await reader.cancel(); return failure('invalid_response', '交易所响应超过限制', mutation); } text += decoder.decode(part.value, { stream: true }); } text += decoder.decode(); }
        finally { reader.releaseLock(); }
      } else text = await response.text();
      if (Buffer.byteLength(text) > 1048576) return failure('invalid_response', '交易所响应超过限制', mutation);
      let data;
      try { data = JSON.parse(text); } catch { return failure('invalid_response', '交易所返回数据无法验证', mutation); }
      if (!isObject(data) || data.jsonrpc !== '2.0' || data.id !== id) return failure('invalid_response', '交易所响应标识无法核验', mutation);
      if (isObject(data.error) && Number.isInteger(data.error.code)) {
        const authError = [13004, 13009, 13021].includes(data.error.code);
        if (authError) { token = null; tokenExpires = 0; keyInfo = null; }
        return { ...failure(authError ? 'authorization_required' : 'exchange_rejected', authError ? '账户认证或权限失败' : '交易所未确认请求成功', mutation && !authError && data.error.code !== -32602), exchangeCode: data.error.code };
      }
      if (response.status !== 200 || !Object.prototype.hasOwnProperty.call(data, 'result')) return failure('invalid_response', '交易所请求结果无法验证', mutation);
      return { ok: true, status: 'ready', data: data.result, ...(Number.isSafeInteger(data.usOut) ? { serverTime: Math.floor(data.usOut / 1000) } : {}) };
    };
    try { return await Promise.race([task(), new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(failure('timeout', '请求超时；请先对账', mutation)); }, timeoutMs); })]); }
    catch { return failure('network_error', '请求结果无法确认；请先对账', mutation); }
    finally { clearTimeout(timer); }
  }
  async function authenticate() {
    if (token && now() < tokenExpires - 5000) return { ok: true, status: 'ready', data: { ...sessionInfo, expiresAt: tokenExpires } };
    if (!clientId || !clientSecret) return failure('authorization_required', '需要本机配置 Deribit 授权');
    if (authenticating) return authenticating;
    authenticating = (async () => {
      const requested = `account:read trade:${liveEnabled ? 'read_write' : 'read'} wallet:none expires:600`;
      const result = await rpc('public/auth', { grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: requested }, { auth: false });
      if (!result.ok) return result;
      try {
        const raw = result.data, info = parseScope(raw.scope);
        if (typeof raw.access_token !== 'string' || raw.access_token.length < 1 || raw.access_token.length > 8192 || /[\r\n]/.test(raw.access_token) || raw.token_type !== 'bearer' || !Number.isInteger(raw.expires_in) || raw.expires_in < 10 || info.unsafePermissions || info.permissions.account !== 'read' || info.permissions.wallet !== 'none' || !['read', 'read_write'].includes(info.permissions.trade)) throw new Error('scope');
        token = raw.access_token; tokenExpires = now() + Math.min(raw.expires_in, 600) * 1000; sessionInfo = info; keyInfo = null;
        return { ok: true, status: 'ready', data: { ...info, expiresAt: tokenExpires } };
      } catch { token = null; tokenExpires = 0; keyInfo = null; return failure('unsafe_permissions', '授权范围或返回字段无法安全核验'); }
    })();
    try { return await authenticating; } finally { authenticating = null; }
  }
  async function syncTime() {
    const begin = now(), result = await rpc('public/time', {}, { auth: false }), end = now();
    if (!result.ok) return result;
    if (!Number.isSafeInteger(result.data) || result.data <= 0 || end < begin || end - begin > 2000) return failure('clock_unverified', '服务器时间无法可靠校准');
    offset = result.data - (begin + end) / 2; synchronizedAt = end;
    return { ok: true, status: 'ready', data: { serverTime: result.data, clockOffsetMs: offset, roundTripMs: end - begin } };
  }
  async function getApiInfo() {
    const auth = await authenticate(); if (!auth.ok) return auth;
    const result = await rpc('private/list_api_keys'); if (!result.ok) return result;
    try {
      const matches = array(result.data, 500).filter(row => row?.client_id === clientId);
      if (matches.length !== 1 || typeof matches[0].enabled !== 'boolean') throw new Error('key');
      const info = parseScope(matches[0].max_scope);
      keyInfo = { ...info, isMaster: sessionInfo.isMaster, unsafePermissions: info.unsafePermissions || sessionInfo.unsafePermissions, keyEnabled: matches[0].enabled, keyScopeKnown: true };
      return { ok: true, status: 'ready', data: { ...keyInfo, permissions: { ...keyInfo.permissions } } };
    } catch { keyInfo = null; return failure('invalid_response', '当前授权密钥的权限无法核验'); }
  }
  async function read(name, params) {
    let p; try { p = checkedParams(name, params); } catch { return failure('invalid_parameters', '只读查询参数无效'); }
    const auth = await authenticate(); if (!auth.ok) return auth;
    const result = await rpc(READ[name], p); if (!result.ok) return result;
    try {
      const data = safeResult(name, result.data);
      if (name === 'getAccountSummary' && data.currency !== p.currency) throw new Error('currency');
      return { ...result, data };
    } catch { return failure('invalid_response', '交易所字段不完整或无法核验'); }
  }
  function validatedOrder(action, order, spec, intent) {
    if (!isObject(order) || Object.keys(order).some(k => !['instrument_name', 'amount', 'price', 'label'].includes(k)) || !identifier(order.label, 64)) throw new Error('order');
    const put = action === 'sell_put', direction = put ? 'sell' : 'buy';
    if (!isObject(spec) || spec.validated !== true || spec.instrument_name !== order.instrument_name || spec.kind !== (put ? 'option' : 'spot') || spec.base_currency !== 'BTC' || spec.quote_currency !== 'USDC' || spec.instrument_type !== 'linear' || spec.is_active !== true || spec.state !== 'open') throw new Error('spec');
    if (!isObject(intent) || intent.confirmed !== true || !identifier(intent.intentId, 64) || intent.action !== action || intent.currency !== 'USDC' || intent.instrument_name !== order.instrument_name || intent.label !== order.label || intent.direction !== direction || intent.type !== 'limit' || intent.time_in_force !== 'immediate_or_cancel' || intent.post_only !== false || !Number.isSafeInteger(intent.expiresAt) || intent.expiresAt <= serverNow() || intent.expiresAt > serverNow() + 60000) throw new Error('intent');
    const amount = units(order.amount), price = units(order.price);
    if (amount !== units(intent.amount) || price !== units(intent.price)) throw new Error('intent');
    const increment = units(spec.min_trade_amount);
    if (amount < increment || amount % increment !== 0n) throw new Error('amount');
    let tick = units(spec.tick_size), previous = -1n, previousTick = tick;
    for (const step of array(spec.tick_size_steps, 30)) {
      const threshold = units(step.above_price, true), value = units(step.tick_size);
      if (threshold <= previous || value < previousTick || value % units(spec.tick_size) !== 0n) throw new Error('tick');
      if (price > threshold) tick = value;
      previous = threshold; previousTick = value;
    }
    if (price % tick !== 0n) throw new Error('price');
    let principal = amount * price;
    if (put) {
      if (!/^BTC_USDC-\d{1,2}[A-Z]{3}\d{2}-\d+(?:\.\d+)?-P$/.test(order.instrument_name) || spec.settlement_currency !== 'USDC' || spec.option_type !== 'put' || units(spec.contract_size) !== UNIT || !Number.isSafeInteger(spec.expiration_timestamp) || spec.expiration_timestamp <= serverNow()) throw new Error('put');
      const strike = units(spec.strike);
      if (strike !== units(intent.strike) || strike !== units(order.instrument_name.split('-')[2])) throw new Error('strike');
      principal = amount * strike;
    } else if (order.instrument_name !== 'BTC_USDC') throw new Error('spot');
    if (principal + units(intent.feeReserve, true) * UNIT > units(intent.maxFunds) * UNIT) throw new Error('funds');
    return { instrument_name: order.instrument_name, amount: rpcNumber(order.amount), price: rpcNumber(order.price), label: order.label, type: 'limit', time_in_force: 'immediate_or_cancel', post_only: false, valid_until: intent.expiresAt };
  }
  async function create(action, order, { spec, confirmedIntent, beforeSubmit } = {}) {
    if (!liveEnabled) return failure('live_disabled', '真实下单尚未启用');
    if (typeof beforeSubmit !== 'function') return failure('final_gate_refused', '发送前的本机最终检查未通过');
    if (unknownBlocked) return failure('reconciliation_required', '存在状态未知的订单；请先对账', true);
    const auth = await authenticate(); if (!auth.ok) return auth;
    if (!keyInfo || keyInfo.isMaster || keyInfo.readOnly || keyInfo.unsafePermissions || !keyInfo.keyEnabled || keyInfo.permissions.account !== 'read' || !['none', 'read'].includes(keyInfo.permissions.wallet) || sessionInfo.readOnly) return failure('account_preflight_required', '专用子账户及最小权限尚未核验');
    if (synchronizedAt === null || now() < synchronizedAt || now() - synchronizedAt > 30000) { const clock = await syncTime(); if (!clock.ok) return clock; }
    if (unknownBlocked || posting) return failure(unknownBlocked ? 'reconciliation_required' : 'order_in_flight', '已有订单等待核验', unknownBlocked);
    let p; try { p = validatedOrder(action, order, spec, confirmedIntent); } catch { return failure('invalid_intent', '确认范围、规格、步长、价格或资金无法核验'); }
    if (attempts.has(confirmedIntent.intentId) || labels.has(order.label)) return failure('intent_already_attempted', '该确认或标签已提交；请查询原订单');
    // Trusted local-service callback. No await is allowed between this gate and
    // invoking the fixed RPC write: a pause during auth/time awaits must win.
    try {
      const allowed = beforeSubmit();
      if (allowed !== true) {
        if (allowed instanceof Promise) allowed.catch(() => {});
        return failure('final_gate_refused', '发送前的本机最终检查未通过');
      }
    } catch { return failure('final_gate_refused', '发送前的本机最终检查未通过'); }
    attempts.set(confirmedIntent.intentId, 'sending'); labels.add(order.label); posting = true;
    const original = { ...p, direction: action === 'sell_put' ? 'sell' : 'buy', intentId: confirmedIntent.intentId, submittedAt: Math.floor(serverNow()) };
    submitted.set(order.label, original);
    const result = await rpc(action === 'sell_put' ? 'private/sell' : 'private/buy', p, { mutation: true }); posting = false;
    if (!result.ok) { attempts.set(original.intentId, result.error.unknown ? 'unknown' : 'rejected'); if (result.error.unknown) unknownBlocked = true; return result; }
    try {
      const data = { order: safeOrder(result.data.order), trades: array(result.data.trades).map(safeTrade) };
      if (!matchesOriginal(data.order, original)) throw new Error('ack');
      let total = 0n;
      const seen = new Set();
      for (const trade of data.trades) {
        if (trade.order_id !== data.order.order_id || trade.instrument_name !== original.instrument_name || trade.direction !== original.direction || seen.has(trade.trade_id) || trade.timestamp < original.submittedAt - 5000 || trade.timestamp > serverNow() + 2000 || (original.direction === 'buy' ? units(trade.price) > units(original.price) : units(trade.price) < units(original.price))) throw new Error('ack');
        seen.add(trade.trade_id); total += units(trade.amount);
      }
      if (total > units(data.order.filled_amount, true)) throw new Error('ack');
      attempts.set(original.intentId, 'accepted');
      return { ...result, status: 'accepted', data };
    } catch { attempts.set(original.intentId, 'unknown'); unknownBlocked = true; return failure('invalid_acknowledgement', '订单受理信息无法核验；请先对账', true); }
  }
  function matchesOriginal(row, original) {
    return row.instrument_name === original.instrument_name && row.label === original.label && row.direction === original.direction && row.order_type === 'limit' && row.time_in_force === 'immediate_or_cancel' && row.post_only === false && units(row.amount) === units(original.amount) && units(row.price) === units(original.price) && Number.isSafeInteger(row.creation_timestamp) && row.creation_timestamp >= original.submittedAt - 5000 && row.creation_timestamp <= original.submittedAt + 60000;
  }
  async function reconcileUnknownOrder(params) {
    const incomplete = () => failure('reconciliation_incomplete', '订单终态及全部成交尚未核验；禁止继续下单', true);
    if (!isObject(params) || Object.keys(params).some(k => !['currency', 'instrument_name', 'label'].includes(k)) || params.currency !== 'USDC') return failure('invalid_parameters', '对账参数无效');
    const original = submitted.get(params.label);
    if (!original || attempts.get(original.intentId) !== 'unknown' || params.instrument_name !== original.instrument_name) return failure('unknown_order_not_tracked', '该标签不是本实例记录的未知订单');
    if (reconciling || posting) return incomplete();
    reconciling = true;
    try {
      const byLabel = await read('getOrderStateByLabel', { currency: 'USDC', label: original.label });
      if (!byLabel.ok) return incomplete();
      const records = [...byLabel.data];
      for (const historical of [false, true]) {
        let continuation, complete = false;
        const seen = new Set();
        for (let page = 0; page < 10; page++) {
          const history = await read('getOrderHistory', { instrument_name: original.instrument_name, historical, count: 100, ...(continuation ? { continuation } : {}) });
          if (!history.ok) return incomplete();
          records.push(...history.data.orders.filter(row => row.label === original.label));
          const next = history.data.continuation;
          if (!next) { complete = true; break; }
          if (seen.has(next)) return incomplete();
          seen.add(next); continuation = next;
        }
        if (!complete) return incomplete();
      }
      if (!records.length) return incomplete();
      const first = records[0];
      for (const row of records) if (!matchesOriginal(row, original) || row.order_id !== first.order_id || row.order_state !== first.order_state || units(row.filled_amount, true) !== units(first.filled_amount, true) || !['filled', 'cancelled', 'rejected'].includes(row.order_state)) return incomplete();
      const filled = units(first.filled_amount, true);
      if ((first.order_state === 'filled' && filled !== units(original.amount)) || (first.order_state === 'rejected' && filled !== 0n)) return incomplete();
      const trades = new Map(); let total = 0n;
      for (const historical of [false, true]) {
        const found = await read('getTradesByOrder', { order_id: first.order_id, historical });
        if (!found.ok) return incomplete();
        for (const row of found.data) {
          if (row.order_id !== first.order_id || row.instrument_name !== original.instrument_name || row.direction !== original.direction || row.timestamp < original.submittedAt - 5000 || row.timestamp > serverNow() + 2000 || (original.direction === 'buy' ? units(row.price) > units(original.price) : units(row.price) < units(original.price))) return incomplete();
          const existing = trades.get(row.trade_id);
          if (existing ? JSON.stringify(existing) !== JSON.stringify(row) : false) return incomplete();
          if (!existing) { trades.set(row.trade_id, row); total += units(row.amount); }
        }
      }
      if (total !== filled) return incomplete();
      attempts.set(original.intentId, 'reconciled'); unknownBlocked = [...attempts.values()].some(v => v === 'unknown');
      return { ok: true, status: 'reconciled', data: { order: first, trades: [...trades.values()], filled_amount: first.filled_amount } };
    } catch { return incomplete(); }
    finally { reconciling = false; }
  }
  return Object.freeze({
    authenticate, syncTime, getApiInfo, getClock: () => ({ synchronized: synchronizedAt !== null, serverNow: Math.floor(serverNow()), syncedAt: synchronizedAt }),
    ...Object.fromEntries(Object.keys(READ).map(name => [name, params => read(name, params)])),
    createSellPut: (order, options) => create('sell_put', order, options), createSpotBuy: (order, options) => create('spot_buy', order, options), reconcileUnknownOrder,
    getExecutionState: () => ({ finalGateSupported: true, reconciliationRequired: unknownBlocked, attempts: [...attempts].map(([intentId, status]) => ({ intentId, status })) }),
  });
}

export class DeribitExecution { constructor(options) { return createDeribitExecution(options); } }

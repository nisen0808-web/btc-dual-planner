import { createHmac } from 'node:crypto';

// Local execution adapter. This module never reads credentials from disk or env.
// Order ACK is acceptance, not a fill. Durable intent/reconciliation belongs to the caller.
const SCALE = 10n ** 18n;
const BASES = new Set(['https://api.bybit.com', 'https://api-testnet.bybit.com']);
const ROUTES = Object.freeze({
  getApiInfo: '/v5/user/query-api', getAccountInfo: '/v5/account/info',
  getWalletBalance: '/v5/account/wallet-balance', getPositions: '/v5/position/list',
  getOrders: '/v5/order/realtime', getOrderHistory: '/v5/order/history',
  getExecutions: '/v5/execution/list', getDeliveryRecords: '/v5/asset/delivery-record',
  getFeeRates: '/v5/account/fee-rate',
});
const RULES = {
  getApiInfo: [], getAccountInfo: [], getWalletBalance: ['accountType', 'coin'],
  getPositions: ['category', 'symbol', 'baseCoin', 'settleCoin', 'limit', 'cursor'],
  getOrders: ['category', 'symbol', 'baseCoin', 'settleCoin', 'orderId', 'orderLinkId', 'openOnly', 'limit', 'cursor'],
  getOrderHistory: ['category', 'symbol', 'baseCoin', 'settleCoin', 'orderId', 'orderLinkId', 'orderStatus', 'startTime', 'endTime', 'limit', 'cursor'],
  getExecutions: ['category', 'symbol', 'baseCoin', 'settleCoin', 'orderId', 'orderLinkId', 'startTime', 'endTime', 'limit', 'cursor'],
  getDeliveryRecords: ['category', 'symbol', 'expDate', 'startTime', 'endTime', 'limit', 'cursor'],
  getFeeRates: ['category', 'symbol', 'baseCoin'],
};
const FIELDS = {
  getPositions: ['symbol', 'side', 'size', 'avgPrice', 'positionValue', 'positionStatus', 'positionIdx', 'markPrice', 'liqPrice', 'positionIM', 'positionMM', 'unrealisedPnl', 'curRealisedPnl', 'cumRealisedPnl', 'createdTime', 'updatedTime', 'seq'],
  getOrders: ['symbol', 'orderId', 'orderLinkId', 'side', 'orderType', 'timeInForce', 'price', 'qty', 'orderStatus', 'cumExecQty', 'cumExecValue', 'avgPrice', 'leavesQty', 'leavesValue', 'cumExecFee', 'feeCurrency', 'cancelType', 'rejectReason', 'createdTime', 'updatedTime', 'isLeverage', 'reduceOnly'],
  getExecutions: ['symbol', 'orderId', 'orderLinkId', 'side', 'execId', 'execQty', 'execPrice', 'execValue', 'execFee', 'feeCurrency', 'execType', 'execTime', 'isMaker', 'feeRate', 'closedSize', 'seq'],
  getDeliveryRecords: ['symbol', 'side', 'position', 'entryPrice', 'deliveryTime', 'deliveryPrice', 'strike', 'fee', 'deliveryRpl'],
};
FIELDS.getOrderHistory = FIELDS.getOrders;
const PERMISSIONS = {
  ContractTrade: ['Order', 'Position'], Spot: ['SpotTrade'],
  Wallet: ['AccountTransfer', 'SubMemberTransfer', 'SubMemberTransferList', 'Withdraw'],
  Options: ['OptionsTrade'], Derivatives: ['DerivativesTrade'],
};
const fail = (code, message, unknown = false) => ({ ok: false, status: unknown ? 'unknown' : 'error', error: { code, message, unknown } });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function pick(obj, keys) {
  if (!record(obj)) throw new Error('schema');
  const out = {};
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.length <= 512) out[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
    else if (value !== undefined && value !== null) throw new Error('schema');
  }
  return out;
}
function decimal(value, zero = false) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,11})(?:\.\d{1,18})?$/.test(value)) throw new Error('decimal');
  const [whole, fraction = ''] = value.split('.');
  const units = BigInt(whole) * SCALE + BigInt(fraction.padEnd(18, '0'));
  if (units < 0n || (!zero && units === 0n)) throw new Error('decimal');
  return units;
}
function matchesDecimal(a, b) { return decimal(a, true) === decimal(b, true); }
function signedDecimal(value) {
  if (typeof value !== 'string') throw new Error('decimal');
  return value.startsWith('-') ? -decimal(value.slice(1), true) : decimal(value, true);
}
function safeId(value, max = 128) { return typeof value === 'string' && value.length > 0 && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value); }
function cleanQuery(name, params = {}) {
  if (!record(params) || Object.keys(params).some(key => !RULES[name].includes(key))) throw new Error('params');
  const p = { ...params };
  if (name === 'getFeeRates' && !((p.category === 'spot' && p.symbol === 'BTCUSDT' && p.baseCoin === undefined) || (p.category === 'option' && p.baseCoin === 'BTC' && p.symbol === undefined))) throw new Error('params');
  if (name === 'getWalletBalance') {
    if (p.accountType !== undefined && p.accountType !== 'UNIFIED') throw new Error('params');
    p.accountType = 'UNIFIED';
    if (p.coin !== undefined && !/^[A-Z0-9]{2,12}(?:,[A-Z0-9]{2,12}){0,19}$/.test(p.coin)) throw new Error('params');
  }
  if (['getPositions', 'getOrders', 'getOrderHistory', 'getExecutions', 'getDeliveryRecords'].includes(name)) {
    const categories = name === 'getPositions' || name === 'getDeliveryRecords' ? ['option', 'linear', 'inverse'] : ['option', 'linear', 'inverse', 'spot'];
    if (!categories.includes(p.category)) throw new Error('params');
    if (name === 'getPositions' && p.category === 'linear' && !p.symbol && !p.settleCoin) throw new Error('params');
  }
  for (const [key, value] of Object.entries(p)) {
    if (['category', 'accountType', 'coin'].includes(key)) continue;
    if (key === 'limit') {
      const max = name === 'getPositions' ? 200 : name === 'getOrders' || name === 'getDeliveryRecords' || name === 'getOrderHistory' ? 50 : 100;
      if (!Number.isInteger(value) || value < 1 || value > max) throw new Error('params');
    } else if (key === 'openOnly') {
      if (![0, 1, 2].includes(value)) throw new Error('params');
    } else if (key === 'startTime' || key === 'endTime') {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('params');
    } else if (key === 'cursor') {
      if (typeof value !== 'string' || value.length > 1024 || /[\u0000-\u001f]/.test(value)) throw new Error('params');
    } else if (key === 'orderId' || key === 'orderLinkId') {
      if (!safeId(value, key === 'orderLinkId' ? 36 : 128)) throw new Error('params');
    } else if (key === 'symbol') {
      if (typeof value !== 'string' || !/^[A-Z0-9]+(?:-[A-Z0-9.]+){0,5}$/.test(value) || value.length > 80) throw new Error('params');
    } else if (key === 'baseCoin' || key === 'settleCoin') {
      if (typeof value !== 'string' || !/^[A-Z0-9]{2,12}$/.test(value)) throw new Error('params');
    } else if (key === 'expDate') {
      if (typeof value !== 'string' || !/^\d{1,2}[A-Z]{3}\d{2}$/.test(value)) throw new Error('params');
    } else if (key === 'orderStatus' && !['New', 'PartiallyFilled', 'Untriggered', 'Rejected', 'PartiallyFilledCanceled', 'Filled', 'Cancelled', 'Triggered', 'Deactivated'].includes(value)) throw new Error('params');
  }
  if (p.startTime && p.endTime && (p.endTime < p.startTime || p.endTime - p.startTime > (name === 'getDeliveryRecords' ? 30 : 7) * 86400000)) throw new Error('params');
  return new URLSearchParams(Object.keys(p).sort().map(key => [key, String(p[key])])).toString();
}
function safeResult(name, result) {
  if (!record(result)) throw new Error('schema');
  if (name === 'getApiInfo') {
    if (typeof result.isMaster !== 'boolean' || ![0, 1].includes(result.readOnly) || !record(result.permissions)) throw new Error('schema');
    const permissions = {};
    let unsafePermissions = false;
    for (const [scope, values] of Object.entries(result.permissions)) {
      if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) throw new Error('schema');
      const allowed = Object.prototype.hasOwnProperty.call(PERMISSIONS, scope) ? PERMISSIONS[scope] : undefined;
      if (allowed ? values.some(value => !allowed.includes(value)) : values.length > 0) unsafePermissions = true;
    }
    for (const [scope, allowed] of Object.entries(PERMISSIONS)) {
      const values = result.permissions[scope];
      if (values !== undefined && (!Array.isArray(values) || values.some(v => typeof v !== 'string'))) throw new Error('schema');
      permissions[scope] = (values || []).filter(v => allowed.includes(v));
    }
    return { isMaster: result.isMaster, readOnly: result.readOnly, permissions, unsafePermissions };
  }
  if (name === 'getAccountInfo') {
    if (!Number.isInteger(result.unifiedMarginStatus) || !['ISOLATED_MARGIN', 'REGULAR_MARGIN', 'PORTFOLIO_MARGIN'].includes(result.marginMode)) throw new Error('schema');
    return pick(result, ['unifiedMarginStatus', 'marginMode', 'spotHedgingStatus', 'updatedTime']);
  }
  if (name === 'getFeeRates') {
    if (!['spot', 'option'].includes(result.category) || !Array.isArray(result.list) || result.list.length !== 1) throw new Error('schema');
    const list = result.list.map(row => {
      const safe = pick(row, ['symbol', 'baseCoin', 'makerFeeRate', 'takerFeeRate']);
      if (result.category === 'spot' ? safe.symbol !== 'BTCUSDT' || (safe.baseCoin !== undefined && safe.baseCoin !== 'BTC') : safe.baseCoin !== 'BTC' || (safe.symbol !== undefined && safe.symbol !== '')) throw new Error('schema');
      const maker = signedDecimal(safe.makerFeeRate), taker = decimal(safe.takerFeeRate, true);
      if (maker <= -SCALE || maker >= SCALE || taker >= SCALE) throw new Error('schema');
      return safe;
    });
    return { category: result.category, list };
  }
  if (!Array.isArray(result.list) || result.list.length > 500) throw new Error('schema');
  if (name !== 'getWalletBalance' && (typeof result.nextPageCursor !== 'string' || result.nextPageCursor.length > 1024)) throw new Error('schema');
  const out = pick(result, ['category', 'nextPageCursor']);
  if (name === 'getWalletBalance') {
    out.list = result.list.map(row => {
      const safe = pick(row, ['accountType', 'totalEquity', 'totalWalletBalance', 'totalAvailableBalance', 'accountIMRate', 'accountMMRate']);
      if (!Array.isArray(row.coin) || row.coin.length > 500) throw new Error('schema');
      safe.coin = row.coin.map(coin => pick(coin, ['coin', 'walletBalance', 'equity', 'locked', 'borrowAmount', 'spotBorrow', 'usdValue']));
      return safe;
    });
  } else out.list = result.list.map(row => {
    const safe = pick(row, FIELDS[name]);
    if (typeof safe.symbol !== 'string' || safe.symbol.length === 0) throw new Error('schema');
    if (name === 'getPositions') {
      if (!['Buy', 'Sell', ''].includes(safe.side)) throw new Error('schema');
      decimal(safe.size, true);
    } else if (name === 'getOrders' || name === 'getOrderHistory') {
      if (!safeId(safe.orderId) || typeof safe.orderStatus !== 'string') throw new Error('schema');
      decimal(safe.qty); decimal(safe.cumExecQty, true);
    } else if (name === 'getExecutions') {
      if (!safeId(safe.execId) || !safeId(safe.orderId) || typeof safe.execType !== 'string') throw new Error('schema');
      decimal(safe.execQty, true); decimal(safe.execPrice, true); signedDecimal(safe.execFee);
      if (!Number.isSafeInteger(Number(safe.execTime)) || Number(safe.execTime) <= 0) throw new Error('schema');
    } else if (name === 'getDeliveryRecords') {
      if (!['Buy', 'Sell'].includes(safe.side) || !Number.isSafeInteger(Number(safe.deliveryTime)) || Number(safe.deliveryTime) <= 0) throw new Error('schema');
      decimal(safe.position); decimal(safe.deliveryPrice, true); decimal(safe.strike); signedDecimal(safe.fee); signedDecimal(safe.deliveryRpl);
    }
    if ((name === 'getOrders' || name === 'getOrderHistory') && record(row.cumFeeDetail)) {
      const fees = Object.entries(row.cumFeeDetail);
      if (fees.length > 20) throw new Error('schema');
      safe.cumFeeDetail = {};
      for (const [currency, fee] of fees) {
        if (!/^[A-Z0-9]{2,12}$/.test(currency)) throw new Error('schema');
        signedDecimal(fee); safe.cumFeeDetail[currency] = fee;
      }
    }
    return safe;
  });
  return out;
}

export function signV5({ apiKey, apiSecret, timestamp, recvWindow = 5000, payload = '' }) {
  return createHmac('sha256', apiSecret).update(`${timestamp}${apiKey}${recvWindow}${payload}`).digest('hex');
}

export function createBybitExecution({ apiKey = '', apiSecret = '', fetchImpl = globalThis.fetch, liveEnabled = false,
  baseUrl = 'https://api.bybit.com', timeoutMs = 8000, now = Date.now } = {}) {
  if (!BASES.has(baseUrl) || typeof fetchImpl !== 'function' || typeof now !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000 || typeof liveEnabled !== 'boolean') throw new Error('Invalid adapter configuration');
  if (typeof apiKey !== 'string' || typeof apiSecret !== 'string' || /[\r\n]/.test(apiKey) || /[\r\n]/.test(apiSecret)) throw new Error('Invalid credentials');
  let offset = 0, syncedAt = null, syncing = null, unknownBlocked = false, posting = false, reconciling = false;
  const attempts = new Map(), links = new Set(), submitted = new Map();
  const serverNow = () => now() + offset;
  async function send(path, { method = 'GET', query = '', body, signed = true } = {}) {
    const controller = new AbortController();
    let timer;
    const work = async () => {
      const headers = { Accept: 'application/json' };
      if (signed) {
        const timestamp = Math.floor(serverNow());
        Object.assign(headers, { 'X-BAPI-API-KEY': apiKey, 'X-BAPI-TIMESTAMP': String(timestamp), 'X-BAPI-RECV-WINDOW': '5000',
          'X-BAPI-SIGN': signV5({ apiKey, apiSecret, timestamp, payload: method === 'GET' ? query : body }) });
      }
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetchImpl(`${baseUrl}${path}${query ? `?${query}` : ''}`, { method, headers, body, signal: controller.signal, redirect: 'manual', credentials: 'omit', cache: 'no-store' });
      if (!response || !Number.isInteger(response.status)) throw new Error('schema');
      if (response.status >= 300 && response.status < 400) return fail('redirect_refused', '交易所重定向已拒绝', method === 'POST');
      const contentType = response.headers?.get('content-type') || '';
      if (!contentType.toLowerCase().includes('application/json')) return fail('invalid_response', '交易所未返回有效数据', method === 'POST');
      const length = Number(response.headers?.get('content-length'));
      if (length > 1048576) return fail('invalid_response', '交易所响应超过限制', method === 'POST');
      let raw = '';
      if (response.body?.getReader) {
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let bytes = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > 1048576) { await reader.cancel(); return fail('invalid_response', '交易所响应超过限制', method === 'POST'); }
            raw += decoder.decode(part.value, { stream: true });
          }
          raw += decoder.decode();
        } finally { reader.releaseLock(); }
      } else raw = await response.text();
      if (Buffer.byteLength(raw) > 1048576) return fail('invalid_response', '交易所响应超过限制', method === 'POST');
      let json;
      try { json = JSON.parse(raw); } catch { return fail('invalid_response', '交易所数据无法验证', method === 'POST'); }
      if (!record(json) || !Number.isInteger(json.retCode)) return fail('invalid_response', '交易所数据无法验证', method === 'POST');
      if (json.retCode !== 0) {
        const auth = [10003, 10004, 10005, 10007, 33004].includes(json.retCode);
        const unknown = method === 'POST' && (response.status >= 500 || [10000, 10014, 10016, 10019].includes(json.retCode));
        return { ...fail(auth ? 'authorization_required' : 'exchange_rejected', auth ? '账户认证或权限校验失败' : unknown ? '交易所未明确确认订单结果；请先对账' : '交易所拒绝了请求', unknown), exchangeCode: json.retCode };
      }
      if (response.status !== 200) return fail('http_error', '交易所请求未成功', method === 'POST');
      return { ok: true, status: 'ready', data: json.result, serverTime: Number.isSafeInteger(json.time) ? json.time : undefined };
    };
    try {
      return await Promise.race([work(), new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(fail('timeout', '请求超时；请先对账', method === 'POST')); }, timeoutMs); })]);
    } catch { return fail('network_error', '请求状态无法确认；请先对账', method === 'POST'); }
    finally { clearTimeout(timer); }
  }
  async function syncTime() {
    if (syncing) return syncing;
    syncing = (async () => {
      const started = now();
      const result = await send('/v5/market/time', { signed: false });
      const ended = now();
      if (!result.ok) return result;
      let time = result.serverTime;
      if (!Number.isSafeInteger(time) && record(result.data) && /^\d{16,22}$/.test(result.data.timeNano)) time = Number(BigInt(result.data.timeNano) / 1000000n);
      if (!Number.isSafeInteger(time) || time <= 0 || !Number.isFinite(started) || !Number.isFinite(ended) || ended < started || ended - started > 2000) return fail('clock_unverified', '服务器时间无法可靠校准');
      offset = time - (started + ended) / 2;
      syncedAt = ended;
      return { ok: true, status: 'ready', data: { serverTime: time, clockOffsetMs: offset, roundTripMs: ended - started } };
    })();
    try { return await syncing; } finally { syncing = null; }
  }
  async function signedReady() {
    if (!apiKey || !apiSecret) return fail('authorization_required', '需要本机配置交易账户授权');
    if (syncedAt === null || now() < syncedAt || now() - syncedAt > 30000) return syncTime();
    return { ok: true };
  }
  async function read(name, params) {
    let query;
    try { query = cleanQuery(name, params); } catch { return fail('invalid_parameters', '只读查询参数无效'); }
    const ready = await signedReady();
    if (!ready.ok) return ready;
    const result = await send(ROUTES[name], { query });
    if (!result.ok) return result;
    try {
      if (params?.category && result.data.category !== params.category) throw new Error('schema');
      return { ...result, data: safeResult(name, result.data) };
    }
    catch { return fail('invalid_response', '交易所返回字段不完整或无法验证'); }
  }
  function validateOrder(action, order, spec, intent) {
    if (!record(order) || Object.keys(order).some(k => !['symbol', 'qty', 'price', 'orderLinkId'].includes(k))) throw new Error('order');
    if (!record(spec) || spec.validated !== true || spec.status !== 'Trading' || spec.baseCoin !== 'BTC' || spec.quoteCoin !== 'USDT' || !record(spec.priceFilter) || !record(spec.lotSizeFilter)) throw new Error('spec');
    const put = action === 'sell_put', category = put ? 'option' : 'spot', side = put ? 'Sell' : 'Buy';
    if (spec.category !== category || spec.symbol !== order.symbol || !safeId(order.orderLinkId, 36)) throw new Error('spec');
    if (!record(intent) || intent.confirmed !== true || !safeId(intent.intentId, 64) || intent.action !== action || !Number.isSafeInteger(intent.expiresAt) || intent.expiresAt <= serverNow() || intent.expiresAt - serverNow() > 60000) throw new Error('intent');
    for (const [field, expected] of Object.entries({ category, symbol: order.symbol, side, orderType: 'Limit', timeInForce: 'IOC', orderLinkId: order.orderLinkId })) if (intent[field] !== expected) throw new Error('intent');
    if (!matchesDecimal(order.qty, intent.qty) || !matchesDecimal(order.price, intent.price)) throw new Error('intent');
    const qty = decimal(order.qty), price = decimal(order.price), pf = spec.priceFilter, lf = spec.lotSizeFilter;
    const tick = decimal(pf.tickSize);
    if (price % tick !== 0n || (put && (price < decimal(pf.minPrice, true) || price > decimal(pf.maxPrice)))) throw new Error('price');
    // Spot instrument metadata specifies tickSize; do not invent absent min/max prices.
    if (!put && ((pf.minPrice !== undefined && price < decimal(pf.minPrice, true)) || (pf.maxPrice !== undefined && price > decimal(pf.maxPrice)))) throw new Error('price');
    const step = decimal(put ? lf.qtyStep : lf.basePrecision);
    const maxQty = decimal(put ? lf.maxOrderQty : lf.maxLimitOrderQty);
    if (qty % step !== 0n || qty > maxQty || (put && qty < decimal(lf.minOrderQty))) throw new Error('qty');
    const maxFunds = decimal(intent.maxFunds), reserve = decimal(intent.feeReserve, true);
    let principal;
    if (put) {
      if (spec.optionsType !== 'Put' || spec.settleCoin !== 'USDT' || !/^BTC-\d{1,2}[A-Z]{3}\d{2}-\d+(?:\.\d+)?-P-USDT$/.test(order.symbol) || !Number.isSafeInteger(Number(spec.deliveryTime)) || Number(spec.deliveryTime) <= serverNow()) throw new Error('spec');
      const strike = decimal(spec.strike);
      if (!matchesDecimal(spec.strike, order.symbol.split('-')[2]) || !matchesDecimal(spec.strike, intent.strike)) throw new Error('strike');
      principal = qty * strike;
    } else {
      if (order.symbol !== 'BTCUSDT' || intent.isLeverage !== 0) throw new Error('spec');
      principal = qty * price;
      if (principal < decimal(lf.minOrderAmt) * SCALE || principal > decimal(lf.maxOrderAmt) * SCALE) throw new Error('notional');
    }
    if (principal + reserve * SCALE > maxFunds * SCALE) throw new Error('funds');
    return { category, symbol: order.symbol, side, orderType: 'Limit', timeInForce: 'IOC', qty: order.qty, price: order.price, orderLinkId: order.orderLinkId, ...(put ? {} : { isLeverage: 0, orderFilter: 'Order' }) };
  }
  async function create(action, order, { spec, confirmedIntent } = {}) {
    if (!liveEnabled) return fail('live_disabled', '真实下单尚未启用');
    if (unknownBlocked) return fail('reconciliation_required', '存在状态未知的订单；完成对账前禁止继续下单', true);
    const ready = await signedReady();
    if (!ready.ok) return ready;
    if (unknownBlocked) return fail('reconciliation_required', '存在状态未知的订单；完成对账前禁止继续下单', true);
    if (posting) return fail('order_in_flight', '已有订单等待确认；请先对账');
    let payload;
    try { payload = validateOrder(action, order, spec, confirmedIntent); }
    catch { return fail('invalid_intent', '确认内容、合约规格、限价、数量或资金范围无法验证'); }
    if (attempts.has(confirmedIntent.intentId) || links.has(order.orderLinkId)) return fail('intent_already_attempted', '该确认已提交过；请查询原订单');
    attempts.set(confirmedIntent.intentId, 'sending'); links.add(order.orderLinkId); posting = true;
    submitted.set(order.orderLinkId, { ...payload, intentId: confirmedIntent.intentId, submittedAt: Math.floor(serverNow()) });
    const result = await send('/v5/order/create', { method: 'POST', body: JSON.stringify(payload) });
    posting = false;
    if (!result.ok) {
      attempts.set(confirmedIntent.intentId, result.error.unknown ? 'unknown' : 'rejected');
      if (result.error.unknown) unknownBlocked = true;
      return result;
    }
    if (!record(result.data) || !safeId(result.data.orderId) || result.data.orderLinkId !== order.orderLinkId) {
      attempts.set(confirmedIntent.intentId, 'unknown'); unknownBlocked = true;
      return fail('invalid_acknowledgement', '订单受理结果无法核验；请先对账', true);
    }
    attempts.set(confirmedIntent.intentId, 'accepted');
    return { ok: true, status: 'accepted', data: { orderId: result.data.orderId, orderLinkId: result.data.orderLinkId }, serverTime: result.serverTime };
  }
  async function reconcileUnknownOrder(params) {
    const incomplete = () => fail('reconciliation_incomplete', '原订单终态和全部成交尚未完成核对；禁止继续下单', true);
    if (!record(params) || Object.keys(params).some(k => !['category', 'symbol', 'orderLinkId'].includes(k))) return fail('invalid_parameters', '对账参数无效');
    const original = submitted.get(params.orderLinkId);
    if (!original || attempts.get(original.intentId) !== 'unknown' || params.category !== original.category || params.symbol !== original.symbol) return fail('unknown_order_not_tracked', '该订单不是本实例记录的未知订单');
    if (reconciling || posting) return fail('reconciliation_in_progress', '已有订单操作或对账正在执行', true);
    reconciling = true;
    try {
      const query = { category: original.category, symbol: original.symbol, orderLinkId: original.orderLinkId };
      async function allPages(name, extra = {}) {
        const rows = [], seenCursors = new Set();
        let cursor;
        for (let page = 0; page < 10; page++) {
          const result = await read(name, { ...query, ...extra, limit: name === 'getExecutions' ? 100 : 50, ...(cursor ? { cursor } : {}) });
          if (!result.ok) return null;
          rows.push(...result.data.list);
          if (rows.length > 1000) return null;
          const next = result.data.nextPageCursor;
          if (!next) return rows;
          if (seenCursors.has(next)) return null;
          seenCursors.add(next); cursor = next;
        }
        return null;
      }
      const realtime = await allPages('getOrders');
      if (!realtime) return incomplete();
      const range = { startTime: Math.max(1, original.submittedAt - 60000), endTime: Math.min(Math.floor(serverNow()), original.submittedAt + 86400000) };
      const history = await allPages('getOrderHistory', range);
      if (!history) return incomplete();
      const executions = await allPages('getExecutions', range);
      if (!executions) return incomplete();
      const orders = [...realtime, ...history];
      if (!orders.length) return incomplete();
      const first = orders[0], qty = decimal(original.qty), filled = decimal(first.cumExecQty, true);
      const terminal = ['Filled', 'Cancelled', 'Rejected', ...(original.category === 'spot' ? ['PartiallyFilledCanceled'] : [])];
      for (const row of orders) {
        if (row.symbol !== original.symbol || row.orderLinkId !== original.orderLinkId || row.orderId !== first.orderId || row.side !== original.side || row.orderType !== 'Limit' || row.timeInForce !== 'IOC' || !matchesDecimal(row.qty, original.qty) || !matchesDecimal(row.price, original.price) || !terminal.includes(row.orderStatus) || row.orderStatus !== first.orderStatus || decimal(row.cumExecQty, true) !== filled) return incomplete();
        const created = Number(row.createdTime);
        if (!Number.isSafeInteger(created) || created < original.submittedAt - 5000 || created > original.submittedAt + 60000 || created > serverNow() + 2000) return incomplete();
      }
      if (filled > qty || (first.orderStatus === 'Filled' && filled !== qty) || (first.orderStatus === 'Rejected' && filled !== 0n) || (first.orderStatus === 'PartiallyFilledCanceled' && (filled === 0n || filled >= qty))) return incomplete();
      const unique = new Map();
      let total = 0n;
      for (const row of executions) {
        if (row.symbol !== original.symbol || row.orderLinkId !== original.orderLinkId || row.orderId !== first.orderId || row.side !== original.side || row.execType !== 'Trade') return incomplete();
        if (Number(row.execTime) < original.submittedAt - 5000 || Number(row.execTime) > serverNow() + 2000) return incomplete();
        const executedQty = decimal(row.execQty), executedPrice = decimal(row.execPrice);
        if ((original.side === 'Buy' && executedPrice > decimal(original.price)) || (original.side === 'Sell' && executedPrice < decimal(original.price))) return incomplete();
        const existing = unique.get(row.execId);
        if (existing) {
          if (JSON.stringify(existing) !== JSON.stringify(row)) return incomplete();
        } else { unique.set(row.execId, row); total += executedQty; }
      }
      if (total !== filled) return incomplete();
      attempts.set(original.intentId, 'reconciled');
      unknownBlocked = [...attempts.values()].some(status => status === 'unknown');
      return { ok: true, status: 'reconciled', data: { category: original.category, symbol: original.symbol, orderId: first.orderId, orderLinkId: original.orderLinkId, orderStatus: first.orderStatus, filledQty: first.cumExecQty, executions: [...unique.values()] } };
    } catch { return incomplete(); }
    finally { reconciling = false; }
  }
  return Object.freeze({
    syncTime, getClock: () => ({ synchronized: syncedAt !== null, serverNow: Math.floor(serverNow()), syncedAt }),
    ...Object.fromEntries(Object.keys(ROUTES).map(name => [name, params => read(name, params)])),
    createSellPut: (order, options) => create('sell_put', order, options),
    createSpotBuy: (order, options) => create('spot_buy', order, options),
    reconcileUnknownOrder,
    getExecutionState: () => ({ reconciliationRequired: unknownBlocked, attempts: [...attempts].map(([intentId, status]) => ({ intentId, status })) }),
  });
}

export class BybitExecution {
  constructor(options) { return createBybitExecution(options); }
}

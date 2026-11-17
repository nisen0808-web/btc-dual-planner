// Coinbase Global Derivatives uses Deribit's BTC_USDC linear options order book.
const CB_PUBLIC_ROOT = 'https://www.deribit.com/api/v2/public/';
const CB_FEES = 'https://help.coinbase.com/en-sg/coinbase/derivatives/derivatives-fees';
const CB_TERMS = 'https://help.coinbase.com/en/coinbase/derivatives/global-derivatives-linear-usdc-options';
const CB_TTL = 30_000;
// The official instrument list is cached for about a minute; it identifies contracts, not executable prices.
const CB_DIRECTORY_TTL = 120_000;
const CB_PAUSED = new Map([['locked','已锁盘'], ['halted','已暂停交易'], ['settlement','正在结算']]);
const CB_MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const cbPositive = value => Number.isFinite(value) && value > 0;
const cbFresh = (stamp, now, ttl = CB_TTL) => Number.isSafeInteger(stamp) && stamp > 0 && stamp <= now + 2_000 && now - stamp < ttl;

function cbContractIdentity(symbol) {
  const parts = /^BTC_USDC-([1-9]|[12]\d|3[01])([A-Z]{3})(\d{2})-([1-9]\d{0,8})-([CP])$/.exec(symbol);
  if (!parts) return null;
  const month = CB_MONTHS.indexOf(parts[2]);
  if (month < 0) return null;
  const expires = Date.UTC(2000 + Number(parts[3]), month, Number(parts[1]), 8);
  if (new Date(expires).getUTCMonth() !== month) return null;
  return {symbol, direction: parts[5] === 'C' ? 'CALL' : 'PUT', expires, strike: Number(parts[4])};
}

function cbContract(row, now) {
  if (row.base_currency !== 'BTC' || row.kind !== 'option' || row.instrument_type !== 'linear' ||
      row.settlement_currency !== 'USDC' || row.quote_currency !== 'USDC' || row.price_index !== 'btc_usdc' ||
      row.is_active !== true || (row.state != null && row.state !== 'open' && !CB_PAUSED.has(row.state)) || row.contract_size !== 1) return null;
  const instrument = cbContractIdentity(row.instrument_name);
  if (!instrument || instrument.expires <= now || instrument.expires !== row.expiration_timestamp ||
      instrument.strike !== row.strike || instrument.direction.toLowerCase() !== row.option_type ||
      !cbPositive(row.min_trade_amount) || !cbPositive(row.tick_size)) return null;
  const min = row.min_trade_amount / row.contract_size;
  return {...instrument, optionType: instrument.direction, unit: row.contract_size, min, step: min,
    priceTick: row.tick_size, coin: 'USDC', settleCoin: 'USDC', strikeCurrency: 'USDC', quoteCurrency: 'USDC',
    maker: 0.001, taker: 0.001, cap: 0.125, delivery: null, deliveryCap: null,
    feeBasis: 'Coinbase 普通 App 公开费率', feeSource: CB_FEES};
}

function cbLevels(rows, side) {
  if (!Array.isArray(rows) || rows.length > 100) throw Error('Deribit 盘口深度无效');
  let previous = side === 'bids' ? Infinity : 0;
  return rows.map(level => {
    if (!Array.isArray(level) || level.length !== 2) throw Error('Deribit 盘口档位无效');
    const [price, amountBTC] = level;
    if (!cbPositive(price) || !cbPositive(amountBTC) || (side === 'bids' ? price >= previous : price <= previous)) {
      throw Error('Deribit 盘口价格或数量无效');
    }
    previous = price;
    // Accepted BTC_USDC options represent one BTC per contract. Book size is underlying BTC.
    return {price, qty: amountBTC};
  });
}

function createCoinbasePublicReader({fetchImpl = (...args) => fetch(...args), clock = Date.now} = {}) {
  let catalogue, cataloguePending, index, indexPending;

  async function rpc(method, params) {
    const url = CB_PUBLIC_ROOT + method + '?' + new URLSearchParams(params);
    const reply = await fetchImpl(url, {
      method: 'GET', headers: {accept: 'application/json'}, signal: AbortSignal.timeout(12_000),
      credentials: 'omit', cache: 'no-store', redirect: 'manual'
    });
    if (!reply.ok) throw Error('Deribit 公开接口返回 HTTP ' + reply.status);
    const limit = method === 'get_instruments' ? 6_000_000 : 128_000;
    if (Number(reply.headers.get('content-length')) > limit) throw Error('Deribit 公开响应过大');
    const stream = reply.body?.getReader();
    if (!stream) throw Error('Deribit 公开接口未返回数据');
    const decoder = new TextDecoder();
    let total = 0, body = '';
    for (;;) {
      const {done, value} = await stream.read();
      if (done) break;
      total += value.length;
      if (total > limit) {await stream.cancel(); throw Error('Deribit 公开响应过大');}
      body += decoder.decode(value, {stream: true});
    }
    const json = JSON.parse(body + decoder.decode());
    const time = Math.floor(json.usOut / 1000);
    if (json.jsonrpc !== '2.0' || json.testnet !== false || json.error || json.result == null ||
        !cbFresh(time, clock(), method === 'get_instruments' ? CB_DIRECTORY_TTL : CB_TTL)) {
      throw Error('Deribit 生产行情缺失、已过期或无法核实时刻');
    }
    return {value: json.result, time};
  }

  async function directory() {
    if (catalogue && clock() - catalogue.receivedAt < 60_000 && cbFresh(catalogue.time, clock(), CB_DIRECTORY_TTL)) return catalogue;
    if (!cataloguePending) cataloguePending = rpc('get_instruments', {currency:'USDC', kind:'option', expired:'false'}).then(listed => {
      if (!Array.isArray(listed.value)) throw Error('Deribit 合约目录格式无效');
      const now = clock(), contracts = listed.value.map(row => cbContract(row,now)).filter(Boolean);
      if (new Set(contracts.map(c => c.symbol)).size !== contracts.length) throw Error('Deribit 返回重复合约');
      catalogue = {contracts,time:listed.time,receivedAt:now};
      return catalogue;
    }).finally(() => { cataloguePending = null; });
    return cataloguePending;
  }

  async function currentIndex() {
    if (index && cbFresh(index.time,clock(),8_000)) return index;
    if (!indexPending) indexPending = rpc('get_index_price', {index_name:'btc_usdc'}).then(result => {
      if (!cbPositive(result.value.index_price)) throw Error('Deribit BTC/USDC 指数不可用');
      index = {spot:result.value.index_price,time:result.time};
      return index;
    }).finally(() => { indexPending = null; });
    return indexPending;
  }

  async function market(direction) {
    const [listed, current] = await Promise.all([directory(), currentIndex()]);
    const now = clock();
    if (!cbFresh(current.time,now)) throw Error('Deribit BTC/USDC 指数已过期');
    if (!cbFresh(listed.time,now,CB_DIRECTORY_TTL)) throw Error('Deribit BTC/USDC 挂牌目录已过期');
    const contracts = listed.contracts.filter(item => item.direction === direction && item.expires > now);
    return {contracts,spot:current.spot,indexTime:current.time,time:current.time,catalogueTime:listed.time,receivedAt:now};
  }

  async function orderBook(identity) {
    if (identity.expires <= clock()) throw Error('该 Deribit 期权已到期');
    const {value, time} = await rpc('get_order_book', {instrument_name: identity.symbol, depth: '100'});
    if (value.instrument_name !== identity.symbol || !cbFresh(value.timestamp, clock())) throw Error('Deribit 盘口与所选合约或最新时刻不符');
    if (value.state !== 'open') {
      const state = CB_PAUSED.get(value.state);
      if (!state) throw Error('Deribit ' + identity.symbol + ' 的盘口未开放交易');
      return {status:'unavailable',symbol:identity.symbol,bookState:value.state,
        time:Math.min(value.timestamp,time),reason:identity.symbol + ' · Deribit ' + state + '，当前无法按盘口计算收益。'};
    }
    if (!cbPositive(value.index_price) ||
        !Number.isSafeInteger(value.change_id) || value.change_id < 0) throw Error('Deribit 盘口与所选合约或最新时刻不符');
    const bids = cbLevels(value.bids, 'bids'), asks = cbLevels(value.asks, 'asks');
    if (bids.length && asks.length && bids[0].price >= asks[0].price) throw Error('Deribit 买卖盘交叉');
    return {symbol: identity.symbol, bids, asks, time: Math.min(value.timestamp, time), receivedAt: clock(),
      spot: value.index_price, indexPrice: value.index_price};
  }

  return async function handle(request) {
    const {pathname, searchParams} = new URL(request.url);
    const headers = {'cache-control': 'no-store', 'x-content-type-options': 'nosniff'};
    const error = (reason, status) => Response.json({status: 'unavailable', platform: 'coinbase', reason}, {status, headers});
    if (request.method !== 'GET') return error('公开行情仅支持 GET', 405);
    if (pathname !== '/api/coinbase/market' && pathname !== '/api/coinbase/book') return error('未知公开行情路径', 404);
    if (searchParams.size !== 1) return error('请选择方向或合约', 400);
    const direction = searchParams.get('type'), symbol = searchParams.get('symbol');
    const identity = symbol && cbContractIdentity(symbol);
    const isMarket = pathname.endsWith('/market');
    if (isMarket ? !['CALL','PUT'].includes(direction) : !identity) return error('请选择有效的 BTC/USDC 期权', 400);
    try {
      const data = isMarket ? await market(direction) : await orderBook(identity);
      return Response.json({status: 'ready', platform: 'coinbase', venue: 'Deribit', indexCoin: 'USDC',
        currency: 'USDC', source: CB_PUBLIC_ROOT, feeSource: CB_FEES, productSource: CB_TERMS, ...data}, {headers});
    } catch (cause) {
      const msg = cause?.name === 'TimeoutError' ? '读取 Deribit 盘口超时' :
        cause?.message?.startsWith('Deribit') || cause?.message?.includes('期权已到期') ? cause.message : 'Deribit 公开行情暂时无法读取';
      return error(msg, 503);
    }
  };
}

const handleCoinbasePublic = createCoinbasePublicReader();

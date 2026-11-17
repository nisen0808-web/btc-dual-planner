// Anonymous OKX market data. Keep these URLs fixed and forward no visitor headers.
const OKX_PUBLIC_ROOT = 'https://www.okx.com';
const OKX_FEE_SCHEDULE = OKX_PUBLIC_ROOT + '/help/updates-to-global-fee-framework';
const OKX_FEE_RULES = OKX_PUBLIC_ROOT + '/help/okx-to-adjust-parameters-for-options-fee-calculation';
const OKX_MAX_AGE = 30_000;
const okxNumber = value => typeof value === 'number' || (typeof value === 'string' && value.trim() !== '') ? Number(value) : NaN;
const okxPositive = value => Number.isFinite(value) && value > 0;
const okxFresh = (time, now) => Number.isSafeInteger(time) && time > 0 && time <= now + 2_000 && now - time < OKX_MAX_AGE;

function okxContractId(symbol) {
  const match = /^BTC-USD-(\d{6})-([1-9]\d{0,7}(?:\.\d{1,4})?)-([CP])$/.exec(symbol);
  if (!match) return null;
  const date = match[1], expires = Date.UTC(2000 + Number(date.slice(0,2)), Number(date.slice(2,4)) - 1, Number(date.slice(4)), 8);
  if (new Date(expires).toISOString().slice(2,10).replaceAll('-', '') !== date) return null;
  return {expires, strike:Number(match[2]), direction:match[3] === 'C' ? 'CALL' : 'PUT'};
}

function createOkxPublicReader({fetchImpl = (...args) => fetch(...args), clock = Date.now} = {}) {
  const cache = new Map(), pending = new Map();
  async function read(path) {
    const response = await fetchImpl(OKX_PUBLIC_ROOT + path, {
      method:'GET', headers:{accept:'application/json'}, credentials:'omit', redirect:'manual',
      cache:'no-store', signal:AbortSignal.timeout(12_000)
    });
    if (!response.ok) throw Error('OKX 公开数据源返回 HTTP ' + response.status);
    const httpTime = Date.parse(response.headers.get('date') || '');
    if (!okxFresh(httpTime, clock())) throw Error('OKX 来源响应时间缺失或已超过 30 秒');
    const body = await response.json();
    if ((body?.code !== 0 && body?.code !== '0') || !body.data) throw Error('OKX 公开数据源暂未返回有效报价');
    return {data:body.data, httpTime};
  }

  async function indexPrice(pair) {
    const {data,httpTime} = await read('/api/v5/market/index-tickers?instId=' + pair);
    const row = Array.isArray(data) && data.find(item => item.instId === pair);
    const price = okxNumber(row?.idxPx), time = okxNumber(row?.ts);
    if (!okxPositive(price) || !okxFresh(time,clock())) throw Error('OKX ' + pair + ' 指数过期或不可用');
    return {price,time:Math.min(time,httpTime),indexTime:time};
  }

  async function market(direction) {
    const [specs, usd, usdt] = await Promise.all([
      read('/api/v5/public/instruments?instType=OPTION&instFamily=BTC-USD'),
      indexPrice('BTC-USD'), indexPrice('BTC-USDT').catch(() => null)
    ]);
    if (!Array.isArray(specs.data) || specs.data.length > 10_000) throw Error('OKX 未返回有效期权合约列表');
    const contracts = [];
    for (const row of specs.data) {
      if (row.state !== 'live' || row.instType !== 'OPTION' || row.instFamily !== 'BTC-USD' ||
          row.uly !== 'BTC-USD' || row.ctType !== 'inverse' || row.ctValCcy !== 'BTC' || row.settleCcy !== 'BTC') continue;
      const symbol = row.instId, id = okxContractId(symbol);
      const unit = okxNumber(row.ctVal) * okxNumber(row.ctMult);
      const step = okxNumber(row.lotSz), min = okxNumber(row.minSz), max = okxNumber(row.maxLmtSz);
      if (!id || id.direction !== direction || row.optType !== direction[0] || id.expires !== okxNumber(row.expTime) ||
          id.expires <= clock() || id.strike !== okxNumber(row.stk) || ![unit,step,min,max].every(okxPositive) || min > max) continue;
      contracts.push({...id,symbol,unit,step,min,max,coin:'BTC',quoteCoin:'BTC',settleCoin:'BTC',strikeCoin:'USD',
        maker:0.0003,taker:0.0003,cap:0.07,delivery:0.0002,deliveryCap:0.07,dailyExemptionVerified:false,
        feeBasis:'公开普通等级；日权行权费豁免须核实',feeSource:OKX_FEE_SCHEDULE,deliverySource:OKX_FEE_RULES});
    }
    if (!contracts.length) throw Error('OKX 暂无通过校验的 BTC ' + direction + ' 挂牌合约');
    const time = Math.min(specs.httpTime,usd.time,usdt?.time ?? usd.time);
    if (!okxFresh(time,clock())) throw Error('OKX 指数或挂牌列表已过期');
    return {platform:'okx',status:'ready',time,spot:usd.price,index:usd.price,indexCoin:'USD',indexTime:usd.indexTime,
      spotUSDT:usdt?.price ?? null,indexUSDTTime:usdt?.indexTime ?? null,contracts};
  }

  function levels(rows, descending) {
    if (!Array.isArray(rows) || rows.length > 400) throw Error('OKX 盘口数据格式无效');
    let prior = descending ? Infinity : 0;
    return rows.map(level => {
      if (!Array.isArray(level)) throw Error('OKX 盘口档位格式无效');
      const price = okxNumber(level[0]), qty = okxNumber(level[1]);
      if (!okxPositive(price) || !okxPositive(qty) || (descending ? price >= prior : price <= prior)) throw Error('OKX 盘口价格或数量无效');
      prior = price;
      return {price,qty};
    });
  }

  async function book(symbol) {
    const {data,httpTime} = await read('/api/v5/market/books?instId=' + encodeURIComponent(symbol) + '&sz=400');
    const row = Array.isArray(data) && data.length === 1 && data[0];
    const stamp = okxNumber(row?.ts), time = Math.min(stamp,httpTime);
    if (!row || (row.instId && row.instId !== symbol) || !okxFresh(stamp,clock()) || !okxFresh(time,clock())) throw Error('OKX 盘口身份或时间无效');
    const bids = levels(row.bids,true), asks = levels(row.asks,false);
    if (bids.length && asks.length && bids[0].price >= asks[0].price) throw Error('OKX 盘口交叉，等候更新');
    return {platform:'okx',status:'ready',time,symbol,quoteCoin:'BTC',settleCoin:'BTC',bids,asks};
  }

  async function dual(direction) {
    const {data,httpTime} = await read('/priapi/v2/sfp/dcd/products?currencyId=0&altCurrencyId=7&dcdOptionType=' + direction);
    if (!Array.isArray(data.products) || data.products.length > 10_000 || data.isVip === true) throw Error('OKX 暂未返回普通双币产品列表');
    const now = clock(), products = [];
    let eligible = 0;
    for (const item of data.products) {
      if (item.productType !== 'DualCurrencyDeposit' || item.dcdType !== 'Standard' || item.protectionProduct !== false ||
          item.type !== direction || item.currency !== 'BTC' || item.alternativeCurrency !== 'USDT' ||
          item.index !== 'BTC-USD' || okxNumber(item.status) !== 1) continue;
      const open = okxNumber(item.launchTime), close = okxNumber(item.stopTradingTime);
      if (!okxPositive(open) || !okxPositive(close) || now < open || now >= close) continue;
      eligible++;
      const term = okxNumber(item.absYield), apr = okxNumber(item.annualYield), hours = okxNumber(item.dcdTerm);
      const id = item.ndBrokerProductId, strike = okxNumber(item.strike), expires = okxNumber(item.expiryTime);
      const idInfo = typeof id === 'string' && id.startsWith('BTC-USDT-') && okxContractId(id.replace('BTC-USDT-','BTC-USD-'));
      const start = okxNumber(item.interestAccrualTime), time = okxNumber(item.quoteResponseTime);
      if (!idInfo || idInfo.direction !== direction || idInfo.expires !== expires || idInfo.strike !== strike ||
          expires <= now || expires !== okxNumber(item.settlementTime) || !okxFresh(time,now) ||
          !okxPositive(hours) || !okxPositive(start) || Math.abs(expires - start - hours * 3_600_000) > 1 ||
          !Number.isFinite(term) || term < 0 || !Number.isFinite(apr) || apr < 0) continue;
      const coin = direction === 'CALL' ? 'BTC' : 'USDT';
      products.push({id,direction,strike,expires,coin,investCoin:coin,strikeCoin:'USDT',indexCoin:'USD',
        apr,term,periodRate:term,days:hours / 24,time,min:null,max:null,step:null,amountRulesVerified:false,
        purchaseEnd:close});
    }
    if (eligible && !products.length) throw Error('OKX 双币产品报价已过期或产品条件未通过校验');
    return {platform:'okx',status:'ready',time:httpTime,products,amountRulesVerified:false,sourceType:'public_web'};
  }

  return async function handle(request) {
    const url = new URL(request.url), path = url.pathname;
    const respond = (body,status=200) => Response.json(body,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
    const fail = (reason,status) => respond({platform:'okx',status:'unavailable',reason},status);
    if (request.method !== 'GET') return fail('行情仅支持 GET',405);
    if (!['/api/okx/market','/api/okx/book','/api/okx/dual'].includes(path)) return fail('无此行情接口',404);
    const isBook = path.endsWith('/book'), key = isBook ? 'symbol' : 'type', value = url.searchParams.get(key);
    if ([...url.searchParams.keys()].length !== 1 || (isBook ? !(okxContractId(value)?.expires > clock()) : !['CALL','PUT'].includes(value))) return fail('OKX 公开行情参数无效',400);
    const cacheKey = path + '/' + value, prior = cache.get(cacheKey), now = clock();
    if (prior && now < prior.until && okxFresh(prior.payload.time,now)) return respond(prior.payload);
    if (!pending.has(cacheKey)) {
      if (pending.size >= 16) return fail('OKX 行情读取繁忙，请稍后刷新',503);
      const next = (isBook ? book(value) : path.endsWith('/dual') ? dual(value) : market(value))
        .then(payload => {
          if (cache.size >= 96) cache.delete(cache.keys().next().value);
          cache.set(cacheKey,{until:clock()+2_000,payload});
          return payload;
        }).finally(() => pending.delete(cacheKey));
      pending.set(cacheKey,next);
    }
    try { return respond(await pending.get(cacheKey)); }
    catch (error) { return fail(error?.name === 'TimeoutError' ? 'OKX 官方公开行情读取超时' : String(error?.message || 'OKX 官方公开行情暂不可用'),503); }
  };
}

const handleOKXPublic = createOkxPublicReader();

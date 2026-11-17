const BITGET_DUAL_SOURCE = 'https://www.bitget.com/finance/dual-investment';
const BITGET_LIST_ROOT = 'https://www.bitget.com/v1/finance/dualInvest/product/';
const BITGET_HOUR = 3_600_000;
const BITGET_TTL = 30_000;
const bitgetFresh = (stamp, now) => Number.isSafeInteger(stamp) && stamp > 0 && stamp <= now + 2_000 && now - stamp < BITGET_TTL;
function bitgetNumber(value) {
  return typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)) ? Number(value) : NaN;
}

function createBitgetPublicReader({fetchImpl = (...args) => fetch(...args), clock = Date.now} = {}) {
  const pending = new Map(), cached = new Map();
  // These two POST endpoints are the anonymous catalogue reads made by the official product page.
  async function read(path, body) {
    const response = await fetchImpl(BITGET_LIST_ROOT + path, {
      method:'POST', headers:{accept:'application/json','content-type':'application/json'}, body:JSON.stringify(body),
      credentials:'omit', redirect:'manual', cache:'no-store', signal:AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw Error('Bitget 官方双币目录返回 HTTP ' + response.status);
    const time = Date.parse(response.headers.get('date') || '');
    if (!bitgetFresh(time,clock())) throw Error('Bitget 官方双币目录的响应时间缺失或已过期');
    const json = await response.json();
    if (String(json?.code) !== '200' || !json.data) throw Error('Bitget 官方双币目录暂未开放此报价');
    return {data:json.data,time};
  }

  async function dual(side) {
    const direction = side === 'CALL' ? 1 : 0, coin = direction ? 'BTC' : 'USDT';
    const tradeTokenId = direction ? 1 : 2;
    const [template, page] = await Promise.all([
      read('template/list/v2', {}),
      read('list/v3', {productTokenId:1, tradeTokenId, direction, pageNum:1, pageSize:1000,
        timeRange:null, expirationTime:null, vipProduct:0})
    ]);
    const btc = Array.isArray(template.data) && template.data.find(item => item.tokenId === 1 && item.tokenName === 'BTC' && item.marketType === 1);
    const pair = btc?.directionList?.find(item => item.direction === direction && item.marketType === 1 &&
      item.productTokenId === 1 && item.productTokenName === 'BTC' && item.tradeTokenId === tradeTokenId &&
      item.tradeTokenName === coin && item.preTokenName === 'USDT');
    if (!pair) throw Error('Bitget 暂无可核验的 BTC/USDT 普通双币产品方向');
    const list = page.data.pageProduct;
    if (!Array.isArray(list?.items) || list.page !== 1 || list.hasNextPage !== false || list.items.length > 1000 ||
        !Number.isSafeInteger(list.pages) || list.pages < 0 || list.pages > 1) throw Error('Bitget 普通双币产品目录不完整');
    const products = [], seen = new Set(), now = clock();
    const catalogTime = Math.min(template.time, page.time);
    if (!bitgetFresh(catalogTime, now)) throw Error('Bitget 双币目录已过期');
    let rejected = 0;
    for (const row of list.items) {
      if (row.stickType !== 0 || row.status !== 2 || row.direction !== direction ||
          row.productTokenId !== 1 || row.productTokenName !== 'BTC' || row.tradeTokenId !== tradeTokenId ||
          row.tradeTokenName !== coin) continue;
      const id = row.productSubId, strike = bitgetNumber(row.targetPrice), apr = bitgetNumber(row.apy) / 100;
      const expires = bitgetNumber(row.settleDate), remaining = bitgetNumber(row.leaveEndTime);
      const hours = Math.floor(remaining / BITGET_HOUR);
      if (Number.isSafeInteger(expires) && expires <= now || Number.isSafeInteger(remaining) && hours < 1) continue;
      const observed = expires - remaining, time = Math.min(observed, catalogTime);
      if (!/^\d{1,24}$/.test(id) || typeof id !== 'string' || seen.has(id) ||
          !(Number.isFinite(strike) && strike > 0) || !Number.isFinite(apr) || apr < 0 ||
          !Number.isSafeInteger(expires) || expires !== bitgetNumber(row.expirationTime) || expires <= now ||
          !Number.isSafeInteger(remaining) || hours <= 0 || hours !== bitgetNumber(row.leaveEndHours) ||
          !bitgetFresh(observed,now) || !bitgetFresh(time,now)) {
        rejected++;
        continue;
      }
      seen.add(id);
      // leaveEndHours is the whole-hour term used by Bitget’s published earnings calculator.
      const term = apr * hours / (365 * 24);
      // The catalogue verifies current availability, but omits an exact subscription deadline.
      const availabilityUntil = Math.min(time + BITGET_TTL, expires - hours * BITGET_HOUR + 1);
      if (availabilityUntil <= now) continue;
      products.push({id,direction:side,strike,expires,coin,investCoin:coin,strikeCoin:'USDT',strikeCurrency:'USDT',
        apr,term,periodRate:term,days:hours/24,time,min:null,max:null,step:null,amountRulesVerified:false,
        purchaseEnd:null,subscriptionOpen:true,availabilityUntil});
    }
    if (rejected && !products.length) throw Error('Bitget 普通双币报价时间或产品条件未通过校验');
    return {platform:'bitget',status:'ready',time:catalogTime,products,sourceType:'public_web',
      sourceUrl:BITGET_DUAL_SOURCE,amountRulesVerified:false};
  }

  return async function handle(request) {
    const url = new URL(request.url), path = url.pathname;
    const reply = (data, status = 200) => Response.json(data,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
    const fail = (reason,status,sourceUrl) => reply({platform:'bitget',status:'unavailable',reason,sourceUrl},status);
    if (path !== '/api/bitget/dual') return fail('无此行情接口',404);
    if (request.method !== 'GET') return fail('行情仅支持 GET',405);
    const value = url.searchParams.get('type');
    if ([...url.searchParams.keys()].length !== 1 || !['PUT','CALL'].includes(value)) {
      return fail('Bitget 公开行情参数无效',400);
    }
    const prior = cached.get(value);
    if (prior && clock() < prior.until) return reply(prior.payload);
    if (!pending.has(value)) {
      pending.set(value,dual(value).then(payload => {
        const until = payload.products.reduce((limit,p) => Math.min(limit,p.availabilityUntil),Math.min(clock()+2_000,payload.time+BITGET_TTL));
        cached.set(value,{payload,until});
        return payload;
      }).finally(() => pending.delete(value)));
    }
    try { return reply(await pending.get(value)); }
    catch (error) { return fail(error?.name === 'TimeoutError' ? 'Bitget 官方双币读取超时' : String(error?.message || 'Bitget 双币报价暂不可用'),503,BITGET_DUAL_SOURCE); }
  };
}

const handleBitgetPublic = createBitgetPublicReader();

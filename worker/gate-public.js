// Anonymous Gate API v4. Order book sizes are contracts; each premium is USDT per BTC.
const GATE_API = 'https://api.gateio.ws/api/v4';
const GATE_OPTION_FEES = 'https://www.gate.com/help/other/optionstradingrules/45829/options-fee-description';
const GATE_DUAL_TERMS = 'https://www.gate.com/help/lend/dual_currency_product/19609/all-about-gate-s-dual-investment';
const gateNumber = value => typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN;
const gatePositive = n => Number.isFinite(n) && n > 0;
const gateFresh = (t, now) => Number.isSafeInteger(t) && t > 0 && t <= now + 2_000 && now - t < 30_000;
function gateRate(value) {
  const n = gateNumber(value);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}
function gateIdentity(symbol) {
  const m = /^BTC_USDT-(20\d{2})(\d{2})(\d{2})-([1-9]\d{0,8}(?:\.\d{1,4})?)-([CP])$/.exec(symbol);
  if (!m) return null;
  const expires = Date.UTC(+m[1], +m[2]-1, +m[3], 8);
  if (new Date(expires).toISOString().slice(0,10).replaceAll('-','') !== m[1]+m[2]+m[3]) return null;
  return {symbol, expires, strike:Number(m[4]), direction:m[5] === 'C' ? 'CALL' : 'PUT'};
}
function gateContract(row, direction, now) {
  const id = gateIdentity(row.name);
  if (!id || row.underlying !== 'BTC_USDT' || row.is_active !== true || id.direction !== direction ||
      row.is_call !== (direction === 'CALL') || id.strike !== gateNumber(row.strike_price) ||
      id.expires !== gateNumber(row.expiration_time)*1000 || id.expires <= now) return null;
  const unit = gateNumber(row.multiplier), min = gateNumber(row.order_size_min), max = gateNumber(row.order_size_max);
  const priceTick = gateNumber(row.order_price_round);
  if (!(gatePositive(unit) && gatePositive(priceTick) && Number.isSafeInteger(min) && min > 0 &&
        Number.isSafeInteger(max) && max >= min)) return null;
  const delivery = gateRate(row.settle_fee_rate);
  return {...id, unit, min, max, step:1, priceTick, coin:'USDT', quoteCoin:'USDT', settleCoin:'USDT',
    strikeCoin:'USDT', strikeCurrency:'USDT', quoteCurrency:'USDT', tag:row.tag,
    maker:gateRate(row.maker_fee_rate), taker:gateRate(row.taker_fee_rate), cap:gateRate(row.price_limit_fee_rate),
    delivery, deliveryCap:gateRate(row.settle_limit_fee_rate), dailyExemptionVerified:row.tag === 'day' && delivery === 0,
    feeBasis:'按 Gate 合约公布费率估算，账户实际费率待核实', feeSource:GATE_OPTION_FEES, deliverySource:GATE_OPTION_FEES};
}

function createGatePublicReader({fetchImpl=(...args)=>fetch(...args), clock=Date.now}={}) {
  const cache = new Map(), pending = new Map();
  async function read(path, maximumBytes, timeout=10_000) {
    const response = await fetchImpl(GATE_API + path, {method:'GET',headers:{accept:'application/json'},
      credentials:'omit',redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(timeout)});
    if (!response.ok) {
      let detail = '';
      if (response.status === 400 && response.body) {
        const reader = response.body.getReader();
        try {
          const first = await reader.read();
          if (first.value && first.value.byteLength <= 2_048) {
            const problem = JSON.parse(new TextDecoder().decode(first.value));
            if (problem?.label === 'MISSING_REQUIRED_HEADER') detail = '（Gate 本次要求认证请求头，公开报价不可用）';
          }
        } catch {} finally { await reader.cancel().catch(()=>{}); }
      }
      throw Error('Gate 官方公开接口返回 HTTP ' + response.status + detail);
    }
    const time = Date.parse(response.headers.get('date') || '');
    if (!gateFresh(time, clock())) throw Error('Gate 官方响应时间缺失或已超过 30 秒');
    if (Number(response.headers.get('content-length')) > maximumBytes || !response.body) throw Error('Gate 官方响应大小无效');
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let raw = '', length = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maximumBytes) {await reader.cancel(); throw Error('Gate 官方响应超过大小限制');}
      raw += decoder.decode(part.value,{stream:true});
    }
    return {data:JSON.parse(raw+decoder.decode()), time};
  }
  async function market(direction) {
    const [catalogue,indices] = await Promise.all([
      read('/options/contracts?underlying=BTC_USDT',5_000_000), read('/options/underlyings',60_000)]);
    if (!Array.isArray(catalogue.data) || catalogue.data.length > 6_000 || !Array.isArray(indices.data)) throw Error('Gate 合约列表格式无效');
    const idx = indices.data.find(i=>i.name==='BTC_USDT'), spot = gateNumber(idx?.index_price), indexTime = gateNumber(idx?.index_time)*1000;
    const now = clock(), time = Math.min(indexTime, catalogue.time, indices.time);
    if (!gatePositive(spot) || !gateFresh(indexTime,now) || !gateFresh(time,now)) throw Error('Gate BTC/USDT 指数缺失或过期');
    const contracts = catalogue.data.map(c=>gateContract(c,direction,now)).filter(Boolean);
    if (new Set(contracts.map(c=>c.symbol)).size !== contracts.length) throw Error('Gate 返回重复期权合约');
    if (!contracts.length) throw Error('Gate 官方目录暂未返回可核验的 BTC ' + direction + ' 合约');
    return {platform:'gate',status:'ready',currency:'USDT',indexCoin:'USDT',spot,index:spot,indexTime,spotUSDT:spot,
      indexUSDTTime:indexTime,time,contracts,feeSource:GATE_OPTION_FEES,source:GATE_API+'/options/contracts'};
  }
  function levels(rows, bids) {
    if (!Array.isArray(rows) || rows.length > 50) throw Error('Gate 盘口深度格式无效');
    let previous = bids ? Infinity : 0;
    return rows.map(level=>{
      const price = gateNumber(level.p), qty = gateNumber(level.s);
      if (!gatePositive(price) || !Number.isSafeInteger(qty) || qty <= 0 || (bids ? previous <= price : price <= previous)) throw Error('Gate 盘口价格或张数无效');
      previous = price;
      return {price,qty};
    });
  }
  async function book(symbol) {
    const {data,time:httpTime} = await read('/options/order_book?contract='+encodeURIComponent(symbol)+'&limit=50&with_id=true',45_000);
    const snapshotTime = Math.floor(gateNumber(data?.current)*1000), lastChangeTime = Math.floor(gateNumber(data?.update)*1000);
    const time = Math.min(snapshotTime,httpTime);
    if (!gateFresh(snapshotTime,clock()) || !gateFresh(time,clock()) || !Number.isSafeInteger(lastChangeTime) || lastChangeTime <= 0 ||
        lastChangeTime > snapshotTime+2_000 || !Number.isSafeInteger(data.id) || data.id < 0 ||
        (data.contract != null && data.contract !== symbol)) throw Error('Gate 盘口时刻或合约无效');
    const bids = levels(data.bids,true), asks = levels(data.asks,false);
    if (bids.length && asks.length && bids[0].price >= asks[0].price) throw Error('Gate 买卖盘口交叉，请刷新');
    return {platform:'gate',status:'ready',symbol,currency:'USDT',quoteCoin:'USDT',settleCoin:'USDT',time,lastChangeTime,bids,asks};
  }
  async function dual(direction) {
    const type = direction.toLowerCase(), coin = direction === 'CALL' ? 'BTC' : 'USDT';
    const other = direction === 'CALL' ? 'USDT' : 'BTC';
    const pageSize = 1_000, rowIds = new Set(), data = [], deadline = clock()+12_000;
    let time = Infinity;
    for (let page = 1; ; page++) {
      const remaining = deadline-clock();
      if (page > 5 || remaining <= 0) throw Error('Gate 双币分页读取未完成，请刷新');
      const result = await read('/earn/dual/investment_plan?coin=BTC&quote_currency=USDT&type='+type+
        '&page='+page+'&page_size='+pageSize,1_500_000,Math.min(remaining,10_000));
      if (!Array.isArray(result.data) || result.data.length > pageSize) throw Error('Gate 双币产品分页格式无效');
      // A repeated page means the source ignored pagination or changed under us.
      if (page > 1 && result.data.some(r=>rowIds.has(r?.id))) throw Error('Gate 双币分页包含重复产品，完整目录暂不可用');
      for (const row of result.data) if (row && Number.isSafeInteger(row.id)) rowIds.add(row.id);
      data.push(...result.data);
      time = Math.min(time,result.time);
      if (result.data.length < pageSize) break;
    }
    const products = [], seen = new Set(), now = clock();
    for (const row of data) {
      if (!row || row.status !== 'ONGOING' || row.type !== type || row.invest_currency !== coin || row.exercise_currency !== other) continue;
      const expires = gateNumber(row.delivery_time)*1000, purchaseEnd = gateNumber(row.end_time)*1000;
      const purchaseStart = gateNumber(row.start_time)*1000, strike = gateNumber(row.exercise_price);
      if (!Number.isSafeInteger(purchaseEnd) || !Number.isSafeInteger(expires) || expires < purchaseEnd ||
          now >= purchaseEnd || !Number.isSafeInteger(purchaseStart) || purchaseStart < 0 || purchaseStart > now) continue;
      const apr = gateNumber(row.apy_display), min = gateNumber(row.min_amount);
      if (!Number.isSafeInteger(row.id) || row.id <= 0 || !gatePositive(strike) || !gatePositive(min) || !Number.isFinite(apr) || apr < 0) continue;
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      const days = (expires-time)/86_400_000, term = apr*days/365;
      products.push({id:String(row.id),direction,strike,expires,coin,investCoin:coin,strikeCoin:'USDT',strikeCurrency:'USDT',
        indexCoin:'USDT',apr,term,periodRate:term,days,time,min,max:null,step:null,purchaseEnd,amountRulesVerified:false,
        termEstimated:true,note:'年化取自 Gate，本期按当前申购至到期的剩余时长估算；公开列表仅提供起购额。'});
    }
    return {platform:'gate',status:'ready',time,products,sourceType:'official_public_api',amountRulesVerified:false,
      source:GATE_API+'/earn/dual/investment_plan',termsSource:GATE_DUAL_TERMS};
  }
  return async function handleGate(request) {
    const url = new URL(request.url), path = url.pathname;
    const reply = (payload,status=200)=>Response.json(payload,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
    const error = (reason,status)=>reply({platform:'gate',status:'unavailable',reason},status);
    if (request.method !== 'GET') return error('Gate 公开行情仅支持 GET',405);
    if (!['/api/gate/market','/api/gate/book','/api/gate/dual'].includes(path)) return error('未知 Gate 行情路径',404);
    const isBook = path.endsWith('/book'), isDual = path.endsWith('/dual'), value = url.searchParams.get(isBook ? 'symbol' : 'type');
    if (url.searchParams.size !== 1 || (isBook ? !(gateIdentity(value)?.expires > clock()) : !['CALL','PUT'].includes(value))) return error('Gate 查询参数无效',400);
    const key = path+'/'+value, prior = cache.get(key), now = clock();
    if (prior && prior.until > now && gateFresh(prior.value.time,now)) return reply(prior.value);
    if (!pending.has(key)) {
      if (pending.size >= 16) return error('Gate 行情查询繁忙，请稍后刷新',503);
      pending.set(key,(isBook ? book(value) : isDual ? dual(value) : market(value)).then(result=>{
        if (!gateFresh(result.time,clock())) throw Error('Gate 报价已过期，请刷新');
        if (cache.size >= 96) cache.delete(cache.keys().next().value);
        cache.set(key,{value:result,until:clock()+(isDual ? 9_000 : 2_000)});
        return result;
      }).finally(()=>pending.delete(key)));
    }
    try {return reply(await pending.get(key));}
    catch (cause) {
      const reason = cause?.message?.startsWith('Gate ') ? cause.message : 'Gate 公开行情暂不可用，请刷新';
      if (isDual && prior && gateFresh(prior.value.time,clock())) return reply({...prior.value,refreshWarning:reason});
      return error(reason,503);
    }
  };
}
const handleGatePublic = createGatePublicReader();


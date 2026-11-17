// Value each currency from a timestamped two-sided spot book.
async function handleQuoteFX(request, fetchImpl = fetch, clock = Date.now) {
  if (request.method !== 'GET') return Response.json({reason:'仅提供公开读取'}, {status:405,headers:{allow:'GET'}});
  if (new URL(request.url).search) return Response.json({reason:'汇率接口不接受查询参数'}, {status:400});
  async function read(url) {
    const response = await fetchImpl(url, {
      method:'GET', redirect:'manual', credentials:'omit', cache:'no-store',
      headers:{accept:'application/json'}, signal:AbortSignal.timeout(4_000)
    });
    if (!response.ok) throw Error('现货盘口读取失败');
    return response.json();
  }
  function midpoint(book, time, source, invert = false) {
    const bid = Number(book?.bids?.[0]?.[0]), ask = Number(book?.asks?.[0]?.[0]);
    const now = clock();
    if (!Number.isFinite(ask) || !Number.isFinite(bid) || bid <= 0 || ask < bid ||
        !Number.isSafeInteger(time) || time <= 0 || time > now + 2_000 || now-time >= 30_000)
      throw Error('现货盘口缺失或已过期');
    return {price:invert ? (1/ask + 1/bid)/2 : (bid+ask)/2,time,source};
  }
  async function quote(asset) {
    try {
      const data = await read('https://www.okx.com/api/v5/market/books?instId=' + asset + '-USDT&sz=1');
      if (data.code !== '0') throw Error('OKX 现货盘口不可用');
      return midpoint(data.data?.[0], Number(data.data?.[0]?.ts), 'OKX ' + asset + '/USDT');
    } catch {
      const inverse = asset === 'USDC';
      const product = inverse ? 'USDT-USDC' : 'BTC-USDT';
      const book = await read('https://api.exchange.coinbase.com/products/' + product + '/book?level=1');
      return midpoint(book, Date.parse(book?.time), 'Coinbase Exchange ' + product, inverse);
    }
  }
  const results = await Promise.allSettled([quote('BTC'), quote('USDC')]);
  const [btc,usdc] = results.map(r => r.status === 'fulfilled' && clock()-r.value.time < 30_000 ? r.value : null);
  return Response.json({status:btc||usdc?'ready':'unavailable',btcUSDT:btc?.price??null,btcTime:btc?.time??null,
    usdcUSDT:usdc?.price??null,usdcTime:usdc?.time??null,btcSource:btc?.source??null,usdcSource:usdc?.source??null,
    source:[btc?.source,usdc?.source].filter(Boolean).join(' · '),reason:btc||usdc?'':'公开汇率未返回有效报价'},
    {status:btc||usdc?200:503,headers:{'cache-control':'no-store'}});
}

const readDualLow = createBinanceDualCloudReader();
const readDualHigh = createBinanceHighDualCloudReader();
const readPuts = createBinanceOptionsCloudReader();
const readCalls = createBinanceOptionsCloudReader({ type: 'CALL' });

const htmlPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self' https://chatgpt.com",
].join('; ');

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/api/quotes/fx') return handleQuoteFX(request);
    if (['/api/gate/market','/api/gate/book','/api/gate/dual'].includes(path)) return handleGatePublic(request);
    if (path === '/api/bitget/dual') return handleBitgetPublic(request);
    if (['/api/okx/market','/api/okx/book','/api/okx/dual'].includes(path)) return handleOKXPublic(request);
    if (['/api/coinbase/market','/api/coinbase/book'].includes(path)) return handleCoinbasePublic(request);
    if (path === '/api/binance-dual') return readDualLow(request);
    if (path === '/api/binance-dual-high') return readDualHigh(request);
    if (path === '/api/binance-options/market') {
      return (url.searchParams.get('type') === 'CALL' ? readCalls : readPuts)(request);
    }
    if (path === '/api/binance-options/book') {
      return (url.searchParams.get('symbol')?.endsWith('-C') ? readCalls : readPuts)(request);
    }

    const staticPath = path === '/' && url.searchParams.get('view') === 'spot-put' ? '/spot-put.html' :
      path === '/' ? '/index.html' : path;
    const entry = assets.get(staticPath);
    if (!entry) return new Response('Not found', { status: 404 });
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
    }

    const html = staticPath.endsWith('.html');
    const headers = {
      'content-type': entry[0],
      'cache-control': html ? 'no-store' : 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    };
    if (html) headers['content-security-policy'] = htmlPolicy;
    return new Response(request.method === 'HEAD' ? null : entry[1], { headers });
  },
};


import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('published comparison reads only anonymous quotes and never forwards caller credentials', async t => {
  const source = await readFile(new URL('../dist/server/index.js', import.meta.url), 'utf8');
  const { default: worker } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const calls = [];
  const cloud = 'https://harmonious-bienenstitch-ef1a0a.netlify.app/';
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'omit');
    assert.deepEqual(options.headers, { accept: 'application/json' });
    calls.push(url);
    const time = Date.now();
    const symbol = new URL(url).searchParams.get('symbol');
    if (symbol) {
      return Response.json({
        status: 'ready', platform: 'binance', currency: 'USDT', symbol,
        sourceType: 'official_public_api', time, receivedAt: time, lastUpdateId: 9, depthLimit: 1000,
        source: 'https://eapi.binance.com/eapi/v1/depth?symbol=' + symbol + '&limit=1000',
        bids: [{ price: 20, qty: 2 }], asks: [{ price: 25, qty: 3 }],
      });
    }
    if (url.endsWith('/dual') || url.endsWith('/dual-high')) {
      const high = url.endsWith('/dual-high');
      const direction = high ? 'BTC&targetAsset=USDT&projectType=UP' : 'USDT&targetAsset=BTC&projectType=DOWN';
      return Response.json({
        status: 'ready', sourceType: 'public_web',
        source: 'https://www.binance.com/bapi/earn/v5/friendly/pos/dc/project/list?investmentAsset=' + direction + '&sortType=APY_DESC&pageSize=100',
        serverTime: time, lastServerTime: time, fetchedAt: time, completedAt: time,
        pageCount: 1, total: 0, catalogueComplete: true, items: [],
        eligibility: { precisionKnown: false, purchaseWindowKnown: false, accountEligibilityVerified: false },
      });
    }
    return Response.json({ reason: '上游暂时不可用' }, { status: 503 });
  });
  function read(path, method = 'GET') {
    return worker.fetch(new Request('https://site.invalid' + path, {
      method, headers: { authorization: 'Bearer local-fixture', cookie: 'owner=local-fixture' },
    }));
  }
  const suffixes = ['PUT', 'CALL'];
  for (const type of suffixes) {
    const high = type === 'CALL';
    const market = await read('/api/binance-options/market' + (high ? '?type=CALL' : ''));
    assert.equal(market.status, 503);
    assert.equal((await market.json()).status, 'unavailable');
    const symbol = 'BTC-301115-72000-' + (high ? 'C' : 'P');
    const book = await read('/api/binance-options/book?symbol=' + symbol);
    assert.equal(book.status, 200);
    assert.deepEqual((await book.json()).asks, [{ price: 25, qty: 3 }]);
    const catalogue = await read(high ? '/api/binance-dual-high' : '/api/binance-dual');
    assert.equal(catalogue.status, 200);
    assert.deepEqual((await catalogue.json()).items, []);
  }
  assert.deepEqual(calls, [
    cloud + 'options/market', cloud + 'options/book?symbol=BTC-301115-72000-P', cloud + 'dual',
    cloud + 'options/market?type=CALL', cloud + 'options/book?symbol=BTC-301115-72000-C', cloud + 'dual-high',
  ]);
  assert.equal((await read('/api/binance-account/status')).status, 404);
  assert.equal((await read('/api/execution/order', 'POST')).status, 404);
  assert.equal((await read('/api/binance-options/book?symbol=ETH-301115-72000-C')).status, 400);
  assert.equal((await read('/api/binance-dual?extra=1')).status, 400);
  assert.equal(calls.length, 6);
});


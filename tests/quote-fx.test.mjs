import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source = await readFile(new URL('../worker/quote-fx.js',import.meta.url),'utf8');
const {handleQuoteFX} = await import('data:text/javascript;base64,'+Buffer.from(source+'\nexport {handleQuoteFX}').toString('base64'));
const request = new Request('https://example.test/api/quotes/fx');
const now = Date.UTC(2026,10,14,10);

test('FX falls back only for the missing pair, reverses the USDT/USDC bid and ask, and keeps its book time',async()=>{
  const result = await handleQuoteFX(request,async(url,options)=>{
    assert.equal(options.cache,'no-store');
    assert.equal(options.redirect,'manual');
    if (url.includes('instId=BTC-USDT')) return Response.json({code:'0',data:[{ts:String(now),bids:[['60000']],asks:[['60002']]}]});
    if (url.includes('instId=USDC-USDT')) return new Response(null,{status:503});
    assert.equal(url,'https://api.exchange.coinbase.com/products/USDT-USDC/book?level=1');
    return Response.json({time:new Date(now-500).toISOString(),bids:[['0.992']],asks:[['0.994']]});
  },()=>now);
  const quote=await result.json();
  assert.equal(result.status,200);
  assert.equal(quote.btcUSDT,60001);
  assert.equal(quote.usdcUSDT,(1/0.994+1/0.992)/2);
  assert.equal(quote.usdcTime,now-500);
  assert.match(quote.usdcSource,/Coinbase/);
});

test('FX never substitutes a stale or crossed book or a nominal peg',async()=>{
  const result = await handleQuoteFX(request,async url=>url.includes('okx.com')
    ? Response.json({code:'0',data:[{ts:String(now-30000),bids:[['1']],asks:[['1.01']]}]})
    : Response.json({time:new Date(now).toISOString(),bids:[['1.02']],asks:[['1.01']]}),()=>now);
  assert.equal(result.status,503);
  const quote=await result.json();
  assert.equal(quote.btcUSDT,null);
  assert.equal(quote.usdcUSDT,null);
});

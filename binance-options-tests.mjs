import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeBinanceOptionsMarket,normalizeBinanceOptionsBook,createBinanceOptionsReader} from './worker/binance-options.js';
import {createBinanceMarketClient} from './web/binance-market.js';
const NOW=Date.UTC(2026,9,23,10),EXPIRY=Date.UTC(2026,9,24,8),SYMBOL='BTC-261024-80000-P';
const clone=x=>structuredClone(x);
function spec(){return {serverTime:NOW,optionContracts:[{baseAsset:'BTC',quoteAsset:'USDT',underlying:'BTCUSDT',settleAsset:'USDT',nakedSell:true}],optionSymbols:[{symbol:SYMBOL,side:'PUT',strikePrice:'80000',expiryDate:EXPIRY,underlying:'BTCUSDT',quoteAsset:'USDT',status:'TRADING',unit:1,contractType:'CRYPTO_OPTIONS',underlyingType:'CRYPTO',filters:[{filterType:'LOT_SIZE',minQty:'0.01',maxQty:'200',stepSize:'0.01'},{filterType:'PRICE_FILTER',tickSize:'5'}]}]};}
const index=()=>({indexPrice:'81700',time:NOW});
const book=()=>({T:NOW,lastUpdateId:123,bids:[['100','0.05'],['95','0.10']],asks:[['105','1']]});
const market=()=>normalizeBinanceOptionsMarket(spec(),index(),NOW);
const quote=()=>normalizeBinanceOptionsBook(book(),SYMBOL,NOW);
const request=(path,options={})=>new Request('https://test.invalid/api/binance-options'+path,options);
function fakeOfficial(calls,alter){return async(url,options)=>{calls.push({url,options});if(alter)return alter(url,options);return Response.json(url.endsWith('exchangeInfo')?spec():url.includes('/index?')?index():book());};}

test('real Binance normalizer preserves exact BTC/USDT PUT metadata and personal fee uncertainty',()=>{
 const value=market(),c=value.contracts[0];assert.equal(value.platform,'binance');assert.equal(value.currency,'USDT');assert.equal(value.spot,81700);assert.equal(c.symbol,SYMBOL);assert.equal(c.expires,EXPIRY);assert.equal(c.strike,80000);assert.equal(c.unit,1);assert.equal(c.step,.01);assert.equal(c.min,.01);assert.equal(c.priceTick,5);
 assert.equal(c.taker,.00024);assert.equal(c.cap,.10);assert.equal(c.delivery,.00015);assert.equal(c.deliveryCap,.10);assert.equal(c.spot,.001);assert.equal(c.accountFeeVerified,false);assert.equal(c.openingRateSource,'published_standard');assert.equal(c.feeProvenance.personalRateVerified,false);assert.match(c.feeSourceURLs.opening,/binance\.com/);
 assert.equal(c.nakedSell,null);assert.equal(c.underlyingNakedSell,true);assert.equal(c.sellPermissionScope,'underlying');assert.equal(c.nakedSellSource,'unverified_symbol');
 const s=spec();s.optionSymbols[0].nakedSell=false;const explicit=normalizeBinanceOptionsMarket(s,index(),NOW).contracts[0];assert.equal(explicit.nakedSell,false);assert.equal(explicit.sellPermissionScope,'symbol');
});
test('normalizer refuses wrong contract unit, altered strike/date, CALL, settled market and missing source time',()=>{
 for(const alter of [x=>x.unit=100,x=>x.strikePrice='79000',x=>x.expiryDate=EXPIRY+3600000,x=>x.side='CALL',x=>x.quoteAsset='USDC',x=>x.status='EXPIRED']){const s=spec();alter(s.optionSymbols[0]);assert.throws(()=>normalizeBinanceOptionsMarket(s,index(),NOW),/暂无/);}
 for(const alter of [s=>delete s.serverTime,s=>s.serverTime=NOW-30000,s=>s.serverTime=NOW+2001]){const s=spec();alter(s);assert.throws(()=>normalizeBinanceOptionsMarket(s,index(),NOW),/时间/);}
 assert.throws(()=>normalizeBinanceOptionsMarket(spec(),{indexPrice:'81700',time:NOW-30000},NOW),/时间/);
});
test('book uses only actual ordered bids and its mandatory exchange timestamp; mark/ask never backfills bids',()=>{
 const value=quote();assert.deepEqual(value.bids,[{price:100,qty:.05},{price:95,qty:.1}]);assert.equal(value.time,NOW);assert.equal(value.depthLimit,1000);
 const empty=book();empty.bids=[];empty.markPrice='500';assert.deepEqual(normalizeBinanceOptionsBook(empty,SYMBOL,NOW).bids,[]);
 for(const alter of [x=>delete x.T,x=>x.T=NOW-30000,x=>x.T=NOW+2001,x=>x.bids=[['100','-1']],x=>x.bids=[['95','1'],['100','1']],x=>x.bids=[['100','1'],['100','2']],x=>x.asks=[['99','1']]]){const raw=book();alter(raw);assert.throws(()=>normalizeBinanceOptionsBook(raw,SYMBOL,NOW));}
});
test('fixed worker market and book proxy reject arbitrary query, private method and unlisted symbol before network',async()=>{
 const calls=[],reader=createBinanceOptionsReader({fetchImpl:fakeOfficial(calls),now:()=>NOW});
 for(const path of ['/market?url=https://example.invalid','/market?symbol='+SYMBOL,'/book?symbol='+SYMBOL+'&signature=private','/book?symbol='+SYMBOL+'&symbol='+SYMBOL,'/book?symbol=BTC-261024-80000-C','/book?url=https://example.invalid'])assert.equal((await reader.handle(request(path))).status,400);
 assert.equal((await reader.handle(request('/market',{method:'POST',body:'{}',headers:{'X-MBX-APIKEY':'MUST_NOT_FORWARD'}}))).status,405);assert.equal(calls.length,0);
 const missing=await reader.handle(request('/book?symbol=BTC-261024-79000-P'));assert.equal(missing.status,502);assert.equal(calls.length,2);assert.equal(calls.some(x=>x.url.includes('/depth?')),false);
 for(const {url,options} of calls){assert.match(url,/^https:\/\/eapi\.binance\.com\/eapi\/v1\//);assert.equal(options.method,'GET');assert.equal(options.credentials,'omit');assert.deepEqual(options.headers,{accept:'application/json'});assert.equal(options.redirect,'manual');}
});
test('worker reads all 1000 depth levels only for listed symbol; source age survives cache and failure',async()=>{
 let now=NOW;const calls=[],reader=createBinanceOptionsReader({fetchImpl:fakeOfficial(calls),now:()=>now});
 const response=await reader.handle(request('/book?symbol='+SYMBOL));assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal((await response.json()).bids[1].price,95);assert.equal(calls.length,3);assert.match(calls[2].url,/depth\?symbol=BTC-261024-80000-P&limit=1000$/);
 await reader.loadBook(SYMBOL);assert.equal(calls.length,3);now=NOW+30000;assert.equal((await reader.handle(request('/book?symbol='+SYMBOL))).status,502);assert.equal(calls.length,5);
 const forbidden=createBinanceOptionsReader({fetchImpl:async()=>new Response('blocked',{status:403}),now:()=>NOW});const failed=await forbidden.handle(request('/market'));assert.equal(failed.status,502);const body=await failed.json();assert.equal(body.status,'unavailable');assert.equal(body.time,0);assert.equal(body.contracts,undefined);assert.match(body.reason,/403/);
});
test('GET market proxy never forwards incoming exchange credentials, cookies or authorization',async()=>{
 const calls=[],reader=createBinanceOptionsReader({fetchImpl:fakeOfficial(calls),now:()=>NOW});
 const response=await reader.handle(request('/market',{headers:{authorization:'Bearer TEST_NOT_REAL',cookie:'session=TEST_NOT_REAL','X-MBX-APIKEY':'TEST_NOT_REAL',origin:'https://untrusted.invalid'}}));
 assert.equal(response.status,200);assert.equal(calls.length,2);for(const {options} of calls){assert.deepEqual(options.headers,{accept:'application/json'});assert.equal(options.credentials,'omit');}
 const body=await response.json();assert.equal(body.status,'ready');assert.doesNotMatch(JSON.stringify(body),/TEST_NOT_REAL/);
});
test('client reads only the no-credential same-origin market and selected book routes',async()=>{
 const calls=[],client=createBinanceMarketClient({now:()=>NOW,fetchImpl:async(url,options)=>{calls.push({url,options});return Response.json(url.includes('/book?')?quote():market());}});
 assert.equal((await client.loadMarket()).transport,'site_proxy');assert.equal((await client.loadBook(SYMBOL)).bids[0].price,100);
 assert.deepEqual(calls.map(x=>x.url),['/api/binance-options/market','/api/binance-options/book?symbol='+SYMBOL]);
 for(const {options} of calls){assert.equal(options.method,'GET');assert.equal(options.credentials,'omit');assert.equal(options.cache,'no-store');assert.equal(options.redirect,'error');assert.equal(options.headers,undefined);}
});

test('client failure never falls back to localhost, another host, or another contract',async()=>{
 for(const fail of [
  async()=>Response.json({status:'source_restricted',reason:'Binance source restricted'},{status:503}),
  async()=>Response.json({status:'unavailable',reason:'No real data'}),
  async()=>{throw Error('offline');}
 ]){
  const calls=[],client=createBinanceMarketClient({now:()=>NOW,fetchImpl:async(url,options)=>{calls.push({url,options});assert.ok(url.startsWith('/api/binance-options/'));return fail();}});
  await assert.rejects(client.loadMarket());assert.deepEqual(calls.map(x=>x.url),['/api/binance-options/market']);
  calls.length=0;await assert.rejects(client.loadBook(SYMBOL));assert.deepEqual(calls.map(x=>x.url),['/api/binance-options/book?symbol='+SYMBOL]);
  calls.length=0;await assert.rejects(client.loadBook('BTC-261024-80000-X'),/有效/);assert.equal(calls.length,0);
 }
});

test('stale and mismatched source payloads are rejected after exactly one same-origin call',async()=>{
 for(const field of ['time','metadataTime','indexTime','receivedAt']){
  const stale=market();stale[field]=NOW-30000;const calls=[];
  const client=createBinanceMarketClient({now:()=>NOW,fetchImpl:async url=>{calls.push(url);return Response.json(stale);}});
  await assert.rejects(client.loadMarket(),/超过 30 秒/);assert.deepEqual(calls,['/api/binance-options/market']);
 }
 const wrong=quote();wrong.symbol='BTC-261024-79000-P';const calls=[];
 const bad=createBinanceMarketClient({now:()=>NOW,fetchImpl:async url=>{calls.push(url);return Response.json(wrong);}});
 await assert.rejects(bad.loadBook(SYMBOL),/真实买盘/);assert.deepEqual(calls,['/api/binance-options/book?symbol='+SYMBOL]);
});

test('a failed market read creates no routing preference and recovery still uses the site once',async()=>{
 let clock=NOW,down=true;const calls=[];
 const client=createBinanceMarketClient({now:()=>clock,fetchImpl:async url=>{
  calls.push(url);assert.ok(url.startsWith('/api/binance-options/'));
  if(down)return Response.json({reason:'source restricted'},{status:503});
  return Response.json(url.includes('/book?')?{...quote(),time:clock,receivedAt:clock}:{...market(),time:clock,metadataTime:clock,indexTime:clock,receivedAt:clock});
 }});
 await assert.rejects(client.loadMarket(),/restricted/);assert.deepEqual(calls,['/api/binance-options/market']);
 calls.length=0;clock+=1000;down=false;const value=await client.loadBook(SYMBOL);
 assert.equal(value.transport,'site_proxy');assert.equal(value.time,clock);assert.deepEqual(calls,['/api/binance-options/book?symbol='+SYMBOL]);
 calls.length=0;clock+=60000;await client.loadMarket();assert.deepEqual(calls,['/api/binance-options/market']);
});

test('new receive timestamps cannot extend the original exchange quote TTL',async()=>{
 let clock=NOW;const calls=[];
 const client=createBinanceMarketClient({now:()=>clock,fetchImpl:async url=>{
  calls.push(url);return Response.json(url.includes('/book?')?{...quote(),receivedAt:clock}:{...market(),receivedAt:clock});
 }});
 await client.loadMarket();calls.length=0;clock+=30000;
 await assert.rejects(client.loadBook(SYMBOL),/超过 30 秒/);assert.deepEqual(calls,['/api/binance-options/book?symbol='+SYMBOL]);
 calls.length=0;await assert.rejects(client.loadMarket(),/超过 30 秒/);assert.deepEqual(calls,['/api/binance-options/market']);
});

test('the browser allows the upstream eighteen-second budget without extending the thirty-second quote lifetime',async t=>{
 const budgets=[];t.mock.method(AbortSignal,'timeout',ms=>{budgets.push(ms);return new AbortController().signal;});
 let clock=NOW;
 const client=createBinanceMarketClient({now:()=>clock,fetchImpl:async url=>Response.json(url.includes('/book?')?quote():market())});
 await client.loadMarket();await client.loadBook(SYMBOL);assert.deepEqual(budgets,[22000,22000]);
 clock=NOW+30000;await assert.rejects(client.loadMarket(),/超过 30 秒/);await assert.rejects(client.loadBook(SYMBOL),/超过 30 秒/);
});

test('a synthetic TimeoutError becomes a useful bounded Chinese source error and never triggers fallback',async()=>{
 const calls=[],client=createBinanceMarketClient({now:()=>NOW,fetchImpl:async url=>{calls.push(url);throw new DOMException('Synthetic timeout fixture','TimeoutError');}});
 await assert.rejects(client.loadMarket(),/期权.*超时.*刷新/);assert.deepEqual(calls,['/api/binance-options/market']);
});

test('a synthetic response-body TimeoutError is also translated for market and book without fallback',async()=>{
 for(const kind of ['market','book']){
  const calls=[],client=createBinanceMarketClient({now:()=>NOW,fetchImpl:async url=>{calls.push(url);return {ok:true,status:200,json:async()=>{throw new DOMException('Synthetic body timeout fixture','TimeoutError');}};}});
  await assert.rejects(kind==='market'?client.loadMarket():client.loadBook(SYMBOL),/期权.*超时.*刷新/);assert.deepEqual(calls,[kind==='market'?'/api/binance-options/market':'/api/binance-options/book?symbol='+SYMBOL]);
 }
});

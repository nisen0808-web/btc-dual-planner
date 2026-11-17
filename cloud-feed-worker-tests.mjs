import test from 'node:test';
import assert from 'node:assert/strict';
import {createBinanceCloudFeedReader} from './worker/binance-cloud-feed.js';
const NOW=Date.now(),TOKEN='test-only-cloud-read-token-0123456789';
const env={BINANCE_CLOUD_ORIGIN:'https://quotes-example.onrender.com',BINANCE_CLOUD_TOKEN:TOKEN};
const req=path=>new Request('https://site.invalid'+path,{headers:{cookie:'CALLER_PRIVATE',authorization:'CALLER_PRIVATE'}});
const market=()=>({status:'ready',platform:'binance',currency:'USDT',time:NOW,receivedAt:NOW,metadataTime:NOW,indexTime:NOW,contracts:[],sourceType:'official_public_api'});
test('cloud quotes use only fixed authenticated source paths and never forward visitor headers',async()=>{
 const calls=[],read=createBinanceCloudFeedReader({now:()=>NOW,fetchImpl:async(url,options)=>{calls.push({url,options});return Response.json(market());}});
 const response=await read(req('/api/binance-options/market'),env),body=await response.json();assert.equal(response.status,200);assert.equal(body.time,NOW);assert.equal(body.transport,'cloud_service');assert.equal(calls[0].url,'https://quotes-example.onrender.com/market');assert.deepEqual(calls[0].options.headers,{accept:'application/json',authorization:'Bearer '+TOKEN});assert.equal(calls[0].options.credentials,'omit');assert.equal(calls[0].options.redirect,'manual');assert.doesNotMatch(JSON.stringify(body),/CALLER_PRIVATE|test-only-cloud-read/);
});
test('unknown parameters, arbitrary origins and writes never reach the cloud data service',async()=>{
 const read=createBinanceCloudFeedReader({now:()=>NOW,fetchImpl:async()=>assert.fail('Unexpected upstream call')});
 for(const path of ['/api/binance-options/market?url=https://attacker.invalid','/api/binance-dual?account=other','/api/binance-options/book?symbol=ETH-261026-3000-P','/api/binance-options/book?symbol=BTC-261026-78000-P&symbol=BTC-261026-79000-P'])assert.equal((await read(req(path),env)).status,400);
 assert.equal((await read(new Request('https://site.invalid/api/binance-dual',{method:'POST'}),env)).status,405);
 for(const origin of ['http://127.0.0.1:8789','https://quotes-example.onrender.com/other','https://attacker.invalid','https://user:pass@quotes-example.onrender.com'])assert.equal((await read(req('/api/binance-dual'),{...env,BINANCE_CLOUD_ORIGIN:origin})).status,503);
});
test('original cloud quote timestamps cannot be refreshed by a new Site request',async()=>{
 for(const payload of [{...market(),time:NOW-30000},{...market(),metadataTime:NOW-31000},{...market(),receivedAt:NOW+2001},{status:'ready',serverTime:NOW-31000,fetchedAt:NOW,items:[]}]){
  const read=createBinanceCloudFeedReader({now:()=>NOW,fetchImpl:async()=>Response.json(payload)}),path=payload.items?'/api/binance-dual':'/api/binance-options/market',response=await read(req(path),env);assert.equal(response.status,503);const body=await response.json();assert.equal(body.time,0);assert.equal(body.contracts,undefined);assert.equal(body.items,undefined);
 }
});
test('cold start, source failure and wrong-contract books never become income data',async()=>{
 for(const fake of [()=>new Response('<html>starting</html>'),()=>Response.json({secret:TOKEN},{status:403}),()=>Response.json({...market(),symbol:'BTC-261026-79000-P',bids:[],asks:[]})]){
  const read=createBinanceCloudFeedReader({now:()=>NOW,fetchImpl:async()=>fake()}),response=await read(req('/api/binance-options/book?symbol=BTC-261026-78000-P'),env),body=await response.json();assert.equal(response.status,503);assert.equal(body.bids,undefined);assert.doesNotMatch(JSON.stringify(body),new RegExp(TOKEN));
 }
});

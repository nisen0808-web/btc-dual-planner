import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {normalizeBinanceOptionsMarket,normalizeBinanceOptionsBook} from './worker/binance-options.js';
import {createBinanceMarketClient} from './web/binance-market.js';
import {createOptionsProductionReader} from './cloud/netlify/netlify/edge-functions/options.js';
import {createAnonymousHighDualHandler} from './cloud/netlify/netlify/functions/dual-high.mjs';
import {loadBinanceHighCatalogue,deriveBinanceHighDualIncome} from './web/binance-high-dual.js';
const NOW=Date.UTC(2026,10,13,9),EXP=Date.UTC(2026,10,14,8),C='BTC-261114-78000-C',P='BTC-261114-78000-P';
const contract=(symbol,side)=>({symbol,side,underlying:'BTCUSDT',quoteAsset:'USDT',status:'TRADING',contractType:'CRYPTO_OPTIONS',underlyingType:'CRYPTO',unit:1,strikePrice:'78000',expiryDate:EXP,filters:[{filterType:'LOT_SIZE',stepSize:'0.01',minQty:'0.01',maxQty:'100'},{filterType:'PRICE_FILTER',tickSize:'5'}]});
const specs=()=>({serverTime:NOW,optionContracts:[{baseAsset:'BTC',quoteAsset:'USDT',underlying:'BTCUSDT',settleAsset:'USDT'}],optionSymbols:[contract(P,'PUT'),contract(C,'CALL')]});
const index=()=>({time:NOW,indexPrice:'70000'});
const book=()=>({T:NOW,lastUpdateId:13,bids:[['100','0.2'],['95','2']],asks:[['105','1']]});
const request=(path,init)=>new Request('https://unit.test'+path,init);
const publicSource='https://www.binance.com/bapi/earn/v5/friendly/pos/dc/project/list?investmentAsset=BTC&targetAsset=USDT&projectType=UP&sortType=APY_DESC&pageSize=100';
const rawProduct=(time,patch={})=>({id:'high-1',type:'UP',investmentAsset:'BTC',targetAsset:'USDT',underlying:'BTC',strikePrice:'78000',duration:'1',settleTime:time+86400000,canPurchase:true,apr:'0.365',minDepositAmount:'0.001',maxDepositAmount:'10',...patch});
function cloudHigh(time,patch={}){return {status:'ready',source:publicSource,sourceType:'public_web',serverTime:time,lastServerTime:time,fetchedAt:time,completedAt:time,total:1,pageCount:1,catalogueComplete:true,eligibility:{precisionKnown:false,purchaseWindowKnown:false,accountEligibilityVerified:false},items:[{id:'high-1',optionType:'CALL',investCoin:'BTC',exercisedCoin:'USDT',strikePrice:'78000',apr:'0.365',minAmount:'0.001',maxAmount:'10',duration:1,settleDate:time+86400000,canPurchase:true,purchaseDecimal:null,purchaseEndTime:null,...patch}]};}

test('CALL and PUT lists stay separate with exact symbol/side consistency',()=>{
 assert.deepEqual(normalizeBinanceOptionsMarket(specs(),index(),NOW).contracts.map(c=>c.symbol),[P]);
 const calls=normalizeBinanceOptionsMarket(specs(),index(),NOW,'CALL');assert.deepEqual(calls.contracts.map(c=>c.symbol),[C]);assert.equal(calls.contracts[0].optionType,'CALL');
 const bad=specs();bad.optionSymbols[1].symbol=P;assert.throws(()=>normalizeBinanceOptionsMarket(bad,index(),NOW,'CALL'),/暂无/);
 assert.equal(normalizeBinanceOptionsBook(book(),C,NOW).symbol,C);
});
test('production CALL reader reads actual CALL listing then depth; rejects PUT and unsupported queries without fetch',async()=>{
 const urls=[];const read=createOptionsProductionReader({type:'CALL',now:()=>NOW,fetchImpl:async url=>{urls.push(url);return Response.json(url.endsWith('exchangeInfo')?specs():url.includes('/index?')?index():book());}});
 for(const path of ['/options/market?type=CALL&type=PUT','/options/market?type=CALL&url=private','/options/book?symbol='+P,'/options/market?type=PUT'])assert.equal((await read(request(path))).status,400);
 assert.equal(urls.length,0);
 const response=await read(request('/options/book?symbol='+C)),value=await response.json();assert.equal(response.status,200);assert.equal(value.symbol,C);assert.equal(value.asks[0].price,105);assert.equal(urls.length,3);assert.ok(urls[2].includes(C));
 const market=await (await read(request('/options/market?type=CALL'))).json();assert.deepEqual(market.contracts.map(c=>c.symbol),[C]);
});
test('browser CALL explicitly selects cloud type and rejects PUT contamination',async()=>{
 const urls=[],value=normalizeBinanceOptionsMarket(specs(),index(),NOW,'CALL');
 const client=createBinanceMarketClient({now:()=>NOW,fetchImpl:async url=>{urls.push(url);return Response.json(url.includes('/book')?normalizeBinanceOptionsBook(book(),C,NOW):value);}});
 assert.equal((await client.loadMarket('CALL')).contracts[0].symbol,C);assert.equal(urls[0],'/api/binance-options/market?type=CALL');assert.equal((await client.loadBook(C)).symbol,C);
 await assert.rejects(client.loadMarket('PUT'),/规格/);await assert.rejects(client.loadMarket('other'),/方向/);
});
test('site CALL cloud adapter preserves type, source and original timestamps',async()=>{
 const prefix=(await readFile('worker/binance-options.js','utf8')).split('export function createBinanceOptionsReader')[0];
 const code=prefix+'\n'+await readFile('worker/binance-options-cloud.js','utf8')+'\nexport {createBinanceOptionsCloudReader};';
 const {createBinanceOptionsCloudReader}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
 const urls=[],reader=createBinanceOptionsCloudReader({type:'CALL',now:()=>NOW,fetchImpl:async url=>{urls.push(url);return Response.json(url.includes('/book')?normalizeBinanceOptionsBook(book(),C,NOW):normalizeBinanceOptionsMarket(specs(),index(),NOW,'CALL'));}});
 const response=await reader(request('/api/binance-options/market?type=CALL'));assert.equal(response.status,200);assert.equal((await response.json()).contracts[0].symbol,C);assert.equal(urls[0],'https://harmonious-bienenstitch-ef1a0a.netlify.app/options/market?type=CALL');
 const quote=await (await reader(request('/api/binance-options/book?symbol='+C))).json();assert.equal(quote.time,NOW);assert.equal(quote.symbol,C);
 assert.equal((await reader(request('/api/binance-options/book?symbol='+P))).status,400);
});
test('high public reader uses only UP BTC/USDT source, removes extra fields, rejects DOWN contamination',async()=>{
 const time=Math.floor(Date.now()/1000)*1000,seen=[];
 const high=createAnonymousHighDualHandler({now:()=>time,fetchImpl:async(url,init)=>{seen.push(url);assert.equal(init.credentials,'omit');return Response.json({code:'000000',data:{total:1,list:[rawProduct(time,{privateKey:'NEVER_RETURN'})]}},{headers:{date:new Date(time).toUTCString()}});}});
 const response=await high(request('/dual-high'));assert.equal(response.status,200);const value=await response.json();assert.equal(seen[0],publicSource+'&pageIndex=1');assert.equal(value.items[0].investCoin,'BTC');assert.equal(value.items[0].optionType,'CALL');assert.equal(value.items[0].exercisedCoin,'USDT');assert.doesNotMatch(JSON.stringify(value),/NEVER_RETURN/);
 const wrong=createAnonymousHighDualHandler({now:()=>time,fetchImpl:async()=>Response.json({code:'000000',data:{total:1,list:[rawProduct(time,{type:'DOWN'})]}},{headers:{date:new Date(time).toUTCString()}})});
 assert.equal((await wrong(request('/dual-high'))).status,503);assert.equal((await high(request('/dual-high?apiKey=secret'))).status,400);
});
test('high browser catalogue validates BTC limits, exact maturity and period rounding; income remains BTC',async t=>{
 const time=Math.floor(Date.now()/1000)*1000,original=globalThis.fetch; t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async url=>{assert.equal(url,'/api/binance-dual-high');return Response.json({...cloudHigh(time),deliveryType:'cloud_pull',snapshotAgeAtRead:0,transport:'netlify_public_feed'});};
 const cat=await loadBinanceHighCatalogue();assert.equal(cat.entries.length,1);const entry=cat.entries[0];assert.equal(entry.currency,'BTC');
 const selection={strike:78000,expires:time+86400000,settleCoin:'BTC'};
 const income=deriveBinanceHighDualIncome(2,selection,entry.data,time+50);assert.equal(income.valid,true);assert.equal(income.incomeBTC,.002);assert.equal(income.term,.001);assert.equal(income.eligibilityVerified,false);
 for(const qty of [.0009,10.001])assert.equal(deriveBinanceHighDualIncome(qty,selection,entry.data,time+50).valid,false);
 assert.equal(deriveBinanceHighDualIncome(2,{...selection,strike:78001},entry.data,time+50).valid,false);
 assert.equal(deriveBinanceHighDualIncome(2,{...selection,expires:time+86400001},entry.data,time+50).valid,false);
 assert.equal(deriveBinanceHighDualIncome(2,selection,entry.data,time+31000).valid,false);
});

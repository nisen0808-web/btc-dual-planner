import test from 'node:test';
import assert from 'node:assert/strict';
import {loadBinanceCatalogue,compareBinanceDual} from './web/binance-dual.js';
import {loadOKXCatalogue,compareOKXDual} from './web/okx-dual.js';
import {compareDual} from './web/dual.js';
import {loadDualCatalogues} from './web/dual-catalogue.js';

const now=Date.UTC(2026,9,22,8),expiry=now+7*86400000;
const contracts=[80000,85000].map(strike=>({symbol:`BTC-test-${strike}-P`,strike,expires:expiry}));
const binance={id:'b1',investCoin:'USDT',exercisedCoin:'BTC',optionType:'PUT',strikePrice:'80000',duration:7,settleDate:expiry,purchaseDecimal:null,purchaseEndTime:null,canPurchase:true,apr:'0.365',minAmount:'20',maxAmount:'20000'};
const publicPayload=items=>({items,serverTime:now,fetchedAt:now,sourceType:'public_web',eligibility:{precisionKnown:false,purchaseWindowKnown:false,accountEligibilityVerified:false}});
const bybit={productId:'p1',baseCoin:'BTC',quoteCoin:'USDT',duration:'7d',status:'Available',isVipProduct:false,subscribeStartAt:String(now-1000),subscribeEndAt:String(now+3600000),settlementTime:String(expiry-1000),minPurchaseQuoteAmount:'20',remainingAmountQuote:'4000000',orderPrecisionDigitalQuote:4};
const bybitQuote={selectPrice:'80000',apyE8:'36500000',maxInvestmentAmount:'1000000',expiredAt:String(now+20000)};
const okx={ndBrokerProductId:'o1',currency:'BTC',alternativeCurrency:'USDT',type:'PUT',productType:'DualCurrencyDeposit',dcdType:'Standard',status:1,launchTime:now-1000,stopTradingTime:now+3600000,expiryTime:expiry,settlementTime:expiry,interestAccrualTime:now,dcdTerm:'168',quoteResponseTime:now,strike:'80000',annualYield:'0.365',absYield:'0.007'};
const response=(payload,status=200)=>({ok:status>=200&&status<300,status,headers:{get:()=>new Date(now).toUTCString()},json:async()=>structuredClone(payload)});
const putFor=entry=>({valid:true,netIncome:90,days:7,strike:entry.strike,expires:entry.expires,currency:entry.currency,expiryPrice:entry.strike*.95});

test('Binance catalogue makes one fixed GET for all exact combinations and retains public omissions',async t=>{
  t.mock.method(Date,'now',()=>now);let calls=0;
  const rows=[binance,{...binance,id:'b2',strikePrice:'85000'},null,{...binance,id:'near',strikePrice:'80000.01'},{...binance,id:'date',settleDate:expiry+1},{...binance,id:'wrong',investCoin:'USDC'},{...binance,id:'call',optionType:'CALL'},{...binance,id:'closed',canPurchase:false},{...binance,id:'bad',apr:true}];
  t.mock.method(globalThis,'fetch',async(url,options)=>{calls++;assert.equal(url,'/api/binance-dual');assert.equal(options.credentials,'same-origin');assert.equal(options.cache,'no-store');return response(publicPayload(rows));});
  const result=await loadBinanceCatalogue('USDT',contracts);
  assert.equal(calls,1);assert.equal(result.source.status,'ready');assert.equal(result.entries.length,2);assert.equal(result.source.rejectedCount,2);
  for(const entry of result.entries){assert.equal(entry.data.sourceType,'public_web');assert.equal(entry.data.product.purchaseDecimal,null);assert.equal(entry.data.contract.strike,entry.strike);const compared=compareBinanceDual(10000,putFor(entry),entry.data,now);assert.equal(compared.valid,true);assert.equal(compared.estimateOnly,true);assert.equal(compared.income,70);}
});

test('Binance catalogue uses existing verified collector age and fails closed at 30 seconds',async t=>{
  t.mock.method(Date,'now',()=>now);let age=30000;
  t.mock.method(globalThis,'fetch',async()=>response({...publicPayload([binance]),deliveryType:'collector_push',snapshotAgeAtRead:age}));
  const expired=await loadBinanceCatalogue('USDT',contracts);assert.equal(expired.entries.length,0);assert.equal(expired.source.status,'unavailable');assert.match(expired.source.reason,/30 秒/);
  age=0;const fresh=await loadBinanceCatalogue('USDT',contracts);assert.equal(fresh.entries.length,1);assert.equal(fresh.entries[0].data.deliveryType,'collector_push');
});

test('USDC catalogue requests never call USDT-only Binance or OKX readers',async t=>{
  let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('must not fetch');});
  for(const load of [loadBinanceCatalogue,loadOKXCatalogue]){const result=await load('USDC',contracts);assert.equal(result.entries.length,0);assert.equal(result.source.status,'unavailable');assert.match(result.source.reason,/不替换/);}
  assert.equal(calls,0);
});

test('OKX catalogue reads the product list once and preserves unknown amount eligibility',async t=>{
  t.mock.method(Date,'now',()=>now);let calls=0;
  const rows=[okx,{...okx,ndBrokerProductId:'o2',strike:'85000'},{...okx,ndBrokerProductId:'o1',quoteResponseTime:now-1000,annualYield:'0.1'},{...okx,ndBrokerProductId:'stale',quoteResponseTime:now-30000},{...okx,ndBrokerProductId:'malformed',annualYield:true},{...okx,ndBrokerProductId:'eth',currency:'ETH'},{...okx,ndBrokerProductId:'near',strike:'80000.01'},null];
  t.mock.method(globalThis,'fetch',async(url,options)=>{calls++;assert.equal(url,'/api/okx-dual');assert.equal(options.credentials,'same-origin');return response({code:0,serverTime:now,data:{products:rows,responseTime:0}});});
  const result=await loadOKXCatalogue('USDT',contracts);
  assert.equal(calls,1);assert.equal(result.entries.length,2);assert.equal(result.source.status,'ready');
  for(const entry of result.entries){assert.equal(entry.data.amountRules,null);assert.equal(entry.data.product.annualYield,'0.365');const compared=compareOKXDual(10000,putFor(entry),entry.data,now);assert.equal(compared.valid,true);assert.equal(compared.eligibilityVerified,false);assert.equal(compared.estimateOnly,true);assert.equal(compared.income,70);}
});

test('OKX catalogue retains verified amount rules without inventing constraints',async t=>{
  t.mock.method(Date,'now',()=>now);
  const rules={verified:true,source:'synthetic test fixture',productId:'o1',currency:'USDT',min:'20',max:'20000',step:'0.01'};
  t.mock.method(globalThis,'fetch',async()=>response({code:0,serverTime:now,amountRules:rules,data:{products:[okx]}}));
  const {entries}=await loadOKXCatalogue('USDT',contracts);assert.deepEqual(entries[0].data.amountRules,rules);assert.equal(compareOKXDual(10000,putFor(entries[0]),entries[0].data,now).eligibilityVerified,true);
});

test('Bybit fetches each intersecting product once, expands strikes and caps concurrency at four',async t=>{
  t.mock.method(Date,'now',()=>now);const {loadBybitCatalogue}=await import('./web/dual.js?catalogue-bounded');
  const products=Array.from({length:7},(_,i)=>({...bybit,productId:'p'+i}));
  const excluded=[{...bybit,productId:'vip',isVipProduct:true},{...bybit,productId:'wrong',quoteCoin:'USDC'},{...bybit,productId:'near',settlementTime:String(expiry+1)},{...bybit,productId:'eth',baseCoin:'ETH'}];
  let metadataCalls=0,active=0,maximum=0;const seen=new Map();
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    assert.equal(options.credentials,'omit');assert.equal(options.cache,'no-store');const parsed=new URL(url);assert.equal(parsed.origin,'https://api.bybit.com');
    if(parsed.pathname.endsWith('/product')){metadataCalls++;return response({retCode:0,time:now,result:{list:[...products,products[0],...excluded]}});}
    assert.equal(parsed.pathname,'/v5/earn/advance/product-extra-info');const id=parsed.searchParams.get('productId');seen.set(id,(seen.get(id)||0)+1);active++;maximum=Math.max(maximum,active);await new Promise(resolve=>setTimeout(resolve,2));active--;
    return response({retCode:0,time:now,result:{list:[{productId:id,buyLowPrice:[bybitQuote,{...bybitQuote,selectPrice:'85000'},{...bybitQuote,selectPrice:'80000.01'},{...bybitQuote,selectPrice:'80000',expiredAt:String(now)}]}]}});
  });
  const result=await loadBybitCatalogue('USDT',contracts);
  assert.equal(metadataCalls,1);assert.equal(seen.size,7);assert.ok([...seen.values()].every(count=>count===1));assert.equal(maximum,4);assert.equal(result.entries.length,14);assert.equal(result.source.matchedProducts,7);
  for(const entry of result.entries){assert.equal(entry.expires,expiry);assert.equal(entry.data.product.settlementTime,String(expiry-1000));assert.equal(entry.data.quote.maxInvestmentAmount,'1000000');assert.equal(compareDual(10000,putFor(entry),entry.data,now).valid,true);}
});

test('Bybit isolates failed products and never converts stale or malformed rates to zero income',async t=>{
  t.mock.method(Date,'now',()=>now);const {loadBybitCatalogue}=await import('./web/dual.js?catalogue-partial');
  t.mock.method(globalThis,'fetch',async url=>{
    if(!String(url).includes('product-extra-info'))return response({retCode:0,time:now,result:{list:[bybit,{...bybit,productId:'failure'},{...bybit,productId:'stale'},{...bybit,productId:'malformed'}]}});
    const id=new URL(url).searchParams.get('productId');if(id==='failure')throw Error('test source failure');
    const quote=id==='stale'?{...bybitQuote,expiredAt:String(now)}:id==='malformed'?{...bybitQuote,apyE8:true}:bybitQuote;
    return response({retCode:0,time:now,result:{list:[{productId:id,buyLowPrice:[quote]}]}});
  });
  const result=await loadBybitCatalogue('USDT',contracts);assert.equal(result.entries.length,1);assert.equal(result.source.status,'ready');assert.equal(result.source.failedProducts,1);assert.equal(result.source.rejectedCount,3);
});

test('aggregate keeps live exact quotes when other sources fail and discloses RFQ absence',async t=>{
  t.mock.method(Date,'now',()=>now);const calls=[];
  t.mock.method(globalThis,'fetch',async url=>{
    calls.push(String(url));if(url==='/api/binance-dual')return response({status:'authorization_required',reason:'reader unavailable'},403);
    if(url==='/api/okx-dual')return response({code:0,serverTime:now,data:{products:[okx]}});
    throw Error('Bybit fixture unavailable');
  });
  const result=await loadDualCatalogues('USDT',contracts);assert.equal(result.entries.length,1);assert.equal(result.entries[0].platform,'okx');
  assert.equal(result.sources.find(s=>s.platform==='bybit').status,'error');assert.equal(result.sources.find(s=>s.platform==='binance').status,'authorization_required');assert.equal(result.sources.find(s=>s.platform==='okx').count,1);assert.equal(result.sources.find(s=>s.platform==='binance-rfq').status,'unavailable');
  assert.equal(calls.filter(url=>url==='/api/binance-dual').length,1);assert.equal(calls.filter(url=>url==='/api/okx-dual').length,1);
});

test('aggregate removes an early quote which expires while another source is pending',async t=>{
  let local=now;t.mock.method(Date,'now',()=>local);let finishBybit;
  t.mock.method(globalThis,'fetch',async url=>{
    if(url==='/api/binance-dual')return response(publicPayload([binance]));
    if(url==='/api/okx-dual')return response({code:0,serverTime:now,data:{products:[okx]}});
    await new Promise(resolve=>{finishBybit=resolve;});throw Error('slow Bybit fixture');
  });
  const pending=loadDualCatalogues('USDT',contracts);await new Promise(resolve=>setTimeout(resolve,0));local=now+30000;finishBybit();
  const result=await pending;assert.equal(result.entries.length,0);
  for(const platform of ['binance','okx']){const source=result.sources.find(s=>s.platform===platform);assert.equal(source.status,'unavailable');assert.equal(source.staleCount,1);assert.match(source.reason,/扫描完成前已失效/);}
});

test('aggregate rejects explicitly mismatched contract currencies and directions before requesting',async t=>{
  let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('must not fetch');});
  const result=await loadDualCatalogues('USDT',[{...contracts[0],currency:'USDC'},{...contracts[1],optionType:'CALL'}]);assert.equal(result.entries.length,0);assert.equal(calls,0);assert.ok(result.sources.every(s=>s.count===0));
});

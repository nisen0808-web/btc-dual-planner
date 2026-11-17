import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeBinanceOptionsMarket,normalizeBinanceOptionsBook} from './worker/binance-options.js';

const ORIGIN='https://btc-strategy-test.invalid';
let importCounter=0;

async function freshWorker(){
  const url=new URL('./dist/server/index.js',import.meta.url);
  url.searchParams.set('worker-test',String(++importCounter));
  const {default:worker}=await import(url.href);
  assert.equal(typeof worker?.fetch,'function','构建产物须导出 default.fetch');
  return worker;
}
function req(path='/',options={}){return new Request(ORIGIN+path,options);}
test('all legacy execution routes remain server-disabled even when old trading configuration exists',async()=>{
 const worker=await freshWorker(),env={TRADING_ENABLED:'true',EXECUTION_GATEWAY_URL:'https://executor-owner.invalid',EXECUTION_GATEWAY_TOKEN:'TEST_EXECUTOR_TOKEN_NOT_REAL_01234567890'};
 await withFetch(async()=>assert.fail('Unconfigured broker must never fetch'),async()=>{
  const response=await worker.fetch(req('/api/execution/status'),env),body=await response.json();assert.equal(response.status,403);assert.equal(body.ok,false);assert.equal(body.canSubmit,false);assert.equal(body.tradingEnabled,false);assert.equal(body.error.code,'trading_disabled');assert.match(response.headers.get('cache-control'),/no-store/);assert.doesNotMatch(JSON.stringify(body),/TEST_EXECUTOR_TOKEN|local_execution_required/);
  for(const action of ['connect','disconnect','prepare','confirm','pause','plans','withdraw'])assert.equal((await worker.fetch(req('/api/execution/'+action,{method:'POST',headers:{origin:ORIGIN,'content-type':'application/json'},body:'{}'}),env)).status,403);
  const session=await (await worker.fetch(req('/api/binance-account/session'),env)).json();assert.equal(session.signedIn,false);assert.equal(session.hasCredential,false);assert.equal(session.canSubmit,false);
 });
});
test('the published desk has a same-origin cloud account client and no visitor-machine dependency',async()=>{
 const worker=await freshWorker();
 for(const path of ['/binance-local-execution.js','/execution-ui.js','/execution-plan.js','/calc.js','/scan-ui.js','/simulation-ui.js','/settlement-ui.js','/combination-scan.js'])assert.equal((await worker.fetch(req(path))).status,404,path);
 const app=await (await worker.fetch(req('/binance-app.js'))).text(),market=await (await worker.fetch(req('/binance-market.js'))).text(),html=await (await worker.fetch(req('/'))).text();
 for(const body of [app,market])assert.doesNotMatch(body,/localhost|127\.0\.0\.1|binance-local-execution|local_public_relay|preferLocalUntil|clientSecret|client_id|client_secret/);
 assert.match(html,/id="targetPrice"/);assert.match(html,/<select\b[^>]*id="expirySelect"/);assert.match(html,/id="settlementMode"/);assert.doesNotMatch(html,/id="expiryCards"/);
 assert.doesNotMatch(html,/id="(?:strikeMin|strikeMax|scanMinStrike|scanMaxStrike|runSimulation|scanDrop)"|代入.*模拟/);
 const response=await worker.fetch(req('/binance-account.js'));assert.equal(response.status,200);const client=await response.text();assert.match(client,/createBinanceAccountClient/);assert.match(client,/\/api\/binance-account\//);assert.doesNotMatch(client,/localhost|127\.0\.0\.1|window\.open|local_public_relay|apiSecret\s*[:=]\s*['"][^'"]+/);
 for(const path of ['/binance-cloud-execution.js','/worker/binance-account.js','/worker/binance-account-signing.js'])assert.equal((await worker.fetch(req(path))).status,404);
});

async function withFetch(fake,run){
  const original=globalThis.fetch;
  globalThis.fetch=fake;
  try{return await run();}finally{globalThis.fetch=original;}
}

test('built GET / serves the actual HTML page with safe HTML MIME',async()=>{
  const worker=await freshWorker();
  const response=await worker.fetch(req('/'));
  assert.equal(response.status,200);
  assert.match(response.headers.get('content-type')||'',/^text\/html\b/i);
  assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  const html=await response.text();
  assert.match(html,/<html\b/i);
  assert.match(html,/BTC/);
  assert.match(html,/<script\b[^>]*src=["']binance-app\.js["']/i);
});

test('built JavaScript asset has JavaScript MIME and its real module contents',async()=>{
  const worker=await freshWorker();
  const response=await worker.fetch(req('/binance-market.js'));
  assert.equal(response.status,200);
  assert.match(response.headers.get('content-type')||'',/^(?:text|application)\/javascript\b/i);
  assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  const body=await response.text();
  assert.match(body,/loadBinanceMarket/);
  assert.doesNotMatch(body,/<!doctype\s+html/i,'JS 请求不能被 SPA HTML 回退代替');
});

test('unknown assets and non-proxy API routes return 404, without upstream requests',async()=>{
  await withFetch(async()=>{assert.fail('未知路径不得发起上游请求');},async()=>{
    const worker=await freshWorker();
    for(const path of ['/missing-page','/missing.js','/api/proxy?url=https://example.invalid/','/api/okx-dual/']){
      const response=await worker.fetch(req(path));
      assert.equal(response.status,404,path);
      assert.match(await response.text(),/not found/i);
    }
  });
});

test('source and hosting configuration are not exposed as website assets',async()=>{
  const worker=await freshWorker();
  for(const path of ['/worker/index.js','/server/index.js','/.openai/hosting.json','/..%2fworker/index.js']){
    assert.equal((await worker.fetch(req(path))).status,404,path);
  }
});

test('POST is rejected on static and API routes before any upstream call',async()=>{
  await withFetch(async()=>{assert.fail('POST 不得触发公开报价代理');},async()=>{
    const worker=await freshWorker();
    for(const path of ['/','/app.js','/api/okx-dual','/api/binance-options/market','/api/binance-options/book?symbol=BTC-261024-80000-P']){
      const response=await worker.fetch(req(path,{method:'POST',body:'not-a-trade'}));
      assert.equal(response.status,405,path);
      const allow=response.headers.get('allow')||'';
      if(!path.startsWith('/api/binance-options/')){assert.match(allow,/\bGET\b/);assert.match(allow,/\bHEAD\b/);}
    }
  });
});

test('HEAD on a static asset preserves MIME but returns no body',async()=>{
  const worker=await freshWorker();
  const response=await worker.fetch(req('/binance-app.js',{method:'HEAD'}));
  assert.equal(response.status,200);
  assert.match(response.headers.get('content-type')||'',/javascript/i);
  assert.equal(await response.text(),'');
});

test('removed OKX routes and modules are unavailable and the primary module graph remains complete',async()=>{
 await withFetch(async()=>assert.fail('Removed OKX endpoints must not contact upstream'),async()=>{
  const worker=await freshWorker();
  for(const path of ['/api/okx-dual','/api/okx-dual?currencyId=0','/okx-dual.js','/dual-catalogue.js','/live-quotes.js']){
   for(const method of ['GET','HEAD'])assert.equal((await worker.fetch(req(path,{method}))).status,404,path);
  }
  const seen=new Set();async function visit(path){
   if(seen.has(path))return;seen.add(path);const response=await worker.fetch(req(path));assert.equal(response.status,200,path);const body=await response.text();assert.doesNotMatch(body,/OKX|okx-dual|api\/okx/i,path);
   for(const match of body.matchAll(/(?:from\s*|import\s*)['"]\.\/([^'"]+)['"]/g))await visit('/'+match[1]);
  }
  await visit('/binance-app.js');assert.ok(seen.has('/put-quote.js'));assert.ok(seen.has('/binance-dual.js'));assert.ok(seen.has('/binance-account.js'));
 });
});

const DUAL_CLOUD='https://harmonious-bienenstitch-ef1a0a.netlify.app/dual';
const DUAL_SOURCE='https://www.binance.com/bapi/earn/v5/friendly/pos/dc/project/list?investmentAsset=USDT&targetAsset=BTC&projectType=DOWN&sortType=APY_DESC&pageSize=100';
function dualSnapshot(now=Date.now(),count=101){
 return {status:'ready',source:DUAL_SOURCE,sourceType:'public_web',total:count,pageCount:Math.max(1,Math.ceil(count/100)),serverTime:now-1000,lastServerTime:now-500,fetchedAt:now-900,completedAt:now,
  eligibility:{precisionKnown:false,purchaseWindowKnown:false,accountEligibilityVerified:false,missingFields:['purchaseDecimal','purchaseEndTime']},
  items:Array.from({length:count},(_,i)=>({id:'public-'+i,optionType:'PUT',exercisedCoin:'BTC',investCoin:'USDT',strikePrice:String(79000+i),duration:7,settleDate:now+7*86400000,purchaseDecimal:null,purchaseEndTime:null,canPurchase:true,apr:'0.365',minAmount:'10',maxAmount:'1000000'}))};
}
const noOwnerEnvironment=()=>new Proxy({},{get(){assert.fail('Cloud read must not inspect owner R2, account keys or environment destinations');}});

test('diagnostics and cloud-check describe configured feeds without claiming a live probe',async()=>{
 await withFetch(async()=>assert.fail('Configuration diagnostics must never probe sources'),async()=>{
  const worker=await freshWorker();
  for(const path of ['/api/binance-diagnostics','/api/binance-cloud-check']){
   const response=await worker.fetch(req(path+'?url=https://untrusted.invalid/&pageIndex=999',{headers:{authorization:'Bearer DO_NOT_FORWARD',cookie:'DO_NOT_FORWARD'}}),noOwnerEnvironment());
   assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
   const body=await response.json();assert.equal(body.status,'configured');assert.equal(body.readOnly,true);assert.equal(body.sources.options,'Netlify Free edge function');assert.equal(body.sources.ordinaryDual,'Netlify Free function');assert.equal(body.items,undefined);assert.equal(body.results,undefined);
   assert.doesNotMatch(JSON.stringify(body),/DO_NOT_FORWARD|untrusted/);
   for(const method of ['HEAD','POST','PUT'])assert.equal((await worker.fetch(req(path,{method}),noOwnerEnvironment())).status,405);
  }
  assert.equal((await worker.fetch(req('/api/binance-diagnostics/'))).status,404);
 });
});

test('hosted ordinary dual reads the full fixed anonymous cloud schema without owner storage or forwarding caller headers',async()=>{
 const snapshot=dualSnapshot(),calls=[];
 await withFetch(async(url,options)=>{
  calls.push({url,options});assert.equal(url,DUAL_CLOUD);assert.equal(options.method,'GET');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'manual');assert.equal(options.cache,'no-store');
  assert.deepEqual(options.headers,{accept:'application/json'});assert.doesNotMatch(JSON.stringify(options),/DO_NOT_FORWARD/);
  return Response.json(snapshot);
 },async()=>{
  const worker=await freshWorker(),env=noOwnerEnvironment();
  const [response,other]=await Promise.all([
   worker.fetch(req('/api/binance-dual',{headers:{authorization:'Bearer DO_NOT_FORWARD',cookie:'DO_NOT_FORWARD','X-MBX-APIKEY':'DO_NOT_FORWARD','X-API-KEY':'DO_NOT_FORWARD',origin:'https://untrusted.invalid'}}),env),
   worker.fetch(req('/api/binance-dual'),env)
  ]);
  assert.equal(response.status,200);assert.equal(other.status,200);assert.equal(calls.length,1,'simultaneous reads must coalesce');
  const data=await response.json();assert.equal(data.status,'ready');assert.equal(data.deliveryType,'cloud_pull');assert.equal(data.transport,'netlify_public_feed');assert.equal(data.upstreamURL,DUAL_CLOUD);
  for(const key of ['serverTime','lastServerTime','fetchedAt','completedAt'])assert.equal(data[key],snapshot[key],key+' must remain the upstream time');
  assert.equal(data.total,101);assert.equal(data.pageCount,2);assert.deepEqual(data.items,snapshot.items);assert.deepEqual(data.eligibility,snapshot.eligibility);
  assert.ok(data.snapshotAgeAtRead>=1000);assert.ok(data.siteValidatedAt>=snapshot.completedAt);assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(data.collectorLastSeen,undefined);assert.doesNotMatch(JSON.stringify(data),/DO_NOT_FORWARD|collector_push|localhost|127\.0\.0\.1/);
 });
});

test('cloud dual cache preserves original source times and expires after ten seconds',async t=>{
 let clock=Date.now(),calls=0;const originalClock=clock;
 t.mock.method(Date,'now',()=>clock);
 await withFetch(async url=>{assert.equal(url,DUAL_CLOUD);calls++;return Response.json(dualSnapshot(clock));},async()=>{
  const worker=await freshWorker(),first=await (await worker.fetch(req('/api/binance-dual'),noOwnerEnvironment())).json();
  clock=originalClock+9999;const cached=await (await worker.fetch(req('/api/binance-dual'),noOwnerEnvironment())).json();
  assert.equal(calls,1);assert.equal(cached.fetchedAt,first.fetchedAt);assert.ok(cached.snapshotAgeAtRead>first.snapshotAgeAtRead);
  clock=originalClock+10000;const next=await (await worker.fetch(req('/api/binance-dual'),noOwnerEnvironment())).json();
  assert.equal(calls,2);assert.equal(next.fetchedAt,clock-900);
 });
});

test('cloud dual rejects non-GET and all query parameters before fetching',async()=>{
 await withFetch(async()=>assert.fail('Invalid cloud-dual requests must not fetch'),async()=>{
  const worker=await freshWorker();
  for(const path of ['/api/binance-dual?url=https://untrusted.invalid','/api/binance-dual?key=private','/api/binance-dual?pageIndex=1'])assert.equal((await worker.fetch(req(path),noOwnerEnvironment())).status,400);
  for(const method of ['HEAD','POST','PUT','OPTIONS'])assert.equal((await worker.fetch(req('/api/binance-dual',{method}),noOwnerEnvironment())).status,405);
 });
});

test('cloud failures never fall back to owner R2, direct Binance or any other host',async()=>{
 for(const status of [403,451,500]){
  let calls=0;
  await withFetch(async url=>{calls++;assert.equal(url,DUAL_CLOUD);return new Response('PRIVATE_DO_NOT_ECHO',{status});},async()=>{
   const worker=await freshWorker();
   for(let i=0;i<2;i++){
    const response=await worker.fetch(req('/api/binance-dual'),noOwnerEnvironment()),data=await response.json();
    assert.equal(response.status,503);assert.equal(data.status,'unavailable');assert.equal(data.deliveryType,'cloud_pull');assert.equal(data.items,undefined);
    assert.doesNotMatch(JSON.stringify(data),/PRIVATE_DO_NOT_ECHO|collector_push/);
   }
   assert.equal(calls,1,'failure cache prevents repeated upstream reads');
  });
 }
});

test('cloud dual rejects stale, future, partial, mismatched and malformed product snapshots',async()=>{
 const patches=[
  x=>{x.serverTime=Date.now()-30000;},x=>{x.fetchedAt=Date.now()-31000;},x=>{x.completedAt=Date.now()+3000;},
  x=>{x.source='https://untrusted.invalid';},x=>{x.pageCount=1;},x=>{x.items.pop();},
  x=>{x.eligibility.precisionKnown=true;},x=>{x.items[0].investCoin='USDC';},x=>{delete x.items[0].apr;},
  x=>{x.items[1].id=x.items[0].id;}
 ];
 for(const patch of patches){
  const snapshot=dualSnapshot();patch(snapshot);let calls=0;
  await withFetch(async url=>{calls++;assert.equal(url,DUAL_CLOUD);return Response.json(snapshot);},async()=>{
   const worker=await freshWorker(),response=await worker.fetch(req('/api/binance-dual'),noOwnerEnvironment()),data=await response.json();
   assert.equal(response.status,503);assert.equal(data.status,'unavailable');assert.equal(data.items,undefined);assert.equal(calls,1);
  });
 }
});

test('cloud dual bounds both declared and streamed response bodies at four megabytes',async()=>{
 for(const response of [new Response('{}',{headers:{'content-length':String(4*1024*1024+1)}}),new Response('x'.repeat(4*1024*1024+1))]){
  let calls=0;
  await withFetch(async url=>{calls++;assert.equal(url,DUAL_CLOUD);return response;},async()=>{
   const worker=await freshWorker(),result=await worker.fetch(req('/api/binance-dual'),noOwnerEnvironment()),data=await result.json();
   assert.equal(result.status,503);assert.equal(data.items,undefined);assert.match(data.reason,/4MB/);assert.equal(calls,1);
  });
 }
});

const OPTIONS_CLOUD='https://harmonious-bienenstitch-ef1a0a.netlify.app/options';
const OPTIONS_NOW=Date.UTC(2026,9,24,13,38,45),OPTIONS_EXPIRY=Date.UTC(2026,9,26,8),OPTIONS_SYMBOL='BTC-261026-78000-P';
// Offline fixtures use the production normalizers; these prices are not live quotes.
function optionsSnapshot(kind='market',now=OPTIONS_NOW){
 const value=kind==='market'?normalizeBinanceOptionsMarket({serverTime:now-700,optionContracts:[{baseAsset:'BTC',quoteAsset:'USDT',underlying:'BTCUSDT',settleAsset:'USDT',nakedSell:true}],optionSymbols:[{symbol:OPTIONS_SYMBOL,side:'PUT',strikePrice:'78000',expiryDate:OPTIONS_EXPIRY,underlying:'BTCUSDT',quoteAsset:'USDT',status:'TRADING',unit:1,contractType:'CRYPTO_OPTIONS',underlyingType:'CRYPTO',filters:[{filterType:'LOT_SIZE',minQty:'0.01',maxQty:'200',stepSize:'0.01'},{filterType:'PRICE_FILTER',tickSize:'5'}]}]},{time:now-1263,indexPrice:'80704.45086957'},now):normalizeBinanceOptionsBook({T:now-1500,lastUpdateId:123,bids:[['100','0.5'],['95','1']],asks:[['105','2']]},OPTIONS_SYMBOL,now);
 return {...value,receivedAt:now-100,serverRegion:'test_edge_zone'};
}

test('hosted options use only fixed anonymous Netlify market and exact-book reads without owner storage or caller credentials',async t=>{
 t.mock.method(Date,'now',()=>OPTIONS_NOW);const market=optionsSnapshot(),book=optionsSnapshot('book'),calls=[];
 await withFetch(async(url,options)=>{
  calls.push({url,options});assert.ok([OPTIONS_CLOUD+'/market',OPTIONS_CLOUD+'/book?symbol='+OPTIONS_SYMBOL].includes(url));
  assert.equal(options.method,'GET');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'manual');assert.equal(options.cache,'no-store');assert.deepEqual(options.headers,{accept:'application/json'});assert.doesNotMatch(JSON.stringify(options),/DO_NOT_FORWARD/);
  return Response.json(url.endsWith('/market')?market:book);
 },async()=>{
  const worker=await freshWorker(),headers={authorization:'Bearer DO_NOT_FORWARD',cookie:'DO_NOT_FORWARD','X-MBX-APIKEY':'DO_NOT_FORWARD',origin:'https://untrusted.invalid'};
  const [first,coalesced,depth]=await Promise.all([worker.fetch(req('/api/binance-options/market',{headers}),noOwnerEnvironment()),worker.fetch(req('/api/binance-options/market'),noOwnerEnvironment()),worker.fetch(req('/api/binance-options/book?symbol='+OPTIONS_SYMBOL,{headers}),noOwnerEnvironment())]);
  assert.equal(first.status,200);assert.equal(coalesced.status,200);assert.equal(depth.status,200);assert.equal(calls.length,2);
  const data=await first.json(),levels=await depth.json();
  for(const key of ['time','metadataTime','indexTime','receivedAt'])assert.equal(data[key],market[key]);
  assert.equal(data.contracts[0].symbol,OPTIONS_SYMBOL);assert.equal(data.contracts[0].strike,78000);assert.equal(data.contracts[0].expires,OPTIONS_EXPIRY);assert.equal(data.contracts[0].accountFeeVerified,false);
  assert.equal(levels.symbol,OPTIONS_SYMBOL);assert.equal(levels.time,book.time);assert.equal(levels.receivedAt,book.receivedAt);assert.deepEqual(levels.bids,book.bids);assert.deepEqual(levels.asks,book.asks);assert.equal(levels.depthLimit,1000);
  for(const result of [data,levels]){assert.equal(result.transport,'netlify_edge_feed');assert.equal(result.serverRegion,'test_edge_zone');assert.doesNotMatch(JSON.stringify(result),/DO_NOT_FORWARD|localhost|127\.0\.0\.1|collector_push/);}
  assert.equal(first.headers.get('cache-control'),'no-store');assert.equal(depth.headers.get('x-content-type-options'),'nosniff');
 });
});

test('hosted option methods and strict market/book queries are rejected before any network access',async()=>{
 await withFetch(async()=>assert.fail('Invalid public-option requests must not fetch'),async()=>{
  const worker=await freshWorker();
  for(const path of ['/api/binance-options/market?url=https://untrusted.invalid','/api/binance-options/market?symbol='+OPTIONS_SYMBOL,'/api/binance-options/book','/api/binance-options/book?symbol='+OPTIONS_SYMBOL+'&symbol='+OPTIONS_SYMBOL,'/api/binance-options/book?symbol='+OPTIONS_SYMBOL+'&key=private','/api/binance-options/book?symbol=BTC-261026-78000-X'])assert.equal((await worker.fetch(req(path),noOwnerEnvironment())).status,400,path);
  for(const path of ['/api/binance-options/market','/api/binance-options/book?symbol='+OPTIONS_SYMBOL])for(const method of ['HEAD','POST','PUT','OPTIONS'])assert.equal((await worker.fetch(req(path,{method}),noOwnerEnvironment())).status,405);
 });
});

test('hosted options preserve source age through the short cache and do not refresh timestamps',async t=>{
 let clock=OPTIONS_NOW,calls=0;t.mock.method(Date,'now',()=>clock);
 await withFetch(async url=>{assert.equal(url,OPTIONS_CLOUD+'/market');calls++;return Response.json(optionsSnapshot('market',clock));},async()=>{
  const worker=await freshWorker(),first=await (await worker.fetch(req('/api/binance-options/market'),noOwnerEnvironment())).json();
  clock+=1000;const cached=await (await worker.fetch(req('/api/binance-options/market'),noOwnerEnvironment())).json();assert.equal(calls,1);assert.equal(cached.time,first.time);assert.equal(cached.receivedAt,first.receivedAt);
  clock=OPTIONS_NOW+3000;const fresh=await (await worker.fetch(req('/api/binance-options/market'),noOwnerEnvironment())).json();assert.equal(calls,2);assert.equal(fresh.time,clock-1263);
 });
});

test('hosted options fail closed for wrong symbols/sources, malformed metadata or depth, and stale source clocks',async t=>{
 t.mock.method(Date,'now',()=>OPTIONS_NOW);
 const cases=[
  ['market',x=>{x.time=OPTIONS_NOW-30000;}],['market',x=>{x.metadataTime=OPTIONS_NOW-30000;}],['market',x=>{x.indexTime=OPTIONS_NOW-30000;}],['market',x=>{x.receivedAt=OPTIONS_NOW-30000;}],['market',x=>{x.time=OPTIONS_NOW+2001;}],
  ['market',x=>{x.sourceURLs[0]='https://untrusted.invalid';}],['market',x=>{x.contracts[0].unit=100;}],['market',x=>{x.contracts[0].strike=79000;}],['market',x=>{x.contracts.push(structuredClone(x.contracts[0]));}],
  ['book',x=>{x.symbol='BTC-261026-79000-P';}],['book',x=>{x.source='https://untrusted.invalid';}],['book',x=>{x.depthLimit=100;}],['book',x=>{x.time=OPTIONS_NOW-30000;}],['book',x=>{x.receivedAt=OPTIONS_NOW-30000;}],['book',x=>{x.bids.reverse();}],['book',x=>{x.asks[0].price=90;}]
 ];
 for(const [kind,alter] of cases){
  const snapshot=optionsSnapshot(kind);alter(snapshot);let calls=0;
  await withFetch(async url=>{calls++;assert.equal(url,OPTIONS_CLOUD+(kind==='market'?'/market':'/book?symbol='+OPTIONS_SYMBOL));return Response.json(snapshot);},async()=>{
   const worker=await freshWorker(),response=await worker.fetch(req('/api/binance-options/'+(kind==='market'?'market':'book?symbol='+OPTIONS_SYMBOL)),noOwnerEnvironment()),body=await response.json();
   assert.equal(response.status,503);assert.equal(body.status,'unavailable');assert.equal(body.time,0);assert.equal(body.contracts,undefined);assert.equal(body.bids,undefined);assert.equal(calls,1);
  });
 }
});

test('hosted options never synthesize missing bids or fall back to Binance, localhost, owner R2 or another feed',async t=>{
 t.mock.method(Date,'now',()=>OPTIONS_NOW);
 const empty=optionsSnapshot('book');empty.bids=[];empty.markPrice='500';
 await withFetch(async url=>{assert.equal(url,OPTIONS_CLOUD+'/book?symbol='+OPTIONS_SYMBOL);return Response.json(empty);},async()=>{
  const worker=await freshWorker(),response=await worker.fetch(req('/api/binance-options/book?symbol='+OPTIONS_SYMBOL),noOwnerEnvironment());assert.equal(response.status,200);assert.deepEqual((await response.json()).bids,[]);
 });
 for(const status of [403,451,500]){
  let calls=0;await withFetch(async url=>{calls++;assert.equal(url,OPTIONS_CLOUD+'/market');return new Response('PRIVATE_DO_NOT_ECHO',{status});},async()=>{
   const worker=await freshWorker();for(let i=0;i<2;i++){const response=await worker.fetch(req('/api/binance-options/market'),noOwnerEnvironment()),body=await response.json();assert.equal(response.status,503);assert.equal(body.time,0);assert.equal(body.contracts,undefined);assert.doesNotMatch(JSON.stringify(body),/PRIVATE_DO_NOT_ECHO/);}assert.equal(calls,1);
  });
 }
});

test('hosted options bound declared and streamed responses to four megabytes',async()=>{
 for(const response of [new Response('{}',{headers:{'content-length':String(4*1024*1024+1)}}),new Response('x'.repeat(4*1024*1024+1))])await withFetch(async url=>{assert.equal(url,OPTIONS_CLOUD+'/market');return response;},async()=>{
  const worker=await freshWorker(),result=await worker.fetch(req('/api/binance-options/market'),noOwnerEnvironment()),body=await result.json();assert.equal(result.status,503);assert.equal(body.time,0);assert.match(body.reason,/4MB/);
 });
});

test('snapshot ingestion rejects an unauthenticated POST without accessing storage or upstreams',async()=>{
  await withFetch(async()=>assert.fail('Ingest must never call an upstream'),async()=>{
    const worker=await freshWorker();
    const response=await worker.fetch(req('/api/binance-snapshot',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),{BINANCE_QUOTES:{get:()=>assert.fail('Unauthorized ingest must not access storage')}});
    assert.equal(response.status,403);assert.equal((await response.json()).ok,undefined);
  });
});



test('hosted CALL selection dispatches only to CALL cloud listing and exact C-book',async t=>{
 t.mock.method(Date,'now',()=>OPTIONS_NOW);
 const callSymbol=OPTIONS_SYMBOL.replace(/-P$/,'-C'),market=optionsSnapshot(),book=optionsSnapshot('book'),calls=[];
 market.optionType='CALL';market.contracts[0].optionType='CALL';market.contracts[0].symbol=callSymbol;
 book.symbol=callSymbol;book.source=book.source.replace(OPTIONS_SYMBOL,callSymbol);
 await withFetch(async(url,options)=>{
  calls.push(url);assert.equal(options.credentials,'omit');
  if(url===OPTIONS_CLOUD+'/market?type=CALL')return Response.json(market);
  if(url===OPTIONS_CLOUD+'/book?symbol='+callSymbol)return Response.json(book);
  assert.fail('CALL must not request PUT or arbitrary cloud endpoint');
 },async()=>{
  const worker=await freshWorker();
  const m=await worker.fetch(req('/api/binance-options/market?type=CALL'),noOwnerEnvironment());assert.equal(m.status,200);assert.equal((await m.json()).contracts[0].symbol,callSymbol);
  const b=await worker.fetch(req('/api/binance-options/book?symbol='+callSymbol),noOwnerEnvironment());assert.equal(b.status,200);const value=await b.json();assert.equal(value.symbol,callSymbol);assert.equal(value.time,book.time);assert.deepEqual(value.bids,book.bids);
 });
 assert.deepEqual(calls,[OPTIONS_CLOUD+'/market?type=CALL',OPTIONS_CLOUD+'/book?symbol='+callSymbol]);
});

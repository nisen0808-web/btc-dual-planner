import test from 'node:test';
import assert from 'node:assert/strict';
import {createBinanceReader} from './worker/binance.js';

const KEY='TEST_READ_ONLY_KEY_NOT_A_REAL_CREDENTIAL';
const PUBLIC='https://www.binance.com/bapi/earn/v5/friendly/pos/dc/project/list?investmentAsset=USDT&targetAsset=BTC&projectType=DOWN&sortType=APY_DESC&pageSize=100';
const SAPI='https://api.binance.com/sapi/v1/dci/product/list?optionType=PUT&exercisedCoin=BTC&investCoin=USDT&pageSize=100';
const USER_AGENT='BTCStrategyStudio/1.0 (+https://btc-dual-planner-oct22.phyrex-ni.chatgpt.site)';
const date='Thu, 22 Oct 2026 08:00:00 GMT',laterDate='Thu, 22 Oct 2026 08:00:01 GMT';
const row=(id='p1',extra={})=>({id,investmentAsset:'USDT',targetAsset:'BTC',underlying:'BTC',strikePrice:'81500.00000000',duration:'1',settleTime:'1792742400000',canPurchase:true,apr:'1.34380000',minDepositAmount:'10.00000000',maxDepositAmount:'3922080.00000000',type:'DOWN',displayDuration:'1',displayDurationUnit:'DAY',autoCompoundUserConfig:{account:'DO_NOT_EXPORT'},orderId:'PRIVATE_ORDER_ID_DO_NOT_EXPORT',...extra});
const sapiRow=(id='p1',extra={})=>({id,optionType:'PUT',exercisedCoin:'BTC',investCoin:'USDT',strikePrice:'80000',duration:7,settleDate:1793347200000,purchaseDecimal:8,purchaseEndTime:1793260800000,canPurchase:true,apr:'0.365',minAmount:'10',maxAmount:'1000000',orderId:'PRIVATE_ORDER_ID_DO_NOT_EXPORT',unexpectedAccountField:'DO_NOT_EXPORT',...extra});
const page=(total,list,options={})=>Response.json({code:'000000',data:{total,list}},{headers:{date,...options.headers},status:options.status||200});
const sapiPage=(total,list)=>Response.json({total,list},{headers:{date}});
const unavailable=()=>new Response('<html>not a quote</html>',{status:202});
async function withFetch(fake,run){const original=globalThis.fetch;globalThis.fetch=fake;try{return await run();}finally{globalThis.fetch=original;}}
async function withClock(run){const original=Date.now;let now=original();Date.now=()=>now;try{return await run(delta=>{now+=delta;});}finally{Date.now=original;}}

test('anonymous read uses only the fixed product GET and honest standard public headers; never reads credentials',async()=>{
  let calls=0;
  const env={get BINANCE_API_KEY(){assert.fail('公开接口成功不应读取key');},url:'https://untrusted.invalid/',query:{targetAsset:'ETH',pageIndex:999},headers:{cookie:'DO_NOT_FORWARD',authorization:'DO_NOT_FORWARD'}};
  await withFetch(async(url,options)=>{
    calls++;assert.equal(String(url),PUBLIC+'&pageIndex=1');assert.equal(options.method,'GET');
    assert.deepEqual([...new Headers(options.headers).entries()],[['accept','application/json'],['clienttype','web'],['lang','en'],['user-agent',USER_AGENT]]);
    assert.equal(options.credentials,'omit');assert.equal(options.redirect,'manual');assert.equal(options.cache,'no-store');assert.ok(options.signal instanceof AbortSignal);assert.equal(options.body,undefined);
    return page('1',[row()]);
  },async()=>{
    const result=await createBinanceReader()(env);
    assert.equal(result.status,'ready');assert.equal(calls,1);assert.equal(result.source,PUBLIC);assert.equal(result.sourceType,'public_web');assert.equal(result.serverTime,Date.parse(date));
    assert.ok(result.completedAt>=result.fetchedAt);assert.equal(result.total,1);assert.equal(result.pageCount,1);
    assert.doesNotMatch(JSON.stringify(result),/TEST_READ_ONLY_KEY|DO_NOT_EXPORT|PRIVATE_ORDER_ID|autoCompoundUserConfig/);
  });
});

test('public product output marks unavailable precision and deadline as unknown without making them up',async()=>{
  await withFetch(async()=>page(1,[row()]),async()=>{
    const result=await createBinanceReader()(),item=result.items[0];
    assert.deepEqual(item,{id:'p1',optionType:'PUT',exercisedCoin:'BTC',investCoin:'USDT',strikePrice:'81500.00000000',duration:1,settleDate:1792742400000,purchaseDecimal:null,purchaseEndTime:null,canPurchase:true,apr:'1.34380000',minAmount:'10.00000000',maxAmount:'3922080.00000000'});
    assert.deepEqual(result.eligibility,{precisionKnown:false,purchaseWindowKnown:false,accountEligibilityVerified:false,missingFields:['purchaseDecimal','purchaseEndTime']});
  });
});

test('complete pagination retains first and last server times and strips unrelated fields from every page',async()=>{
  const urls=[];
  await withFetch(async url=>{urls.push(String(url));const p=Number(new URL(url).searchParams.get('pageIndex'));return p===1?page('101',Array.from({length:100},(_,i)=>row('p'+i))):page('101',[row('p100')],{headers:{date:laterDate}});},async()=>{
    const result=await createBinanceReader()({BINANCE_API_KEY:KEY});assert.equal(result.status,'ready');assert.equal(result.items.length,101);
    assert.deepEqual(urls,[PUBLIC+'&pageIndex=1',PUBLIC+'&pageIndex=2']);assert.equal(result.pageCount,2);
    assert.equal(result.serverTime,Date.parse(date));assert.equal(result.lastServerTime,Date.parse(laterDate));
    assert.doesNotMatch(JSON.stringify(result),/DO_NOT_EXPORT|PRIVATE_ORDER_ID/);
  });
});

test('public snapshots are cached across callers for 10 seconds and returned as independent copies',async()=>{
  await withClock(async advance=>{
    let calls=0;
    await withFetch(async()=>{calls++;return page(1,[row('response-'+calls)]);},async()=>{
      const read=createBinanceReader(),one=await read({BINANCE_API_KEY:KEY});one.items[0].apr='999';one.eligibility.missingFields.push('invented');
      advance(9999);const cached=await read({});assert.equal(calls,1);assert.equal(cached.items[0].apr,'1.34380000');assert.equal(cached.eligibility.missingFields.length,2);
      advance(1);const fresh=await read({BINANCE_API_KEY:KEY+'_ROTATED'});assert.equal(calls,2);assert.equal(fresh.items[0].id,'response-2');
    });
  });
});

test('an expired public snapshot is never used on error, and no key is required for anonymous failure status',async()=>{
  await withClock(async advance=>{
    let calls=0;
    await withFetch(async()=>++calls===1?page(1,[row('OLD_MUST_NOT_RETURN')]):Response.json({msg:'unavailable '+KEY},{status:503}),async()=>{
      const read=createBinanceReader();assert.equal((await read()).status,'ready');advance(10001);
      const failed=await read();assert.equal(failed.status,'unavailable');assert.equal(failed.fallbackStatus,'authorization_required');assert.equal(failed.items,undefined);assert.doesNotMatch(JSON.stringify(failed),/OLD_MUST_NOT_RETURN|TEST_READ_ONLY_KEY/);
      await read();assert.equal(calls,3,'失败不能伪装成旧报价');
    });
  });
});

test('SAPI is used only after public failure, with one key header and no browser headers or secrets',async()=>{
  const urls=[];
  await withFetch(async(url,options)=>{
    urls.push(String(url));
    if(String(url).startsWith(PUBLIC))return unavailable();
    assert.equal(String(url),SAPI+'&pageIndex=1');assert.equal(options.method,'GET');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'manual');
    assert.deepEqual([...new Headers(options.headers).entries()],[['x-mbx-apikey',KEY]]);return sapiPage(1,[sapiRow()]);
  },async()=>{
    const result=await createBinanceReader()({BINANCE_API_KEY:KEY,secret:'DO_NOT_FORWARD',headers:{cookie:'DO_NOT_FORWARD'}});
    assert.equal(result.status,'ready');assert.equal(result.sourceType,'sapi');assert.equal(result.source,SAPI);assert.equal(result.publicStatus,'unavailable');
    assert.deepEqual(result.eligibility,{precisionKnown:true,purchaseWindowKnown:true,accountEligibilityVerified:false,missingFields:[]});
    assert.equal(result.items[0].purchaseDecimal,8);assert.equal(result.items[0].purchaseEndTime,1793260800000);assert.equal(urls.length,2);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_ORDER_ID|DO_NOT_EXPORT|TEST_READ_ONLY_KEY/);
  });
});

test('fallback cache is key-isolated, and deleting the key cannot return a prior fallback quote',async()=>{
  await withClock(async advance=>{
    const sent=[];
    await withFetch(async(url,options)=>{
      if(String(url).startsWith(PUBLIC))return unavailable();
      sent.push(new Headers(options.headers).get('x-mbx-apikey'));return sapiPage(1,[sapiRow('response-'+sent.length)]);
    },async()=>{
      const read=createBinanceReader();await read({BINANCE_API_KEY:KEY});advance(9999);await read({BINANCE_API_KEY:KEY});assert.equal(sent.length,1);
      advance(1);await read({BINANCE_API_KEY:KEY});assert.equal(sent.length,2);
      const changed=await read({BINANCE_API_KEY:KEY+'_ROTATED'});assert.equal(sent.length,3);assert.equal(changed.items[0].id,'response-3');
      const removed=await read({});assert.equal(removed.status,'unavailable');assert.equal(removed.items,undefined);
      await read({BINANCE_API_KEY:KEY});assert.equal(sent.length,4);
    });
  });
});

test('fallback authentication and quota failures are safe summaries and never echo upstream data',async()=>{
  for(const [status,code,expected] of [[400,-2014,'authorization_required'],[400,-2015,'authorization_required'],[401,0,'authorization_required'],[429,-1003,'unavailable'],[418,-1003,'unavailable'],[200,-1015,'unavailable']]){
    let calls=0;
    await withFetch(async url=>{calls++;return String(url).startsWith(PUBLIC)?unavailable():Response.json({code,msg:'key='+KEY},{status});},async()=>{
      const result=await createBinanceReader()({BINANCE_API_KEY:KEY});assert.equal(result.status,expected);assert.equal(result.items,undefined);assert.doesNotMatch(JSON.stringify(result),/TEST_READ_ONLY_KEY/);assert.equal(calls,2);
    });
  }
});

test('missing public envelope fields, wrong currencies or types and malformed numeric data fail closed',async()=>{
  for(const body of [{data:{total:1,list:[row()]}},{code:'000000',data:{list:[row()]}},{code:'000000',data:{total:1}},{code:'000000',data:{total:false,list:[]}},...[{apr:null},{duration:'1.5'},{settleTime:null},{investmentAsset:'USDC'},{targetAsset:'ETH'},{underlying:'ETH'},{type:'UP'},{canPurchase:'true'},{strikePrice:'Infinity'},{minDepositAmount:'-1'}].map(extra=>({code:'000000',data:{total:1,list:[row('p1',extra)]}}))]){
    await withFetch(async()=>Response.json(body,{headers:{date}}),async()=>{const result=await createBinanceReader()();assert.equal(result.status,'unavailable');assert.equal(result.items,undefined);});
  }
  await withFetch(async()=>page(1,[row('p1',{apr:'0',canPurchase:false})]),async()=>{const result=await createBinanceReader()();assert.equal(result.status,'ready');assert.equal(result.items[0].apr,'0');assert.equal(result.items[0].canPurchase,false);});
});

test('short or changing pages and duplicate products cannot become a complete public snapshot',async()=>{
  await withFetch(async()=>page(101,[row()]),async()=>assert.equal((await createBinanceReader()()).status,'unavailable'));
  let calls=0;
  await withFetch(async()=>++calls===1?page(101,Array.from({length:100},(_,i)=>row('p'+i))):page(102,[row('p100'),row('p101')]),async()=>{
    const result=await createBinanceReader()();assert.equal(result.status,'unavailable');assert.match(result.reason,/分页期间发生变化/);assert.equal(result.items,undefined);
  });
  await withFetch(async()=>page(2,[row('duplicate'),row('duplicate')]),async()=>{const result=await createBinanceReader()();assert.equal(result.status,'unavailable');assert.match(result.reason,/重复/);});
});

test('oversized product listings stop after one bounded request',async()=>{
  let calls=0;
  await withFetch(async()=>{calls++;return page(2001,Array.from({length:100},(_,i)=>row('p'+i)));},async()=>{
    const result=await createBinanceReader()();assert.equal(result.status,'unavailable');assert.match(result.reason,/上限/);assert.equal(calls,1);
  });
});

test('a valid HTTP Date is required, page times cannot regress, and an empty complete list is valid',async()=>{
  await withFetch(async()=>Response.json({code:'000000',data:{total:1,list:[row()]}}),async()=>{
    const result=await createBinanceReader()();assert.equal(result.status,'unavailable');assert.match(result.reason,/服务器读取时间/);
  });
  let calls=0;
  await withFetch(async()=>++calls===1?page(101,Array.from({length:100},(_,i)=>row('p'+i)),{headers:{date:laterDate}}):page(101,[row('p100')]),async()=>{
    const result=await createBinanceReader()();assert.equal(result.status,'unavailable');assert.match(result.reason,/服务器时间不一致/);
  });
  await withFetch(async()=>page(0,[]),async()=>{const result=await createBinanceReader()();assert.equal(result.status,'ready');assert.deepEqual(result.items,[]);});
});

test('network errors, HTML challenges, redirects and malformed JSON are never exposed as quotes or followed',async()=>{
  for(const fake of [async()=>{throw Error('transport accidentally included '+KEY);},async()=>new Response('not JSON '+KEY,{headers:{date}}),async()=>new Response('<html>'+KEY+'</html>',{status:202}),async()=>new Response('',{status:302,headers:{location:'https://untrusted.invalid/'}})]){
    let calls=0;
    await withFetch(async(...args)=>{calls++;return fake(...args);},async()=>{const result=await createBinanceReader()();assert.equal(result.status,'unavailable');assert.equal(result.items,undefined);assert.doesNotMatch(JSON.stringify(result),/TEST_READ_ONLY_KEY|untrusted.invalid/);assert.equal(calls,1);});
  }
});

test('the complete public read and optional fallback share a 15-second deadline',async()=>{
  await withClock(async advance=>{
    let calls=0;
    await withFetch(async url=>{calls++;if(String(url).startsWith(PUBLIC)){advance(15000);return unavailable();}assert.fail('到达总时限不应再读取SAPI');},async()=>{
      const result=await createBinanceReader()({BINANCE_API_KEY:KEY});assert.equal(result.status,'unavailable');assert.match(result.reason,/超时/);assert.equal(calls,1);
    });
    calls=0;
    await withFetch(async()=>{calls++;advance(15000);return page(1,[row()]);},async()=>{
      const result=await createBinanceReader()();assert.equal(result.status,'unavailable');assert.match(result.reason,/超时/);assert.equal(calls,1);
    });
  });
});

test('concurrent readers share the anonymous request regardless of optional server key',async()=>{
  let calls=0,release;
  const gate=new Promise(resolve=>{release=resolve;});
  await withFetch(async()=>{calls++;await gate;return page(1,[row()]);},async()=>{
    const read=createBinanceReader(),a=read({BINANCE_API_KEY:KEY}),b=read({});assert.equal(calls,1);release();
    const results=await Promise.all([a,b]);assert.ok(results.every(x=>x.status==='ready'));assert.equal(calls,1);assert.notEqual(results[0].items,results[1].items);
  });
});

test('diagnostics use two fixed credential-free GETs and classify public JSON and missing API authorization',async()=>{
  const calls=[];
  await withFetch(async(url,options)=>{
    calls.push(String(url));assert.equal(options.method,'GET');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'manual');assert.equal(options.cache,'no-store');assert.ok(options.signal instanceof AbortSignal);
    const expected=String(url).startsWith(PUBLIC)?[['accept','application/json'],['clienttype','web'],['lang','en'],['user-agent',USER_AGENT]]:[['accept','application/json'],['user-agent',USER_AGENT]];
    assert.deepEqual([...new Headers(options.headers).entries()],expected);assert.equal(options.body,undefined);
    return String(url).startsWith(PUBLIC)?page(1,[row()]):Response.json({code:-2014,msg:'PRIVATE_BODY_DO_NOT_ECHO'},{status:400,headers:{'content-type':'application/json',date}});
  },async()=>{
    const result=await createBinanceReader().diagnostics({url:'https://untrusted.invalid/',headers:{cookie:KEY},BINANCE_API_KEY:KEY});
    assert.deepEqual(calls.sort(),[PUBLIC+'&pageIndex=1',SAPI+'&pageIndex=1'].sort());
    assert.equal(result.results.public_web.classification,'public_ok');assert.equal(result.results.sapi.classification,'auth_required');
    assert.equal(result.results.sapi.httpStatus,400);assert.ok(Number.isFinite(result.checkedAt));
    assert.doesNotMatch(JSON.stringify(result),/TEST_READ_ONLY_KEY|DO_NOT_ECHO|orderId|items|apr|strikePrice|untrusted/);
  });
});

test('diagnostic classifications require explicit evidence and never equate generic CloudFront denial to a region block',async()=>{
  const cases=[
    [451,'unavailable',{},'region_restricted'],
    [403,'Service unavailable from a restricted location.',{},'region_restricted'],
    [403,'Access denied',{server:'CloudFront','x-cache':'Error from cloudfront'},'edge_denied'],
    [403,'Request blocked. Generated by cloudfront.',{},'edge_denied'],
    [403,'Please verify you are human. CAPTCHA',{server:'CloudFront'},'challenge'],
    [403,'Access denied',{},'unknown'],
    [302,'',{location:'https://DO_NOT_ECHO.invalid/'},'unknown']
  ];
  for(const [status,body,headers,expected] of cases){
    let calls=0;
    await withFetch(async()=>{calls++;return new Response(body,{status,headers});},async()=>{
      const result=await createBinanceReader().diagnostics();
      assert.equal(result.results.public_web.classification,expected);assert.equal(result.results.sapi.classification,expected);assert.equal(calls,2);
      assert.doesNotMatch(JSON.stringify(result),/DO_NOT_ECHO|restricted location|Access denied|verify you are/);
    });
  }
});

test('diagnostic headers are allowlisted and truncated; cookies, locations and raw messages are excluded',async()=>{
  await withFetch(async()=>new Response('PRIVATE_RESPONSE_BODY_DO_NOT_ECHO',{status:403,headers:{server:'x'.repeat(500),'x-cache':'Error from cloudfront','set-cookie':'PRIVATE_COOKIE_DO_NOT_ECHO',location:'https://PRIVATE_LOCATION_DO_NOT_ECHO.invalid/','x-api-key':KEY,'x-amz-cf-id':'f'.repeat(500),'content-type':'text/html'}}),async()=>{
    const result=await createBinanceReader().diagnostics();
    for(const item of Object.values(result.results)){
      assert.equal(item.classification,'edge_denied');assert.equal(item.server.length,180);assert.equal(item.cfId.length,180);
      assert.deepEqual(Object.keys(item).sort(),['classification','httpStatus','contentType','server','xCache','via','cfRay','cfId','date','retryAfter'].sort());
    }
    assert.doesNotMatch(JSON.stringify(result),/PRIVATE_|TEST_READ_ONLY_KEY|set-cookie|location|x-api-key/);
  });
});

test('diagnostics contain transport and oversized-body failures without exposing error strings',async()=>{
  for(const fake of [async()=>{throw Error('PRIVATE_NETWORK_ERROR '+KEY);},async()=>new Response('PRIVATE_BIG_BODY'.repeat(20000),{status:403})]){
    await withFetch(fake,async()=>{
      const result=await createBinanceReader().diagnostics();
      assert.ok(Object.values(result.results).every(item=>item.classification==='unknown'));
      assert.doesNotMatch(JSON.stringify(result),/PRIVATE_|TEST_READ_ONLY_KEY/);
    });
  }
});

test('diagnostics share a 15-second deadline and never classify a response completing after it as a quote',async()=>{
  await withClock(async advance=>{
    let calls=0;
    await withFetch(async()=>{calls++;advance(15000);return page(1,[row()]);},async()=>{
      const result=await createBinanceReader().diagnostics();assert.equal(calls,1);
      assert.equal(result.results.public_web.classification,'unknown');assert.equal(result.results.sapi.classification,'unknown');assert.equal(result.results.sapi.httpStatus,0);
    });
  });
});

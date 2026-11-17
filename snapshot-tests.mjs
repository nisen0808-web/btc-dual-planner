import test from 'node:test';
import assert from 'node:assert/strict';
import {saveSnapshot,readStoredSnapshot} from './worker/binance-snapshot.js';

const TOKEN='MOCK_COLLECTOR_TOKEN_NOT_A_REAL_SECRET_0123456789';
const KEY='binance/public-btc-usdt.json';
const SOURCE='https://www.binance.com/bapi/earn/v5/friendly/pos/dc/project/list?investmentAsset=USDT&targetAsset=BTC&projectType=DOWN&sortType=APY_DESC&pageSize=100';
const origin='https://owner-site.invalid/api/binance-snapshot';
const row=(id='p1',extra={})=>({id,optionType:'PUT',exercisedCoin:'BTC',investCoin:'USDT',strikePrice:'81500.00000000',duration:1,settleDate:1792742400000,purchaseDecimal:null,purchaseEndTime:null,canPurchase:true,apr:'1.34380000',minAmount:'10.00000000',maxAmount:'3922080.00000000',...extra});
const sample=(now=Date.now(),extra={})=>({status:'ready',items:[row()],serverTime:now-1500,lastServerTime:now-1000,fetchedAt:now-1500,completedAt:now-500,source:SOURCE,sourceType:'public_web',eligibility:{precisionKnown:false,purchaseWindowKnown:false,accountEligibilityVerified:false,missingFields:['purchaseDecimal','purchaseEndTime']},pageCount:1,total:1,...extra});
function request(body,extra={}){return new Request(origin,{method:'POST',headers:{'content-type':'application/json','x-binance-collector-token':TOKEN,...extra.headers},body:typeof body==='string'?body:JSON.stringify(body),...Object.fromEntries(Object.entries(extra).filter(([key])=>key!=='headers'))});}
function memoryBucket(){
  let text=null,etag=0;const calls=[];
  return {calls,get text(){return text;},set text(value){text=value;etag++;},async get(key){calls.push(['get',key]);assert.equal(key,KEY);return text===null?null:{size:new TextEncoder().encode(text).length,etag:String(etag),text:async()=>text};},async put(key,value,options){calls.push(['put',key,options]);assert.equal(key,KEY);const condition=options.onlyIf;if(condition instanceof Headers){assert.equal(condition.get('if-none-match'),'*');if(text!==null)return null;}else if(condition.etagMatches!==String(etag))return null;text=String(value);etag++;return {etag:String(etag)};}};
}
const env=bucket=>({BINANCE_COLLECTOR_TOKEN:TOKEN,BINANCE_QUOTES:bucket});
async function fixedClock(run){const real=Date.now;let now=1792670400000;Date.now=()=>now;try{return await run(ms=>{now+=ms;});}finally{Date.now=real;}}

test('unauthorized POST and GET cannot read or write R2 and never echo supplied tokens',async()=>{
  const bucket=memoryBucket();
  for(const [method,token] of [['POST',''],['POST',TOKEN+'bad'],['GET',TOKEN+'bad']]){
    const req=new Request(origin,{method,headers:{'x-binance-collector-token':token,'content-type':'application/json'},...(method==='POST'?{body:'{}'}:{})});
    const response=await saveSnapshot(req,env(bucket));assert.equal(response.status,403);assert.doesNotMatch(await response.text(),/MOCK_COLLECTOR|bad/);
  }
  assert.equal(bucket.calls.length,0);
  assert.equal((await saveSnapshot(new Request(origin,{headers:{'x-binance-collector-token':TOKEN}}),env(bucket))).status,405);
});

test('valid authenticated snapshot is stored only at the fixed key with strict conditional creation and canonical public fields',async()=>{
  await fixedClock(async()=>{
    const bucket=memoryBucket(),body=sample();body.orderId='PRIVATE_DO_NOT_STORE';body.items[0].autoCompoundUserConfig={private:'PRIVATE_DO_NOT_STORE'};body.items[0].orderId='PRIVATE_DO_NOT_STORE';body.eligibility.private='PRIVATE_DO_NOT_STORE';
    const response=await saveSnapshot(request(body),env(bucket));assert.equal(response.status,200);assert.equal((await response.json()).ok,true);assert.equal(response.headers.get('cache-control'),'no-store');
    assert.doesNotMatch(bucket.text,/PRIVATE_|orderId|autoCompound|MOCK_COLLECTOR/);
    const stored=JSON.parse(bucket.text);assert.equal(stored.version,1);assert.equal(stored.snapshot.source,SOURCE);assert.equal(stored.snapshot.items[0].purchaseDecimal,null);
    const read=await readStoredSnapshot(env(bucket));assert.equal(read.status,'ready');assert.equal(read.deliveryType,'collector_push');assert.equal(read.sourceType,'public_web');assert.equal(read.collectorLastSeen,Date.now());assert.equal(read.snapshotAgeMs,500);assert.equal(read.total,1);assert.deepEqual(read.eligibility,sample().eligibility);
  });
});

test('snapshots with stale, future or internally inconsistent timing are rejected before storage',async()=>{
  await fixedClock(async()=>{
    for(const change of [{fetchedAt:Date.now()+2001},{serverTime:Date.now()-30001},{lastServerTime:Date.now()+2001},{completedAt:Date.now()+2001},{fetchedAt:Date.now()-16000,serverTime:Date.now()-16000},{serverTime:Date.now()-5000},{lastServerTime:Date.now()-1600}]){
      const bucket=memoryBucket();assert.equal((await saveSnapshot(request(sample(Date.now(),change)),env(bucket))).status,400);assert.equal(bucket.calls.length,0);
    }
  });
});

test('source, readiness, complete-page proofs and duplicate IDs are mandatory',async()=>{
  await fixedClock(async()=>{
    for(const change of [{source:SOURCE+'&anything=1'},{sourceType:'sapi'},{status:'unavailable'},{total:2},{total:'1'},{pageCount:2},{total:2,items:[row('same'),row('same')]},{eligibility:{...sample().eligibility,precisionKnown:true}}]){
      const bucket=memoryBucket();assert.equal((await saveSnapshot(request(sample(Date.now(),change)),env(bucket))).status,400);assert.equal(bucket.calls.length,0);
    }
    const bucket=memoryBucket(),items=Array.from({length:101},(_,i)=>row('p'+i));assert.equal((await saveSnapshot(request(sample(Date.now(),{items,total:101,pageCount:2})),env(bucket))).status,200);
  });
});

test('individual product direction, currency, decimal, limits and missing precision are strictly validated; zero APR is valid',async()=>{
  await fixedClock(async()=>{
    for(const change of [{investCoin:'USDC'},{exercisedCoin:'ETH'},{optionType:'CALL'},{apr:'Infinity'},{apr:'-0.1'},{apr:null},{strikePrice:'0'},{duration:1.5},{settleDate:null},{minAmount:'100',maxAmount:'1'},{purchaseDecimal:8},{purchaseEndTime:Date.now()},{canPurchase:'true'}]){
      const bucket=memoryBucket();assert.equal((await saveSnapshot(request(sample(Date.now(),{items:[row('p',change)]})),env(bucket))).status,400);assert.equal(bucket.calls.length,0);
    }
    const bucket=memoryBucket();assert.equal((await saveSnapshot(request(sample(Date.now(),{items:[row('zero',{apr:'0'})]})),env(bucket))).status,200);
  });
});

test('same or older collection times cannot overwrite the stored snapshot; a newer collection succeeds',async()=>{
  await fixedClock(async advance=>{
    const bucket=memoryBucket(),one=sample();assert.equal((await saveSnapshot(request(one),env(bucket))).status,200);const original=bucket.text;
    for(const body of [one,{...one,fetchedAt:one.fetchedAt-1}]){assert.equal((await saveSnapshot(request(body),env(bucket))).status,409);assert.equal(bucket.text,original);}
    advance(1000);assert.equal((await saveSnapshot(request(sample()),env(bucket))).status,200);assert.notEqual(bucket.text,original);
  });
});

test('conditional R2 write races fail closed instead of overwriting another producer update',async()=>{
  await fixedClock(async()=>{
    const bucket=memoryBucket();bucket.put=async()=>null;
    assert.equal((await saveSnapshot(request(sample()),env(bucket))).status,409);assert.equal(bucket.text,null);
  });
});

test('expired stored data and malformed or future envelopes never become a ready quote',async()=>{
  await fixedClock(async advance=>{
    const bucket=memoryBucket();assert.equal((await saveSnapshot(request(sample()),env(bucket))).status,200);advance(30000);
    const expired=await readStoredSnapshot(env(bucket));assert.equal(expired.status,'unavailable');assert.equal(expired.items,undefined);assert.ok(expired.collectorLastSeen>0);
    for(const text of ['not JSON',JSON.stringify({version:1,savedAt:Date.now()+1,snapshot:sample()}),JSON.stringify({version:1,savedAt:Date.now(),snapshot:sample(Date.now(),{source:'https://untrusted.invalid/'})})]){bucket.text=text;assert.equal((await readStoredSnapshot(env(bucket))).status,'unavailable');}
  });
});

test('content type, declared size, streamed byte size and malformed JSON are bounded',async()=>{
  const bucket=memoryBucket();
  assert.equal((await saveSnapshot(request('{}',{headers:{'content-type':'text/plain'}}),env(bucket))).status,415);
  assert.equal((await saveSnapshot(request('{}',{headers:{'content-length':'1048577'}}),env(bucket))).status,413);
  assert.equal((await saveSnapshot(request('x'.repeat(1048577)),env(bucket))).status,413);
  assert.equal((await saveSnapshot(request('not JSON'),env(bucket))).status,400);assert.equal(bucket.calls.length,0);
});

test('a stalled request body is cancelled within the complete-read time limit',async()=>{
  const realSet=setTimeout,realClear=clearTimeout;let cancelled=false;
  globalThis.setTimeout=(fn)=>realSet(fn,1);globalThis.clearTimeout=realClear;
  try{
    const body=new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled=true;}});
    const req=new Request(origin,{method:'POST',headers:{'content-type':'application/json','x-binance-collector-token':TOKEN},body,duplex:'half'});
    const response=await saveSnapshot(req,env(memoryBucket()));assert.equal(response.status,408);assert.equal(cancelled,true);
  }finally{globalThis.setTimeout=realSet;globalThis.clearTimeout=realClear;}
});

test('missing or failing storage is safe and cannot leak storage exceptions or credentials',async()=>{
  assert.equal((await readStoredSnapshot({})).status,'unavailable');
  const bucket={async get(){throw Error('PRIVATE_STORAGE '+TOKEN);},async put(){throw Error('PRIVATE_STORAGE '+TOKEN);}};
  await fixedClock(async()=>{
    const response=await saveSnapshot(request(sample()),env(bucket));assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/PRIVATE_|MOCK_COLLECTOR/);
    const read=await readStoredSnapshot(env(bucket));assert.equal(read.status,'unavailable');assert.doesNotMatch(JSON.stringify(read),/PRIVATE_|MOCK_COLLECTOR/);
  });
});

test('read TTL is checked after storage body delivery, so delayed reads cannot return an expired quote',async()=>{
  await fixedClock(async advance=>{
    const bucket=memoryBucket();assert.equal((await saveSnapshot(request(sample()),env(bucket))).status,200);
    const get=bucket.get.bind(bucket);bucket.get=async key=>{const object=await get(key);const text=object.text;return {...object,text:async()=>{advance(30000);return text();}};};
    const result=await readStoredSnapshot(env(bucket));assert.equal(result.status,'unavailable');assert.equal(result.items,undefined);assert.ok(result.collectorLastSeen>0);
  });
});

test('oversized or corrupted existing objects fail closed without being overwritten',async()=>{
  await fixedClock(async()=>{
    let writes=0;
    const bucket={async get(){return {size:1048577,etag:'old',async text(){assert.fail('超大存储对象不得读取正文');}};},async put(){writes++;}};
    assert.equal((await readStoredSnapshot(env(bucket))).status,'unavailable');
    assert.equal((await saveSnapshot(request(sample()),env(bucket))).status,503);assert.equal(writes,0);
  });
});

test('authenticated validation diagnostics distinguish a future producer clock from stale or invalid timestamps',async()=>{
  await fixedClock(async()=>{
    for(const [change,code,field,delta] of [[{completedAt:Date.now()+2001},'timestamp_future','completedAt',2001],[{serverTime:Date.now()-30001},'timestamp_stale','serverTime',-30001],[{lastServerTime:'INVALID_PRIVATE_VALUE'},'timestamp_invalid','lastServerTime',undefined]]){
      const bucket=memoryBucket(),response=await saveSnapshot(request(sample(Date.now(),change)),env(bucket)),body=await response.json();
      assert.equal(response.status,400);assert.equal(body.validationCode,code);assert.equal(body.validationField,field);assert.equal(body.timeDeltaMs,delta);
      assert.equal(body.serverReceivedAt,Date.now());assert.equal(body.serverValidatedAt,Date.now());assert.equal(bucket.calls.length,0);
      assert.equal(body.reason,'采集快照无效、时间不合理或已超过 30 秒。');assert.doesNotMatch(JSON.stringify(body),/INVALID_PRIVATE_VALUE|items|strikePrice|MOCK_COLLECTOR/);
    }
  });
});

test('row-schema diagnostics contain only fixed codes, field names and index, never the offending quote value',async()=>{
  await fixedClock(async()=>{
    const cases=[['apr',1.2,'item_decimal_type_invalid'],['maxAmount','1e50','item_decimal_format_invalid'],['maxAmount','9007199254740992','item_decimal_range_invalid']];
    for(const [field,value,code] of cases){
      const body=sample(Date.now(),{items:[row('p0'),row('PRIVATE_ID_DO_NOT_ECHO',{[field]:value})],total:2});
      const response=await saveSnapshot(request(body),env(memoryBucket())),result=await response.json();
      assert.equal(response.status,400);assert.equal(result.validationCode,code);assert.equal(result.validationField,field);assert.equal(result.itemIndex,1);assert.equal(result.timeDeltaMs,undefined);
      assert.doesNotMatch(JSON.stringify(result),/PRIVATE_ID|9007199254740992|1e50|MOCK_COLLECTOR/);
    }
  });
});

test('proof and source failures have stable enums, while unauthorized and non-400 responses expose no validation diagnostics',async()=>{
  await fixedClock(async()=>{
    for(const [change,code] of [[{source:'PRIVATE_UNTRUSTED_SOURCE'},'source_invalid'],[{pageCount:9},'page_count_invalid'],[{total:2},'item_total_mismatch']]){
      const response=await saveSnapshot(request(sample(Date.now(),change)),env(memoryBucket()));assert.equal(response.status,400);
      const body=await response.json();assert.equal(body.validationCode,code);assert.equal(body.serverReceivedAt,Date.now());assert.doesNotMatch(JSON.stringify(body),/PRIVATE_UNTRUSTED_SOURCE/);
    }
    const response=await saveSnapshot(request('{}',{headers:{'x-binance-collector-token':'wrong'}}),env(memoryBucket())),body=await response.json();
    assert.equal(response.status,403);assert.equal(body.validationCode,undefined);assert.equal(body.serverReceivedAt,undefined);
    const badJson=await saveSnapshot(request('PRIVATE_MALFORMED_JSON'),env(memoryBucket())),diagnostic=await badJson.json();assert.equal(badJson.status,400);assert.equal(diagnostic.validationCode,'json_invalid');assert.equal(diagnostic.serverReceivedAt,Date.now());assert.doesNotMatch(JSON.stringify(diagnostic),/PRIVATE_MALFORMED_JSON/);
  });
});

test('producer future skew permits exactly 2 seconds, rejects larger skew, and returns nonnegative conservative age',async()=>{
  await fixedClock(async advance=>{
    const now=Date.now(),bucket=memoryBucket(),body=sample(now,{serverTime:now,lastServerTime:now+1000,fetchedAt:now+1500,completedAt:now+2000});
    assert.equal((await saveSnapshot(request(body),env(bucket))).status,200);
    let read=await readStoredSnapshot(env(bucket));assert.equal(read.status,'ready');assert.equal(read.snapshotAgeMs,0);assert.equal(read.snapshotAgeAtRead,0);
    advance(1000);read=await readStoredSnapshot(env(bucket));assert.equal(read.snapshotAgeMs,0);assert.equal(read.snapshotAgeAtRead,1000);
    for(const field of ['serverTime','lastServerTime','fetchedAt','completedAt']){
      const rejected=await saveSnapshot(request(sample(Date.now(),{[field]:Date.now()+2001})),env(memoryBucket())),error=await rejected.json();
      assert.equal(rejected.status,400);assert.equal(error.validationCode,'timestamp_future');assert.equal(error.validationField,field);assert.equal(error.timeDeltaMs,2001);
    }
  });
});

test('old source HTTP dates expire the snapshot even when producer times are recent or slightly ahead',async()=>{
  await fixedClock(async()=>{
    const now=Date.now(),bucket=memoryBucket(),old=sample(now,{serverTime:now-30001});
    const response=await saveSnapshot(request(old),env(bucket)),error=await response.json();assert.equal(response.status,400);assert.equal(error.validationCode,'timestamp_stale');assert.equal(error.validationField,'serverTime');assert.equal(bucket.calls.length,0);
    const envelope={version:1,savedAt:now,snapshot:old};bucket.text=JSON.stringify(envelope);
    assert.equal((await readStoredSnapshot(env(bucket))).status,'unavailable');
  });
});

test('cloud savedAt remains strictly nonfuture and is included in read age when producer clocks are ahead',async()=>{
  await fixedClock(async advance=>{
    const now=Date.now(),bucket=memoryBucket(),future=sample(now,{serverTime:now+1000,lastServerTime:now+1000,fetchedAt:now+1000,completedAt:now+2000});
    assert.equal((await saveSnapshot(request(future),env(bucket))).status,200);
    advance(2000);const read=await readStoredSnapshot(env(bucket));assert.equal(read.status,'ready');assert.equal(read.snapshotAgeMs,0);assert.equal(read.snapshotAgeAtRead,2000,'云端接收年龄不得被producer未来时间抵消');
    const stored=JSON.parse(bucket.text);stored.savedAt=Date.now()+1;bucket.text=JSON.stringify(stored);assert.equal((await readStoredSnapshot(env(bucket))).status,'unavailable');
    stored.savedAt=now;stored.snapshot.completedAt=now+2001;bucket.text=JSON.stringify(stored);assert.equal((await readStoredSnapshot(env(bucket))).status,'unavailable','envelope不能放过completedAt比云savedAt快超过2秒');
  });
});

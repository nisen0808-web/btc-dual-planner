const BINANCE_SNAPSHOT_KEY='binance/public-btc-usdt.json';
const BINANCE_SNAPSHOT_SOURCE='https://www.binance.com/bapi/earn/v5/friendly/pos/dc/project/list?investmentAsset=USDT&targetAsset=BTC&projectType=DOWN&sortType=APY_DESC&pageSize=100';
const BINANCE_SNAPSHOT_LIMIT=1048576,BINANCE_SNAPSHOT_TTL=30000,BINANCE_SNAPSHOT_READ_MS=5000,BINANCE_SNAPSHOT_FUTURE_SKEW=2000;
const snapshotEncoder=new TextEncoder();
const snapshotUnavailable=reason=>({status:'unavailable',reason,source:BINANCE_SNAPSHOT_SOURCE,sourceType:'public_web',serverTime:0,fetchedAt:0});
const snapshotReply=(status,reason,extra={})=>Response.json({status:status===200?'accepted':'unavailable',reason,...extra},{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
const snapshotTime=value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0&&value<=8640000000000000;
const snapshotDecimal=value=>typeof value==='string'&&value.length<=60&&/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)&&Number.isFinite(Number(value))&&Number(value)>=0&&Number(value)<=Number.MAX_SAFE_INTEGER;
const snapshotEligibility=()=>({precisionKnown:false,purchaseWindowKnown:false,accountEligibilityVerified:false,missingFields:['purchaseDecimal','purchaseEndTime']});

function normalizeBinanceSnapshot(raw,now,fresh=true,diagnostic=null) {
  const reject=(validationCode,metadata={})=>{if(diagnostic)Object.assign(diagnostic,{validationCode},metadata);return null;};
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return reject('snapshot_shape_invalid');
  if(raw.status!=='ready')return reject('snapshot_status_invalid');
  if(raw.sourceType!=='public_web')return reject('source_type_invalid');
  if(raw.source!==BINANCE_SNAPSHOT_SOURCE)return reject('source_invalid');
  if(!Number.isSafeInteger(raw.total)||raw.total<0||raw.total>2000)return reject('total_invalid');
  if(!Array.isArray(raw.items))return reject('items_invalid');
  if(raw.items.length!==raw.total)return reject('item_total_mismatch');
  if(raw.pageCount!==Math.max(1,Math.ceil(raw.total/100)))return reject('page_count_invalid');
  const {serverTime,lastServerTime,fetchedAt,completedAt}=raw;
  for(const validationField of ['serverTime','lastServerTime','fetchedAt','completedAt']){
    const value=raw[validationField];
    if(!snapshotTime(value))return reject('timestamp_invalid',{validationField});
    if(value>now+BINANCE_SNAPSHOT_FUTURE_SKEW)return reject('timestamp_future',{validationField,timeDeltaMs:value-now});
    if(fresh&&now-value>BINANCE_SNAPSHOT_TTL)return reject('timestamp_stale',{validationField,timeDeltaMs:value-now});
  }
  if(fetchedAt>completedAt)return reject('collection_time_order_invalid');
  if(serverTime>lastServerTime)return reject('server_time_order_invalid');
  if(completedAt-fetchedAt>15000)return reject('collection_span_exceeded');
  if(lastServerTime-serverTime>15000)return reject('server_span_exceeded');
  // HTTP Date has one-second precision; allow a small clock/rounding difference between its timestamps and collection times.
  if(serverTime<fetchedAt-2000)return reject('server_time_before_collection');
  if(lastServerTime>completedAt+2000)return reject('server_time_after_collection');
  const eligibility=raw.eligibility;
  if(!eligibility||eligibility.precisionKnown!==false||eligibility.purchaseWindowKnown!==false||eligibility.accountEligibilityVerified!==false||!Array.isArray(eligibility.missingFields)||eligibility.missingFields.length!==2||!['purchaseDecimal','purchaseEndTime'].every(field=>eligibility.missingFields.includes(field)))return reject('eligibility_invalid');
  const seen=new Set(),items=[];
  for(const [itemIndex,row] of raw.items.entries()){
    const rowReject=(code,metadata={})=>reject(code,{itemIndex,...metadata});
    if(!row||typeof row!=='object'||Array.isArray(row))return rowReject('item_shape_invalid');
    if(typeof row.id!=='string'||!/^[-A-Za-z0-9_]{1,150}$/.test(row.id))return rowReject('item_id_invalid');
    if(seen.has(row.id))return rowReject('item_id_duplicate');
    if(row.optionType!=='PUT'||row.exercisedCoin!=='BTC'||row.investCoin!=='USDT')return rowReject('item_market_invalid');
    if(typeof row.canPurchase!=='boolean')return rowReject('item_availability_invalid');
    if(row.purchaseDecimal!==null||row.purchaseEndTime!==null)return rowReject('item_precision_not_null');
    for(const validationField of ['strikePrice','apr','minAmount','maxAmount']){
      const value=row[validationField];
      if(!snapshotDecimal(value)){
        const code=typeof value!=='string'?'item_decimal_type_invalid':value.length>60||!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)?'item_decimal_format_invalid':'item_decimal_range_invalid';
        return rowReject(code,{validationField});
      }
    }
    if(Number(row.strikePrice)<=0)return rowReject('item_strike_nonpositive');
    if(row.canPurchase&&Number(row.maxAmount)<Number(row.minAmount))return rowReject('item_limits_inconsistent');
    if(!Number.isSafeInteger(row.duration)||row.duration<=0||row.duration>3650)return rowReject('item_duration_invalid');
    if(!snapshotTime(row.settleDate))return rowReject('item_settlement_invalid');
    seen.add(row.id);
    items.push({id:row.id,optionType:'PUT',exercisedCoin:'BTC',investCoin:'USDT',strikePrice:row.strikePrice,duration:row.duration,settleDate:row.settleDate,purchaseDecimal:null,purchaseEndTime:null,canPurchase:row.canPurchase,apr:row.apr,minAmount:row.minAmount,maxAmount:row.maxAmount});
  }
  return {status:'ready',items,serverTime,lastServerTime,fetchedAt,completedAt,source:BINANCE_SNAPSHOT_SOURCE,sourceType:'public_web',eligibility:snapshotEligibility(),pageCount:raw.pageCount,total:raw.total};
}

async function snapshotAuthorized(request,env) {
  const expected=env?.BINANCE_COLLECTOR_TOKEN,provided=request.headers.get('x-binance-collector-token');
  if(typeof expected!=='string'||expected.length<32||expected.length>1024||!provided||provided.length>1024)return false;
  const algorithm={name:'HMAC',hash:'SHA-256'},message=snapshotEncoder.encode('btc-public-snapshot-collector-auth-v1');
  const signer=await crypto.subtle.importKey('raw',snapshotEncoder.encode(expected),algorithm,false,['sign']);
  const signature=await crypto.subtle.sign('HMAC',signer,message);
  const verifier=await crypto.subtle.importKey('raw',snapshotEncoder.encode(provided),algorithm,false,['verify']);
  // HMAC verification performs the fixed-size tag comparison in WebCrypto, not a JavaScript string comparison.
  return crypto.subtle.verify('HMAC',verifier,signature,message);
}

async function snapshotReadRequest(request) {
  const declared=request.headers.get('content-length');
  if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>BINANCE_SNAPSHOT_LIMIT))throw {kind:'size'};
  if(!request.body)throw {kind:'json'};
  const reader=request.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});
  let timer,size=0,text='';
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{void reader.cancel().catch(()=>{});reject({kind:'timeout'});},BINANCE_SNAPSHOT_READ_MS);});
  try{
    const result=await Promise.race([(async()=>{
      for(;;){
        const {done,value}=await reader.read();
        if(done)return JSON.parse(text+decoder.decode());
        size+=value.byteLength;
        if(size>BINANCE_SNAPSHOT_LIMIT){void reader.cancel().catch(()=>{});throw {kind:'size'};}
        text+=decoder.decode(value,{stream:true});
      }
    })(),timeout]);
    return result;
  }finally{clearTimeout(timer);reader.releaseLock();}
}

async function snapshotStoredEnvelope(object,now) {
  if(!object||!Number.isSafeInteger(object.size)||object.size<0||object.size>BINANCE_SNAPSHOT_LIMIT||typeof object.text!=='function')throw Error('invalid storage');
  const text=await object.text();
  if(snapshotEncoder.encode(text).byteLength>BINANCE_SNAPSHOT_LIMIT)throw Error('invalid storage');
  const envelope=JSON.parse(text);
  if(envelope?.version!==1||!snapshotTime(envelope.savedAt)||envelope.savedAt>now)throw Error('invalid storage');
  const snapshot=normalizeBinanceSnapshot(envelope.snapshot,now,false);
  if(!snapshot||envelope.savedAt+BINANCE_SNAPSHOT_FUTURE_SKEW<snapshot.completedAt)throw Error('invalid storage');
  return {savedAt:envelope.savedAt,snapshot};
}

/** POST-only fixed snapshot ingestion. Platform owner-private access is an additional, separate boundary. */
export async function saveSnapshot(request,env) {
  const serverReceivedAt=Date.now();
  try{if(!await snapshotAuthorized(request,env))return snapshotReply(403,'采集提交未获授权。');}
  catch{return snapshotReply(403,'采集提交未获授权。');}
  if(request.method!=='POST')return new Response('Method not allowed',{status:405,headers:{allow:'POST','cache-control':'no-store'}});
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))return snapshotReply(415,'采集快照必须为 JSON。');
  let raw;
  try{raw=await snapshotReadRequest(request);}
  catch(error){const status=error?.kind==='size'?413:error?.kind==='timeout'?408:400;return snapshotReply(status,error?.kind==='size'?'采集快照超过大小上限。':error?.kind==='timeout'?'采集快照读取超时。':'采集快照不是有效 JSON。',status===400?{validationCode:'json_invalid',serverReceivedAt,serverValidatedAt:Date.now()}:{});}
  let now=Date.now();const diagnostic={};let snapshot=normalizeBinanceSnapshot(raw,now,true,diagnostic);
  if(!snapshot)return snapshotReply(400,'采集快照无效、时间不合理或已超过 30 秒。',{...diagnostic,serverReceivedAt,serverValidatedAt:now});
  const bucket=env?.BINANCE_QUOTES;
  if(!bucket||typeof bucket.get!=='function'||typeof bucket.put!=='function')return snapshotReply(503,'报价存储暂不可用。');
  try{
    const existing=await bucket.get(BINANCE_SNAPSHOT_KEY);
    if(existing){
      const old=await snapshotStoredEnvelope(existing,Date.now());
      if(snapshot.fetchedAt<=old.snapshot.fetchedAt)return snapshotReply(409,'采集快照未更新，请重新采集。');
      if(typeof existing.etag!=='string'||!existing.etag)return snapshotReply(503,'报价存储暂不可用。');
    }
    now=Date.now();snapshot=normalizeBinanceSnapshot(snapshot,now,true,diagnostic);
    if(!snapshot)return snapshotReply(400,'采集快照已超过 30 秒，请重新采集。',{...diagnostic,serverReceivedAt,serverValidatedAt:now});
    const onlyIf=existing?{etagMatches:existing.etag}:new Headers({'If-None-Match':'*'});
    const content=JSON.stringify({version:1,savedAt:now,snapshot});
    if(snapshotEncoder.encode(content).byteLength>BINANCE_SNAPSHOT_LIMIT)return snapshotReply(413,'采集快照超过大小上限。');
    const written=await bucket.put(BINANCE_SNAPSHOT_KEY,content,{onlyIf,httpMetadata:{contentType:'application/json',cacheControl:'no-store'}});
    if(written===null)return snapshotReply(409,'报价已被另一份快照更新，请重新采集。');
    return snapshotReply(200,'采集快照已更新。',{ok:true,collectorLastSeen:now,fetchedAt:snapshot.fetchedAt,total:snapshot.total});
  }catch{return snapshotReply(503,'报价存储暂不可用。');}
}

/** Caller routing must enforce the Site's owner-private access; no collector token is returned. */
export async function readStoredSnapshot(env) {
  const bucket=env?.BINANCE_QUOTES;
  if(!bucket||typeof bucket.get!=='function')return snapshotUnavailable('本机报价采集存储尚未就绪。');
  try{
    const object=await bucket.get(BINANCE_SNAPSHOT_KEY);
    if(!object)return snapshotUnavailable('尚未收到本机公开报价快照。');
    const envelope=await snapshotStoredEnvelope(object,Date.now()),now=Date.now();
    const snapshot=normalizeBinanceSnapshot(envelope.snapshot,now);
    if(!snapshot||now-envelope.savedAt>BINANCE_SNAPSHOT_TTL)return {...snapshotUnavailable('本机公开报价快照已超过 30 秒，请等待新数据。'),collectorLastSeen:envelope.savedAt};
    const snapshotAgeAtRead=Math.max(0,now-envelope.savedAt,now-snapshot.serverTime,now-snapshot.lastServerTime,now-snapshot.fetchedAt,now-snapshot.completedAt);
    return {...snapshot,deliveryType:'collector_push',collectorLastSeen:envelope.savedAt,snapshotAgeMs:Math.max(0,now-snapshot.completedAt),snapshotAgeAtRead};
  }catch{return snapshotUnavailable('本机公开报价快照暂不可用。');}
}

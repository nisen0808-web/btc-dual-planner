/** Fixed, read-only product discovery. No request or browser data is accepted. */
export function createBinanceReader() {
  const publicSource='https://www.binance.com/bapi/earn/v5/friendly/pos/dc/project/list?investmentAsset=USDT&targetAsset=BTC&projectType=DOWN&sortType=APY_DESC&pageSize=100';
  const sapiSource='https://api.binance.com/sapi/v1/dci/product/list?optionType=PUT&exercisedCoin=BTC&investCoin=USDT&pageSize=100';
  const pageSize=100,maxPages=20,cacheMilliseconds=10000,totalReadMilliseconds=15000;
  const userAgent='BTCStrategyStudio/1.0 (+https://btc-dual-planner-oct22.phyrex-ni.chatgpt.site)';
  const publicHeaders={clienttype:'web',lang:'en',Accept:'application/json','User-Agent':userAgent};
  let publicSnapshot=null,publicPending=null;
  let activeKey=null,generation=0,sapiSnapshot=null,sapiPending=null;
  const num=value=>(typeof value==='number'||typeof value==='string'&&value.trim()!=='')?Number(value):NaN;
  const timestamp=value=>Number.isSafeInteger(num(value))&&num(value)>0;
  const decimal=value=>{
    if(typeof value!=='string'&&typeof value!=='number')return null;
    const text=String(value).trim();
    if(!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)||!Number.isFinite(Number(text)))return null;
    return text;
  };
  const eligibility=kind=>({
    precisionKnown:kind==='sapi',purchaseWindowKnown:kind==='sapi',accountEligibilityVerified:false,
    missingFields:kind==='public_web'?['purchaseDecimal','purchaseEndTime']:[]
  });
  const sourceFor=kind=>kind==='public_web'?publicSource:sapiSource;
  const failure=(kind,status,reason)=>({status,reason,source:sourceFor(kind),sourceType:kind,serverTime:0,fetchedAt:Date.now()});
  const copy=result=>result.status==='ready'?{
    ...result,eligibility:{...result.eligibility,missingFields:[...result.eligibility.missingFields]},items:result.items.map(item=>({...item}))
  }:{...result};
  const invalidData=kind=>failure(kind,'unavailable','Binance 产品数据缺少必要字段，暂不提供部分或估算报价。');
  const fresh=snapshot=>{const age=snapshot?Date.now()-snapshot.fetchedAt:Infinity;return age>=0&&age<cacheMilliseconds;};

  function sanitize(raw,kind) {
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
    const publicWeb=kind==='public_web';
    if(publicWeb){
      if(raw.type!=='DOWN'||raw.investmentAsset!=='USDT'||raw.targetAsset!=='BTC'||raw.underlying!=='BTC')return null;
    }else if(raw.optionType!=='PUT'||raw.exercisedCoin!=='BTC'||raw.investCoin!=='USDT')return null;
    const id=(typeof raw.id==='string'||typeof raw.id==='number')?String(raw.id).trim():'';
    if(!id||id.length>150||typeof raw.canPurchase!=='boolean')return null;
    const strikePrice=decimal(raw.strikePrice),apr=decimal(raw.apr);
    const minAmount=decimal(publicWeb?raw.minDepositAmount:raw.minAmount),maxAmount=decimal(publicWeb?raw.maxDepositAmount:raw.maxAmount);
    if(strikePrice==null||!(Number(strikePrice)>0)||apr==null||minAmount==null||maxAmount==null)return null;
    const duration=num(raw.duration),settleDate=publicWeb?raw.settleTime:raw.settleDate;
    if(!Number.isSafeInteger(duration)||duration<=0||duration>3650||!timestamp(settleDate))return null;
    let purchaseDecimal=null,purchaseEndTime=null;
    if(!publicWeb){
      purchaseDecimal=num(raw.purchaseDecimal);
      if(!Number.isSafeInteger(purchaseDecimal)||purchaseDecimal<0||purchaseDecimal>18||!timestamp(raw.purchaseEndTime))return null;
      purchaseEndTime=num(raw.purchaseEndTime);
    }
    if(raw.canPurchase&&Number(maxAmount)<Number(minAmount))return null;
    // Explicit fields only: order IDs, user config and unexpected account data never leave this module.
    return {id,optionType:'PUT',exercisedCoin:'BTC',investCoin:'USDT',strikePrice,duration,settleDate:num(settleDate),purchaseDecimal,purchaseEndTime,canPurchase:raw.canPurchase,apr,minAmount,maxAmount};
  }

  async function fetchAll(kind,key,started) {
    const items=[],seen=new Set();
    let expectedTotal=null,oldestServerTime=Infinity,lastServerTime=0;
    for(let page=1;page<=maxPages;page++){
      const remaining=totalReadMilliseconds-(Date.now()-started);
      if(remaining<=0)return failure(kind,'unavailable','读取 Binance 产品列表超时，请稍后刷新。');
      let response,body;
      try {
        response=await fetch(sourceFor(kind)+'&pageIndex='+page,{
          method:'GET',headers:kind==='public_web'?{...publicHeaders}:{'X-MBX-APIKEY':key},
          credentials:'omit',redirect:'manual',signal:AbortSignal.timeout(Math.max(1,remaining)),cache:'no-store'
        });
        if(response.status===401)return failure(kind,kind==='sapi'?'authorization_required':'unavailable',kind==='sapi'?'Binance 只读 API key 未通过认证，请核对凭据、读取权限及访问限制。':'Binance 公开产品接口暂未允许本次读取。');
        if(response.status===429||response.status===418)return failure(kind,'unavailable','Binance 请求频率或配额受限，请稍后刷新。');
        if(response.status!==200&&!(kind==='sapi'&&response.status===400))return failure(kind,'unavailable','Binance 产品接口暂不可用（HTTP '+response.status+'）。');
        try{body=await response.json();}catch{return failure(kind,'unavailable','Binance 接口未返回有效 JSON 产品数据。');}
      } catch(error) {
        return failure(kind,'unavailable',error?.name==='AbortError'||error?.name==='TimeoutError'?'读取 Binance 产品列表超时，请稍后刷新。':'Binance 产品接口暂时无法连接，请稍后刷新。');
      }
      if(Date.now()-started>=totalReadMilliseconds)return failure(kind,'unavailable','读取 Binance 产品列表超时，请稍后刷新。');
      const apiCode=num(body?.code);
      if(kind==='sapi'&&[-2014,-2015,-1022,-1002].includes(apiCode))
        return failure(kind,'authorization_required','Binance 只读 API key 未通过认证，请核对凭据、读取权限及访问限制。');
      if(apiCode===-1003||apiCode===-1015)return failure(kind,'unavailable','Binance 请求频率或配额受限，请稍后刷新。');
      if(response.status!==200)return failure(kind,'unavailable','Binance 产品接口暂不可用（HTTP '+response.status+'）。');
      if((kind==='public_web'&&body?.code!=='000000')||(kind==='sapi'&&Number.isFinite(apiCode)&&apiCode<0))
        return failure(kind,'unavailable','Binance 产品接口拒绝了本次只读请求，暂未取得报价。');
      const data=kind==='public_web'?body?.data:body;
      if(!data||typeof data!=='object'||Array.isArray(data)||data.total==null||data.total===''||!Array.isArray(data.list))return invalidData(kind);
      const total=num(data.total);
      if(!Number.isSafeInteger(total)||total<0)return invalidData(kind);
      if(total>pageSize*maxPages)return failure(kind,'unavailable','Binance 产品列表超过本次安全分页上限，未使用不完整报价。');
      if(expectedTotal===null)expectedTotal=total;
      else if(total!==expectedTotal)return failure(kind,'unavailable','Binance 产品列表在分页期间发生变化，请刷新后重新读取。');
      const expectedCount=Math.min(pageSize,Math.max(0,expectedTotal-(page-1)*pageSize));
      if(data.list.length!==expectedCount)return failure(kind,'unavailable','Binance 产品分页不完整，未使用部分报价。');
      const serverTime=Date.parse(response.headers.get('date')||'');
      if(!Number.isFinite(serverTime)||serverTime<=0)return failure(kind,'unavailable','Binance 未返回可核验的服务器读取时间，请稍后刷新。');
      if(serverTime<lastServerTime)return failure(kind,'unavailable','Binance 产品分页的服务器时间不一致，请刷新后重新读取。');
      oldestServerTime=Math.min(oldestServerTime,serverTime);lastServerTime=serverTime;
      for(const raw of data.list){
        const item=sanitize(raw,kind);
        if(!item)return invalidData(kind);
        if(seen.has(item.id))return failure(kind,'unavailable','Binance 产品分页存在重复条目，未使用不完整报价。');
        seen.add(item.id);items.push(item);
      }
      if(items.length===expectedTotal)return {
        status:'ready',items,serverTime:oldestServerTime,lastServerTime,fetchedAt:started,completedAt:Date.now(),
        source:sourceFor(kind),sourceType:kind,eligibility:eligibility(kind),pageCount:page,total:expectedTotal
      };
    }
    return failure(kind,'unavailable','Binance 产品列表未能完整读取，暂不提供报价。');
  }

  // Explicit anonymous fallback for a moving catalogue. It never claims a
  // complete list, borrows a strict snapshot, reads env, or switches to SAPI.
  async function fetchChangingPublic(started) {
    const kind='public_web',items=new Map(),conflicts=new Set(),reportedTotals=[];
    let oldestServerTime=Infinity,lastServerTime=0;
    for(let page=1;page<=maxPages;page++){
      const remaining=totalReadMilliseconds-(Date.now()-started);
      if(remaining<=0)return failure(kind,'unavailable','读取 Binance 产品列表超时，请稍后刷新。');
      let response,body;
      try{
        response=await fetch(publicSource+'&pageIndex='+page,{
          method:'GET',headers:{...publicHeaders},credentials:'omit',redirect:'manual',
          signal:AbortSignal.timeout(Math.max(1,remaining)),cache:'no-store'
        });
        if(response.status===429||response.status===418)return failure(kind,'unavailable','Binance 请求频率或配额受限，请稍后刷新。');
        if(response.status!==200)return failure(kind,'unavailable','Binance 产品接口暂不可用（HTTP '+response.status+'）。');
        try{body=await response.json();}catch{return failure(kind,'unavailable','Binance 接口未返回有效 JSON 产品数据。');}
      }catch(error){
        return failure(kind,'unavailable',error?.name==='AbortError'||error?.name==='TimeoutError'?'读取 Binance 产品列表超时，请稍后刷新。':'Binance 产品接口暂时无法连接，请稍后刷新。');
      }
      const checkedAt=Date.now();
      if(checkedAt-started>=totalReadMilliseconds)return failure(kind,'unavailable','读取 Binance 产品列表超时，请稍后刷新。');
      if(body?.code!=='000000')return failure(kind,'unavailable','Binance 产品接口拒绝了本次只读请求，暂未取得报价。');
      const data=body?.data;
      if(!data||typeof data!=='object'||Array.isArray(data)||data.total==null||data.total===''||!Array.isArray(data.list)||data.list.length>pageSize)return invalidData(kind);
      const reportedTotal=num(data.total),serverTime=Date.parse(response.headers.get('date')||'');
      if(!Number.isSafeInteger(reportedTotal)||reportedTotal<0||reportedTotal>pageSize*maxPages)return invalidData(kind);
      const expectedCount=Math.min(pageSize,Math.max(0,reportedTotal-(page-1)*pageSize));
      if(data.list.length!==expectedCount)return failure(kind,'unavailable','Binance 变动产品单页数据与报告总数不符，未使用截断报价。');
      if(!Number.isSafeInteger(serverTime)||serverTime<=0||serverTime>checkedAt+2000||checkedAt-serverTime>=30000||serverTime<lastServerTime)return failure(kind,'unavailable','Binance 产品分页的服务器时间无效或已超过 30 秒，请刷新后重新读取。');
      oldestServerTime=Math.min(oldestServerTime,serverTime);lastServerTime=serverTime;reportedTotals.push(reportedTotal);
      for(const raw of data.list){
        const item=sanitize(raw,kind);
        if(!item||num(item.strikePrice)>1e15||num(item.minAmount)>1e15||num(item.maxAmount)>1e15)return invalidData(kind);
        if(conflicts.has(item.id))continue;
        const previous=items.get(item.id);
        // Quarantine conflicting observations permanently for this batch.
        // Do not pick a higher APR or combine fields from different reads.
        if(previous&&JSON.stringify(previous)!==JSON.stringify(item)){
          items.delete(item.id);conflicts.add(item.id);continue;
        }
        if(!previous)items.set(item.id,item);
      }
      if(data.list.length<pageSize){
        const completedAt=Date.now();
        if(completedAt-started>=totalReadMilliseconds)return failure(kind,'unavailable','读取 Binance 产品列表超时，请稍后刷新。');
        if(completedAt-oldestServerTime>=30000)return failure(kind,'unavailable','Binance 产品分页的服务器时间无效或已超过 30 秒，请刷新后重新读取。');
        if(!items.size)return failure(kind,'unavailable','Binance 变动列表未取得可核验的有效产品，暂不提供报价。');
        return {status:'ready',items:[...items.values()],serverTime:oldestServerTime,lastServerTime,
          fetchedAt:started,completedAt,source:publicSource,sourceType:kind,eligibility:eligibility(kind),
          catalogueComplete:false,coverageReason:'changing_catalogue',total:items.size,pageCount:page,
          reportedTotals,rejectedConflictCount:conflicts.size};
      }
    }
    return failure(kind,'unavailable','Binance 变动产品列表达到安全分页上限仍未读到末页，暂不提供报价。');
  }

  async function readPublic(started) {
    if(fresh(publicSnapshot))return publicSnapshot;
    if(publicPending)return publicPending;
    const task=fetchAll('public_web',null,started);publicPending=task;
    try{const result=await task;publicSnapshot=result.status==='ready'?result:null;return result;}
    finally{if(publicPending===task)publicPending=null;}
  }

  async function readSapi(key,started) {
    if(key!==activeKey){activeKey=key;generation++;sapiSnapshot=null;sapiPending=null;}
    const currentGeneration=generation;
    if(fresh(sapiSnapshot))return sapiSnapshot;
    if(sapiPending)return sapiPending;
    const task=fetchAll('sapi',key,started);sapiPending=task;
    try{
      const result=await task;
      if(currentGeneration===generation&&activeKey===key)sapiSnapshot=result.status==='ready'?result:null;
      return result;
    }finally{if(sapiPending===task)sapiPending=null;}
  }

  const read=async function read(env={}) {
    const started=Date.now(),publicResult=await readPublic(started);
    if(publicResult.status==='ready')return copy(publicResult);
    // Only the optional server environment is examined after anonymous discovery fails.
    const key=typeof env?.BINANCE_API_KEY==='string'?env.BINANCE_API_KEY.trim():'';
    if(!key){activeKey=null;generation++;sapiSnapshot=null;sapiPending=null;return {...publicResult,fallbackStatus:'authorization_required'};}
    const result=await readSapi(key,started);
    return copy({...result,publicStatus:publicResult.status});
  };

  read.changingPublic=async function changingPublic(){
    return copy(await fetchChangingPublic(Date.now()));
  };

  // This probe never accepts env, a Request, credentials, a URL, or caller headers.
  read.diagnostics=async function diagnostics() {
    const started=Date.now(),bodyLimit=262144;
    const header=(response,name,max=180)=>(response.headers.get(name)||'').replace(/[\u0000-\u001f\u007f]/g,'').slice(0,max);
    async function limitedText(response) {
      if(!response.body)return '';
      const reader=response.body.getReader(),decoder=new TextDecoder();
      let size=0,text='';
      try{
        for(;;){
          const {done,value}=await reader.read();
          if(done)return text+decoder.decode();
          size+=value.byteLength;
          if(size>bodyLimit){await reader.cancel();return '';}
          text+=decoder.decode(value,{stream:true});
        }
      }finally{reader.releaseLock();}
    }
    async function probe(kind) {
      const result={classification:'unknown',httpStatus:0,contentType:'',server:'',xCache:'',via:'',cfRay:'',cfId:'',date:'',retryAfter:''};
      try{
        const remaining=totalReadMilliseconds-(Date.now()-started);
        if(remaining<=0)return result;
        const response=await fetch(sourceFor(kind)+'&pageIndex=1',{
          method:'GET',headers:kind==='public_web'?{...publicHeaders}:{Accept:'application/json','User-Agent':userAgent},
          credentials:'omit',redirect:'manual',signal:AbortSignal.timeout(Math.max(1,remaining)),cache:'no-store'
        });
        Object.assign(result,{
          httpStatus:response.status,contentType:header(response,'content-type',100),server:header(response,'server'),
          xCache:header(response,'x-cache'),via:header(response,'via'),cfRay:header(response,'cf-ray'),
          cfId:header(response,'x-amz-cf-id'),date:header(response,'date',80),retryAfter:header(response,'retry-after',80)
        });
        if(response.status===451){result.classification='region_restricted';return result;}
        const text=await limitedText(response);
        if(Date.now()-started>=totalReadMilliseconds)return result;
        let payload;
        try{payload=JSON.parse(text);}catch{}
        if(payload&&typeof payload==='object'&&!Array.isArray(payload)&&num(payload.code)===-2014){result.classification='auth_required';return result;}
        if(kind==='public_web'&&response.status===200&&payload?.code==='000000'){result.classification='public_ok';return result;}
        if(/unavailable from a restricted location|not available in (?:your|this) (?:country|region)|block access from your country|country (?:is |has been )?(?:restricted|blocked|not supported)/i.test(text))result.classification='region_restricted';
        else if(/captcha|verify (?:that )?you are human|challenge-platform|cf-chl-|awswaf-captcha|awswaf-challenge/i.test(text))result.classification='challenge';
        else if(response.status>=400&&/cloudfront/i.test(result.server+' '+result.xCache+' '+result.via+' '+text))result.classification='edge_denied';
      }catch{ /* Deliberately discard transport errors and upstream bodies. */ }
      return result;
    }
    const [publicWeb,sapi]=await Promise.all([probe('public_web'),probe('sapi')]);
    return {checkedAt:Date.now(),results:{public_web:publicWeb,sapi}};
  };
  return read;
}

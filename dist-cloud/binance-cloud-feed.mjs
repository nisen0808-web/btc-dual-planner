// Generated from the current read-only Binance readers. Node.js 22+.
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

// Fixed, anonymous Binance public market data only. No account headers or arbitrary URLs.
const BNO_ROOT='https://eapi.binance.com/eapi/v1/';
const BNO_DOC='https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-options/api/rest-api/market-data';
const BNO_FEES='https://www.binance.com/en/support/faq/detail/5326e5de61c34fed98abe28d2f175a23';
const BNO_SPOT_FEES='https://www.binance.com/en/fee/trading';
const BNO_TTL=30000,BNO_CACHE=3000,BNO_TIMEOUT=10000,BNO_LIMIT=4*1024*1024;
const bnoNumber=x=>typeof x==='number'&&Number.isFinite(x)?x:typeof x==='string'&&/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(x)&&x.length<=50?Number(x):NaN;
const bnoPositive=x=>Number.isFinite(x)&&x>0&&x<=1e15;
const bnoTime=(time,now)=>Number.isSafeInteger(time)&&time>0&&time<=now+2000&&now-time<BNO_TTL;
const bnoSymbol=s=>typeof s==='string'&&/^BTC-\d{6}-(?:[1-9]\d{0,8})(?:\.\d{1,4})?-[PC]$/.test(s);
const bnoError=message=>{throw Error(message);};
const bnoReply=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
function bnoExpiry(symbol){
 const [,date]=symbol.split('-'),year=2000+Number(date.slice(0,2)),month=Number(date.slice(2,4)),day=Number(date.slice(4));
 const time=Date.UTC(year,month-1,day,8),d=new Date(time);
 return d.getUTCFullYear()===year&&d.getUTCMonth()===month-1&&d.getUTCDate()===day?time:NaN;
}
function bnoContract(row,parent,now,type='PUT'){
 if(!row||row.underlying!=='BTCUSDT'||row.quoteAsset!=='USDT'||row.side!==type||!['PUT','CALL'].includes(type)||!row.symbol?.endsWith(type==='CALL'?'-C':'-P')||row.status!=='TRADING'||!bnoSymbol(row.symbol)||row.contractType!=='CRYPTO_OPTIONS'||row.underlyingType!=='CRYPTO')return null;
 const strike=bnoNumber(row.strikePrice),expires=row.expiryDate,unit=bnoNumber(row.unit);
 if(!bnoPositive(strike)||Number(row.symbol.split('-')[2])!==strike||!Number.isSafeInteger(expires)||expires<=now||bnoExpiry(row.symbol)!==expires||unit!==1)return null;
 const lot=row.filters?.find(x=>x.filterType==='LOT_SIZE'),price=row.filters?.find(x=>x.filterType==='PRICE_FILTER');
 const step=bnoNumber(lot?.stepSize),min=bnoNumber(lot?.minQty),max=bnoNumber(lot?.maxQty),priceTick=bnoNumber(price?.tickSize);
 if(!bnoPositive(step)||step>1||!bnoPositive(min)||!bnoPositive(max)||max<min||!bnoPositive(priceTick))return null;
 const nakedSell=typeof row.nakedSell==='boolean'?row.nakedSell:null;
 return {symbol:row.symbol,optionType:type,strike,expires,unit:1,underlying:'BTCUSDT',settleCoin:'USDT',currency:'USDT',status:'TRADING',step,min,max,priceTick,
  nakedSell,nakedSellSource:nakedSell===null?'unverified_symbol':'public_symbol',underlyingNakedSell:typeof parent?.nakedSell==='boolean'?parent.nakedSell:null,
  sellPermissionScope:nakedSell===null&&typeof parent?.nakedSell==='boolean'?'underlying':nakedSell===null?'unverified':'symbol',sellPermissionSource:BNO_ROOT+'exchangeInfo',
  taker:.00024,cap:.10,delivery:.00015,deliveryCap:.10,deliveryExemptionConfirmed:false,deliveryClassification:'standard',spot:.001,spotDeductBase:true,
  openingRateSource:'published_standard',deliveryRateSource:'published_standard',spotRateSource:'published_standard',accountFeeVerified:false,
  feeTier:'公开普通费率；个人账户费率和优惠未核实',feeCheckedAt:'2026-11-13',feeSourceURLs:{opening:BNO_FEES,delivery:BNO_FEES,spot:BNO_SPOT_FEES},
  feeProvenance:{basis:'published_standard',personalRateVerified:false,openingRate:.00024,openingCap:.10,deliveryRate:.00015,deliveryCap:.10,spotRate:.001,checkedAt:'2026-11-13',sources:[BNO_FEES,BNO_SPOT_FEES]},
  feeNote:'期权开仓按公开 0.024%（新挂 Crypto Options 优惠），上限为各档权利金的 10%；交割 0.015%，上限为内在价值的 10%；现货普通费率 0.1%。个人账户费率、BNB 抵扣和费币种须连接后核实。'};
}
export function normalizeBinanceOptionsMarket(specs,index,now=Date.now(),type='PUT'){
 if(!specs||!Array.isArray(specs.optionSymbols)||specs.optionSymbols.length>30000||!Array.isArray(specs.optionContracts)||!bnoTime(specs.serverTime,now)||!bnoTime(index?.time,now))bnoError('Binance 公开合约或指数时间无效、已超过 30 秒');
 const parent=specs.optionContracts.find(x=>x.baseAsset==='BTC'&&x.quoteAsset==='USDT'&&x.underlying==='BTCUSDT'&&x.settleAsset==='USDT');
 if(!parent)bnoError('Binance 未返回 BTC/USDT 期权市场');
 const spot=bnoNumber(index.indexPrice);if(!bnoPositive(spot))bnoError('Binance BTC/USDT 指数价格无效');
 const seen=new Set(),contracts=[];
 for(const row of specs.optionSymbols){const contract=bnoContract(row,parent,now,type);if(!contract)continue;if(seen.has(contract.symbol))bnoError('Binance 公开合约标识重复');seen.add(contract.symbol);contracts.push(contract);}
 contracts.sort((a,b)=>a.expires-b.expires||a.strike-b.strike);
 if(!contracts.length)bnoError('Binance 暂无可核实的 BTC/USDT '+type+' 合约');
 return {status:'ready',platform:'binance',currency:'USDT',optionType:type,source:'Binance BTC/USDT 期权指数及真实挂牌',sourceType:'official_public_api',sourceURLs:[BNO_ROOT+'exchangeInfo',BNO_ROOT+'index?underlying=BTCUSDT'],documentation:BNO_DOC,time:Math.min(specs.serverTime,index.time),metadataTime:specs.serverTime,indexTime:index.time,receivedAt:now,spot,contracts};
}
function bnoLevels(rows,bid){
 if(!Array.isArray(rows)||rows.length>1000)bnoError('Binance 盘口深度格式无效');
 const result=[],seen=new Set();let previous=bid?Infinity:0;
 for(const row of rows){if(!Array.isArray(row)||row.length!==2)bnoError('Binance 盘口档位无效');const price=bnoNumber(row[0]),qty=bnoNumber(row[1]);if(!bnoPositive(price)||!Number.isFinite(qty)||qty<0||qty>1e15)bnoError('Binance 盘口价格或数量无效');if(qty===0)continue;if(seen.has(price)||bid&&price>=previous||!bid&&price<=previous)bnoError('Binance 盘口价格次序无效');seen.add(price);previous=price;result.push({price,qty});}
 return result;
}
export function normalizeBinanceOptionsBook(raw,symbol,now=Date.now()){
 if(!bnoSymbol(symbol)||!bnoTime(raw?.T,now)||!Number.isSafeInteger(raw.lastUpdateId)||raw.lastUpdateId<0)bnoError('Binance 买盘来源时间无效或已超过 30 秒');
 const bids=bnoLevels(raw.bids,true),asks=bnoLevels(raw.asks,false);
 if(bids.length&&asks.length&&bids[0].price>=asks[0].price)bnoError('Binance 期权盘口交叉，等待新报价');
 return {status:'ready',platform:'binance',currency:'USDT',symbol,time:raw.T,receivedAt:now,lastUpdateId:raw.lastUpdateId,bids,asks,depthLimit:1000,sourceType:'official_public_api',source:BNO_ROOT+'depth?symbol='+encodeURIComponent(symbol)+'&limit=1000'};
}
export function createBinanceOptionsReader({fetchImpl=(...args)=>fetch(...args),now=()=>Date.now(),type='PUT'}={}){
 let market=null,marketPending=null;const books=new Map(),pending=new Map();
 const fresh=x=>x&&bnoTime(x.time,now())&&now()-x.receivedAt<BNO_CACHE;
 async function read(path){
  const response=await fetchImpl(BNO_ROOT+path,{method:'GET',credentials:'omit',redirect:'manual',headers:{accept:'application/json'},signal:AbortSignal.timeout(BNO_TIMEOUT)});
  if(!response.ok)bnoError('Binance 官方公开期权接口返回 '+response.status);
  const declared=response.headers.get('content-length');if(declared&&Number(declared)>BNO_LIMIT)bnoError('Binance 公开响应超过大小上限');
  const text=await response.text();if(text.length>BNO_LIMIT)bnoError('Binance 公开响应超过大小上限');
  const value=JSON.parse(text);if(value?.code!==undefined&&Number(value.code)!==0)bnoError('Binance 官方公开接口暂不可用');return value;
 }
 async function loadMarket(){
  if(fresh(market))return market;if(marketPending)return marketPending;
  marketPending=(async()=>{const [specs,index]=await Promise.all([read('exchangeInfo'),read('index?underlying=BTCUSDT')]);market=normalizeBinanceOptionsMarket(specs,index,now(),type);return market;})();
  try{return await marketPending;}finally{marketPending=null;}
 }
 async function loadBook(symbol){
  if(!bnoSymbol(symbol)||!symbol.endsWith(type==='CALL'?'-C':'-P'))bnoError('仅支持当前方向真实 BTC/USDT 期权合约');
  const listed=await loadMarket();if(!listed.contracts.some(x=>x.symbol===symbol))bnoError('所选接币价与到期日在 Binance 没有真实挂牌 PUT');
  const cached=books.get(symbol);if(fresh(cached))return cached;if(pending.has(symbol))return pending.get(symbol);if(pending.size>=8)bnoError('公开盘口读取繁忙，请稍后刷新');
  const task=(async()=>{const value=normalizeBinanceOptionsBook(await read('depth?symbol='+encodeURIComponent(symbol)+'&limit=1000'),symbol,now());books.delete(symbol);books.set(symbol,value);while(books.size>32)books.delete(books.keys().next().value);return value;})();pending.set(symbol,task);
  try{return await task;}finally{pending.delete(symbol);}
 }
 async function handle(request){
  const url=new URL(request.url),marketPath=url.pathname.endsWith('/market'),bookPath=url.pathname.endsWith('/book');
  if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405,headers:{allow:'GET, HEAD','cache-control':'no-store'}});
  if(!marketPath&&!bookPath)return bnoReply({status:'unavailable',reason:'未知公开期权接口'},404);
  const keys=[...url.searchParams.keys()];
  if(marketPath&&keys.length||bookPath&&(keys.length!==1||keys[0]!=='symbol'||url.searchParams.getAll('symbol').length!==1||!bnoSymbol(url.searchParams.get('symbol'))||!url.searchParams.get('symbol').endsWith(type==='CALL'?'-C':'-P')))return bnoReply({status:'unavailable',reason:'公开期权参数无效'},400);
  try{const value=marketPath?await loadMarket():await loadBook(url.searchParams.get('symbol'));return request.method==='HEAD'?new Response(null,{headers:{'content-type':'application/json','cache-control':'no-store'}}):bnoReply(value);}
  catch(error){return bnoReply({status:'unavailable',platform:'binance',reason:error.message,sourceType:'official_public_api',time:0,receivedAt:0},502);}
 }
 return {loadMarket,loadBook,handle};
}


import {createServer} from 'node:http';
import {timingSafeEqual,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {AsyncLocalStorage} from 'node:async_hooks';

const FEED_MAX_BYTES=4*1024*1024,FEED_MAX_ACTIVE=4;
const feedHash=value=>createHash('sha256').update(value).digest();
const feedRequestScope=new AsyncLocalStorage();
// Observe upstream status without modifying URLs, headers, responses or reader logic.
// Lexical fetch also covers the product reader, which has no fetch injection option.
const fetch=async(...args)=>{
 const scope=feedRequestScope.getStore();
 if(scope?.blocked())throw Error('Binance source HTTP '+scope.blocked());
 const response=await globalThis.fetch(...args);
 if([403,418,429,451].includes(response.status))scope?.stop(response.status);
 return response;
};
export function createQuoteService({optionsReader,dualReader,token=process.env.QUOTE_READ_TOKEN}={}){
 if(typeof token!=='string'||!token.trim())throw Error('QUOTE_READ_TOKEN is required');
 const expected=feedHash(token);
 const options=optionsReader||createBinanceOptionsReader();
 const dual=dualReader||createBinanceReader();
 let active=0;
 const stopped={options:0,dual:0};
 const unavailable=(source)=>({status:'unavailable',reason:stopped[source]?'Binance source stopped (HTTP '+stopped[source]+'); restart only after access or rate limits are resolved.':'Public quote source is unavailable.',...(stopped[source]?{upstreamStatus:stopped[source]}:{}),time:0,receivedAt:0});
 function reply(response,status,value,extra={}){
  let body;
  try{body=JSON.stringify(value);}catch{status=503;body=JSON.stringify(unavailable());}
  if(typeof body!=='string'||Buffer.byteLength(body)>FEED_MAX_BYTES){status=503;body=JSON.stringify({status:'unavailable',reason:'Quote response exceeded the size limit.',time:0,receivedAt:0});}
  response.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-length':Buffer.byteLength(body),...extra});
  response.end(body);
 }
 const denied=value=>{
  const explicit=Number(value?.upstreamStatus||value?.httpStatus);
  if([403,418,429,451].includes(explicit))return explicit;
  const match=String(value?.reason||value?.message||'').match(/\b(403|418|429|451)\b/);
  return match?Number(match[1]):0;
 };
 const server=createServer({maxHeaderSize:8192,requestTimeout:20000,headersTimeout:10000},async(request,response)=>{
  if(request.method!=='GET'){request.resume();return reply(response,405,{status:'unavailable',reason:'GET only.'},{allow:'GET'});}
  let url;
  try{url=new URL(request.url,'http://quote.local');}catch{return reply(response,400,{status:'unavailable',reason:'Invalid request.'});}
  const route=url.pathname,keys=[...url.searchParams.keys()];
  if(url.origin!=='http://quote.local'||url.username||url.password||url.hash||request.url.split('?')[0]!==route)return reply(response,400,{status:'unavailable',reason:'Invalid request.'});
  if(!['/health','/market','/book','/dual'].includes(route))return reply(response,404,{status:'unavailable',reason:'Unknown route.'});
  if((route!=='/book'&&keys.length)||(route==='/book'&&(keys.length!==1||keys[0]!=='symbol'||!bnoSymbol(url.searchParams.get('symbol')))))return reply(response,400,{status:'unavailable',reason:'Invalid quote parameters.'});
  // Client credentials and arbitrary target/header forwarding are never accepted.
  if(['cookie','x-mbx-apikey','x-api-key','proxy-authorization'].some(name=>request.headers[name]!==undefined)||request.headers['transfer-encoding']||Number(request.headers['content-length']||0)!==0){request.resume();return reply(response,400,{status:'unavailable',reason:'Credentials and request bodies are not accepted.'});}
  if(route==='/health')return reply(response,200,{serviceReady:true});
  const authorization=request.headers.authorization;
  if(typeof authorization!=='string'||authorization.length>4096||!authorization.startsWith('Bearer ')||!timingSafeEqual(expected,feedHash(authorization.slice(7))))return reply(response,401,{status:'unavailable',reason:'Unauthorized.'},{'www-authenticate':'Bearer'});
  const source=route==='/dual'?'dual':'options';
  if(stopped[source])return reply(response,503,unavailable(source));
  if(active>=FEED_MAX_ACTIVE)return reply(response,503,{status:'unavailable',reason:'Quote service is busy.',time:0,receivedAt:0});
  active++;
  try{
   // No inbound headers, Binance keys, account data or request objects enter readers.
   const value=await feedRequestScope.run({blocked:()=>stopped[source],stop:status=>{stopped[source]=status;}},()=>route==='/market'?options.loadMarket():route==='/book'?options.loadBook(url.searchParams.get('symbol')):dual({}));
   if(denied(value))stopped[source]=denied(value);
   if(stopped[source]||value?.status!=='ready')return reply(response,503,unavailable(source));
   return reply(response,200,value);
  }catch(error){if(denied(error))stopped[source]=denied(error);return reply(response,503,unavailable(source));}
  finally{active--;}
 });
 return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const port=Number(process.env.PORT||8080);
 if(!Number.isInteger(port)||port<1||port>65535)throw Error('PORT is invalid');
 const server=createQuoteService();
 server.listen(port,'0.0.0.0');
 const stop=()=>server.close(()=>process.exit(0));
 process.once('SIGTERM',stop);process.once('SIGINT',stop);
}

import {createHmac,createHash} from 'node:crypto';
import {units,decimal,SCALE,multiplyUp,fresh,isId,optionSymbol} from './binance-decimal.mjs';

const EAPI='https://eapi.binance.com',API='https://api.binance.com';
const fail=(code,message,unknown=false)=>({ok:false,status:unknown?'unknown':'error',error:{code,message,unknown}});
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const clientId=value=>isId(value)&&value.length<=36;
const array=value=>{if(!Array.isArray(value)||value.length>1000)throw Error('schema');return value;};
const id=value=>{if(typeof value==='number'){if(!Number.isSafeInteger(value)||value<0)throw Error('unsafe_id');value=String(value);}if(typeof value!=='string'||!/^\d{1,30}$/.test(value))throw Error('id');return value;};
const number=value=>{units(value,true);return String(value);};
const pick=(row,keys)=>{if(!object(row))throw Error('schema');const value={};for(const key of keys){const v=row[key];if(v===undefined)continue;if(v===null||typeof v==='object'||!['string','boolean','number'].includes(typeof v))throw Error('schema');value[key]=v;}return value;};
function order(raw,spot=false){
  const out=pick(raw,['symbol','side','type','timeInForce','clientOrderId','status','price','quantity','origQty','executedQty','cummulativeQuoteQty','createTime','createDate','updateTime','time','transactTime','reduceOnly','avgPrice','quoteAsset','optionSide']);
  out.orderId=id(raw.orderId);if(spot?out.symbol!=='BTCUSDT':!optionSymbol(out.symbol))throw Error('symbol');
  if(!['NEW','ACCEPTED','PARTIALLY_FILLED','FILLED','CANCELED','CANCELLED','EXPIRED','REJECTED','EXERCISED'].includes(out.status)||!['BUY','SELL'].includes(out.side)||out.type!=='LIMIT'||out.timeInForce!=='IOC'||!clientId(out.clientOrderId))throw Error('order');
  units(out.price);units(out.quantity??out.origQty);units(out.executedQty);return out;
}
function optionTrade(raw){const out=pick(raw,['symbol','price','quantity','fee','realizedProfit','side','type','liquidity','time','quoteAsset']);out.id=id(raw.id);out.tradeId=id(raw.tradeId);out.orderId=id(raw.orderId);if(!optionSymbol(out.symbol)||out.quoteAsset!=='USDT'||!['SELL','BUY'].includes(out.side)||!Number.isSafeInteger(out.time))throw Error('trade');for(const k of ['price','quantity','fee','realizedProfit'])number(out[k]);return out;}
function spotTrade(raw){const out=pick(raw,['symbol','price','qty','quoteQty','commission','commissionAsset','time','isBuyer','isMaker']);out.id=id(raw.id);out.orderId=id(raw.orderId);if(out.symbol!=='BTCUSDT'||!['BTC','USDT'].includes(out.commissionAsset)||typeof out.isBuyer!=='boolean'||!Number.isSafeInteger(out.time))throw Error('trade');for(const k of ['price','qty','quoteQty','commission'])units(out[k]);return out;}
function bill(raw){const out=pick(raw,['asset','amount','symbol','type','createDate']);out.id=id(raw.id);if(out.asset!=='USDT'||!Number.isSafeInteger(out.createDate)||typeof out.type!=='string'||(out.symbol!==undefined&&!optionSymbol(out.symbol)))throw Error('bill');number(out.amount);return out;}
function exercise(raw){const out=pick(raw,['currency','symbol','exercisePrice','quantity','amount','fee','createDate','positionSide','optionSide','quoteAsset']);out.id=id(raw.id);if(out.currency!=='USDT'||!optionSymbol(out.symbol)||out.positionSide!=='SHORT'||out.optionSide!=='PUT'||out.quoteAsset!=='USDT'||!Number.isSafeInteger(out.createDate))throw Error('exercise');for(const k of ['exercisePrice','quantity','amount','fee'])number(out[k]);return out;}
function positions(raw){return array(raw).map(row=>{const out=pick(row,['symbol','side','quantity','positionCost','expiryDate','priceScale','quantityScale','reducibleQty','markValue','ror','unrealizedPNL']);if(typeof out.symbol!=='string')throw Error('position');number(out.quantity);return out;});}
function balances(raw){return array(raw).map(row=>{if(typeof row.asset!=='string'||!/^[A-Z0-9]{2,16}$/.test(row.asset))throw Error('balance');return {asset:row.asset,free:decimal(units(row.free)),locked:decimal(units(row.locked))};});}
function optionWallet(raw){if(!object(raw)||typeof raw.canTrade!=='boolean'||typeof raw.reduceOnly!=='boolean'||!Number.isSafeInteger(raw.time))throw Error('wallet');return {canTrade:raw.canTrade,reduceOnly:raw.reduceOnly,time:raw.time,asset:array(raw.asset).map(row=>{const out={asset:row.asset};if(typeof out.asset!=='string')throw Error('asset');for(const k of ['marginBalance','equity','available','initialMargin','maintMargin','unrealizedPNL'])out[k]=decimal(units(row[k],true));return out;})};}
function spotWallet(raw){if(!object(raw)||raw.accountType!=='SPOT'||typeof raw.canTrade!=='boolean')throw Error('account');return {uid:id(raw.uid),accountType:raw.accountType,canTrade:raw.canTrade,permissions:array(raw.permissions),balances:balances(raw.balances)};}
function restrictions(raw){const keys=['ipRestrict','enableReading','enableWithdrawals','enableInternalTransfer','enableMargin','enableFutures','permitsUniversalTransfer','enableVanillaOptions','enableFixApiTrade','enableFixReadOnly','enableSpotAndMarginTrading','enablePortfolioMarginTrading'];const out={};for(const k of keys){if(typeof raw?.[k]!=='boolean')throw Error('permission');out[k]=raw[k];}return out;}
function spotFee(raw){if(raw?.symbol!=='BTCUSDT'||!object(raw.discount)||typeof raw.discount.enabledForAccount!=='boolean'||typeof raw.discount.enabledForSymbol!=='boolean')throw Error('fee');const out={symbol:raw.symbol,discountEnabled:raw.discount.enabledForAccount&&raw.discount.enabledForSymbol};let rate=0n;for(const kind of ['standardCommission','specialCommission','taxCommission']){if(!object(raw[kind]))throw Error('fee');out[kind]={};for(const field of ['taker','buyer']){const v=units(raw[kind][field]);if(v>=SCALE)throw Error('fee');out[kind][field]=decimal(v);rate+=v;}}if(rate>=SCALE)throw Error('fee');out.takerBuyRate=decimal(rate);return out;}
function optionFee(raw){const rows=array(raw?.commissions).filter(row=>row.underlying==='BTCUSDT');if(rows.length!==1)throw Error('fee');const maker=units(rows[0].makerFee),taker=units(rows[0].takerFee);if(maker>=SCALE||taker>=SCALE)throw Error('fee');return {underlying:'BTCUSDT',makerFee:decimal(maker),takerFee:decimal(taker)};}

/** Fixed official mainnet endpoints. Never follows a redirect with credentials.
 * Every write is one attempt; client IDs are correlation, not idempotency proof.
 * The durable service must journal before it calls any of the three write methods. */
export function createBinanceExecution({apiKey='',apiSecret='',fetchImpl=fetch,now=Date.now,liveEnabled=false,accountLabel='binance-dedicated-usdt'}={}){
  if(typeof apiKey!=='string'||typeof apiSecret!=='string'||typeof fetchImpl!=='function'||typeof now!=='function'||typeof liveEnabled!=='boolean'||!isId(accountLabel))throw Error('Invalid Binance configuration');
  const sent=new Set(),unresolved=new Set();let latestEvidence=null;
  async function request(host,path,params={},write=false){
    if(!liveEnabled||!apiKey||!apiSecret)return fail('not_configured','Binance 交易账户尚未配置。');
    const query=new URLSearchParams();for(const [key,value]of Object.entries(params))query.append(key,String(value));query.append('recvWindow','5000');query.append('timestamp',String(now()));
    const encoded=query.toString(),signature=createHmac('sha256',apiSecret).update(encoded).digest('hex'),body=encoded+'&signature='+signature;
    try{
      const response=await fetchImpl(host+path+(write?'':'?'+body),{method:write?'POST':'GET',headers:{Accept:'application/json','X-MBX-APIKEY':apiKey,...(write?{'Content-Type':'application/x-www-form-urlencoded'}:{})},...(write?{body}:{}),credentials:'omit',redirect:'manual',signal:AbortSignal.timeout(10000)});
      if(response.status>=300&&response.status<400)return fail('redirect_rejected','交易所返回重定向，已停止。',write);
      if(!response.headers?.get('content-type')?.includes('application/json'))return fail('response_invalid','交易所响应格式无法核验。',write);
      // Binance order/bill IDs are int64 and can exceed Number.MAX_SAFE_INTEGER.
      const raw=typeof response.text==='function'?JSON.parse((await response.text()).replace(/("(?:orderId|tradeId|id|tranId|uid)"\s*:\s*)(\d{1,30})(?=\s*[,}])/g,'$1"$2"')):await response.json();
      if(!response.ok||typeof raw?.code==='number'&&raw.code<0){const unknown=write&&(response.status>=500||[-1000,-1001,-1006,-1007].includes(raw?.code));return fail('exchange_rejected','交易所未确认操作；请查看本机状态。',unknown);}
      return {ok:true,data:raw};
    }catch{return fail('network_unavailable','交易所连接失败，未确认写入不得重试。',write);}
  }
  const read=async(host,path,params,validate=x=>x)=>{const r=await request(host,path,params);if(!r.ok)return r;try{return {ok:true,data:validate(r.data)};}catch{return fail('schema_invalid','交易所账户或流水字段无法完整核验。');}};
  async function write(kind,key,host,path,payload,authorization,validate){
    if(!isId(key)||sent.has(kind+':'+key)||unresolved.size)return fail('write_locked','已有发送记录或未知结果，禁止重复提交。');
    if(!authorization||authorization.confirmed!==true||authorization.account!==accountLabel||authorization.currency!=='USDT'||!fresh(authorization.checkedAt,now(),15000)||!Number.isSafeInteger(authorization.expiresAt)||authorization.expiresAt<=now()||authorization.expiresAt>now()+30000||typeof authorization.beforeSubmit!=='function'||authorization.beforeSubmit()!==true)return fail('confirmation_invalid','本笔确认、账户复核或最终门禁失效。');
    if(!latestEvidence||!fresh(latestEvidence.checkedAt,now(),15000)||authorization.accountId!==latestEvidence.uid)return fail('account_unverified','真实账户身份尚未核验。');
    if(authorization.payloadHash!==createHash('sha256').update(JSON.stringify(payload)).digest('hex'))return fail('payload_changed','最终请求与持久化资金授权不一致。');
    const r=latestEvidence.restriction;
    if(r.ipRestrict!==true||r.enableReading!==true||r.enableWithdrawals!==false||r.enableMargin!==false||r.enableFutures!==false||r.enablePortfolioMarginTrading!==false||r.enableFixApiTrade!==false||latestEvidence.trading.isLocked!==false||latestEvidence.info.isOptionsEnabled!==true||latestEvidence.info.isPortfolioMarginRetailEnabled!==false||latestEvidence.option.canTrade!==true||latestEvidence.option.reduceOnly!==false)return fail('permission_invalid','最终账户权限或卖出资格证据不满足要求。');
    if(kind==='put'&&r.enableVanillaOptions!==true||kind==='transfer'&&(r.enableInternalTransfer!==true||r.permitsUniversalTransfer!==true)||kind==='spot'&&(r.enableSpotAndMarginTrading!==true||latestEvidence.spot.canTrade!==true||latestEvidence.spotFee.discountEnabled!==false))return fail('permission_invalid','该次操作的真实权限或手续费币种尚未核验。');
    sent.add(kind+':'+key);const response=await request(host,path,payload,true);
    if(!response.ok){if(response.error.unknown)unresolved.add(kind+':'+key);return response;}
    try{return {ok:true,data:validate(response.data)};}catch{unresolved.add(kind+':'+key);return fail('write_response_invalid','交易所可能已经受理，禁止重发，等待真实流水核对。',true);}
  }
  const client={
    async getAccountEvidence(){
      const specs=[['restriction',API,'/sapi/v1/account/apiRestrictions',{},restrictions],['info',API,'/sapi/v1/account/info',{},raw=>{if(typeof raw?.isOptionsEnabled!=='boolean'||typeof raw.isPortfolioMarginRetailEnabled!=='boolean')throw Error('info');return {isOptionsEnabled:raw.isOptionsEnabled,isPortfolioMarginRetailEnabled:raw.isPortfolioMarginRetailEnabled};}],['trading',API,'/sapi/v1/account/apiTradingStatus',{},raw=>{if(typeof raw?.data?.isLocked!=='boolean')throw Error('status');return {isLocked:raw.data.isLocked};}],['option',EAPI,'/eapi/v1/marginAccount',{},optionWallet],['spot',API,'/api/v3/account',{},spotWallet],['optionFee',EAPI,'/eapi/v1/commission',{},optionFee],['spotFee',API,'/api/v3/account/commission',{symbol:'BTCUSDT'},spotFee],['positions',EAPI,'/eapi/v1/position',{},positions],['optionOrders',EAPI,'/eapi/v1/openOrders',{},array],['spotOrders',API,'/api/v3/openOrders',{},array]];
      const results=await Promise.all(specs.map(async([name,host,path,params,validate])=>({name,result:await read(host,path,params,validate)})));const evidence={};for(const item of results){if(!item.result.ok)return item.result;evidence[item.name]=item.result.data;}
      evidence.uid=evidence.spot.uid;evidence.checkedAt=now();latestEvidence=structuredClone(evidence);return {ok:true,data:evidence};
    },
    getPositions:()=>read(EAPI,'/eapi/v1/position',{},positions),
    getOpenOrders:()=>read(EAPI,'/eapi/v1/openOrders',{},array),
    getOptionOrder:({symbol,clientOrderId})=>optionSymbol(symbol)&&clientId(clientOrderId)?read(EAPI,'/eapi/v1/order',{symbol,clientOrderId},r=>order(r)):Promise.resolve(fail('query_invalid','委托身份无效。')),
    getOptionTrades:({symbol,startTime,endTime})=>optionSymbol(symbol)?read(EAPI,'/eapi/v1/userTrades',{symbol,startTime,endTime,limit:1000},r=>array(r).map(optionTrade)):Promise.resolve(fail('query_invalid','合约身份无效。')),
    getBills:({startTime,endTime})=>read(EAPI,'/eapi/v1/bill',{currency:'USDT',startTime,endTime,limit:1000},r=>array(r).map(bill)),
    getExerciseRecords:({symbol,startTime,endTime})=>optionSymbol(symbol)?read(EAPI,'/eapi/v1/exerciseRecord',{symbol,startTime,endTime,limit:1000},r=>array(r).map(exercise)):Promise.resolve(fail('query_invalid','合约身份无效。')),
    getSpotOrder:({clientOrderId})=>clientId(clientOrderId)?read(API,'/api/v3/order',{symbol:'BTCUSDT',origClientOrderId:clientOrderId},r=>order(r,true)):Promise.resolve(fail('query_invalid','委托身份无效。')),
    getSpotTrades:({orderId,startTime,endTime})=>read(API,'/api/v3/myTrades',{symbol:'BTCUSDT',...(orderId?{orderId}:{startTime,endTime}),limit:1000},r=>array(r).map(spotTrade)),
    getTransferHistory:({startTime,endTime})=>read(API,'/sapi/v1/asset/transfer',{type:'OPTION_MAIN',startTime,endTime,current:1,size:100},raw=>{if(!Number.isSafeInteger(raw?.total)||raw.total<0||raw.total>=100)throw Error('pagination');const rows=array(raw.rows).map(row=>{const out=pick(row,['asset','amount','type','status','timestamp']);out.tranId=id(row.tranId);if(out.asset!=='USDT'||out.type!=='OPTION_MAIN'||!['CONFIRMED','FAILED','PENDING'].includes(out.status)||!Number.isSafeInteger(out.timestamp))throw Error('transfer');units(out.amount);return out;});if(rows.length!==raw.total)throw Error('pagination');return {rows,total:raw.total};}),
    async createSellPut(payload,authorization){
      try{if(!optionSymbol(payload?.symbol)||!clientId(payload.clientOrderId)||payload.side!=='SELL'||payload.type!=='LIMIT'||payload.timeInForce!=='IOC'||payload.reduceOnly!==false||payload.postOnly!==false||Object.keys(payload).some(k=>!['symbol','clientOrderId','side','type','timeInForce','quantity','price','reduceOnly','postOnly','newOrderRespType'].includes(k))||!authorization?.spec||authorization.spec.symbol!==payload.symbol||authorization.spec.nakedSell===false||authorization.spec.sellPermission?.allowed!==true||authorization.spec.sellPermission?.underlying!=='BTCUSDT'||authorization.spec.status!=='TRADING')throw Error('payload');
        const q=units(payload.quantity),p=units(payload.price),step=units(authorization.spec.stepSize),tick=units(authorization.spec.tickSize);if(q<=0n||p<=0n||step<=0n||tick<=0n||q%step||p%tick||q<units(authorization.spec.minQty)||q>units(authorization.spec.maxQty)||multiplyUp(q,units(authorization.spec.strikePrice))+units(authorization.feeReserve)>units(authorization.maxFunds))throw Error('budget');
      }catch{return fail('order_invalid','卖 PUT 合约、数量、限价或全额资金无法核验。');}
      return write('put',payload.clientOrderId,EAPI,'/eapi/v1/order',payload,authorization,r=>order(r));
    },
    async transferToSpot(payload,authorization){
      try{if(payload?.type!=='OPTION_MAIN'||payload.asset!=='USDT'||Object.keys(payload).some(k=>!['type','asset','amount'].includes(k))||units(payload.amount)<=0n||units(payload.amount)>units(authorization.maxFunds))throw Error('transfer');}catch{return fail('transfer_invalid','仅允许本笔已核对 USDT 余款划至同账户现货钱包。');}
      return write('transfer',authorization?.intentId,API,'/sapi/v1/asset/transfer',payload,authorization,raw=>({tranId:id(raw.tranId)}));
    },
    async createSpotBuy(payload,authorization){
      try{if(payload?.symbol!=='BTCUSDT'||payload.side!=='BUY'||payload.type!=='LIMIT'||payload.timeInForce!=='IOC'||!clientId(payload.newClientOrderId)||Object.keys(payload).some(k=>!['symbol','side','type','timeInForce','quantity','price','newClientOrderId','newOrderRespType'].includes(k)))throw Error('spot');const q=units(payload.quantity),p=units(payload.price),cost=multiplyUp(q,p);if(q<=0n||p<=0n||cost+units(authorization.feeReserve)>units(authorization.maxFunds))throw Error('budget');}catch{return fail('spot_invalid','现货金额或限价超出本笔已确认资金。');}
      return write('spot',payload.newClientOrderId,API,'/api/v3/order',payload,authorization,r=>order(r,true));
    },
    acknowledgeReconciled({kind,clientOrderId}){if(!['put','spot','transfer'].includes(kind)||!isId(clientOrderId))return false;return unresolved.delete(kind+':'+clientOrderId);},
    getExecutionState:()=>({finalGateSupported:true,reconciliationRequired:unresolved.size>0,unknownOperations:unresolved.size,environment:'mainnet'})
  };
  return Object.freeze(client);
}

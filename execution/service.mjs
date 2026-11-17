import {randomUUID,createHash} from 'node:crypto';
import {calculate} from '../web/calc.js';
import {prepareExecutionIntent} from '../web/execution-plan.js';
import {ExecutionController} from './controller.mjs';

const SCALE=10n**18n,TTL=30000,TERMINAL=new Set(['Filled','Cancelled','Rejected','PartiallyFilledCanceled','Deactivated']);
const KNOWN_ORDERS=new Set([...TERMINAL,'New','PartiallyFilled','Untriggered','Triggered']);
const PERMISSIONS={ContractTrade:['Order','Position'],Spot:['SpotTrade'],Wallet:['AccountTransfer','SubMemberTransfer','SubMemberTransferList','Withdraw'],Options:['OptionsTrade'],Derivatives:['DerivativesTrade']};
const clone=value=>JSON.parse(JSON.stringify(value));
class ServiceError extends Error{constructor(code,message){super(message);this.code=code;}}
const stop=(code,message)=>{throw new ServiceError(code,message);};
function units(value,signed=false){
  let s=typeof value==='number'&&Number.isFinite(value)?String(value):value;
  if(typeof value==='number'&&typeof s==='string'&&/e/i.test(s)){
    const [coefficient,power]=s.toLowerCase().split('e'),negative=coefficient.startsWith('-'),plain=negative?coefficient.slice(1):coefficient,[whole,fraction='']=plain.split('.'),digits=whole+fraction,point=whole.length+Number(power);
    s=(negative?'-':'')+(point<=0?'0.'+'0'.repeat(-point)+digits:point>=digits.length?digits+'0'.repeat(point-digits.length):digits.slice(0,point)+'.'+digits.slice(point));
  }
  if(typeof s!=='string'||!(signed?/^-?(?:0|[1-9]\d{0,14})(?:\.\d{1,18})?$/:/^(?:0|[1-9]\d{0,14})(?:\.\d{1,18})?$/).test(s))stop('decimal_invalid','交易所金额或数量字段缺失、格式不明。');
  const negative=s.startsWith('-'),[whole,fraction='']=(negative?s.slice(1):s).split('.');return (negative?-1n:1n)*(BigInt(whole)*SCALE+BigInt(fraction.padEnd(18,'0')));
}
function text(value){const sign=value<0n?'-':'',digits=(value<0n?-value:value).toString().padStart(19,'0');return sign+(digits.slice(0,-18)+'.'+digits.slice(-18)).replace(/\.?0+$/,'');}
const equal=(a,b,tolerance=10000000000n)=>{const d=units(a,true)-units(b,true);return (d<0n?-d:d)<=tolerance;};
const fresh=(stamp,now,ttl=TTL)=>Number.isSafeInteger(stamp)&&stamp>0&&stamp<=now+2000&&now-stamp<ttl;
const alignDown=(value,step)=>value/step*step;
const multiplyUp=(a,b)=>(a*b+SCALE-1n)/SCALE;
const filledUnits=plan=>Array.isArray(plan.fills)&&plan.fills.length?plan.fills.reduce((sum,fill)=>sum+units(fill.execQty),0n):units(plan.filledQty);
const safeError=error=>error instanceof ServiceError?{code:error.code,reason:error.message}:{code:'service_unavailable',reason:'执行服务核验未完成，请稍后重试。'};
function checkedResult(result){if(result?.ok!==true||!result.data||typeof result.data!=='object')stop('exchange_unverified','交易所读取未成功核验，未生成执行证明。');return result.data;}

/** No credentials, HTTP server, runner or implicit private access are supplied here.
 * exchangeFactory is an operator-owned, immutable account binding. All calls in tests
 * are mocks. The authenticated gateway must never expose the factory to a browser. */
export function createExecutionService({journal,exchangeFactory,marketProvider,now=Date.now,liveEnabled=false,accountLabel='bybit-dedicated'}={}){
  if(!journal||typeof journal.get!=='function'||typeof journal.list!=='function'||typeof marketProvider?.prepare!=='function'||typeof now!=='function'||typeof liveEnabled!=='boolean'||typeof accountLabel!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(accountLabel))throw Error('Invalid execution service configuration');
  const drafts=new Map();let exchange=null,queue=Promise.resolve(),verification=null,lastTick=null;
  const serialize=run=>{const task=queue.then(run,run);queue=task.catch(()=>{});return task;};
  function api(){
    if(!liveEnabled||typeof exchangeFactory!=='function')stop('not_configured','真实执行尚未配置。');
    if(!exchange)exchange=exchangeFactory({accountLabel,liveEnabled:true});
    const required=['getApiInfo','getAccountInfo','getWalletBalance','getPositions','getOrders','getOrderHistory','getExecutions','getDeliveryRecords','getFeeRates','createSellPut','createSpotBuy','getExecutionState','reconcileUnknownOrder'];
    if(!exchange||required.some(name=>typeof exchange[name]!=='function')||typeof marketProvider.spot!=='function')stop('adapter_incomplete','期权、现货、费用或恢复对账链路尚未完整接通。');return exchange;
  }
  async function pages(method,params){
    const rows=[],cursors=new Set();let cursor;
    for(let page=0;page<50;page++){
      const result=checkedResult(await api()[method]({...params,...(cursor?{cursor}:{})}));
      if(result.category!==params.category||!Array.isArray(result.list)||typeof result.nextPageCursor!=='string'||result.nextPageCursor.length>1024)stop('pagination_invalid','交易所分页字段不完整。');
      rows.push(...result.list);const next=result.nextPageCursor;
      if(!next)return rows;
      if(!result.list.length||cursors.has(next))stop('pagination_invalid','交易所分页不完整或游标重复。');cursors.add(next);cursor=next;
    }
    stop('pagination_limit','交易所分页超过核验上限，不能假定已读完。');
  }
  async function permissionCheck(){
    const p=checkedResult(await api().getApiInfo());
    if(p.isMaster!==false||p.readOnly!==0||p.unsafePermissions!==false||!p.permissions||Object.keys(p.permissions).some(key=>!Object.hasOwn(PERMISSIONS,key)))stop('permissions_invalid','需要仅含必要交易权限的子账户连接。');
    for(const [scope,allowed] of Object.entries(PERMISSIONS))if(!Array.isArray(p.permissions[scope])||p.permissions[scope].some(value=>!allowed.includes(value)))stop('permissions_unknown','账户权限字段缺失或存在未知权限。');
    if(!p.permissions.Options.includes('OptionsTrade')||!p.permissions.Spot.includes('SpotTrade')||p.permissions.Wallet.length)stop('permissions_invalid','需要期权及现货交易权限，禁止提现和账户转账权限。');
    const info=checkedResult(await api().getAccountInfo());
    if(info.marginMode!=='REGULAR_MARGIN'||![3,4,5,6].includes(info.unifiedMarginStatus))stop('account_mode_unsupported','账户保证金模式尚未通过本策略核验。');
  }
  async function wallet(){
    const result=checkedResult(await api().getWalletBalance({accountType:'UNIFIED'}));
    if(!Array.isArray(result.list)||result.list.length!==1||result.list[0].accountType!=='UNIFIED'||!Array.isArray(result.list[0].coin))stop('wallet_invalid','统一账户余额字段不完整。');
    const row=result.list[0];units(row.totalAvailableBalance);const seen=new Set();let usdt=null,btc=0n;
    for(const coin of row.coin){
      if(typeof coin.coin!=='string'||seen.has(coin.coin))stop('wallet_invalid','账户币种记录缺失或重复。');seen.add(coin.coin);
      const balance=units(coin.walletBalance),equity=units(coin.equity),locked=units(coin.locked);
      if(units(coin.borrowAmount)!==0n||units(coin.spotBorrow)!==0n)stop('borrowing_detected','账户存在借款，不能启用本策略。');
      if(!['USDT','BTC'].includes(coin.coin)&&(balance!==0n||equity!==0n||locked!==0n))stop('wallet_not_isolated','专用账户只能保留 USDT 和本策略 BTC。');
      if(coin.coin==='BTC'){btc=balance;if(locked!==0n||equity!==balance)stop('wallet_invalid','BTC 余额仍受其他占用或无法核验。');}
      if(coin.coin==='USDT'){if(locked>equity||locked>balance)stop('wallet_invalid','USDT 可用金额无法核验。');usdt={balance,equity,locked,available:(balance<equity?balance:equity)-locked};}
    }
    if(!usdt)stop('wallet_invalid','未返回完整 USDT 余额。');return {...usdt,btc};
  }
  async function accountEvidence({stage='entry',plan=null}={}){
    await permissionCheck();const w=await wallet();
    const positions=[];for(const params of [{category:'option',limit:200},{category:'linear',settleCoin:'USDT',limit:200},{category:'linear',settleCoin:'USDC',limit:200},{category:'inverse',limit:200}])positions.push(...await pages('getPositions',params));
    const orders=[];for(const category of ['option','spot','linear','inverse'])orders.push(...await pages('getOrders',{category,openOnly:0,limit:50}));
    for(const position of positions){
      const q=units(position.size);if(typeof position.symbol!=='string'||!['Buy','Sell',''].includes(position.side))stop('position_invalid','持仓字段不完整。');
      const allowed=stage==='status'&&plan&&position.symbol===plan.symbol&&position.side==='Sell'&&q<=units(plan.q);
      if(q!==0n&&!allowed)stop('other_position','账户存在本次核验范围以外的持仓。');
    }
    for(const order of orders){
      if(typeof order.orderId!=='string'||!KNOWN_ORDERS.has(order.orderStatus)||!['Buy','Sell'].includes(order.side))stop('order_invalid','挂单状态或方向无法核验。');
      if(TERMINAL.has(order.orderStatus))continue;
      const allowed=stage==='status'&&plan&&[plan.orderPayload?.orderLinkId,plan.spotOrder?.orderLinkId].includes(order.orderLinkId);
      if(!allowed)stop('other_order','账户存在其他未结束委托。');
    }
    const knownBTC=journal.list().filter(row=>row.account===accountLabel).reduce((sum,row)=>sum+(row.receivedBTC==null?0n:units(row.receivedBTC)),0n);
    if(!equal(text(w.btc),text(knownBTC),1000000n))stop('btc_not_isolated','账户 BTC 尚未与本策略已对账成交一致。');
    const checkedAt=now();verification={checkedAt,verified:true,availableFunds:text(w.available)};
    return {verified:true,account:accountLabel,currency:'USDT',checkedAt,dedicatedSubaccount:true,noOtherPositions:true,noOtherOrders:true,noBorrowing:true,availableFunds:text(w.available),wallet:w};
  }
  async function feeRate(category){
    const params=category==='option'?{category,baseCoin:'BTC'}:{category,symbol:'BTCUSDT'},r=checkedResult(await api().getFeeRates(params));
    if(r.category!==category||!Array.isArray(r.list))stop('fee_unverified','未取得实际账户费率。');
    const matching=r.list.filter(row=>category==='option'?row.baseCoin==='BTC':row.symbol==='BTCUSDT');
    if(matching.length!==1)stop('fee_unverified','实际账户费率缺失或不唯一。');const rate=units(matching[0].takerFeeRate);if(rate>=SCALE)stop('fee_unverified','实际账户费率超出可核验范围。');return rate;
  }
  async function preflight(intent){
    const evidence=await accountEvidence({stage:intent.stage==='spot'?'spot':'entry'});
    if(intent.stage!=='spot'){
      const actual=await feeRate('option');if(actual>units(intent.optionTakerRate))stop('fee_changed','实际期权手续费高于准备计划，请重新准备。');
    }
    if(evidence.wallet.locked!==0n||evidence.wallet.equity!==evidence.wallet.balance)stop('wallet_unsettled','账户现金尚未与持仓完全结清。');
    if(intent.stage==='spot'&&journal.get(intent.id)?.automationPaused===true)stop('automation_paused','用户已暂停后续自动动作，已有订单仍继续对账。');
    return {...evidence,wallet:undefined};
  }
  const proxy={createSellPut:(order,authorization)=>api().createSellPut(order,authorization),createSpotBuy:(order,authorization)=>api().createSpotBuy(order,authorization)};
  const controller=new ExecutionController({journal,exchange:proxy,preflight,now,liveEnabled});

  async function prepare(input){
    if(!input||Object.keys(input).some(key=>!['amount','symbol','buyBufferRate'].includes(key))||typeof input.symbol!=='string')stop('prepare_invalid','准备请求只接受资金、真实合约及接币缓冲。');
    const amount=text(units(input.amount)),buffer=Number(input.buyBufferRate??.005);
    if(units(amount)<=0n||!Number.isFinite(buffer)||buffer<0||buffer>.05)stop('prepare_invalid','资金或接币缓冲无效。');
    const data=await marketProvider.prepare({amount,symbol:input.symbol,buyBufferRate:buffer});
    const {market,contract,book,spec}=data||{};
    if(market?.platform!=='bybit'||contract?.symbol!==input.symbol||spec?.validated!==true||spec.category!=='option'||spec.status!=='Trading'||spec.optionsType!=='Put'||spec.baseCoin!=='BTC'||spec.quoteCoin!=='USDT'||spec.settleCoin!=='USDT'||spec.symbol!==input.symbol||!equal(spec.strike,contract.strike)||Number(spec.deliveryTime)!==contract.expires||!equal(spec.priceFilter?.tickSize,contract.priceTick)||!equal(spec.lotSizeFilter?.qtyStep,contract.step)||!equal(spec.lotSizeFilter?.minOrderQty,contract.min)||!fresh(book?.time,now())||!fresh(market?.time,now()))stop('market_unverified','真实合约、价格步长或新鲜买盘未核验。');
    const canonicalContract={...contract};
    if(liveEnabled){canonicalContract.taker=Number(text(await feeRate('option')));canonicalContract.spot=Number(text(await feeRate('spot')));}
    const model=calculate(Number(amount),canonicalContract,book,market.spot,now(),canonicalContract.strike,buffer),id='put_'+randomUUID().replaceAll('-','');
    const intent=prepareExecutionIntent({model,contract:canonicalContract,book,market,amount,now:now(),orderLinkId:id});
    if(!intent.valid||!intent.payloadReady)stop('prepare_unavailable','无法生成符合资金和官方规格的有效委托。');
    const stored={...intent,account:accountLabel,optionTakerRate:String(canonicalContract.taker)};
    for(const [key,value] of drafts)if(value.intent.expiresAt<=now())drafts.delete(key);
    if(drafts.size>=100)stop('prepare_limit','待确认计划数量已达到上限。');drafts.set(id,{intent:clone(stored),spec:clone(spec)});
    return clone(stored);
  }
  async function confirm(input){return serialize(async()=>{
    if(!liveEnabled||typeof exchangeFactory!=='function')stop('not_configured','真实执行尚未配置，不能提交委托。');
    if(!input||Object.keys(input).some(key=>!['id','fingerprint','account','currency','confirmed'].includes(key))||input.confirmed!==true||input.account!==accountLabel||input.currency!=='USDT')stop('confirmation_invalid','需要与账户及币种绑定的明确确认。');
    const existing=journal.get(input.id);if(existing){if(existing.fingerprint!==input.fingerprint||existing.account!==input.account||existing.currency!==input.currency)stop('confirmation_invalid','确认条件与原委托不一致。');return existing;}
    if(!fresh(lastTick,now(),15000))stop('runner_unavailable','常驻执行器尚无新鲜心跳，不能新开 PUT。');
    if(api().getExecutionState().reconciliationRequired!==false)stop('reconciliation_pending','已有未知订单未完成对账，不能新开 PUT。');
    const entry=drafts.get(input.id);if(!entry||entry.intent.expiresAt<=now()||entry.intent.fingerprint!==input.fingerprint)stop('confirmation_expired','准备计划已失效或条件已改变，请重新准备。');
    if(journal.list().some(plan=>!plan.closed&&plan.account===accountLabel))stop('active_plan','该专用账户已有未结束计划。');
    // Baseline is private server evidence; a browser cannot provide or replace it.
    const baseline=await accountEvidence();
    const intent={...clone(entry.intent),baselineWalletCash:text(baseline.wallet.balance),baselineBTC:text(baseline.wallet.btc)};
    const {category,symbol,side,orderType,timeInForce,qty,price,orderLinkId}=intent.orderPayload;
    intent.exchangeAuthorization={spec:clone(entry.spec),confirmedIntent:{confirmed:true,intentId:intent.id,action:'sell_put',category,symbol,side,orderType,timeInForce,qty,price,orderLinkId,expiresAt:intent.expiresAt,maxFunds:intent.amount,feeReserve:text(units(intent.fullFundReserve)-units(intent.capital)),strike:intent.strike}};
    const result=await controller.confirm(intent,{...input,account:accountLabel});drafts.delete(input.id);return result;
  });}
  async function matchingOrder(plan,spot=false){
    const expected=spot?plan.spotOrder:plan.orderPayload,category=spot?'spot':'option',side=spot?'Buy':'Sell';
    const params={category,symbol:expected.symbol,orderLinkId:expected.orderLinkId,limit:50};
    let rows=await pages('getOrders',params);if(!rows.length)rows=await pages('getOrderHistory',params);
    const unique=new Map();for(const row of rows){
      if(row.symbol!==expected.symbol||row.orderLinkId!==expected.orderLinkId||row.side!==side||row.orderType!=='Limit'||row.timeInForce!=='IOC'||!equal(row.qty,expected.qty)||!equal(row.price,expected.price)||typeof row.orderId!=='string'||!KNOWN_ORDERS.has(row.orderStatus))stop('order_mismatch','原订单身份、方向或价格数量无法核验。');
      const old=unique.get(row.orderId);if(old&&JSON.stringify(old)!==JSON.stringify(row))stop('order_conflict','分页订单内容发生冲突。');unique.set(row.orderId,row);
    }
    if(unique.size!==1)stop('order_unknown','尚未找到唯一原订单，禁止重新提交。');
    const order=[...unique.values()][0],executions=await pages('getExecutions',{category,symbol:expected.symbol,orderId:order.orderId,orderLinkId:expected.orderLinkId,limit:100});
    const fills=new Map();for(const row of executions){
      if(row.orderId!==order.orderId||row.orderLinkId!==expected.orderLinkId||row.symbol!==expected.symbol||row.side!==side||row.execType!=='Trade'||typeof row.execId!=='string'||!['USDT',...(spot?['BTC']:[])].includes(row.feeCurrency)||units(row.execQty)<=0n||units(row.execPrice)<=0n||!fresh(Number(row.execTime),now(),Math.max(TTL,now()-plan.confirmedAt+2000)))stop('execution_invalid','原订单成交记录、方向、时间或费用币种不完整。');
      units(row.execFee);const old=fills.get(row.execId);if(old&&JSON.stringify(old)!==JSON.stringify(row))stop('execution_conflict','重复成交记录内容冲突。');fills.set(row.execId,row);
    }
    return {order,executions:[...fills.values()]};
  }
  async function clearUnknown(plan,spot=false){
    if(api().getExecutionState?.().reconciliationRequired!==true)return true;
    if(typeof api().reconcileUnknownOrder!=='function')return false;
    const expected=spot?plan.spotOrder:plan.orderPayload;
    const result=await api().reconcileUnknownOrder({category:spot?'spot':'option',symbol:expected.symbol,orderLinkId:expected.orderLinkId});return result?.ok===true;
  }
  async function settlement(plan){
    const rows=await pages('getDeliveryRecords',{category:'option',symbol:plan.symbol,startTime:plan.expiry,endTime:now(),limit:50});
    const candidates=rows.filter(row=>row.symbol===plan.symbol&&row.side==='Sell'&&Number(row.deliveryTime)===plan.expiry);
    if(candidates.length!==1)stop('settlement_pending','尚未取得唯一最终交割记录。');const record=candidates[0];
    if(!equal(record.position,plan.filledQty)||!equal(record.strike,plan.strike))stop('settlement_mismatch','最终交割数量或执行价不匹配。');
    const price=units(record.deliveryPrice),fee=units(record.fee);units(record.deliveryRpl,true);
    const evidence=await accountEvidence({stage:'settlement'}),w=evidence.wallet;
    if(w.locked!==0n||w.balance!==w.equity)stop('wallet_unsettled','交割后 USDT 现金尚未结清。');
    const payout=filledUnits(plan)*(units(plan.strike)>price?units(plan.strike)-price:0n)/SCALE,delta=units(plan.gross)-units(plan.openFee)-payout-fee;
    const expectedWallet=units(plan.baselineWalletCash)+delta,strategy=units(plan.amount)+delta;
    if(strategy<0n||!equal(text(w.balance),text(expectedWallet))||w.available<strategy)stop('settlement_cash_mismatch','最终钱包与本策略实际现金流尚未对账一致。');
    const observationKey=createHash('sha256').update(JSON.stringify({record,wallet:text(w.balance),available:text(w.available),strategy:text(strategy)})).digest('hex');
    const prior=plan.settlementObservation;
    if(!prior||prior.observationKey!==observationKey||now()<prior.observedAt){journal.update(plan.id,plan.version,{phase:'settlement_pending',settlementObservation:{observationKey,observedAt:now()}});return null;}
    if(now()-prior.observedAt<1000)return null;
    const latest=journal.get(plan.id);
    return controller.recordSettlement(plan.id,{account:accountLabel,currency:'USDT',checkedAt:now(),final:true,positionEmpty:true,balanceVerified:true,symbol:plan.symbol,side:'Sell',position:Number(plan.filledQty),strike:Number(plan.strike),deliveryTime:plan.expiry,deliveryPrice:Number(text(price)),deliveryFee:Number(text(fee)),strategyCash:Number(text(strategy)),observedAt:now(),observationKey,priorObservedAt:prior.observedAt});
  }
  async function buy(plan){
    plan=journal.get(plan.id);if(plan.automationPaused)return plan;
    if(now()>=plan.spotDeadline)return journal.update(plan.id,plan.version,{phase:'needs_attention',serviceIssue:'spot_window_expired'});
    const data=await marketProvider.spot({symbol:'BTCUSDT',planId:plan.id}),spec=data?.spec;
    if(spec?.validated!==true||spec.category!=='spot'||spec.status!=='Trading'||spec.symbol!=='BTCUSDT'||spec.baseCoin!=='BTC'||spec.quoteCoin!=='USDT'||!fresh(data.time,now(),10000))stop('spot_market_unverified','现货规格或最新卖盘未核验。');
    const rate=await feeRate('spot'),tick=units(spec.priceFilter?.tickSize),step=units(spec.lotSizeFilter?.basePrecision),q=filledUnits(plan);
    if(tick<=0n||step<=0n)stop('spot_market_unverified','现货价格或数量步长无效。');
    const cap=alignDown(units(plan.settlement.deliveryPrice)*(SCALE+units(plan.buyBufferRate))/SCALE,tick);
    if(q%step!==0n||cap<=0n||units(data.ask)<=0n||units(data.ask)>cap)stop('spot_price_outside','现货价格或数量不在已批准范围内，暂停买入。');
    const principal=q*cap/SCALE,reserve=multiplyUp(principal,rate),maxFunds=units(plan.settlement.strategyCash);
    if(principal+reserve>maxFunds)stop('spot_budget_exceeded','真实现货价格和账户手续费超过策略可用现金。');
    const latest=journal.get(plan.id);if(latest.automationPaused)return latest;
    if(!await clearUnknown(latest))stop('reconciliation_pending','原未知订单尚未解除对账限制，不能提交现货订单。');
    const order={symbol:'BTCUSDT',qty:text(q),price:text(cap),orderLinkId:'spot_'+randomUUID().replaceAll('-','').slice(0,31)};
    return controller.buySpot(plan.id,{order,feeReserve:Number(text(reserve)),authorization:{spec,confirmedIntent:{confirmed:true,intentId:'spot_'+randomUUID().replaceAll('-',''),action:'spot_buy',category:'spot',side:'Buy',orderType:'Limit',timeInForce:'IOC',...order,isLeverage:0,expiresAt:Math.min(now()+TTL,plan.spotDeadline),maxFunds:text(maxFunds),feeReserve:text(reserve)}}});
  }
  async function tick(id){return serialize(async()=>{
    if(!liveEnabled||typeof exchangeFactory!=='function')return {status:'not_configured',plans:journal.list()};
    const targets=id?[journal.get(id)].filter(Boolean):journal.list().filter(plan=>!plan.closed&&plan.account===accountLabel);
    const results=[];let succeeded=true;
    for(let plan of targets){
      if(plan.account!==accountLabel)continue;
      try{
        if(['put_submitting','put_reconciling','unknown'].includes(plan.phase)){
          const evidence=await matchingOrder(plan);plan=controller.reconcilePut(plan.id,evidence.order,evidence.executions);
          if(TERMINAL.has(evidence.order.orderStatus)&&!await clearUnknown(plan)){
            plan=journal.update(plan.id,plan.version,{phase:'unknown',closed:false,serviceIssue:'reconciliation_pending'});stop('reconciliation_pending','适配器仍要求核对原未知订单，未启用后续买入。');
          }
        }
        if(['spot_submitting','spot_reconciling','spot_unknown'].includes(plan.phase)){
          const evidence=await matchingOrder(plan,true);plan=controller.reconcileSpot(plan.id,evidence.order,evidence.executions);
          if(TERMINAL.has(evidence.order.orderStatus)&&!await clearUnknown(plan,true)){
            plan=journal.update(plan.id,plan.version,{phase:'spot_unknown',closed:false,serviceIssue:'reconciliation_pending'});stop('reconciliation_pending','现货终态已记账，但适配器仍未解除原未知订单限制。');
          }
        }
        if(['holding','settlement_pending','spot_ready'].includes(plan.phase)&&!await clearUnknown(plan))stop('reconciliation_pending','适配器仍要求核对原未知订单，未启用后续买入。');
        if(['holding','settlement_pending'].includes(plan.phase)&&now()>=plan.expiry){const settled=await settlement(plan);if(settled)plan=settled;else plan=journal.get(plan.id);}
        if(plan.phase==='spot_ready'&&!plan.automationPaused)plan=await buy(plan);
        results.push(plan);
      }catch(caught){
        verification=null;const issue=safeError(caught),current=journal.get(plan.id);if(!['settlement_pending','order_unknown'].includes(issue.code))succeeded=false;
        if(current){
          const closedUnknown=current.closed===true&&exchange?.getExecutionState?.().reconciliationRequired===true;
          const phase=closedUnknown?(current.spotOrder?'spot_unknown':'unknown'):['spot_price_outside','spot_budget_exceeded','spot_market_unverified'].includes(issue.code)?'needs_attention':current.phase;
          plan=journal.update(plan.id,current.version,{phase,serviceIssue:issue.code,...(closedUnknown?{closed:false}:{}),...(['holding','settlement_pending'].includes(current.phase)&&now()>=current.expiry?{settlementObservation:null}:{})});
        }
        results.push({...plan,serviceIssue:issue.code});
      }
    }
    if(succeeded)lastTick=now();return {status:'checked',plans:results,lastTick};
  });}
  async function status(){
    const runnerOnline=liveEnabled&&fresh(lastTick,now(),15000);
    if(!liveEnabled||typeof exchangeFactory!=='function')return {status:'not_configured',connected:false,accountVerified:false,canSubmit:false,runnerOnline:false,liveEnabled:false,account:accountLabel,currency:'USDT',runnerRequired:true};
    try{
      if(!verification||verification.feesVerified!==true||!fresh(verification.checkedAt,now(),15000)){const active=journal.list().find(plan=>!plan.closed&&plan.account===accountLabel);await accountEvidence({stage:'status',plan:active});await feeRate('option');await feeRate('spot');verification.feesVerified=true;}
      const active=journal.list().some(plan=>!plan.closed&&plan.account===accountLabel);
      const unknown=api().getExecutionState().reconciliationRequired!==false;
      return {status:'verified',connected:true,accountVerified:true,canSubmit:runnerOnline&&!active&&!unknown&&units(verification.availableFunds)>0n,runnerOnline,reconciliationRequired:unknown,liveEnabled:true,account:accountLabel,currency:'USDT',verifiedAt:verification.checkedAt,lastTick,runnerRequired:true};
    }catch(caught){verification=null;return {status:'account_unverified',connected:false,accountVerified:false,canSubmit:false,runnerOnline,liveEnabled:true,account:accountLabel,currency:'USDT',runnerRequired:true,...safeError(caught)};}
  }
  function pause({id}={}){
    const plan=journal.get(id);if(!plan||plan.account!==accountLabel)stop('plan_not_found','未找到当前账户的执行记录。');
    if(plan.automationPaused)return plan;
    return journal.update(id,plan.version,{automationPaused:true,automationPausedAt:now()});
  }
  return Object.freeze({status,prepare,confirm,list:()=>journal.list().filter(plan=>plan.account===accountLabel),tick,pause});
}

import {randomUUID,createHash} from 'node:crypto';
import {calculate} from '../web/calc.js';
import {DERIBIT_FEE_POLICY} from './deribit-market.mjs';

const S=10n**18n,TTL=30000,TERMINAL=new Set(['filled','cancelled','rejected']);
const clone=x=>JSON.parse(JSON.stringify(x));
class ServiceError extends Error{constructor(code,message){super(message);this.code=code;}}
const stop=(code,message)=>{throw new ServiceError(code,message);};
function u(value,signed=false){
  let x=typeof value==='number'&&Number.isFinite(value)?String(value):value;
  if(typeof x==='string'&&/e/i.test(x)){const [a,b]=x.toLowerCase().split('e'),neg=a.startsWith('-'),[w,f='']=(neg?a.slice(1):a).split('.'),d=w+f,p=w.length+Number(b);if(!Number.isSafeInteger(p)||Math.abs(p)>40)stop('decimal_invalid','数值超出可核验范围。');x=(neg?'-':'')+(p<=0?'0.'+'0'.repeat(-p)+d:p>=d.length?d+'0'.repeat(p-d.length):d.slice(0,p)+'.'+d.slice(p));}
  if(typeof x!=='string'||!(signed?/^-?(?:0|[1-9]\d{0,14})(?:\.\d{1,18})?$/:/^(?:0|[1-9]\d{0,14})(?:\.\d{1,18})?$/).test(x))stop('decimal_invalid','交易所数量或金额字段缺失、格式不明。');
  const neg=x.startsWith('-'),[w,f='']=(neg?x.slice(1):x).split('.');return (neg?-1n:1n)*(BigInt(w)*S+BigInt(f.padEnd(18,'0')));
}
function t(v){const neg=v<0n,d=(neg?-v:v).toString().padStart(19,'0');return (neg?'-':'')+(d.slice(0,-18)+'.'+d.slice(-18)).replace(/\.?0+$/,'');}
// Some official fixed fee examples have binary-JSON tails beyond 18 decimals.
// Round only the reserve rate upward; order quantities/prices remain exact.
function rateU(value){const str=String(value);if(/^(?:0|[1-9]\d{0,3})\.\d{19,36}$/.test(str)){const [whole,fraction]=str.split('.'),base=BigInt(whole)*S+BigInt(fraction.slice(0,18));return base+(BigInt(fraction.slice(18))>0n?1n:0n);}return u(value);}
const mul=(a,b)=>a*b/S,up=(a,b)=>(a*b+S-1n)/S,abs=v=>v<0n?-v:v;
// Search whole spot increments against the exact rounded notional and fee.
// Dividing the budget by an approximate float fee factor can overspend at the
// last increment, especially when the exchange reports account-specific rates.
function affordableSpotQuantity(cash,price,rate,step){
  let low=0n,high=cash*S/(step*price);
  while(low<high){const mid=(low+high+1n)/2n,cost=up(mid*step,price);if(cost+up(cost,rate)<=cash)low=mid;else high=mid-1n;}
  return low*step;
}
const eq=(a,b)=>abs(u(a,true)-u(b,true))<=10000000000n; // 0.00000001 USDC API reporting precision.
const fresh=(stamp,now,ttl=TTL)=>Number.isSafeInteger(stamp)&&stamp>0&&stamp<=now+2000&&now-stamp<ttl;
const fail=error=>error instanceof ServiceError?{code:error.code,reason:error.message}:{code:'service_unavailable',reason:'执行证据尚未核验完整，自动操作已停止。'};
const result=r=>{if(r?.ok!==true||r.data==null)stop('exchange_unverified','交易所读取未通过核验。');return r.data;};
function tickAt(spec,price){let tick=u(spec.tick_size);if(tick<=0n||!Array.isArray(spec.tick_size_steps))stop('tick_invalid','官方价格步长不完整。');let prior=-1n;for(const row of spec.tick_size_steps){const above=u(row.above_price),next=u(row.tick_size);if(above<=prior||next<=0n||next%u(spec.tick_size)!==0n)stop('tick_invalid','官方分档价格步长无效。');if(price>above)tick=next;prior=above;}return tick;}
function specCheck(spec,spot=false){
  if(spec?.validated!==true||spec.state!=='open'||spec.is_active!==true||spec.kind!==(spot?'spot':'option')||spec.base_currency!=='BTC'||spec.quote_currency!=='USDC'||spec.instrument_type!=='linear'||u(spec.min_trade_amount)<=0n||u(spec.contract_size)<=0n)stop('spec_invalid','官方交易规格或交易状态不完整。');
  if(spot){if(spec.instrument_name!=='BTC_USDC')stop('spec_invalid','仅支持 BTC_USDC 现货。');}
  else if(!/^BTC_USDC-\d{1,2}[A-Z]{3}\d{2}-\d+(?:d\d+|\.\d+)?-P$/.test(spec.instrument_name)||spec.option_type!=='put'||spec.settlement_currency!=='USDC'||u(spec.contract_size)!==S||u(spec.strike)<=0n||!Number.isSafeInteger(spec.expiration_timestamp)||spec.price_index!=='btc_usdc')stop('spec_invalid','仅支持单位为 BTC 的线性 USDC PUT。');
  if(!spot){const [,date,strike]=spec.instrument_name.split('-'),match=date.match(/^(\d{1,2})([A-Z]{3})(\d{2})$/),month=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'].indexOf(match?.[2]),day=Number(match?.[1]),expiry=Date.UTC(2000+Number(match?.[3]),month,day,8);if(!match||month<0||new Date(expiry).getUTCDate()!==day||expiry!==spec.expiration_timestamp||u(strike)!==u(spec.strike))stop('spec_invalid','合约名称与官方执行价或精确到期时间不一致。');}
  tickAt(spec,u(spec.tick_size));
}
function feeFor(summary,spec){
  const base=rateU(spec.taker_commission);if(base>=S)stop('fee_unverified','官方基准费率无效。');
  if(spec.kind==='spot'&&(spec.is_csr===true||spec.is_cbe_routed===true)&&base===0n)stop('fee_unverified','路由现货基准费用与官方收费规则不一致。');
  if(!Object.hasOwn(summary,'fees'))return base; // Official extended summary: fees is present only for discounted accounts.
  if(!summary.fees||typeof summary.fees!=='object'||Array.isArray(summary.fees))stop('fee_unverified','实际账户费率字段不完整。');
  const entry=summary.fees[spec.price_index]?.[spec.kind]?.default;
  if(!entry||!['relative','fixed'].includes(entry.type))stop('fee_unverified','本账户该产品的实际费率无法唯一确认。');
  const rate=entry.type==='relative'?up(base,rateU(entry.taker)):rateU(entry.taker);if(rate>=S)stop('fee_unverified','实际手续费率无效。');return rate;
}

/** Default off. Operator supplies the immutable account factory; no credentials or
 * browser account/model assertions are read. Journal records precede every POST. */
export function createDeribitExecutionService({journal,exchangeFactory,marketProvider,now=Date.now,liveEnabled=false,accountLabel='deribit-dedicated-usdc'}={}){
  if(!journal||!['get','list','create','update'].every(k=>typeof journal[k]==='function')||typeof marketProvider?.prepare!=='function'||typeof now!=='function'||typeof liveEnabled!=='boolean'||typeof accountLabel!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(accountLabel))throw Error('Invalid Deribit service configuration');
  const drafts=new Map();let exchange=null,lastTick=null,queue=Promise.resolve();
  const serial=fn=>{const task=queue.then(fn,fn);queue=task.catch(()=>{});return task;};
  const active=()=>journal.list().filter(p=>p.account===accountLabel&&!p.closed);
  const patch=(plan,change,event)=>journal.update(plan.id,plan.version,change,event);
  function api(){
    if(!liveEnabled||typeof exchangeFactory!=='function')stop('not_configured','真实执行尚未配置。');if(!exchange)exchange=exchangeFactory({accountLabel,liveEnabled:true});
    const methods=['getApiInfo','getAccountSummaries','getPositions','getOpenOrders','getOrderStateByLabel','getOrderHistory','getTradesByOrder','getTransactionLog','createSellPut','createSpotBuy','getExecutionState','reconcileUnknownOrder'];
    if(!exchange||methods.some(k=>typeof exchange[k]!=='function')||exchange.getExecutionState()?.finalGateSupported!==true||typeof marketProvider.spot!=='function'||typeof marketProvider.settlement!=='function')stop('adapter_incomplete','期权、现货、实际资金或提交前最终门禁尚未完整接通。');return exchange;
  }
  const unlocked=()=>{if(api().getExecutionState()?.reconciliationRequired!==false)stop('reconciliation_pending','已有未知订单待核对，禁止提交任何新单。');};
  async function account({plan=null,flat=false}={}){
    const info=result(await api().getApiInfo());
    if(info.isMaster!==false||info.readOnly!==false||info.unsafePermissions!==false||info.keyEnabled!==true||info.keyScopeKnown!==true||!info.permissions||info.permissions.account!=='read'||info.permissions.trade!=='read_write'||!['none',undefined].includes(info.permissions.wallet)||Object.entries(info.permissions).some(([k,v])=>!['account','trade','wallet'].includes(k)&&v!=='none'))stop('permissions_invalid','需要仅有账户读取及交易权限的专用子账户，禁止提现、转账或未知权限。');
    const summaryData=result(await api().getAccountSummaries({extended:true}));
    if(!Array.isArray(summaryData.summaries)||summaryData.type!=='subaccount'||!Number.isSafeInteger(summaryData.id)||summaryData.id<=0)stop('wallet_invalid','所有币种余额及真实子账户身份未完整返回。');
    if(journal.list().some(p=>p.account===accountLabel&&p.accountId!==summaryData.id))stop('account_changed','当前真实账户与持久化策略记录不一致。');
    const seen=new Set();let cash=null,btc=0n;
    for(const row of summaryData.summaries){
      if(typeof row.currency!=='string'||seen.has(row.currency))stop('wallet_invalid','账户币种缺失或重复。');seen.add(row.currency);
      const balance=u(row.balance),equity=u(row.equity,true),margin=u(row.margin_balance,true),available=u(row.available_funds),withdrawable=u(row.available_withdrawal_funds),initial=u(row.initial_margin),maintenance=u(row.maintenance_margin),spot=u(row.spot_reserve),additional=u(row.additional_reserve);
      if(row.cross_collateral_enabled!==false||row.portfolio_margining_enabled!==false||row.margin_model!=='segregated_sm'||equity<0n||margin<0n||spot!==0n||additional!==0n||u(row.locked_balance)!==0n)stop('account_mode_unsupported','需要无借款、无其他资金占用的隔离标准保证金子账户。');
      if(!['USDC','BTC'].includes(row.currency)&&[balance,equity,margin,available,withdrawable,initial,maintenance].some(v=>v!==0n))stop('wallet_not_isolated','专用账户存在其他币种资金或占用。');
      if(row.currency==='BTC'){if(balance!==equity||balance!==margin||initial!==0n||maintenance!==0n)stop('wallet_invalid','BTC 余额未结清。');btc=balance;}
      if(row.currency==='USDC')cash={row,balance,equity,margin,available:available<balance?available:balance,withdrawable,initial,maintenance};
    }
    if(!cash)stop('wallet_invalid','没有完整 USDC 资金记录。');
    const positions=result(await api().getPositions({currency:'any'})),orders=result(await api().getOpenOrders({type:'all'}));
    if(!Array.isArray(positions)||!Array.isArray(orders))stop('account_unverified','完整持仓与所有类型挂单尚未读取。');
    for(const pos of positions){const size=u(pos.size,true);if(size===0n)continue;const permitted=!flat&&plan&&pos.instrument_name===plan.symbol&&pos.direction==='sell'&&abs(size)<=u(plan.q);if(!permitted)stop('other_position','账户存在未经本策略核验的持仓或交割期货。');}
    for(const order of orders){if(typeof order.order_id!=='string'||!['open','untriggered','filled','cancelled','rejected'].includes(order.order_state))stop('order_invalid','订单状态无法核验。');if(TERMINAL.has(order.order_state))continue;if(!plan||flat||![plan.orderPayload.label,plan.spotOrder?.label].includes(order.label))stop('other_order','账户存在其他未结束委托。');}
    const known=journal.list().filter(p=>p.account===accountLabel).reduce((sum,p)=>sum+(p.receivedBTC==null?0n:u(p.receivedBTC)),0n);
    if(btc!==known)stop('btc_not_isolated','BTC 钱包尚未与本策略已对账成交一致。');
    if(flat&&(cash.balance!==cash.equity||cash.balance!==cash.margin||cash.initial!==0n||cash.maintenance!==0n||cash.available!==cash.balance||cash.withdrawable<cash.balance))stop('cash_unsettled','USDC 现金、权益和可用资金尚未结清。');
    return {cash,btc,positions,accountId:summaryData.id,checkedAt:now()};
  }
  async function prepare(input){
    if(!input||Object.keys(input).some(k=>!['amount','symbol','buyBufferRate'].includes(k))||typeof input.symbol!=='string')stop('prepare_invalid','仅接受本次资金、真实合约和接币缓冲。');
    const amount=t(u(input.amount)),buffer=u(input.buyBufferRate??.005);if(u(amount)<=0n||buffer>u('0.05'))stop('prepare_invalid','资金或接币缓冲无效。');
    const data=await marketProvider.prepare({amount,symbol:input.symbol,buyBufferRate:Number(t(buffer))});const {spec,spotSpec,book,market}=data||{};
    specCheck(spec);specCheck(spotSpec,true);
    if(spec.instrument_name!==input.symbol||spec.expiration_timestamp<=now()||market?.platform!=='deribit'||!fresh(market.time,now())||!fresh(book?.time,now())||!Array.isArray(book.bids)||u(market.spot)<=0n)stop('market_unverified','合约、指数或深度报价未通过新鲜度核验。');
    let optionRate=rateU(spec.taker_commission),spotRate=rateU(spotSpec.taker_commission);
    if(liveEnabled){const evidence=await account();optionRate=feeFor(evidence.cash.row,spec);spotRate=feeFor(evidence.cash.row,spotSpec);}
    const cap=u(spec.taker_max_commission??DERIBIT_FEE_POLICY.optionFeeCap);if(cap>S||cap===0n)stop('fee_unverified','官方期权手续费上限无效。');
    const contract={symbol:spec.instrument_name,strike:Number(spec.strike),expires:spec.expiration_timestamp,step:Number(spec.min_trade_amount),min:Number(spec.min_trade_amount),taker:Number(t(optionRate)),cap:Number(t(cap)),delivery:.00015,spot:Number(t(spotRate)),spotDeductBase:false};
    const model=calculate(Number(amount),contract,book,Number(market.spot),now(),Number(spec.strike),Number(t(buffer)));if(!model.valid)stop('prepare_unavailable',model.errors.join(' '));
    const step=u(spec.min_trade_amount),K=u(spec.strike),A=u(amount),index=u(market.spot);let q=u(model.q),reserves;
    while(q>=step){const capital=mul(q,K),opening=up(up(q,index),optionRate),delivery=up(capital,u('0.00015')),buyBuffer=up(capital,buffer),spotReserve=up(capital+buyBuffer,spotRate),fee=opening+delivery+spotReserve;reserves={capital,opening,delivery,buyBuffer,spotReserve,fee,full:capital+buyBuffer+fee};if(reserves.full<=A)break;q-=step;}
    if(q<step)stop('funding_shortfall','资金不足以覆盖最小数量、实际费用和价格缓冲。');
    let remaining=q,gross=0n,estimatedOpenFee=0n,floor=0n;const bids=book.bids.map(row=>({price:u(row.price),qty:u(row.qty)})).sort((a,b)=>a.price===b.price?0:a.price>b.price?-1:1);
    for(const row of bids){if(row.price<=0n||row.qty<=0n)stop('depth_invalid','买盘深度字段无效。');if(row.price%tickAt(spec,row.price)!==0n)stop('tick_invalid','买盘价格不符合官方分档步长。');const take=remaining<row.qty?remaining:row.qty;gross+=mul(take,row.price);
      // Expected cost follows each visible fill's capped exchange fee. The
      // larger nominal opening reserve remains untouched as a funding guard.
      const nominal=(take*index*optionRate+S*S-1n)/(S*S),capped=(take*row.price*cap+S*S-1n)/(S*S);estimatedOpenFee+=nominal<capped?nominal:capped;
      remaining-=take;floor=row.price;if(remaining===0n)break;}
    if(remaining!==0n||floor<=0n)stop('depth_insufficient','可见买盘不足，不能生成 IOC 委托。');
    if(!fresh(book.time,now())||!fresh(market.time,now()))stop('market_stale','账户核验期间行情已经失效，请重新准备。');
    const spotBudgetMode='remaining_strategy_cash';
    const id='dp_'+randomUUID().replaceAll('-',''),createdAt=now(),expiry=spec.expiration_timestamp,fingerprint=JSON.stringify({platform:'deribit',currency:'USDC',amount,strike:t(K),expiry,symbol:input.symbol,q:t(q),minPrice:t(floor),optionRate:t(optionRate),optionFeeCap:t(cap),optionIndexPrice:t(index),estimatedGross:t(gross),estimatedOpenFee:t(estimatedOpenFee),spotRate:t(spotRate),buffer:t(buffer),reserve:t(reserves.full),spotBudgetMode});
    const orderPayload={instrument_name:spec.instrument_name,amount:t(q),price:t(floor),label:id};
    const intent={id,account:accountLabel,platform:'deribit',currency:'USDC',environment:data.environment||marketProvider.environment||'unknown',symbol:input.symbol,strike:t(K),expiry,amount,q:t(q),capital:t(reserves.capital),feeReserve:t(reserves.fee),openingFeeReserve:t(reserves.opening),buyBufferRate:t(buffer),buyBufferReserve:t(reserves.buyBuffer),fullFundReserve:t(reserves.full),freeCash:t(A-reserves.full),estimatedGross:t(gross),estimatedOpenFee:t(estimatedOpenFee),estimatedNetIncome:t(gross-estimatedOpenFee),optionTakerRate:t(optionRate),optionFeeCap:t(cap),spotTakerRate:t(spotRate),limitPrice:t(floor),priceTick:t(tickAt(spec,floor)),createdAt,expiresAt:Math.min(createdAt+TTL,book.time+TTL,market.time+TTL,expiry),fingerprint,orderPayload,payloadReady:true,valid:true,canSubmit:false,state:'account_required',fundsLocked:false,fundsReservationScope:'service_only_after_confirmation',automationPaused:false,notes:['Deribit 不保证 label 唯一；服务在持久化后只发送一次，未知结果只对账。','ITM 先生成期货再现金结算；须核验最终现金后另买 BTC。','价格缓冲仅规定未来限价，不保证到期能成交；本机离线时不能执行。']};
    intent.spotBudgetMode=spotBudgetMode;
    intent.spotBudgetBasis='confirmed_amount_plus_reconciled_cashflows';
    intent.notes.push('触发后用本笔全部投入及已核对净损益的余款买 BTC；PUT 部分成交也不按比例缩减本笔资金，未成交资金仍属于本笔接币预算。不会使用本笔之外的钱包余额。');
    intent.feePolicy={...DERIBIT_FEE_POLICY,capSource:Object.hasOwn(spec,'taker_max_commission')?'public instrument metadata':'official published fee policy'};
    for(const [key,value]of drafts)if(value.intent.expiresAt<=now())drafts.delete(key);if(drafts.size>=100)stop('prepare_limit','待确认草案过多。');drafts.set(id,{intent:clone(intent),spec:clone(spec),spotSpec:clone(spotSpec)});return clone(intent);
  }
  function authFor(plan,order,spec,spot=false,feeReserve=t(u(plan.fullFundReserve)-u(plan.capital))){return {spec,confirmedIntent:{confirmed:true,intentId:spot?plan.id+'_spot':plan.id,action:spot?'spot_buy':'sell_put',currency:'USDC',instrument_name:order.instrument_name,amount:order.amount,price:order.price,label:order.label,type:'limit',time_in_force:'immediate_or_cancel',post_only:false,direction:spot?'buy':'sell',expiresAt:Math.min(now()+TTL,spot?plan.spotDeadline:plan.expiresAt),maxFunds:spot?plan.strategyCash:plan.amount,feeReserve,...(!spot?{strike:plan.strike}:{})}};}
  async function confirm(input){return serial(async()=>{
    if(!liveEnabled)stop('not_configured','真实执行尚未配置，不能提交委托。');
    if(!input||Object.keys(input).some(k=>!['id','fingerprint','account','currency','confirmed'].includes(k))||input.confirmed!==true||input.account!==accountLabel||input.currency!=='USDC')stop('confirmation_invalid','确认须绑定本机账户、USDC 和服务器准备计划。');
    const old=journal.get(input.id);if(old){if(old.fingerprint!==input.fingerprint||old.account!==input.account||old.currency!==input.currency)stop('confirmation_invalid','确认条件与已记录计划不一致。');return old;}
    const entry=drafts.get(input.id);if(!entry||entry.intent.expiresAt<=now()||entry.intent.fingerprint!==input.fingerprint)stop('confirmation_expired','计划已失效或参数改变，请重新准备。');
    if(!fresh(lastTick,now(),15000))stop('runner_unavailable','本机执行器没有新鲜心跳。');unlocked();if(active().length)stop('active_plan','专用账户已有未结束计划。');
    const evidence=await account({flat:true}),p=entry.intent;if(evidence.cash.available<u(p.amount)||evidence.cash.balance<u(p.fullFundReserve)||u(p.fullFundReserve)>u(p.amount))stop('funding_shortfall','真实已结算 USDC 不足以覆盖本次全部资金。');
    if(feeFor(evidence.cash.row,entry.spec)>u(p.optionTakerRate)||feeFor(evidence.cash.row,entry.spotSpec)>u(p.spotTakerRate))stop('fee_changed','账户期权或现货费用改变，请重新准备。');
    if(now()>=p.expiresAt)stop('confirmation_expired','账户核验期间计划已到期，请重新准备。');unlocked();
    let saved=journal.create({...clone(p),accountId:evidence.accountId,phase:'put_submitting',closed:false,confirmedAt:now(),baselineWalletCash:t(evidence.cash.balance),baselineBTC:t(evidence.btc),spec:clone(entry.spec)});drafts.delete(p.id);
    const authorization=authFor(saved,saved.orderPayload,entry.spec);
    authorization.beforeSubmit=()=>{const current=journal.get(saved.id);return current?.phase==='put_submitting'&&current.automationPaused!==true&&now()<current.expiresAt&&fresh(evidence.checkedAt,now(),15000)&&api().getExecutionState().reconciliationRequired===false;};
    try{const response=await api().createSellPut(clone(saved.orderPayload),authorization);saved=patch(journal.get(saved.id),{phase:response?.ok===true?'put_reconciling':response?.error?.unknown===true?'unknown':'needs_attention',submitStatus:response?.ok===true?'accepted':'unconfirmed'});}catch{saved=patch(journal.get(saved.id),{phase:'unknown',submitStatus:'unknown'});}return saved;
  });}
  async function history(plan,spot=false){
    const expected=spot?plan.spotOrder:plan.orderPayload;let rows=result(await api().getOrderStateByLabel({currency:'USDC',label:expected.label}));if(!Array.isArray(rows))stop('order_invalid','标签订单读取无效。');
    if(!rows.length){for(const historical of [false,true]){let continuation,seen=new Set();for(let page=0;page<50;page++){const data=result(await api().getOrderHistory({instrument_name:expected.instrument_name,count:100,historical,...(continuation!=null?{continuation}:{})}));if(!Array.isArray(data.orders)||!Object.hasOwn(data,'continuation'))stop('pagination_invalid','订单历史分页缺失。');rows.push(...data.orders.filter(row=>row.label===expected.label));if(data.continuation===null||data.continuation==='')break;if(!data.orders.length||seen.has(String(data.continuation))||page===49)stop('pagination_invalid','订单历史分页未读完。');continuation=data.continuation;seen.add(String(continuation));}}}
    const unique=new Map();for(const row of rows){if(row.instrument_name!==expected.instrument_name||row.label!==expected.label||row.direction!==(spot?'buy':'sell')||row.order_type!=='limit'||row.time_in_force!=='immediate_or_cancel'||row.post_only!==false||row.is_liquidation===true||row.is_rebalance===true||!Number.isSafeInteger(row.creation_timestamp)||row.creation_timestamp<plan.confirmedAt-5000||row.creation_timestamp>now()+2000||u(row.amount)!==u(expected.amount)||u(row.price)!==u(expected.price)||typeof row.order_id!=='string'||!['open','untriggered',...TERMINAL].includes(row.order_state))stop('order_mismatch','原订单身份、方向或限价数量不符。');const previous=unique.get(row.order_id);if(previous&&JSON.stringify(previous)!==JSON.stringify(row))stop('order_conflict','原订单历史记录冲突。');unique.set(row.order_id,row);}
    if(unique.size!==1)stop('order_unknown','无法确定唯一原订单，禁止重复发送。');const order=[...unique.values()][0],trades=new Map();
    for(const historical of [false,true]){const list=result(await api().getTradesByOrder({order_id:order.order_id,historical}));if(!Array.isArray(list))stop('trades_invalid','完整成交历史未返回。');for(const row of list){if(typeof row.trade_id!=='string'||row.order_id!==order.order_id||row.instrument_name!==expected.instrument_name||row.direction!==(spot?'buy':'sell')||!['USDC',...(spot?['BTC']:[])].includes(row.fee_currency)||u(row.amount)<=0n||u(row.price)<=0n||!Number.isSafeInteger(row.timestamp)||row.timestamp<plan.confirmedAt||row.timestamp>now()+2000)stop('trade_invalid','成交身份、时间或费用币种无法核验。');u(row.fee,true);const prior=trades.get(row.trade_id);if(prior&&JSON.stringify(prior)!==JSON.stringify(row))stop('trade_conflict','成交重复但内容不一致。');trades.set(row.trade_id,row);}}
    let qty=0n,gross=0n,cashFee=0n,baseFee=0n;for(const row of trades.values()){qty+=u(row.amount);gross+=mul(u(row.amount),u(row.price));if(row.fee_currency==='USDC')cashFee+=u(row.fee,true);else baseFee+=u(row.fee,true);}
    if(qty!==u(order.filled_amount))stop('trades_incomplete','累计成交与订单不一致，等待完整对账。');
    if(order.order_state==='filled'&&qty!==u(expected.amount)||order.order_state==='rejected'&&qty!==0n)stop('order_state_invalid','订单终态与完整成交数量矛盾。');
    const outside=qty>u(expected.amount)||[...trades.values()].some(row=>spot?u(row.price)>u(expected.price):u(row.price)<u(expected.price));
    return {order,trades:[...trades.values()],qty,gross,cashFee,baseFee,outside,terminal:TERMINAL.has(order.order_state)};
  }
  async function reconcile(plan,spot=false){
    const evidence=await history(plan,spot);let blocked=false;
    if(api().getExecutionState().reconciliationRequired===true){const expected=spot?plan.spotOrder:plan.orderPayload;const cleared=await api().reconcileUnknownOrder({currency:'USDC',instrument_name:expected.instrument_name,label:expected.label});blocked=cleared?.ok!==true||api().getExecutionState().reconciliationRequired!==false;}
    const old=journal.get(plan.id),change=spot?{spotFills:evidence.trades,spotFilledQty:t(evidence.qty),spentUSDC:t(evidence.gross),spotFeeUSDC:t(evidence.cashFee),spotFeeBTC:t(evidence.baseFee),receivedBTC:t(evidence.qty-evidence.baseFee),remainingStrategyCash:t(u(plan.strategyCash)-evidence.gross-evidence.cashFee)}:{fills:evidence.trades,filledQty:t(evidence.qty),gross:t(evidence.gross),openFee:t(evidence.cashFee)};
    let phase=spot?'spot_reconciling':'put_reconciling',closed=false;
    const moneyOutside=spot?(evidence.gross+evidence.cashFee>u(plan.spotCashCap)||evidence.qty-evidence.baseFee<0n):evidence.cashFee>u(plan.openingFeeReserve);
    const attention=old.attentionRequired===true||evidence.outside||moneyOutside;
    if(blocked)phase=spot?'spot_unknown':'unknown';else if(evidence.terminal){phase=attention?'needs_attention':spot?(evidence.qty===u(plan.spotOrder.amount)?'complete_btc':'needs_attention'):(evidence.qty>0n?'holding':'no_fill');closed=['complete_btc','no_fill'].includes(phase);}
    if(!spot&&evidence.terminal){const ratio=evidence.qty;change.activeCapital=t(mul(ratio,u(plan.strike)));change.activeBuyBufferReserve=t(up(u(change.activeCapital),u(plan.buyBufferRate)));change.activeFundReserve=t((u(plan.fullFundReserve)*ratio+u(plan.q)-1n)/u(plan.q));}
    return patch(old,{...change,phase,closed,attentionRequired:attention,lastOrderTerminal:evidence.terminal,reconciliationPending:blocked,lastReconciledAt:now()});
  }
  async function ledger(plan){
    const logs=new Map(),end=now();if(end-plan.confirmedAt>366*86400000)stop('ledger_range','资金流水核验区间超出一年上限。');
    // Seven-day windows keep the adapter/API bounded. Inclusive boundaries are
    // intentional; immutable log IDs are deduplicated across adjacent windows.
    for(let start=plan.confirmedAt;start<=end;){const finish=Math.min(start+7*86400000,end);let continuation,seen=new Set(),complete=false;for(let page=0;page<50;page++){
      const data=result(await api().getTransactionLog({currency:'USDC',start_timestamp:start,end_timestamp:finish,count:1000,...(continuation!=null?{continuation}:{})}));
      if(!Array.isArray(data.logs)||!Object.hasOwn(data,'continuation'))stop('pagination_invalid','资金流水分页不完整。');for(const row of data.logs){if(!Number.isSafeInteger(row.id)||row.currency!=='USDC'||!Number.isSafeInteger(row.timestamp)||row.timestamp<plan.confirmedAt||row.timestamp>now()+2000)stop('ledger_invalid','资金流水身份或时间不完整。');u(row.change,true);u(row.commission,true);const old=logs.get(row.id);if(old&&JSON.stringify(old)!==JSON.stringify(row))stop('ledger_conflict','资金流水重复且内容冲突。');logs.set(row.id,row);}
      if(data.continuation===null){complete=true;break;}if(!Number.isSafeInteger(data.continuation)||!data.logs.length||seen.has(data.continuation))stop('pagination_invalid','资金流水分页重复或缺失。');continuation=data.continuation;seen.add(continuation);
    }if(!complete)stop('pagination_limit','资金流水超过完整核验上限。');if(finish===end)break;start=finish;}
    return [...logs.values()];
  }
  async function settle(plan){
    const final=await marketProvider.settlement({symbol:plan.symbol,expiry:plan.expiry,indexName:plan.spec.price_index});
    if(final?.final!==true||final.symbol!==plan.symbol||final.expiry!==plan.expiry||final.indexName!=='btc_usdc'||!fresh(final.checkedAt,now())||u(final.price)<=0n)stop('settlement_pending','官方最终交割价尚未核验。');
    const rows=await ledger(plan),future=plan.symbol.split('-').slice(0,2).join('-'),q=u(plan.filledQty),K=u(plan.strike),price=u(final.price),itm=price<K;
    const option=rows.filter(r=>r.instrument_name===plan.symbol&&r.timestamp>=plan.expiry&&r.type===(itm?'assignment':'expiry'));
    const delivered=rows.filter(r=>r.instrument_name===future&&r.timestamp>=plan.expiry&&r.type==='delivery');
    const created=rows.filter(r=>r.instrument_name===future&&r.timestamp>=plan.expiry&&r.type==='future creation');
    if(option.length!==1||u(option[0].amount)!==q||u(option[0].position,true)!==0n||itm&&(delivered.length!==1||u(delivered[0].amount)!==q||u(delivered[0].position,true)!==0n||!eq(delivered[0].settlement_price,final.price)))stop('settlement_pending','期权指派和对应期货最终交割尚未形成唯一完整链。');
    if(created.length>1||created.length===1&&(!itm||u(created[0].amount)!==q||abs(u(created[0].position,true))!==q)||!itm&&delivered.length)stop('settlement_mismatch','出现多余或数量不符的到期期货交割。');
    const tradeIds=new Set(plan.fills.map(r=>r.trade_id));let fees=0n,deliveryChange=0n,allChange=0n;
    for(const row of rows){const change=u(row.change,true);allChange+=change;
      if(row.type==='trade'&&row.instrument_name===plan.symbol&&tradeIds.has(row.trade_id)&&row.order_id===plan.fills[0].order_id)continue;
      const optionEvent=row.instrument_name===plan.symbol&&row.timestamp>=plan.expiry&&['assignment','expiry'].includes(row.type),futureEvent=row.instrument_name===future&&row.timestamp>=plan.expiry&&['future creation','delivery'].includes(row.type);
      if(optionEvent||futureEvent){fees+=u(row.commission,true);deliveryChange+=change;continue;}
      // A flat zero-change session marker is harmless. Every other activity stops automation.
      if(row.type==='settlement'&&change===0n&&u(row.position,true)===0n&&u(row.commission,true)===0n)continue;
      stop('ledger_not_isolated','存在本策略以外或无法归属的资金流水，停止自动接币。');
    }
    const payout=itm?mul(q,K-price):0n;if(fees<0n||!eq(t(deliveryChange),t(-payout-fees)))stop('settlement_cash_mismatch','最终期货现金损益或交割费用无法核对。');
    const delta=u(plan.gross)-u(plan.openFee)-payout-fees;if(!eq(t(allChange),t(delta)))stop('ledger_cash_mismatch','完整资金流水与实际成交及交割金额不一致。');
    const evidence=await account({flat:true}),expected=u(plan.baselineWalletCash)+delta,strategy=u(plan.amount)+delta;
    if(strategy<0n||!eq(t(evidence.cash.balance),t(expected))||evidence.cash.available<strategy)stop('settlement_cash_mismatch','最终 USDC 钱包与完整现金流水尚未一致。');
    const key=createHash('sha256').update(JSON.stringify({logs:rows.sort((a,b)=>a.id-b.id),balance:t(evidence.cash.balance),strategy:t(strategy),price:t(price)})).digest('hex'),old=journal.get(plan.id),observation=old.settlementObservation;
    if(observation?.key!==key||now()-observation.checkedAt<1000){if(observation?.key!==key)patch(old,{phase:'settlement_pending',settlementObservation:{key,checkedAt:now()}});return journal.get(plan.id);}
    const deadline=plan.expiry+300000,phase=price>K?'complete_cash':now()>=deadline?'needs_attention':'spot_ready';
    return patch(old,{phase,closed:phase==='complete_cash',settlement:{account:accountLabel,currency:'USDC',symbol:plan.symbol,futureSymbol:itm?future:null,price:t(price),filledQty:t(q),deliveryFee:t(fees),deliveryTime:plan.expiry,checkedAt:now(),final:true,twoObservations:true,ledgerIds:rows.map(r=>r.id),ledgerHash:key},strategyCash:t(strategy),spotDeadline:deadline,settlementObservation:null});
  }
  async function buy(plan){
    if(plan.automationPaused===true||now()>=plan.spotDeadline)return plan;unlocked();
    const quote=await marketProvider.spot();specCheck(quote?.spec,true);if(!fresh(quote.time,now())||u(quote.ask)<=0n)stop('spot_quote_invalid','现货报价已经失效。');
    const evidence=await account({flat:true}),spotRate=feeFor(evidence.cash.row,quote.spec),rawCap=mul(u(plan.settlement.price),S+u(plan.buyBufferRate)),step=u(quote.spec.min_trade_amount),cash=u(plan.strategyCash);let price=rawCap/tickAt(quote.spec,rawCap)*tickAt(quote.spec,rawCap);price=price/tickAt(quote.spec,price)*tickAt(quote.spec,price);
    if(step<=0n||price<=0n||u(quote.ask)>price)stop('spot_price_or_quantity','现货价格超过接币上限，或数量不符合官方步长。');
    // Absence means a previously authorized fixed-quantity plan. Never migrate
    // existing holdings to a larger all-cash purchase without a new confirmation.
    const mode=plan.spotBudgetMode??'fixed_quantity';if(!['remaining_strategy_cash','fixed_quantity'].includes(mode))stop('spot_budget_mode','原计划的现货资金授权无法识别，停止自动接币。');
    const q=mode==='remaining_strategy_cash'?affordableSpotQuantity(cash,price,spotRate,step):u(plan.filledQty);
    if(q<step||q%step!==0n)stop('spot_price_or_quantity','本笔结算余款不足最小现货数量，或原计划数量不符合步长。');
    const cost=up(q,price),fee=up(cost,spotRate);if(cost+fee>cash||evidence.cash.available<cash)stop('spot_budget','当前实际可用现金无法覆盖限价及真实现货费用。');
    // Last read-phase gate: a concurrent pause or unknown lock must win before POST.
    const current=journal.get(plan.id);if(current.automationPaused===true||now()>=current.spotDeadline)return current;unlocked();
    const order={instrument_name:'BTC_USDC',amount:t(q),price:t(price),label:plan.id+'_s'},authorization=authFor(plan,order,quote.spec,true,t(fee));
    let saved=patch(current,{phase:'spot_submitting',spotOrder:order,spotCashCap:t(cash),spotFeeReserve:t(fee),spotPlannedQty:t(q),spotLimitNotional:t(cost),spotAppliedFeeRate:t(spotRate),spotSpec:quote.spec});
    authorization.beforeSubmit=()=>{const latest=journal.get(plan.id);return latest?.phase==='spot_submitting'&&latest.spotOrder?.label===order.label&&latest.automationPaused!==true&&now()<latest.spotDeadline&&fresh(evidence.checkedAt,now(),15000)&&api().getExecutionState().reconciliationRequired===false;};
    try{const response=await api().createSpotBuy(clone(order),authorization);saved=patch(journal.get(plan.id),{phase:response?.ok===true?'spot_reconciling':response?.error?.unknown===true?'spot_unknown':'needs_attention'});}catch{saved=patch(journal.get(plan.id),{phase:'spot_unknown'});}return saved;
  }
  async function tick(){return serial(async()=>{
    if(!liveEnabled)return {running:false,reason:'真实执行尚未配置。'};api();const outcomes=[];
    for(let plan of active()){
      try{
        if(['put_submitting','put_reconciling','unknown'].includes(plan.phase))plan=await reconcile(plan);
        else if(['spot_submitting','spot_reconciling','spot_unknown'].includes(plan.phase))plan=await reconcile(plan,true);
        if(api().getExecutionState().reconciliationRequired===true)continue;
        if(plan.phase==='holding'&&now()<plan.expiry){const evidence=await account({plan}),held=evidence.positions.filter(pos=>pos.instrument_name===plan.symbol&&u(pos.size,true)!==0n);if(held.length!==1||held[0].direction!=='sell'||abs(u(held[0].size,true))!==u(plan.filledQty)){plan=patch(journal.get(plan.id),{phase:'needs_attention',reason:'实际 PUT 持仓与已对账成交不一致，停止自动接币。'});}}
        if(['holding','settlement_pending'].includes(plan.phase)&&now()>=plan.expiry)plan=await settle(plan);
        if(plan.phase==='spot_ready'&&now()>=plan.spotDeadline)plan=patch(journal.get(plan.id),{phase:'needs_attention',reason:'超过交割后五分钟，保留现金并等待人工处理。'});
        else if(plan.phase==='spot_ready'&&plan.automationPaused!==true)plan=await buy(plan);
        outcomes.push({id:plan.id,phase:plan.phase});
      }catch(error){const current=journal.get(plan.id);if(current&&!current.closed)patch(current,{lastError:fail(error),...(['holding','settlement_pending'].includes(current.phase)?{settlementObservation:null}:{})});outcomes.push({id:plan.id,...fail(error)});}
    }
    lastTick=now();return {running:true,checkedAt:lastTick,outcomes};
  });}
  function pause({id}={}){const p=journal.get(id);if(!p||p.account!==accountLabel)stop('plan_missing','没有该账户的执行记录。');return patch(p,{automationPaused:true,pauseNotice:'仅停止后续自动买币；不会平仓、撤回已成交 PUT 或释放已承诺备资。'});}
  async function status(){
    const base={platform:'deribit',currency:'USDC',environment:marketProvider.environment||'unknown',account:accountLabel,liveEnabled,connected:false,accountVerified:false,canSubmit:false,runnerOnline:false};
    if(!liveEnabled||typeof exchangeFactory!=='function')return {...base,status:'not_configured',reason:'真实执行尚未配置。'};
    try{const plans=active(),evidence=await account({plan:plans[0]||null});const runnerOnline=fresh(lastTick,now(),15000),clear=api().getExecutionState().reconciliationRequired===false;return {...base,status:clear?'ready':'reconciliation_pending',connected:true,accountVerified:true,checkedAt:evidence.checkedAt,availableFunds:t(evidence.cash.available),runnerOnline,canSubmit:runnerOnline&&clear&&!plans.length&&evidence.cash.available>0n,reason:plans.length?'本账户已有执行计划。':!clear?'未知订单仍待核对。':!runnerOnline?'本机执行器没有新鲜心跳。':'账户已核验，等待准备并明确确认。'};}catch(error){return {...base,status:'unavailable',...fail(error)};}
  }
  return {status,prepare,confirm,list:()=>clone(journal.list().filter(p=>p.account===accountLabel)),tick,pause};
}

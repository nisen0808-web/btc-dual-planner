import {randomUUID,createHash} from 'node:crypto';
import {units as u,decimal as t,SCALE as S,multiply as mul,multiplyUp as up,closeMoney as equal,fresh,optionSymbol,isId} from './binance-decimal.mjs';
import {BINANCE_FEE_POLICY} from './binance-market.mjs';

const TTL=30000,FINAL=new Set(['FILLED','CANCELED','CANCELLED','EXPIRED','REJECTED','EXERCISED']),clone=value=>JSON.parse(JSON.stringify(value));
class ExecutionError extends Error{constructor(code,message){super(message);this.code=code;}}
const stop=(code,message)=>{throw new ExecutionError(code,message);};
const failure=error=>error instanceof ExecutionError?{code:error.code,reason:error.message}:{code:'evidence_unavailable',reason:'Binance 实际账户、成交或结算证据未完整核验，操作已停止。'};
const result=value=>{if(value?.ok!==true||value.data==null)stop(value?.error?.code||'exchange_unavailable',value?.error?.message||'交易所读取尚未通过核验。');return value.data;};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const positive=v=>u(v)>0n;
const absolute=v=>v<0n?-v:v;
function specCheck(spec,spot=false){
  if(spec?.validated!==true||spec.status!=='TRADING'||(spot?spec.symbol!=='BTCUSDT':!optionSymbol(spec.symbol))||!positive(spec.tickSize)||!positive(spec.stepSize)||!positive(spec.minQty)||!positive(spec.maxQty))stop('spec_unverified','官方交易规格或可交易状态不完整。');
  if(spot){if(spec.baseAsset!=='BTC'||spec.quoteAsset!=='USDT'||!positive(spec.minNotional))stop('spot_spec_unverified','现货 BTC/USDT 官方交易规则未核验。');}
  else if(spec.side!=='PUT'||spec.underlying!=='BTCUSDT'||spec.quoteAsset!=='USDT'||spec.settleAsset!=='USDT'||spec.unit!==1||!positive(spec.strikePrice)||!Number.isSafeInteger(spec.expiryDate))stop('spec_unverified','仅支持 BTC/USDT 单位为 1 BTC 的现金结算 PUT。');
}
function sellPermission(spec){if(spec.nakedSell===false)stop('sell_not_allowed','官方合约明确不允许卖出开仓。');if(spec.sellPermission?.allowed!==true||spec.sellPermission.underlying!=='BTCUSDT'||!['symbol','underlying'].includes(spec.sellPermission.scope))stop('sell_permission_unverified','官方合约及对应 BTCUSDT 底层的卖出开仓许可未完整返回，不能核验 SELL 资格。');}
function affordable(cash,price,fee,step,max){let low=0n,high=cash*S/(step*price);if(high>max/step)high=max/step;while(low<high){const mid=(low+high+1n)/2n,cost=up(mid*step,price);if(cost+up(cost,fee)<=cash)low=mid;else high=mid-1n;}return low*step;}

/** One dedicated account, full cash collateral, no cross-exchange operation.
 * No write is retried. Every write-ahead journal phase survives process restart.
 * User's opening confirmation freezes cash-vs-BTC mode and all-cash BTC authority. */
export function createBinanceExecutionService({journal,exchangeFactory,marketProvider,liveEnabled=false,accountLabel='binance-dedicated-usdt',now=Date.now}={}){
  if(!journal||!['get','list','create','update'].every(key=>typeof journal[key]==='function')||!marketProvider||!['prepare','spot','settlement'].every(key=>typeof marketProvider[key]==='function')||typeof now!=='function'||typeof liveEnabled!=='boolean'||!isId(accountLabel))throw Error('Invalid Binance execution configuration');
  const drafts=new Map();let exchange=null,lastTick=null,queue=Promise.resolve();
  const serial=fn=>{const pending=queue.then(fn,fn);queue=pending.catch(()=>{});return pending;};
  const plans=()=>journal.list().filter(p=>p.account===accountLabel&&p.platform==='binance');
  const active=()=>plans().filter(p=>!p.closed);
  const patch=(plan,change,event)=>journal.update(plan.id,plan.version,change,event);
  function api(){if(!liveEnabled||typeof exchangeFactory!=='function')stop('not_configured','Binance 交易账户尚未配置。');if(!exchange)exchange=exchangeFactory({accountLabel,liveEnabled:true});if(!exchange||!['getAccountEvidence','getOptionOrder','getOptionTrades','getBills','getExerciseRecords','getSpotOrder','getSpotTrades','getTransferHistory','createSellPut','transferToSpot','createSpotBuy','getExecutionState','acknowledgeReconciled'].every(key=>typeof exchange[key]==='function')||exchange.getExecutionState()?.finalGateSupported!==true)stop('adapter_incomplete','Binance 期权、结算、同账户划转及现货接口未完整接通。');return exchange;}
  const unlocked=()=>{if(api().getExecutionState()?.reconciliationRequired!==false)stop('unknown_operation','已有未知写入待核对，禁止提交任何新操作。');};
  async function account({plan=null,flat=false,mode='buy_btc'}={}){
    const e=result(await api().getAccountEvidence()),r=e.restriction;
    if(!fresh(e.checkedAt,now(),15000)||typeof e.uid!=='string'||!/^\d{1,30}$/.test(e.uid)||e.spot?.uid!==e.uid)stop('identity_unverified','真实 Binance UID 或账户复核时间无法核验。');
    if(r?.ipRestrict!==true||r.enableReading!==true||r.enableVanillaOptions!==true||r.enableWithdrawals!==false||r.enableMargin!==false||r.enableFutures!==false||r.enablePortfolioMarginTrading!==false||r.enableFixApiTrade!==false)stop('permission_invalid','需要限制本机 IP 的读取和期权交易权限，关闭提现、杠杆、合约及组合保证金权限。');
    const buyPermission=r.enableSpotAndMarginTrading===true&&r.enableInternalTransfer===true&&r.permitsUniversalTransfer===true;
    if(mode==='buy_btc'&&!buyPermission)stop('permission_invalid','自动买 BTC 还需要现货交易及同账户内部划转权限；仅现金结算不需要这些权限。');
    if(e.info?.isOptionsEnabled!==true||e.info.isPortfolioMarginRetailEnabled!==false||e.trading?.isLocked!==false||e.option?.canTrade!==true||e.option.reduceOnly!==false||e.spot?.accountType!=='SPOT'||e.spot.canTrade!==true)stop('account_restricted','期权尚未开通、账户仅可减仓、API 被锁或账户模式不支持。');
    if(plans().some(p=>p.accountId!==e.uid))stop('account_changed','当前 Binance UID 与本机已有策略记录不一致。');
    const options=e.option.asset;if(!Array.isArray(options)||!Array.isArray(e.positions)||!Array.isArray(e.optionOrders)||!Array.isArray(e.spotOrders)||!Array.isArray(e.spot.balances))stop('account_incomplete','完整钱包、持仓或所有挂单未返回。');
    let cash=null;const assets=new Set();for(const row of options){if(typeof row.asset!=='string'||assets.has(row.asset))stop('wallet_invalid','期权钱包币种重复或缺失。');assets.add(row.asset);const fields=['marginBalance','equity','available','initialMargin','maintMargin','unrealizedPNL'];for(const field of fields)u(row[field],true);if(row.asset!=='USDT'&&fields.some(k=>u(row[k],true)!==0n))stop('wallet_not_isolated','期权专用账户存在其他币种资产或占用。');if(row.asset==='USDT')cash={balance:u(row.marginBalance),equity:u(row.equity,true),available:u(row.available),initial:u(row.initialMargin),maintenance:u(row.maintMargin),unrealized:u(row.unrealizedPNL,true)};}
    if(!cash)stop('wallet_invalid','USDT 期权钱包缺失。');
    for(const position of e.positions){const q=u(position.quantity,true);if(q===0n)continue;if(flat||!plan||position.symbol!==plan.symbol||position.side!=='SHORT'||q>=0n||absolute(q)>u(plan.filledQty??plan.q))stop('other_position','专用账户存在未归属本笔策略的实际持仓。');}
    for(const order of [...e.optionOrders,...e.spotOrders]){if(FINAL.has(order.status))continue;if(!plan||flat||![plan.orderPayload.clientOrderId,plan.spotOrder?.newClientOrderId].includes(order.clientOrderId))stop('other_order','专用账户存在其他未结束委托。');}
    let spotCash=0n,btc=0n;const seen=new Set();for(const row of e.spot.balances){if(typeof row.asset!=='string'||seen.has(row.asset))stop('spot_wallet_invalid','现货币种重复或缺失。');seen.add(row.asset);const free=u(row.free),locked=u(row.locked);if(locked!==0n)stop('spot_wallet_locked','现货钱包仍有其他资金锁定。');if(row.asset==='USDT')spotCash=free;else if(row.asset==='BTC')btc=free;else if(free!==0n)stop('wallet_not_isolated','专用现货钱包存在其他币种资产；本版本不使用外部费用资产。');}
    const knownBTC=plans().reduce((sum,p)=>sum+u(p.receivedBTC??'0'),0n);if(btc!==knownBTC)stop('btc_not_isolated','BTC 钱包与本工具已核对成交不一致。');
    if(flat&&(cash.balance!==cash.equity||cash.balance!==cash.available||cash.initial!==0n||cash.maintenance!==0n||cash.unrealized!==0n))stop('cash_unsettled','期权现金、权益和可用余额未结清。');
    if(e.optionFee?.underlying!=='BTCUSDT'||u(e.optionFee.takerFee)>=S||u(e.spotFee?.takerBuyRate)>=S)stop('fee_unverified','账户真实期权或现货费率缺失。');
    if(mode==='buy_btc'&&e.spotFee.discountEnabled!==false)stop('fee_currency_unverified','请在专用账户关闭 BNB 抵扣；本版本仅核对 BTC/USDT 费用。');
    const buyBTCCapable=buyPermission&&e.spotFee.discountEnabled===false;
    const buyBTCReason=!buyPermission?'自动买 BTC 需要现货交易及同账户内部划转权限；现金结算可用。':e.spotFee.discountEnabled!==false?'自动买 BTC 需要关闭 BNB 抵扣；现金结算可用。':'';
    return {uid:e.uid,cash,spotCash,btc,positions:e.positions,optionRate:u(e.optionFee.takerFee),spotRate:u(e.spotFee.takerBuyRate),buyBTCCapable,buyBTCReason,checkedAt:e.checkedAt};
  }
  async function prepare(input){
    if(!input||Object.keys(input).some(k=>!['amount','symbol','buyBufferRate','settlementMode'].includes(k))||!optionSymbol(input.symbol)||!['cash','buy_btc'].includes(input.settlementMode))stop('prepare_invalid','请选择真实 BTC PUT、当次资金及到期处理方式。');
    const amount=t(u(input.amount)),A=u(amount),buffer=u(input.buyBufferRate??'0.005');if(A<=0n||buffer>u('0.05'))stop('prepare_invalid','资金或现货价格保护幅度无效。');
    const data=await marketProvider.prepare(input),{spec,spotSpec,book,market}=data||{};specCheck(spec);specCheck(spotSpec,true);
    if(spec.symbol!==input.symbol||spec.expiryDate<=now()||market?.platform!=='binance'||market.currency!=='USDT'||!fresh(market.time,now())||!fresh(book?.time,now())||!Array.isArray(book.bids)||!positive(market.spot))stop('quote_unverified','真实合约、指数或买盘报价已失效。');
    let optionRate=u(BINANCE_FEE_POLICY.optionTakerRate),spotRate=u(BINANCE_FEE_POLICY.spotReferenceRate),evidence=null;
    if(liveEnabled){evidence=await account({flat:true,mode:input.settlementMode});sellPermission(spec);optionRate=evidence.optionRate;spotRate=evidence.spotRate;}
    const step=u(spec.stepSize),K=u(spec.strikePrice),index=u(market.spot),cap=u(BINANCE_FEE_POLICY.optionFeeCap),delivery=u(BINANCE_FEE_POLICY.deliveryReserveRate),buying=input.settlementMode==='buy_btc';
    const rows=book.bids.map(row=>({price:u(row.price),qty:u(row.qty)})).sort((a,b)=>a.price>b.price?-1:a.price<b.price?1:0);
    for(const row of rows)if(row.price<=0n||row.qty<=0n||row.price%u(spec.tickSize))stop('depth_invalid','真实买盘数量或价格步长不符合合约规则。');
    if(!rows.length)stop('depth_insufficient','当前真实买盘为空。');
    const fraction=buying?spotRate:0n,minimum=(u(spec.minQty)+step-1n)/step,maximumByFunds=(A*S/K)/step,maximum=maximumByFunds<u(spec.maxQty)/step?maximumByFunds:u(spec.maxQty)/step;
    if(maximum<minimum)stop('funding_shortfall','资金不足以全额覆盖最小 PUT 数量及对应费用。');
    function evaluate(count){
      const q=count*step;let remaining=q,gross=0n,openFee=0n,limit=0n;
      for(const row of rows){const take=remaining<row.qty?remaining:row.qty,fill=mul(take,row.price),nominal=up(up(take,index),optionRate),capped=up(fill,cap);gross+=fill;openFee+=nominal<capped?nominal:capped;remaining-=take;limit=row.price;if(remaining===0n)break;}
      if(remaining!==0n)return null;
      const capital=up(q,K),exercise=up(capital,delivery),spotReserve=up(A+gross,fraction),total=capital+openFee+exercise+spotReserve;
      return {q,gross,openFee,limit,capital,opening:openFee,exercise,buyBuffer:0n,spotReserve,total};
    }
    // Same conservative initial sizing as the public desk. The exact fee cap
    // can release a further increment; every additional increment is re-priced.
    const perCoinUpper=K+up(index,optionRate)+up(K,delivery)+up(rows[0].price,fraction);
    let count=(mul(A,S-fraction)*S/perCoinUpper)/step;if(count<minimum)count=minimum;if(count>maximum)count=maximum;
    let reserve=evaluate(count);if(!reserve)stop('depth_insufficient','从买一向下的真实可见深度不足以覆盖本次计划数量。');
    if(reserve.total>A)stop('funding_shortfall','资金不足以全额覆盖最小 PUT 数量及对应费用。');
    if(count<maximum){const next=evaluate(count+1n);if(next&&next.total<=A){count++;reserve=next;}}
    const {q,gross,openFee,limit}=reserve;
    if(!fresh(book.time,now())||!fresh(market.time,now()))stop('quote_stale','账户核对期间报价已失效，请重新准备。');
    // Leave room for the spot suffix under Binance's 36-character client ID cap.
    const id='bp_'+randomUUID().replaceAll('-','').slice(0,28),createdAt=now(),orderPayload={symbol:input.symbol,side:'SELL',type:'LIMIT',timeInForce:'IOC',quantity:t(q),price:t(limit),reduceOnly:false,postOnly:false,newOrderRespType:'RESULT',clientOrderId:id};
    const intent={id,account:accountLabel,accountId:evidence?.uid??null,platform:'binance',currency:'USDT',environment:'mainnet',symbol:input.symbol,amount,strike:t(K),expiry:spec.expiryDate,q:t(q),capital:t(reserve.capital),fullFundReserve:t(reserve.total),feeReserve:t(reserve.opening+reserve.exercise+reserve.spotReserve),openingFeeReserve:t(reserve.opening),deliveryFeeReserve:t(reserve.exercise),spotFeeReserve:t(reserve.spotReserve),freeCash:t(A-reserve.total),buyBufferRate:t(buffer),buyBufferReserve:t(reserve.buyBuffer),limitPrice:t(limit),estimatedGross:t(gross),estimatedOpenFee:t(openFee),estimatedNetIncome:t(gross-openFee),optionTakerRate:t(optionRate),spotTakerRate:t(spotRate),settlementMode:input.settlementMode,spotBudgetMode:'remaining_strategy_cash',createdAt,expiresAt:Math.min(createdAt+TTL,book.time+TTL,market.time+TTL,spec.expiryDate),orderPayload,payloadReady:true,valid:true,canSubmit:false,fundsLocked:false,automationPaused:false,sellPermission:spec.sellPermission,feePolicy:BINANCE_FEE_POLICY};
    intent.fingerprint=hash(intent);for(const [key,draft]of drafts)if(draft.intent.expiresAt<=now())drafts.delete(key);if(drafts.size>=100)stop('draft_limit','未确认草案过多。');drafts.set(id,{intent:clone(intent),spec:clone(spec),spotSpec:clone(spotSpec)});return clone(intent);
  }
  function authorization(plan,evidence,{kind,expiresAt,maxFunds,feeReserve,spec,payload}={}){
    return {confirmed:true,account:accountLabel,accountId:plan.accountId,currency:'USDT',checkedAt:evidence.checkedAt,expiresAt:Math.min(now()+TTL,expiresAt),intentId:kind==='transfer'?plan.id+'_t':kind==='spot'?plan.id+'_s':plan.id,maxFunds,feeReserve,spec,payloadHash:hash(payload),beforeSubmit:()=>{const latest=journal.get(plan.id);return !!latest&&latest.accountId===plan.accountId&&latest.fingerprint===plan.fingerprint&&latest.automationPaused!==true&&latest.phase===({put:'put_submitting',transfer:'transfer_submitting',spot:'spot_submitting'})[kind]&&now()<expiresAt&&fresh(evidence.checkedAt,now(),15000)&&api().getExecutionState().reconciliationRequired===false;}};
  }
  async function confirm(input){return serial(async()=>{
    if(!liveEnabled)stop('not_configured','Binance 真实交易尚未配置。');
    if(!input||Object.keys(input).some(k=>!['id','fingerprint','account','currency','confirmed'].includes(k))||input.confirmed!==true||input.account!==accountLabel||input.currency!=='USDT')stop('confirmation_invalid','确认必须绑定本机账户、USDT 及完整服务器草案。');
    const old=journal.get(input.id);if(old){if(old.fingerprint!==input.fingerprint||old.account!==input.account||old.platform!=='binance')stop('confirmation_invalid','确认内容与已有记录不一致。');return old;}
    const draft=drafts.get(input.id);if(!draft||draft.intent.fingerprint!==input.fingerprint||draft.intent.expiresAt<=now())stop('confirmation_expired','报价或到期方式已改变，请重新准备并确认。');
    if(!fresh(lastTick,now(),15000))stop('runner_offline','本机执行器没有新鲜心跳。');unlocked();if(active().length)stop('active_plan','专用账户已有未结束策略。');
    const p=draft.intent,e=await account({flat:true,mode:p.settlementMode});sellPermission(draft.spec);if(e.uid!==p.accountId||e.cash.balance<u(p.amount)||e.cash.available<u(p.amount)||u(p.fullFundReserve)>u(p.amount))stop('funding_shortfall','账户身份或实际 USDT 全额备资不足。');
    if(e.optionRate>u(p.optionTakerRate)||p.settlementMode==='buy_btc'&&e.spotRate>u(p.spotTakerRate))stop('fee_changed','账户费率改变，请重新准备。');if(now()>=p.expiresAt)stop('confirmation_expired','账户核验期间报价已失效。');unlocked();
    let saved=journal.create({...clone(p),phase:'put_submitting',closed:false,fundsLocked:true,baselineOptionCash:t(e.cash.balance),baselineSpotCash:t(e.spotCash),baselineBTC:t(e.btc),spec:draft.spec,spotSpec:draft.spotSpec,confirmedAt:now()});drafts.delete(p.id);
    const auth=authorization(saved,e,{kind:'put',expiresAt:p.expiresAt,maxFunds:p.amount,feeReserve:t(u(p.fullFundReserve)-u(p.capital)),spec:draft.spec,payload:saved.orderPayload});
    try{const response=await api().createSellPut(clone(saved.orderPayload),auth);saved=patch(journal.get(p.id),{phase:response?.ok===true?'put_reconciling':response?.error?.unknown?'put_unknown':'needs_attention',...(response?.ok===true?{putAcknowledgement:response.data}:{reason:response?.error?.message||'提交未获确认，请核对。'})});}catch{saved=patch(journal.get(p.id),{phase:'put_unknown'});}return saved;
  });}
  async function reconcilePut(plan){
    const order=result(await api().getOptionOrder({symbol:plan.symbol,clientOrderId:plan.orderPayload.clientOrderId}));
    if(order.symbol!==plan.symbol||order.clientOrderId!==plan.orderPayload.clientOrderId||order.side!=='SELL'||order.type!=='LIMIT'||order.timeInForce!=='IOC'||u(order.quantity)!==u(plan.q)||u(order.price)!==u(plan.limitPrice)||u(order.executedQty)>u(plan.q))stop('order_mismatch','实际 PUT 委托与原始确认不一致。');
    if(!FINAL.has(order.status))return plan;
    const rows=result(await api().getOptionTrades({symbol:plan.symbol,startTime:plan.confirmedAt,endTime:now()}));if(!Array.isArray(rows)||rows.length>=1000)stop('trades_incomplete','实际成交未完整返回。');
    let qty=0n,gross=0n,fee=0n;const ids=new Set();for(const row of rows){if(ids.has(row.tradeId)||row.orderId!==order.orderId||row.symbol!==plan.symbol||row.side!=='SELL'||row.quoteAsset!=='USDT'||u(row.realizedProfit,true)!==0n||row.time<plan.confirmedAt)stop('other_trade','真实成交包含其他交易或无法归属的盈亏。');ids.add(row.tradeId);const q=u(row.quantity),p=u(row.price);if(q<=0n||p<u(plan.limitPrice))stop('trade_invalid','实际成交数量或价格不符合已确认限价。');qty+=q;gross+=mul(q,p);fee-=u(row.fee,true);}
    if(qty!==u(order.executedQty)||qty>u(plan.q))stop('fill_mismatch','委托成交数量与逐笔成交不一致。');api().acknowledgeReconciled({kind:'put',clientOrderId:plan.orderPayload.clientOrderId});
    return patch(journal.get(plan.id),{phase:qty===0n?'complete_unfilled':'holding',closed:qty===0n,fundsLocked:qty>0n,putOrder:order,filledQty:t(qty),gross:t(gross),openFee:t(fee),netPremium:t(gross-fee),putTradeIds:[...ids],partialPut:qty>0n&&qty<u(plan.q)},plan.id+'_put_reconciled');
  }
  async function settle(plan){
    const official=await marketProvider.settlement({symbol:plan.symbol,expiry:plan.expiry});if(official?.final!==true||official.symbol!==plan.symbol||official.expiry!==plan.expiry||!fresh(official.checkedAt,now())||u(official.strikePrice)!==u(plan.strike)||!positive(official.price))stop('settlement_pending','官方最终结算价尚未核验。');
    const [bills,records]=await Promise.all([api().getBills({startTime:plan.confirmedAt,endTime:now()}),api().getExerciseRecords({symbol:plan.symbol,startTime:plan.expiry,endTime:now()})]).then(rows=>rows.map(result));
    if(!Array.isArray(bills)||bills.length>=1000||!Array.isArray(records)||records.length>=1000)stop('ledger_incomplete','到期实际流水未完整返回。');
    const K=u(plan.strike),price=u(official.price),q=u(plan.filledQty),loss=price<K?mul(q,K-price):0n;let contractCash=0n,openFees=0n,exercisePNL=0n,delivery=0n,total=0n;const ids=new Set();
    for(const row of bills){if(ids.has(row.id)||row.asset!=='USDT'||row.symbol!==plan.symbol||row.createDate<plan.confirmedAt||row.createDate>now())stop('ledger_not_isolated','存在外部入金、划转或无法归属本笔策略的资金变化。');ids.add(row.id);const cash=u(row.amount,true);total+=cash;if(row.type==='CONTRACT')contractCash+=cash;else if(row.type==='FEE')openFees-=cash;else if(row.type==='EXERCISE_PNL')exercisePNL+=cash;else if(row.type==='EXERCISE_FEE')delivery-=cash;else stop('ledger_type_unknown','资金流水出现未经支持的类型，停止自动接币。');}
    if(!equal(t(contractCash),plan.gross)||!equal(t(openFees),plan.openFee)||!equal(t(exercisePNL),t(-loss))||delivery<0n||!equal(t(total),t(u(plan.gross)-u(plan.openFee)-loss-delivery)))stop('ledger_mismatch','权利金、开仓费、行权损失及交割费未逐项对平。');
    let recordQty=0n,recordPNL=0n,recordFee=0n;const recordIds=new Set();for(const row of records){if(recordIds.has(row.id)||row.symbol!==plan.symbol||row.currency!=='USDT'||row.positionSide!=='SHORT'||row.optionSide!=='PUT'||row.quoteAsset!=='USDT'||row.createDate<plan.expiry)stop('exercise_mismatch','行权记录身份或方向未通过核验。');recordIds.add(row.id);recordQty+=absolute(u(row.quantity,true));recordPNL+=u(row.amount,true);recordFee+=absolute(u(row.fee,true));}
    if(loss>0n&&(recordQty!==q||!equal(t(recordPNL),t(-loss))||!equal(t(recordFee),t(delivery))))stop('exercise_pending','实际行权数量、现金损失或交割费尚未核对。');
    if(loss===0n&&(delivery!==0n||records.length&&(!equal(t(recordPNL),'0')||recordFee!==0n)))stop('exercise_mismatch','未发生损失时出现不符规则的结算费用。');
    const e=await account({flat:true,mode:plan.settlementMode}),strategy=u(plan.amount)+total,expected=u(plan.baselineOptionCash)+total;
    if(strategy<0n||!equal(t(e.cash.balance),t(expected))||e.cash.available<strategy||e.spotCash!==u(plan.baselineSpotCash))stop('wallet_mismatch','结算后钱包与本笔逐笔流水未对平，或发生了外部资金变化。');
    const key=hash({bills:[...bills].sort((a,b)=>a.id.localeCompare(b.id)),records:[...records].sort((a,b)=>a.id.localeCompare(b.id)),balance:t(e.cash.balance),price:t(price)}),old=journal.get(plan.id);
    if(old.settlementObservation?.key!==key){return patch(old,{phase:'settlement_pending',settlementObservation:{key,checkedAt:now()}});}
    if(now()-old.settlementObservation.checkedAt<1000)return old;
    const triggered=price<=K,cashMode=plan.settlementMode==='cash'||!triggered,deadline=plan.expiry+300000;
    return patch(old,{phase:cashMode?'complete_cash':now()>=deadline?'needs_attention':'transfer_ready',closed:cashMode,fundsLocked:!cashMode,strategyCash:t(strategy),settlementLoss:t(loss),deliveryFee:t(delivery),spotDeadline:deadline,settlementObservation:null,settlement:{price:t(price),symbol:plan.symbol,expiry:plan.expiry,triggered,final:true,twoObservations:true,checkedAt:now(),ledgerIds:[...ids],exerciseIds:[...recordIds],ledgerHash:key,deliveryFee:t(delivery)}});
  }
  async function transfer(plan){
    if(plan.settlementMode!=='buy_btc'||plan.spotBudgetMode!=='remaining_strategy_cash')stop('mode_invalid','原始确认不允许到期自动买币。');if(plan.automationPaused||now()>=plan.spotDeadline)return plan;unlocked();
    const e=await account({flat:true,mode:'buy_btc'}),amount=u(plan.strategyCash)/10000000000n*10000000000n;if(amount<=0n||e.cash.available<amount||!equal(t(e.cash.balance),t(u(plan.baselineOptionCash)+u(plan.gross)-u(plan.openFee)-u(plan.settlementLoss)-u(plan.deliveryFee)))||e.spotCash!==u(plan.baselineSpotCash))stop('transfer_budget','实际可划转余额与本笔结算余款不一致。');
    const current=journal.get(plan.id);if(current.automationPaused||now()>=current.spotDeadline)return current;
    const payload={type:'OPTION_MAIN',asset:'USDT',amount:t(amount)},auth=authorization(plan,e,{kind:'transfer',expiresAt:plan.spotDeadline,maxFunds:plan.strategyCash,feeReserve:'0',payload});let saved=patch(current,{phase:'transfer_submitting',transferPayload:payload,transferIntentId:plan.id+'_t',transferStartedAt:now(),transferRoundingDust:t(u(plan.strategyCash)-amount)});
    try{const response=await api().transferToSpot(payload,auth);saved=patch(journal.get(plan.id),{phase:response?.ok===true?'transfer_reconciling':response?.error?.unknown?'transfer_unknown':'needs_attention',...(response?.ok===true?{transferId:response.data.tranId}:{reason:response?.error?.message||'内部划转未确认。'})});}catch{saved=patch(journal.get(plan.id),{phase:'transfer_unknown'});}return saved;
  }
  async function reconcileTransfer(plan){
    // The universal transfer endpoint has NO client transaction ID. A timeout
    // without an acknowledged tranId can never be safely matched by amount/time.
    if(!plan.transferId)return patch(journal.get(plan.id),{phase:'transfer_unknown',reason:'内部划转结果未知且未返回交易所 tranId；禁止重发或凭金额猜测成功，需人工核对。'});
    const history=result(await api().getTransferHistory({startTime:plan.transferStartedAt-1000,endTime:now()}));const matching=history.rows.filter(row=>row.tranId===plan.transferId);
    if(matching.length!==1)stop('transfer_pending','实际划转流水尚未返回唯一 tranId。');const row=matching[0];if(row.type!=='OPTION_MAIN'||row.asset!=='USDT'||!equal(row.amount,plan.transferPayload.amount))stop('transfer_mismatch','内部划转方向或金额与原始计划不符。');if(row.status==='FAILED')return patch(journal.get(plan.id),{phase:'needs_attention',reason:'内部划转失败；未重新发送。'});if(row.status!=='CONFIRMED')return plan;
    if(history.rows.some(r=>r.tranId!==row.tranId))stop('other_transfer','内部划转窗口中出现其他划转，停止自动买币。');
    const e=await account({flat:true,mode:'buy_btc'}),baseline=u(plan.baselineOptionCash)+u(plan.gross)-u(plan.openFee)-u(plan.settlementLoss)-u(plan.deliveryFee),amount=u(plan.transferPayload.amount);
    if(!equal(t(e.cash.balance),t(baseline-amount))||!equal(t(e.spotCash),t(u(plan.baselineSpotCash)+amount)))stop('transfer_wallet_pending','两个钱包尚未与实际已确认划转对平。');
    api().acknowledgeReconciled({kind:'transfer',clientOrderId:plan.transferIntentId});return patch(journal.get(plan.id),{phase:'spot_ready',transferVerifiedAt:now(),transferredCash:plan.transferPayload.amount,transferReceipt:row});
  }
  async function buy(plan){
    if(plan.automationPaused||now()>=plan.spotDeadline)return plan;unlocked();const quote=await marketProvider.spot();specCheck(quote?.spec,true);if(!fresh(quote.time,now(),5000)||!positive(quote.ask)||!Array.isArray(quote.asks))stop('spot_quote_stale','现货真实卖盘不可用或已经失效。');
    const e=await account({flat:true,mode:'buy_btc'}),cash=u(plan.transferredCash),ask=u(quote.ask),cap=mul(u(plan.settlement.price),S+u(plan.buyBufferRate)),tick=u(quote.spec.tickSize),step=u(quote.spec.stepSize);
    if(ask>cap)stop('spot_price_limit','当前现货卖一超过已确认的交割价保护上限，保留本笔现金。');if(!equal(t(e.spotCash),t(u(plan.baselineSpotCash)+cash)))stop('spot_wallet_mismatch','现货钱包出现本笔以外的资金变化。');if(e.spotRate>u(plan.spotTakerRate))stop('fee_changed','现货实际费率高于开仓确认时的费率，保留现金。');
    // Start at ask1 and sweep visible asks only inside the confirmed protection.
    // Official Spot commission FAQ: a BUY with BNB disabled deducts its fee
    // from the received base quantity. Do not reserve that fee a second time in
    // USDT, otherwise this all-cash strategy would deliberately under-buy BTC.
    const asks=quote.asks.map(row=>({price:u(row.price),qty:u(row.qty)})).sort((a,b)=>a.price<b.price?-1:a.price>b.price?1:0);
    if(!asks.length||asks[0].price!==ask||asks.some(row=>row.price<=0n||row.qty<=0n||row.price%tick))stop('spot_depth_invalid','真实现货卖盘与价格步长无法核验。');
    let available=0n,selected=null,levelsUsed=0;for(const row of asks){if(row.price>cap)break;available+=row.qty;levelsUsed++;const qty=affordable(cash,row.price,0n,step,u(quote.spec.maxQty)),notional=up(qty,row.price);if(qty>=u(quote.spec.minQty)&&notional>=u(quote.spec.minNotional)&&available>=qty){selected={q:qty,price:row.price,cost:notional};break;}}
    if(!selected)stop('spot_depth_insufficient','从现货卖一向上的保护范围内深度不足以承接本笔余款，保留现金。');
    const {q,price,cost}=selected,feeBTC=up(q,e.spotRate);if(cost>cash||feeBTC>=q)stop('spot_minimum','现货限价上界及手续费超出本笔余款。');
    if(!fresh(quote.time,now(),5000))stop('spot_quote_stale','账户核对期间现货盘口已超过五秒，请等待下一次真实盘口。');
    const current=journal.get(plan.id);if(current.automationPaused||now()>=current.spotDeadline)return current;
    const payload={symbol:'BTCUSDT',side:'BUY',type:'LIMIT',timeInForce:'IOC',quantity:t(q),price:t(price),newClientOrderId:plan.id+'_s',newOrderRespType:'RESULT'},auth=authorization(plan,e,{kind:'spot',expiresAt:Math.min(plan.spotDeadline,quote.time+5000),maxFunds:plan.transferredCash,feeReserve:'0',spec:quote.spec,payload});let saved=patch(current,{phase:'spot_submitting',spotOrder:payload,spotStartedAt:now(),spotPlannedQty:t(q),spotFeeReserve:'0',spotEstimatedFeeBTC:t(feeBTC),spotFeeCurrency:'BTC',spotAppliedFeeRate:t(e.spotRate),spotLevelsUsed:levelsUsed,spotBestAsk:t(ask),spotProtectedPrice:t(cap)});
    try{const response=await api().createSpotBuy(payload,auth);saved=patch(journal.get(plan.id),{phase:response?.ok===true?'spot_reconciling':response?.error?.unknown?'spot_unknown':'needs_attention',...(response?.ok===true?{spotAcknowledgement:response.data}:{reason:response?.error?.message||'现货委托未确认。'})});}catch{saved=patch(journal.get(plan.id),{phase:'spot_unknown'});}return saved;
  }
  async function reconcileSpot(plan){
    const order=result(await api().getSpotOrder({clientOrderId:plan.spotOrder.newClientOrderId}));if(order.symbol!=='BTCUSDT'||order.clientOrderId!==plan.spotOrder.newClientOrderId||order.side!=='BUY'||order.type!=='LIMIT'||order.timeInForce!=='IOC'||u(order.origQty)!==u(plan.spotOrder.quantity)||u(order.price)!==u(plan.spotOrder.price)||u(order.executedQty)>u(order.origQty))stop('spot_order_mismatch','实际现货委托与已记录资金授权不一致。');if(!FINAL.has(order.status))return plan;
    const rows=result(await api().getSpotTrades({orderId:order.orderId,startTime:plan.spotStartedAt,endTime:now()}));if(!Array.isArray(rows)||rows.length>=1000)stop('spot_trades_incomplete','现货实际成交未完整返回。');let q=0n,cost=0n,baseFee=0n,cashFee=0n;const ids=new Set();for(const row of rows){if(ids.has(row.id)||row.orderId!==order.orderId||row.symbol!=='BTCUSDT'||row.isBuyer!==true||!['BTC','USDT'].includes(row.commissionAsset)||u(row.price)>u(plan.spotOrder.price))stop('spot_trade_mismatch','现货成交、手续费币种或价格未通过核验。');ids.add(row.id);q+=u(row.qty);cost+=u(row.quoteQty);if(row.commissionAsset==='BTC')baseFee+=u(row.commission);else cashFee+=u(row.commission);}
    if(q!==u(order.executedQty)||!equal(t(cost),order.cummulativeQuoteQty)||q<baseFee||cost+cashFee>u(plan.transferredCash))stop('spot_fill_mismatch','实际现货数量、成本及费用未对平。');
    const received=q-baseFee,remaining=u(plan.transferredCash)-cost-cashFee;
    // Read wallet directly here: account() intentionally rejects unjournaled BTC.
    const e=result(await api().getAccountEvidence());if(e.uid!==plan.accountId)stop('identity_changed','现货成交后账户 UID 改变。');const btc=e.spot.balances.find(r=>r.asset==='BTC'),cash=e.spot.balances.find(r=>r.asset==='USDT');if(!btc||!cash||u(btc.locked)!==0n||u(cash.locked)!==0n||!equal(btc.free,t(u(plan.baselineBTC)+received))||!equal(cash.free,t(u(plan.baselineSpotCash)+remaining)))stop('spot_wallet_pending','BTC 和 USDT 钱包尚未与逐笔现货成交对平。');
    api().acknowledgeReconciled({kind:'spot',clientOrderId:plan.spotOrder.newClientOrderId});const complete=q===u(plan.spotOrder.quantity);return patch(journal.get(plan.id),{phase:complete?'complete_btc':'needs_attention',closed:complete,fundsLocked:!complete,spotActualOrder:order,receivedBTC:t(received),spotCost:t(cost),spotFeeBTC:t(baseFee),spotFeeUSDT:t(cashFee),spotTradeIds:[...ids],remainingCash:t(remaining+u(plan.transferRoundingDust)),...(complete?{}:{reason:'现货 IOC 仅部分成交；保留已购 BTC 及剩余现金，不自动补单。'})},plan.id+'_spot_reconciled');
  }
  async function tick(){return serial(async()=>{
    if(!liveEnabled)return {running:false,reason:'Binance 交易尚未配置。'};api();const outcomes=[];
    for(let plan of active())try{
      if(['put_submitting','put_reconciling','put_unknown'].includes(plan.phase))plan=await reconcilePut(plan);
      else if(['transfer_submitting','transfer_reconciling','transfer_unknown'].includes(plan.phase))plan=await reconcileTransfer(plan);
      else if(['spot_submitting','spot_reconciling','spot_unknown'].includes(plan.phase))plan=await reconcileSpot(plan);
      if(['holding','settlement_pending'].includes(plan.phase)&&now()>=plan.expiry)plan=await settle(plan);
      else if(plan.phase==='holding'){const evidence=await account({plan,mode:plan.settlementMode}),held=evidence.positions.filter(row=>u(row.quantity,true)!==0n);if(held.length!==1||held[0].symbol!==plan.symbol||held[0].side!=='SHORT'||u(held[0].quantity,true)!==-u(plan.filledQty))stop('position_mismatch','真实 PUT 空仓与已核对实际成交数量不一致，停止到期自动买币。');}
      if(['transfer_ready','spot_ready'].includes(plan.phase)&&now()>=plan.spotDeadline)plan=patch(journal.get(plan.id),{phase:'needs_attention',reason:'超过到期后五分钟，保留本笔现金并停止买币。'});
      else if(plan.phase==='transfer_ready'&&!plan.automationPaused)plan=await transfer(plan);
      else if(plan.phase==='spot_ready'&&!plan.automationPaused)plan=await buy(plan);
      outcomes.push({id:plan.id,phase:plan.phase});
    }catch(error){const current=journal.get(plan.id);if(current&&!current.closed)patch(current,{lastError:failure(error),...(['holding','settlement_pending'].includes(current.phase)?{settlementObservation:null}:{})});outcomes.push({id:plan.id,...failure(error)});}
    lastTick=now();return {running:true,checkedAt:lastTick,outcomes};
  });}
  async function status(){const base={platform:'binance',currency:'USDT',environment:'mainnet',account:accountLabel,liveEnabled,connected:false,accountVerified:false,canSubmit:false,cashCanSubmit:false,buyBTCCanSubmit:false,runnerOnline:false};if(!liveEnabled||typeof exchangeFactory!=='function')return {...base,status:'not_configured',reason:'Binance 交易账户尚未配置；公开报价无需登录。'};
    try{const current=active(),e=await account({plan:current[0]??null,mode:'cash'}),runnerOnline=fresh(lastTick,now(),15000),clear=api().getExecutionState().reconciliationRequired===false,cashCanSubmit=runnerOnline&&clear&&!current.length&&e.cash.available>0n,reason=current.length?'本账户已有未结束策略。':!clear?'未知写入尚未核对。':!runnerOnline?'本机执行器没有新鲜心跳。':e.cash.available<=0n?'期权钱包没有可用 USDT。':'账户已核验；选择合约后还会核对官方卖出许可及实际费用。';return {...base,status:clear?'ready':'reconciliation_pending',connected:true,accountVerified:true,accountId:e.uid,availableFunds:t(e.cash.available),checkedAt:e.checkedAt,runnerOnline,canSubmit:cashCanSubmit,cashCanSubmit,buyBTCCanSubmit:cashCanSubmit&&e.buyBTCCapable,buyBTCReason:e.buyBTCReason||(!cashCanSubmit?reason:''),reason};}catch(error){return {...base,status:'unavailable',...failure(error)};}}
  function pause({id}={}){const plan=journal.get(id);if(!plan||plan.account!==accountLabel||plan.platform!=='binance')stop('plan_missing','没有该账户的 Binance 记录。');return patch(plan,{automationPaused:true,pauseNotice:'暂停后续内部划转及现货买币；不会平仓、撤回已成交 PUT 或撤销已发送的操作。'});}
  const list=()=>clone(plans());return {status,prepare,confirm,list,listPlans:list,tick,pause};
}

// Pure preparation and ledger transitions. This module never connects an account,
// reserves exchange funds, submits an order, or treats a browser event as exchange proof.
const INTENT_TTL=30000,SPOT_WINDOW=300000,CLOCK_SKEW=2000;
const COPY=value=>JSON.parse(JSON.stringify(value));
const error=(...errors)=>({valid:false,errors});
const time=value=>Number.isSafeInteger(value)&&value>0;
function decimal(value){
  if(typeof value!=='string'&&typeof value!=='number')return null;
  const text=String(value).trim();if(text.length>120)return null;
  const match=/^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i.exec(text);
  if(!match)return null;
  let scale=(match[3]??match[4]??'').length-Number(match[5]||0);
  if(!Number.isInteger(scale)||Math.abs(scale)>100)return null;
  let digits=BigInt((match[1]==='-'?'-':'')+(match[2]||'0')+(match[3]??match[4]??''));
  if(scale<0){digits*=10n**BigInt(-scale);scale=0;}
  while(scale>0&&digits%10n===0n){digits/=10n;scale--;}
  return {digits,scale};
}
function string(value){
  const d=typeof value==='object'&&value?.digits!==undefined?value:decimal(value);if(!d)return null;
  const sign=d.digits<0n?'-':'',digits=(d.digits<0n?-d.digits:d.digits).toString().padStart(d.scale+1,'0');
  return d.scale?sign+digits.slice(0,-d.scale)+'.'+digits.slice(-d.scale):sign+digits;
}
function compare(a,b){const x=decimal(a),y=decimal(b);if(!x||!y)return NaN;const s=Math.max(x.scale,y.scale),n=x.digits*10n**BigInt(s-x.scale)-y.digits*10n**BigInt(s-y.scale);return n<0n?-1:n>0n?1:0;}
function add(a,b){const x=decimal(a),y=decimal(b),scale=Math.max(x.scale,y.scale);return string({digits:x.digits*10n**BigInt(scale-x.scale)+y.digits*10n**BigInt(scale-y.scale),scale});}
const subtract=(a,b)=>add(a,string({digits:-decimal(b).digits,scale:decimal(b).scale}));
function multiply(a,b){const x=decimal(a),y=decimal(b);return string({digits:x.digits*y.digits,scale:x.scale+y.scale});}
function divideUp(a,b,scale=18){
  const x=decimal(a),y=decimal(b);let numerator=x.digits,denominator=y.digits;
  const shift=scale+y.scale-x.scale;if(shift>=0)numerator*=10n**BigInt(shift);else denominator*=10n**BigInt(-shift);
  return string({digits:(numerator+denominator-1n)/denominator,scale});
}
const positive=value=>decimal(value)&&compare(value,0)>0;
const nonnegative=value=>decimal(value)&&compare(value,0)>=0;
function multiple(value,step){const x=decimal(value),y=decimal(step);if(!x||!y||y.digits<=0n)return false;const s=Math.max(x.scale,y.scale);return x.digits*10n**BigInt(s-x.scale)%(y.digits*10n**BigInt(s-y.scale))===0n;}
const almost=(a,b)=>Number.isFinite(Number(a))&&Number.isFinite(Number(b))&&Math.abs(Number(a)-Number(b))<=Math.max(1e-8,Math.abs(Number(a))*Number.EPSILON*16);
const linkId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,36}$/.test(value);
const fresh=(value,now,ttl=INTENT_TTL)=>time(value)&&value<=now+CLOCK_SKEW&&now-value<ttl;
const LIMITS={bybit:'USDT',deribit:'USDC'};

export const executionLifecycle=Object.freeze([
  {state:'prepared',label:'检查委托与接币规则'},
  {state:'account_required',label:'等待连接账户及核验策略资金'},
  {state:'ready',label:'等待确认卖 PUT 并启用接币规则'},
  {state:'submitting',label:'已生成提交意图，等待执行器回报'},
  {state:'awaiting_confirmation',label:'交易所已受理，等待成交对账'},
  {state:'unknown',label:'订单结果不明，先对账，禁止盲目重发'},
  {state:'partially_filled',label:'PUT 部分成交，仅对实际敞口安排接币'},
  {state:'holding',label:'PUT 已成交，核对持仓'},
  {state:'settlement_pending',label:'等待交易所最终结算证据'},
  {state:'spot_ready',label:'在预算、价格及时间范围内另买现货'},
  {state:'spot_submitting',label:'现货提交中，等待真实成交'},
  {state:'spot_partially_filled',label:'现货部分成交，仅处理剩余毛数量'},
  {state:'hold_cash',label:'未触发接币，保留稳定币'},
  {state:'attention_required',label:'边界触发，停止新委托并等待处理'},
  {state:'complete',label:'对账完成'}
]);

export function executionFingerprint({platform,amount,strike,expiry,symbol,currency=LIMITS[platform]}={}){
  if(!LIMITS[platform]||currency!==LIMITS[platform]||!positive(amount)||!positive(strike)||!time(expiry)||typeof symbol!=='string'||!symbol)return null;
  return JSON.stringify({platform,currency,amount:string(amount),strike:string(strike),expiry,symbol});
}

function sweep(q,book){
  const levels=(book?.bids||[]).filter(row=>positive(row?.price)&&positive(row?.qty)).map(row=>({price:string(row.price),qty:string(row.qty)})).sort((a,b)=>compare(b.price,a.price));
  let remaining=q,gross='0',last=null;
  for(const level of levels){if(compare(remaining,0)<=0)break;const take=compare(level.qty,remaining)<0?level.qty:remaining;gross=add(gross,multiply(take,level.price));remaining=subtract(remaining,take);last=level.price;}
  return compare(remaining,0)===0&&last?{gross,lastBid:last}:null;
}

export function prepareExecutionIntent({model,contract,book,market,amount=model?.amount,now=Date.now(),orderLinkId}={}){
  if(!model?.valid||!contract||!market||!book||!time(now))return error('需要有效测算、真实合约与买盘。');
  const platform=market.platform,currency=LIMITS[platform],q=string(model.q),capital=positive(q)&&positive(contract.strike)?multiply(q,contract.strike):null;
  const expiry=Number(contract.expires),fingerprint=executionFingerprint({platform,amount,strike:contract.strike,expiry,symbol:contract.symbol});
  if(!fingerprint||!positive(q)||!nonnegative(model.feeReserve)||!positive(model.reserve)||!almost(model.amount,amount)||!almost(model.capital,capital)||!almost(model.strike,contract.strike))return error('金额、数量或合约与测算结果不一致。');
  if(market.currency!=null&&market.currency!==currency||contract.settleCoin!=null&&contract.settleCoin!==currency)return error('合约或账户计价币种不一致。');
  if(!positive(contract.step)||!positive(contract.min)||!multiple(q,contract.step)||compare(q,contract.min)<0)return error('委托数量未按真实合约步长对齐或低于最低数量。');
  if(compare(amount,model.reserve)<0)return error('当次资金不足以覆盖完整备资、费用和价格差缓冲。');
  const buyBufferRate=string(model.buyBufferRate??0),buyBufferReserve=string(model.buyBufferReserve??0);
  if(!nonnegative(buyBufferRate)||compare(buyBufferRate,'.05')>0||!nonnegative(buyBufferReserve)||!almost(buyBufferReserve,multiply(capital,buyBufferRate))||!almost(model.reserve,add(add(capital,model.feeReserve),buyBufferReserve)))return error('价格差缓冲或完整资金预留与测算不一致。');
  if(!fresh(book.time,now)||expiry<=now)return error('买盘已超过 30 秒、时间异常或合约已到期，请重新准备。');
  const fill=sweep(q,book);if(!fill)return error('真实买盘深度不足，不能生成本次数量的委托。');
  if(!almost(fill.gross,model.gross))return error('测算权利金与本次买盘已不一致，请重新计算。');
  const blockers=[];
  if(platform==='deribit'&&!/^BTC_USDC-\d{1,2}[A-Z]{3}\d{2}-\d+(?:\.\d+)?-P$/.test(contract.symbol))blockers.push({code:'instrument_mismatch',message:'仅支持 Deribit BTC USDC 看跌期权。'});
  if(!positive(contract.priceTick))blockers.push({code:'price_tick_missing',message:'缺少官方价格步长，不生成真实订单请求。'});
  else if(!multiple(fill.lastBid,contract.priceTick))blockers.push({code:'price_tick_mismatch',message:'最后覆盖买价未按官方价格步长对齐，请刷新合约规则和买盘。'});
  if(!linkId(orderLinkId))blockers.push({code:'order_link_id_invalid',message:'需要调用方提供不超过 36 字符的唯一幂等订单标识。'});
  if(!positive(model.netIncome))blockers.push({code:'nonpositive_income',message:'预计净权利金不大于零，暂停提交。'});
  const payloadReady=blockers.length===0;
  const orderPayload=payloadReady?(platform==='deribit'?{instrument_name:contract.symbol,amount:Number(q),price:Number(fill.lastBid),type:'limit',time_in_force:'immediate_or_cancel',label:orderLinkId}:{category:'option',symbol:contract.symbol,side:'Sell',orderType:'Limit',timeInForce:'IOC',qty:q,price:fill.lastBid,orderLinkId}):null;
  const spotRate=string(contract.spot??0);if(!nonnegative(spotRate)||compare(spotRate,1)>=0)return error('现货费用口径无效。');
  return {valid:true,version:1,revision:0,state:'account_required',phase:'put',id:linkId(orderLinkId)?orderLinkId:null,fingerprint,createdAt:now,expiresAt:Math.min(now+INTENT_TTL,book.time+INTENT_TTL,expiry),platform,currency,symbol:contract.symbol,strike:string(contract.strike),expiry,amount:string(amount),q,capital,feeReserve:string(model.feeReserve),buyBufferRate,buyBufferReserve,fullFundReserve:string(model.reserve),freeCash:string(subtract(amount,model.reserve)),fundsLocked:false,fundsReservationScope:'not_reserved',estimatedGross:fill.gross,estimatedNetIncome:string(model.netIncome),limitPrice:fill.lastBid,minimumGrossAtLimit:multiply(q,fill.lastBid),priceTick:positive(contract.priceTick)?string(contract.priceTick):null,payloadReady,orderPayload,canSubmit:false,blockers,
    spotEstimate:{grossBtc:q,netBtc:contract.spotDeductBase?multiply(q,subtract(1,spotRate)):q,feeRate:spotRate,feeDeductedFromBtc:contract.spotDeductBase===true,estimateOnly:true,assumesSpotEqualsSettlement:true},
    settlementRule:{trigger:'finalSettlementPrice <= strike',requiresFinalExchangeProof:true,spotMaxPriceRule:'finalSettlementPrice * (1 + buyBufferRate)',spotMaxSpendRule:'not above reconciled strategy cash and authorized budget',spotWindowMs:SPOT_WINDOW,noAutomaticTopUp:true},
    put:{fills:[],filledQty:'0',gross:'0',fees:'0',terminal:false,orderId:null},spot:{fills:[],filledQty:'0',netBtc:'0',spent:'0',orders:[],activeOrder:null},account:null,settlement:null,pendingAction:null,lifecycle:COPY(executionLifecycle),notes:['这是可检查的执行计划，尚未连接账户或提交订单。','资金数额为策略预留要求，不代表交易所已冻结资金。','现金结算 PUT 到期后仍需另买现货；实际成交价和净到账币量以真实成交为准。','到期任务依赖常驻执行器，浏览器或本机离线不能提供执行保证。']};
}

export function validateExecutionConfirmation(plan,{now=Date.now(),currentFingerprint}={}){
  const errors=[];
  if(!plan?.valid||!time(now))return error('执行计划无效。');
  if(now>=plan.expiresAt)errors.push('委托计划已超过有效期，请重新准备。');
  if(currentFingerprint!==plan.fingerprint)errors.push('金额、币种、合约、接币价或到期条件已改变。');
  if(plan.state!=='ready')errors.push('账户、资金核验或订单对账尚未完成。');
  if(!plan.payloadReady||!plan.orderPayload)errors.push(...plan.blockers.map(item=>item.message));
  if(!plan.account||!fresh(plan.account.checkedAt,now))errors.push('账户与资金核验已失效。');
  return errors.length?error(...errors):{valid:true,errors:[]};
}

function proofIdentity(plan,proof,source){return proof?.source===source&&proof.accountId===plan.account?.accountId&&proof.platform===plan.platform&&proof.symbol===plan.symbol&&proof.currency===plan.currency;}
function reconcileFills(existing,incoming,kind,plan,order){
  if(!Array.isArray(incoming))throw Error('缺少交易所逐笔成交记录。');
  const fills=COPY(existing);
  for(const raw of incoming){
    if(typeof raw?.fillId!=='string'||!raw.fillId||!positive(raw.qty)||!positive(raw.price)||!nonnegative(raw.fee)||!['BTC',plan.currency].includes(raw.feeCurrency))throw Error('成交记录缺少有效数量、价格、费用或费用币种。');
    if(raw.orderId!=null&&raw.orderId!==order.orderId||raw.clientOrderId!=null&&raw.clientOrderId!==order.clientOrderId)throw Error('成交记录属于其他订单。');
    if(kind==='put'&&raw.feeCurrency!==plan.currency)throw Error('期权成交费用币种未核实。');
    const row={fillId:raw.fillId,orderId:order.orderId,clientOrderId:order.clientOrderId,qty:string(raw.qty),price:string(raw.price),fee:string(raw.fee),feeCurrency:raw.feeCurrency};
    const old=fills.find(fill=>fill.fillId===row.fillId);
    if(old){if(JSON.stringify(old)!==JSON.stringify(row))throw Error('同一成交标识返回冲突内容，必须继续对账。');continue;}
    if(compare(row.price,kind==='put'?plan.limitPrice:order.price)*(kind==='put'?1:-1)<0)throw Error('真实成交价格越过已批准的限价，需要人工核对。');
    fills.push(row);
  }
  const qty=fills.reduce((sum,fill)=>add(sum,fill.qty),'0');
  if(compare(qty,kind==='put'?plan.q:plan.put.filledQty)>0)throw Error('累计成交超过策略批准数量。');
  const gross=fills.reduce((sum,fill)=>add(sum,multiply(fill.qty,fill.price)),'0'),quoteFees=fills.filter(fill=>fill.feeCurrency===plan.currency).reduce((sum,fill)=>add(sum,fill.fee),'0'),baseFees=fills.filter(fill=>fill.feeCurrency==='BTC').reduce((sum,fill)=>add(sum,fill.fee),'0');
  if(compare(baseFees,qty)>0)throw Error('BTC 手续费超过成交数量。');
  return {fills,qty,gross,quoteFees,baseFees};
}

/** Evidence events must come from a trusted exchange adapter, never directly from
 * browser-provided booleans. The adapter must persist the transition before sending
 * pendingAction, and independently authenticate account/order/settlement evidence. */
export function transitionExecutionIntent(plan,event,{now=Date.now(),currentFingerprint}={}){
  const reject=message=>({ok:false,plan,errors:[message]});
  if(!plan?.valid||!event||!time(now))return reject('执行计划或事件无效。');
  const next=COPY(plan),type=event.type;
  const inState=(...states)=>states.includes(plan.state);
  const accept=()=>{next.revision=plan.revision+1;next.canSubmit=next.state==='ready'&&now<next.expiresAt;return {ok:true,plan:next,errors:[]};};
  try{
    if(type==='ACCOUNT_VERIFIED'){
      if(!inState('account_required','ready'))return reject('当前阶段不能替换账户。');
      if(now>=plan.expiresAt||currentFingerprint!==plan.fingerprint)return reject('计划已过期或条件已改变，请重新准备。');
      if(!plan.payloadReady)return reject('官方订单参数尚未完整核实。');
      const p=event.proof;
      if(p?.source!=='execution_adapter'||p.platform!==plan.platform||p.currency!==plan.currency||typeof p.accountId!=='string'||!p.accountId||p.tradingEnabled!==true||p.spotEnabled!==true||p.executorOnline!==true||!fresh(p.checkedAt,now)||!positive(p.availableBalance)||!positive(p.reservedAmount)||compare(p.availableBalance,plan.fullFundReserve)<0||compare(p.reservedAmount,plan.fullFundReserve)<0||typeof p.reservationId!=='string'||!p.reservationId)return reject('账户、常驻执行器或完整策略资金预留尚未核验。');
      next.account={accountId:p.accountId,checkedAt:p.checkedAt,reservationId:p.reservationId,reservedAmount:string(p.reservedAmount)};next.fundsReservationScope='strategy_ledger';next.state='ready';return accept();
    }
    if(type==='SUBMIT'){
      const check=validateExecutionConfirmation(plan,{now,currentFingerprint});if(!check.valid)return reject(check.errors.join(' '));
      next.state='submitting';next.pendingAction={kind:'sell_put',clientOrderId:plan.id,payload:COPY(plan.orderPayload)};return accept();
    }
    if(type==='ORDER_ACCEPTED'){
      const p=event.proof;
      if(!inState('submitting')||!proofIdentity(plan,p,'exchange_order')||p.clientOrderId!==plan.id||typeof p.orderId!=='string'||!p.orderId||p.accepted!==true)return reject('缺少交易所订单受理证据。');
      next.put.orderId=p.orderId;next.pendingAction=null;next.state='awaiting_confirmation';return accept();
    }
    if(type==='ORDER_UNKNOWN'){
      if(!inState('submitting','awaiting_confirmation','partially_filled','spot_submitting'))return reject('当前没有待核实的提交。');
      if(plan.state==='partially_filled'&&plan.put.terminal)return reject('PUT 订单终态已确认，不能恢复为待提交状态。');
      next.phase=plan.state==='spot_submitting'?'spot':'put';next.state='unknown';next.canSubmit=false;next.pendingAction=null;next.requiresReconciliation=true;return accept();
    }
    if(type==='PUT_RECONCILED'){
      const p=event.proof;
      if(!inState('submitting','awaiting_confirmation','partially_filled','holding','unknown')||plan.phase!=='put'||!proofIdentity(plan,p,'exchange_order_and_fills')||p.clientOrderId!==plan.id||typeof p.orderId!=='string'||!p.orderId||!['open','filled','cancelled','rejected'].includes(p.status)||!nonnegative(p.filledQty))return reject('缺少匹配的真实 PUT 订单与成交对账。');
      if(plan.put.orderId&&plan.put.orderId!==p.orderId)return reject('交易所订单标识不一致。');
      if(plan.put.terminal&&p.status==='open')return reject('旧的非终态订单回报不能覆盖已确认终态。');
      const fills=reconcileFills(plan.put.fills,p.fills,'put',plan,{orderId:p.orderId,clientOrderId:plan.id});
      if(compare(fills.qty,p.filledQty)!==0)return reject('逐笔成交数量与交易所累计数量不一致。');
      if(p.status==='filled'&&compare(fills.qty,plan.q)!==0)return reject('全部成交状态与原委托数量不一致。');
      if(p.status==='rejected'&&positive(fills.qty))return reject('拒绝状态不能包含已成交数量。');
      next.put={fills:fills.fills,filledQty:fills.qty,gross:fills.gross,fees:fills.quoteFees,terminal:p.status!=='open',orderId:p.orderId};next.pendingAction=null;next.requiresReconciliation=false;
      next.exposureFullFundReserve=positive(fills.qty)?divideUp(multiply(plan.fullFundReserve,fills.qty),plan.q):'0';next.exposureBuyBufferReserve=positive(fills.qty)?divideUp(multiply(plan.buyBufferReserve,fills.qty),plan.q):'0';
      // Unfilled order quantity can still execute until its terminal state is proven.
      next.activeFullFundReserve=next.put.terminal?next.exposureFullFundReserve:plan.fullFundReserve;next.activeBuyBufferReserve=next.put.terminal?next.exposureBuyBufferReserve:plan.buyBufferReserve;
      next.state=compare(fills.qty,plan.q)===0?'holding':positive(fills.qty)?'partially_filled':next.put.terminal?'complete':'awaiting_confirmation';return accept();
    }
    if(type==='WAIT_SETTLEMENT'){
      if(!inState('holding','partially_filled')||!plan.put.terminal||!positive(plan.put.filledQty))return reject('需要先确认 PUT 订单终态与实际持仓。');
      next.state='settlement_pending';return accept();
    }
    if(type==='SETTLEMENT_CONFIRMED'){
      const p=event.proof;
      if(plan.settlement&&proofIdentity(plan,p,'exchange_settlement')&&p.settlementId===plan.settlement.settlementId){
        if(p.final===true&&p.expiry===plan.expiry&&compare(p.settledQty,plan.settlement.settledQty)===0&&compare(p.settlementPrice,plan.settlement.price)===0&&p.settledAt===plan.settlement.settledAt&&compare(p.availableCash,plan.settlement.availableCash)===0)return {ok:true,plan,errors:[]};
        return reject('同一结算记录内容冲突，必须继续对账。');
      }
      if(!inState('settlement_pending','holding','partially_filled','attention_required')||!plan.put.terminal||!positive(plan.put.filledQty)||!proofIdentity(plan,p,'exchange_settlement')||p.final!==true||typeof p.settlementId!=='string'||!p.settlementId||p.expiry!==plan.expiry||compare(p.settledQty,plan.put.filledQty)!==0||!nonnegative(p.settlementPrice)||!nonnegative(p.availableCash)||!time(p.settledAt)||p.settledAt<plan.expiry||p.settledAt>now+CLOCK_SKEW)return reject('需要正确账户、合约、实际数量及最终结算的真实证据。');
      const payout=multiply(plan.put.filledQty,compare(p.settlementPrice,plan.strike)<0?subtract(plan.strike,p.settlementPrice):0),cashUpper=subtract(subtract(add(plan.amount,plan.put.gross),plan.put.fees),payout);
      if(compare(p.availableCash,cashUpper)>0)return reject('策略结算现金高于已确认本金与成交现金流，不能混入其他资金。');
      next.settlement={settlementId:p.settlementId,price:string(p.settlementPrice),settledAt:p.settledAt,availableCash:string(p.availableCash),settledQty:string(p.settledQty),spotDeadline:p.settledAt+SPOT_WINDOW};
      next.phase='spot';next.pendingAction=null;
      if(compare(p.settlementPrice,plan.strike)>0)next.state='hold_cash';
      else {next.spot.maxPrice=multiply(p.settlementPrice,add(1,plan.buyBufferRate));next.spot.targetQty=plan.put.filledQty;next.state=!plan.paused&&positive(next.spot.maxPrice)&&now<next.settlement.spotDeadline?'spot_ready':'attention_required';}
      return accept();
    }
    if(type==='SPOT_SUBMIT'){
      const p=event.quote;
      if(!inState('spot_ready','spot_partially_filled')||plan.spot.activeOrder||!plan.settlement)return reject('当前不允许再提交现货订单。');
      if(now>=plan.settlement.spotDeadline)return reject('已超过结算后 5 分钟，暂停现货买入。');
      const remaining=subtract(plan.put.filledQty,plan.spot.filledQty),cash=subtract(plan.settlement.availableCash,plan.spot.spent);
      if(!p||!linkId(p.clientOrderId)||p.clientOrderId===plan.id||plan.spot.orders.some(order=>order.clientOrderId===p.clientOrderId)||!positive(p.qty)||compare(p.qty,remaining)>0||!positive(p.price)||compare(p.price,plan.spot.maxPrice)>0||!nonnegative(p.feeReserve)||!nonnegative(p.availableCash)||!fresh(p.checkedAt,now,10000))return reject('现货数量、价格、资金或最新行情超出已确认边界。');
      const maximumSpend=add(multiply(p.qty,p.price),p.feeReserve);
      if(compare(maximumSpend,cash)>0||compare(maximumSpend,p.availableCash)>0)return reject('现货实际价格及费用超过策略可用现金，不追加资金。');
      next.spot.activeOrder={clientOrderId:p.clientOrderId,orderId:null,qty:string(p.qty),price:string(p.price),maxSpend:maximumSpend};next.state='spot_submitting';next.pendingAction={kind:'buy_spot',...COPY(next.spot.activeOrder),currency:plan.currency,deadline:plan.settlement.spotDeadline};return accept();
    }
    if(type==='SPOT_RECONCILED'){
      const p=event.proof,active=plan.spot.activeOrder;
      if(!inState('spot_submitting','unknown')||plan.phase!=='spot'||!active||!proofIdentity(plan,p,'exchange_order_and_fills')||p.clientOrderId!==active.clientOrderId||typeof p.orderId!=='string'||!p.orderId||!['open','filled','cancelled','rejected'].includes(p.status)||!nonnegative(p.filledQty))return reject('缺少匹配的真实现货订单与成交对账。');
      const fills=reconcileFills(plan.spot.fills,p.fills,'spot',plan,{...active,orderId:p.orderId});
      const orderFills=fills.fills.filter(fill=>fill.clientOrderId===active.clientOrderId),orderQty=orderFills.reduce((sum,fill)=>add(sum,fill.qty),'0'),orderSpent=orderFills.reduce((sum,fill)=>add(sum,add(multiply(fill.qty,fill.price),fill.feeCurrency===plan.currency?fill.fee:0)),'0');
      if(compare(orderQty,p.filledQty)!==0||compare(orderQty,active.qty)>0||p.status==='filled'&&compare(orderQty,active.qty)!==0)return reject('现货订单累计成交数量不一致。');
      const spent=add(fills.gross,fills.quoteFees),budgetExceeded=compare(orderSpent,active.maxSpend)>0||compare(spent,plan.settlement.availableCash)>0;
      next.spot.fills=fills.fills;next.spot.filledQty=fills.qty;next.spot.netBtc=subtract(fills.qty,fills.baseFees);next.spot.spent=spent;next.pendingAction=null;next.requiresReconciliation=false;
      // An authenticated fill already happened. Keep its assets/cost even if an
      // unexpected fee crossed the reserve; stop further orders instead of erasing it.
      if(budgetExceeded){
        next.riskViolation='actual_spot_spend_exceeded';next.state=p.status==='open'?'unknown':'attention_required';next.requiresReconciliation=p.status==='open';
        if(p.status!=='open'){next.spot.orders.push({...active,orderId:p.orderId,status:p.status});next.spot.activeOrder=null;}
        return accept();
      }
      if(p.status==='open'){next.state='spot_submitting';next.spot.activeOrder.orderId=p.orderId;}
      else {next.spot.orders.push({...active,orderId:p.orderId,status:p.status});next.spot.activeOrder=null;next.state=compare(fills.qty,plan.put.filledQty)===0?'complete':now>=plan.settlement.spotDeadline?'attention_required':'spot_partially_filled';}
      return accept();
    }
    if(type==='COMPLETE'&&inState('hold_cash')){next.state='complete';return accept();}
    if(type==='PAUSE'){
      if(inState('submitting','awaiting_confirmation','spot_submitting','unknown'))return reject('存在待核实订单，必须先完成对账；暂停不能撤销已有成交。');
      if(inState('partially_filled','holding')&&!plan.put.terminal)return reject('PUT 委托终态尚未确认，暂停不能释放资金或停止对账。');
      if(inState('complete'))return reject('计划已完成。');next.state='attention_required';next.paused=true;next.pendingAction=null;return accept();
    }
    return reject('该事件不适用于当前执行阶段；未知订单不能盲目重发。');
  }catch(caught){return reject(caught?.message||'执行证据无效，需要继续核对。');}
}

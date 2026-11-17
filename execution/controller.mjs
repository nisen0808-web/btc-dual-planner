const terminal=new Set(['Filled','Cancelled','Rejected','PartiallyFilledCanceled']);
const positive=n=>Number.isFinite(Number(n))&&Number(n)>0;
const nonnegative=n=>n!==null&&n!==undefined&&n!==''&&Number.isFinite(Number(n))&&Number(n)>=0;
const equal=(a,b)=>Math.abs(Number(a)-Number(b))<=Math.max(1e-10,Math.abs(Number(b))*1e-9);
const fresh=(time,now)=>Number.isSafeInteger(time)&&time<=now+2000&&now-time<15000;
function decimal(value){
  if(!nonnegative(value))throw Error('Invalid decimal');
  const match=String(value).match(/^(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
  if(!match)throw Error('Invalid decimal');
  let scale=(match[2]||'').length-Number(match[3]||0),units=BigInt(match[1]+(match[2]||''));
  if(Math.abs(scale)>30)throw Error('Decimal is outside supported precision');
  if(scale<0){units*=10n**BigInt(-scale);scale=0;}
  return {units,base:10n**BigInt(scale)};
}
function withinSettlementCap(price,settlement,buffer){
  const p=decimal(price),s=decimal(settlement),b=decimal(buffer);
  return p.units*s.base*b.base<=s.units*(b.base+b.units)*p.base;
}

/** The server must obtain preflight/proofs itself. Never pass browser-supplied account or settlement claims here. */
export class ExecutionController{
  constructor({journal,exchange,preflight,now=Date.now,liveEnabled=false}){Object.assign(this,{journal,exchange,preflight,now,liveEnabled});}
  async confirm(intent,confirmation){
    if(!this.liveEnabled)throw Error('Live execution is disabled');
    if(!intent?.id||typeof intent.account!=='string'||!intent.account||intent.platform!=='bybit'||intent.currency!=='USDT'||!positive(intent.amount)||!intent.orderPayload||!intent.fingerprint||confirmation?.account!==intent.account||confirmation?.currency!==intent.currency||confirmation?.fingerprint!==intent.fingerprint||confirmation?.confirmed!==true||intent.expiresAt<=this.now())throw Error('A fresh explicit confirmation is required');
    const existing=this.journal.get(intent.id);if(existing)return existing;
    const checked=await this.preflight(intent);
    if(checked?.verified!==true||checked.account!==intent.account||checked.currency!==intent.currency||!fresh(checked.checkedAt,this.now())||checked.dedicatedSubaccount!==true||checked.noOtherPositions!==true||checked.noOtherOrders!==true||checked.noBorrowing!==true||!nonnegative(checked.availableFunds)||Number(checked.availableFunds)<Number(intent.fullFundReserve)||!positive(intent.fullFundReserve)||Number(intent.fullFundReserve)>Number(intent.amount))throw Error('Account funding and isolation checks failed');
    if(intent.expiresAt<=this.now())throw Error('Execution quote expired during preflight');
    // A crash from this point must lead to reconciliation by this same link ID,
    // never to a second submission under a new link ID.
    const {exchangeAuthorization,...record}=intent;
    let plan=this.journal.create({...record,phase:'put_submitting',closed:false,confirmedAt:this.now()});
    const {symbol,qty,price,orderLinkId}=intent.orderPayload;
    let result;try{result=await this.exchange.createSellPut({symbol,qty,price,orderLinkId},intent.exchangeAuthorization);}catch{result={ok:false,error:{unknown:true}};}
    return this.journal.update(plan.id,plan.version,{phase:result.ok?'put_reconciling':result.error?.unknown?'unknown':'needs_attention',exchangeOrderId:result.ok?result.data?.orderId||null:null});
  }
  reconcilePut(id,order,executions){
    const plan=this.journal.get(id);if(!plan||!['put_submitting','put_reconciling','unknown'].includes(plan.phase))throw Error('PUT reconciliation is not allowed in this state');
    if(!order||order.orderLinkId!==plan.orderPayload.orderLinkId||order.symbol!==plan.orderPayload.symbol)return this.journal.update(id,plan.version,{phase:'unknown'});
    const unique=new Map();
    for(const fill of executions||[]){
      if(fill.orderLinkId!==order.orderLinkId||fill.symbol!==order.symbol||typeof fill.execId!=='string'||!positive(fill.execQty)||!positive(fill.execPrice)||!Number.isFinite(Number(fill.execFee))||Number(fill.execFee)<0)throw Error('Invalid PUT execution evidence');
      const old=unique.get(fill.execId);if(old&&JSON.stringify(old)!==JSON.stringify(fill))throw Error('Conflicting duplicate execution');unique.set(fill.execId,fill);
    }
    const fills=[...unique.values()],filledQty=fills.reduce((n,f)=>n+Number(f.execQty),0),gross=fills.reduce((n,f)=>n+Number(f.execQty)*Number(f.execPrice),0),openFee=fills.reduce((n,f)=>n+Number(f.execFee),0);
    if(!equal(filledQty,order.cumExecQty))throw Error('PUT execution quantity has not reconciled');
    const outOfBounds=filledQty>Number(plan.orderPayload.qty)+1e-10||filledQty*Number(plan.strike)+openFee>Number(plan.amount)||fills.some(f=>Number(f.execPrice)<Number(plan.orderPayload.price));
    const phase=outOfBounds?'needs_attention':!terminal.has(order.orderStatus)?'put_reconciling':filledQty?'holding':'no_fill';
    return this.journal.update(id,plan.version,{phase,closed:phase==='no_fill',filledQty,gross,openFee,fills,outOfBounds});
  }
  recordSettlement(id,proof){
    const plan=this.journal.get(id);if(!plan||!['holding','settlement_pending'].includes(plan.phase))throw Error('No reconciled PUT holding');
    if(proof?.final!==true||proof.account!==plan.account||proof.currency!==plan.currency||proof.positionEmpty!==true||proof.balanceVerified!==true||!fresh(proof.checkedAt,this.now())||proof.symbol!==plan.orderPayload.symbol||proof.side!=='Sell'||!equal(proof.position,plan.filledQty)||!equal(proof.strike,plan.strike)||!Number.isSafeInteger(proof.deliveryTime)||proof.deliveryTime<plan.expiry||proof.deliveryTime>this.now()||!Number.isFinite(proof.deliveryPrice)||proof.deliveryPrice<0||!Number.isFinite(proof.deliveryFee)||proof.deliveryFee<0||!Number.isFinite(proof.strategyCash)||proof.strategyCash<0)throw Error('Final settlement, empty position and available funds must reconcile');
    const strategyCashCap=Number(plan.amount)+plan.gross-plan.openFee-plan.filledQty*Math.max(plan.strike-proof.deliveryPrice,0)-proof.deliveryFee;
    if(proof.strategyCash>strategyCashCap+1e-8)throw Error('Settlement cash includes funds outside this confirmed strategy');
    const willBuy=proof.deliveryPrice<=plan.strike;
    const deadline=proof.deliveryTime+300000;
    return this.journal.update(id,plan.version,{phase:!willBuy?'complete_cash':this.now()>=deadline||proof.deliveryPrice===0?'needs_attention':'spot_ready',closed:!willBuy,settlement:proof,spotDeadline:deadline},'settlement:'+id+':'+proof.deliveryTime);
  }
  async buySpot(id,proposal){
    if(!this.liveEnabled)throw Error('Live execution is disabled');
    let plan=this.journal.get(id);if(!plan||plan.phase!=='spot_ready')throw Error('Final settlement is not ready for spot purchase');
    if(this.now()>=plan.spotDeadline)return this.journal.update(id,plan.version,{phase:'needs_attention'});
    const order=proposal?.order;
    if(!order||order.symbol!=='BTCUSDT'||!positive(order.qty)||!positive(order.price)||Number(order.qty)>plan.filledQty+1e-10||!withinSettlementCap(order.price,plan.settlement.deliveryPrice,plan.buyBufferRate)||Number(order.qty)*Number(order.price)+Number(proposal.feeReserve)>plan.settlement.strategyCash||!Number.isFinite(Number(proposal.feeReserve))||Number(proposal.feeReserve)<0)throw Error('Spot order exceeds the confirmed price, quantity or cash limit');
    const checked=await this.preflight({...plan,stage:'spot'});
    if(checked?.verified!==true||checked.account!==plan.account||checked.currency!==plan.currency||!fresh(checked.checkedAt,this.now())||checked.dedicatedSubaccount!==true||checked.noOtherPositions!==true||checked.noOtherOrders!==true||checked.noBorrowing!==true||!nonnegative(checked.availableFunds)||Number(checked.availableFunds)<Number(order.qty)*Number(order.price)+Number(proposal.feeReserve)||this.now()>=plan.spotDeadline)throw Error('Spot account and cash must be rechecked immediately before buying');
    plan=this.journal.update(id,plan.version,{phase:'spot_submitting',spotOrder:order,spotCashCap:Number(order.qty)*Number(order.price)+Number(proposal.feeReserve),spotFeeReserve:Number(proposal.feeReserve)});
    let result;try{result=await this.exchange.createSpotBuy(order,proposal.authorization);}catch{result={ok:false,error:{unknown:true}};}
    return this.journal.update(id,plan.version,{phase:result.ok?'spot_reconciling':result.error?.unknown?'spot_unknown':'needs_attention',spotOrderId:result.ok?result.data?.orderId||null:null});
  }
  reconcileSpot(id,order,executions){
    const plan=this.journal.get(id);if(!plan||!['spot_submitting','spot_reconciling','spot_unknown'].includes(plan.phase))throw Error('No spot order to reconcile');
    if(!order||order.orderLinkId!==plan.spotOrder.orderLinkId||order.symbol!=='BTCUSDT')return this.journal.update(id,plan.version,{phase:'spot_unknown'});
    const unique=new Map();
    for(const fill of executions||[]){
      if(fill.symbol!=='BTCUSDT'||fill.orderLinkId!==order.orderLinkId||typeof fill.execId!=='string'||!positive(fill.execQty)||!positive(fill.execPrice)||!Number.isFinite(Number(fill.execFee))||Number(fill.execFee)<0||!['BTC','USDT'].includes(fill.feeCurrency))throw Error('Invalid spot execution evidence');
      const old=unique.get(fill.execId);if(old&&JSON.stringify(old)!==JSON.stringify(fill))throw Error('Conflicting duplicate execution');unique.set(fill.execId,fill);
    }
    const fills=[...unique.values()],quantity=fills.reduce((n,f)=>n+Number(f.execQty),0),spent=fills.reduce((n,f)=>n+Number(f.execQty)*Number(f.execPrice)+(f.feeCurrency==='USDT'?Number(f.execFee):0),0),received=quantity-fills.reduce((n,f)=>n+(f.feeCurrency==='BTC'?Number(f.execFee):0),0);
    if(!equal(quantity,order.cumExecQty)||received<0)throw Error('Spot fills and cash do not reconcile');
    const outOfBounds=quantity>Number(plan.spotOrder.qty)+1e-10||spent>plan.settlement.strategyCash+1e-8||spent>plan.spotCashCap+1e-8||fills.some(f=>Number(f.execPrice)>Number(plan.spotOrder.price));
    if(!terminal.has(order.orderStatus))return this.journal.update(id,plan.version,{phase:outOfBounds?'needs_attention':'spot_reconciling',spotFills:fills,receivedBTC:received,spentUSDT:spent,outOfBounds});
    const complete=equal(quantity,plan.filledQty)&&!outOfBounds;
    return this.journal.update(id,plan.version,{phase:complete?'complete_btc':'needs_attention',closed:complete,spotFills:fills,receivedBTC:received,spentUSDT:spent,outOfBounds});
  }
}

const finite=v=>typeof v==='number'&&Number.isFinite(v);
const positive=v=>finite(v)&&v>0;
const number=v=>typeof v==='number'?v:typeof v==='string'&&v.trim()!==''?Number(v):NaN;
const fail=reason=>({valid:false,quoteOnly:true,reason,errors:[reason]});
const coin=v=>typeof v==='string'?v.toUpperCase():'';
const decimals=value=>{const[m,e='0']=String(value).toLowerCase().split('e');return Math.max(0,(m.split('.')[1]||'').length-Number(e));};
function levels(book){return Array.isArray(book?.bids)?book.bids.map(x=>({price:number(x?.price),qty:number(x?.qty)})).filter(x=>positive(x.price)&&x.price<=1e15&&positive(x.qty)).sort((a,b)=>b.price-a.price):[];}
function metrics(book){const bids=levels(book);return{bestBid:bids[0]?.price??null,bestBidQty:bids[0]?.qty??null,depthQty:bids.reduce((sum,x)=>sum+x.qty,0)};}
function fill(q,bids,index,taker,cap){
  let remaining=q,gross=0,openFee=0,levelsUsed=0;
  const tolerance=Math.max(Number.MIN_VALUE,q*Number.EPSILON*Math.max(32,bids.length*4));
  for(const level of bids){const take=Math.min(remaining,level.qty);if(take<=0)continue;gross+=take*level.price;openFee+=take*Math.min(taker*index,cap*level.price);remaining-=take;levelsUsed++;if(remaining<=tolerance)break;}
  return remaining>tolerance?null:{gross,openFee,averagePrice:gross/q,levelsUsed};
}

/** Current visible bid quote only. Reserves are retained assets, not paid fees. */
export function calculatePutQuote(amount,contract,book,spot,serverTime){
  const A=number(amount),S0=number(spot),now=number(serverTime);
  if(!positive(A)||A>1e15)return fail('请填写有效的当次投入资金');
  if(!positive(S0)||S0>1e15||!positive(now))return fail('BTC 指数价格或行情时间无效，请刷新');
  if(!contract||typeof contract!=='object')return fail('请先选择有效的 PUT 合约');
  const K=number(contract.strike),expires=number(contract.expires),step=number(contract.step),minimum=number(contract.min);
  const taker=number(contract.taker),cap=number(contract.cap),delivery=number(contract.delivery),spotRate=number(contract.spot);
  if(!positive(K)||K>1e15||!positive(expires)||expires<=now)return fail('执行价无效或合约已到期');
  if(!positive(step)||step>1||decimals(step)>14||!positive(minimum))return fail('合约最小数量或交易步长无效');
  if(![taker,cap,delivery,spotRate].every(v=>finite(v)&&v>=0&&v<=1)||contract.spotDeductBase===true&&spotRate>=1)return fail('公开标准费率无效');
  const bids=levels(book),timestamp=number(book?.time);
  if(!bids.length)return fail('当前没有有效买盘，不能用标记价代替卖出报价');
  if(!positive(timestamp)||timestamp>now+180000||now-timestamp>180000)return fail('买盘报价时间无效或已过期，请刷新');
  const precision=decimals(step),qty=units=>Number((units*step).toFixed(precision));
  const minUnits=Math.ceil(minimum/step-1e-9),upperUnits=Math.floor(A/K/step+1e-9);
  if(!Number.isSafeInteger(minUnits)||!Number.isSafeInteger(upperUnits))return fail('金额或数量步长超出可安全计算范围');
  if(upperUnits<minUnits)return fail(`当次资金不足以覆盖最小交易数量 ${qty(minUnits)} BTC 及费用预留`);
  const fraction=contract.spotDeductBase===true?spotRate:spotRate/(1+spotRate);
  const perCoinUpper=K+taker*S0+delivery*K+fraction*bids[0].price;
  let units=Math.max(minUnits,Math.min(upperUnits,Math.floor(A*(1-fraction)/perCoinUpper/step+1e-9)));
  const evaluate=count=>{
    const q=qty(count),quoted=fill(q,bids,S0,taker,cap);if(!quoted)return null;
    const capital=K*q,deliveryFeeReserve=delivery*capital,spotFeeReserve=fraction*(A+quoted.gross);
    const feeReserve=quoted.openFee+deliveryFeeReserve+spotFeeReserve;
    return{q,capital,deliveryFeeReserve,spotFeeReserve,feeReserve,reserve:capital+feeReserve,...quoted};
  };
  let sized=evaluate(units);if(!sized)return fail('当前买盘深度不足以承接整笔卖出数量');
  const tolerance=Math.max(1e-8,A*Number.EPSILON*8);
  if(sized.reserve>A+tolerance)return fail(`当次资金不足以覆盖最小交易数量 ${qty(minUnits)} BTC 及费用预留`);
  if(units<upperUnits){const next=evaluate(units+1);if(next&&next.reserve<=A+tolerance){units++;sized=next;}}
  const days=(expires-now)/86400000,netIncome=sized.gross-sized.openFee,term=netIncome/A,annual=term*365/days;
  const result={valid:true,quoteOnly:true,amount:A,...sized,netIncome,term,annual,days,
    ...metrics(book),unused:A-sized.capital,freeCash:Math.max(0,A-sized.reserve),expires,strike:K,
    quoteTime:timestamp,feeEstimateOnly:true,executionStatus:'quoted'};
  const currency=coin(contract.settleCoin??contract.currency);if(['USDT','USDC'].includes(currency))result.settleCoin=currency;
  if(Object.values(result).some(v=>typeof v==='number'&&!finite(v)))return fail('报价参数超出可计算范围');
  return result;
}

/** A proposed sell limit at the real best ask. No fill or buyer capacity is inferred. */
export function calculatePutAskLimitQuote(amount,contract,book,spot,serverTime){
  const invalid=reason=>({...fail(reason),quoteMode:'ask_limit',conditional:true,fillGuaranteed:false,executionStatus:'unavailable_limit_quote'});
  const A=number(amount),S0=number(spot),now=number(serverTime);
  if(!positive(A)||A>1e15)return invalid('请填写有效的当次投入资金');
  if(!positive(S0)||S0>1e15||!Number.isSafeInteger(now)||now<=0)return invalid('BTC 指数价格或行情时间无效，请刷新');
  if(!contract||typeof contract!=='object')return invalid('请先选择有效的 PUT 合约');
  const K=number(contract.strike),expires=number(contract.expires),step=number(contract.step),minimum=number(contract.min),maximum=number(contract.max),tick=number(contract.priceTick);
  const rate=number(contract.taker),cap=number(contract.cap),delivery=number(contract.delivery),spotRate=number(contract.spot);
  if(!positive(K)||K>1e15||!Number.isSafeInteger(expires)||expires<=now)return invalid('执行价无效或合约已到期');
  if(!positive(step)||step>1||decimals(step)>14||!positive(minimum)||!positive(maximum)||maximum>1e15||minimum>maximum||decimals(minimum)>14)return invalid('合约最小、最大数量或交易步长无效');
  if(!positive(tick)||tick>1e15||decimals(tick)>14)return invalid('合约价格步长未核实，无法估算卖一挂单');
  if(![rate,cap,delivery,spotRate].every(v=>finite(v)&&v>=0&&v<=1)||contract.spotDeductBase===true&&spotRate>=1)return invalid('公开标准费率无效');
  const timestamp=number(book?.time);
  if(!Number.isSafeInteger(timestamp)||timestamp<=0||timestamp>now+2000||now-timestamp>=30000)return invalid('卖一报价时间无效或已超过 30 秒，请刷新');
  if(!Array.isArray(book?.asks)||!book.asks.length)return invalid('当前没有有效卖一，无法估算限价挂单');
  if(!Array.isArray(book.bids)||book.asks.length>1000||book.bids.length>1000)return invalid('期权盘口档位无效，请刷新');
  let priorAsk=0,priorBid=Infinity;
  for(const [rows,bid] of [[book.asks,false],[book.bids,true]])for(const row of rows){
    const price=number(row?.price),q=number(row?.qty);
    if(!positive(price)||price>1e15||!positive(q)||q>1e15||bid&&price>=priorBid||!bid&&price<=priorAsk)return invalid('期权盘口价格、数量或次序无效，请刷新');
    if(bid)priorBid=price;else priorAsk=price;
  }
  const price=number(book.asks[0].price),askQty=number(book.asks[0].qty),bestBid=book.bids.length?number(book.bids[0].price):null;
  if(bestBid!==null&&bestBid>=price)return invalid('期权买卖盘交叉，等待新的卖一报价');
  const scaled=(v,places)=>{const[m,e='0']=String(v).toLowerCase().split('e'),fraction=(m.split('.')[1]||'').length;return BigInt(m.replace('.',''))*10n**BigInt(places+Number(e)-fraction);};
  const tickPlaces=Math.max(decimals(price),decimals(tick));
  if(tickPlaces>14||scaled(price,tickPlaces)%scaled(tick,tickPlaces)!==0n)return invalid('卖一价格不符合合约价格步长，请刷新');
  const precision=decimals(step),qty=units=>Number((units*step).toFixed(precision)),lotPlaces=Math.max(precision,decimals(minimum)),minimumScaled=scaled(minimum,lotPlaces),stepScaled=scaled(step,lotPlaces),minUnits=Number((minimumScaled+stepScaled-1n)/stepScaled);
  const fraction=contract.spotDeductBase===true?spotRate:spotRate/(1+spotRate),feePerCoin=Math.min(rate*S0,cap*price);
  const perCoin=K+feePerCoin+delivery*K+fraction*price;
  let units=Math.floor(A*(1-fraction)/perCoin/step);
  if(!Number.isSafeInteger(minUnits)||!Number.isSafeInteger(units))return invalid('金额或数量步长超出可安全计算范围');
  const evaluate=count=>{const q=qty(count),gross=q*price,openFee=q*feePerCoin,capital=q*K,deliveryFeeReserve=delivery*capital,spotFeeReserve=fraction*(A+gross),feeReserve=openFee+deliveryFeeReserve+spotFeeReserve;return{q,gross,openFee,capital,deliveryFeeReserve,spotFeeReserve,feeReserve,reserve:capital+feeReserve};};
  if(units<minUnits){if(evaluate(minUnits).reserve<=A)units=minUnits;else return invalid(`当次资金不足以覆盖最小交易数量 ${qty(minUnits)} BTC 及费用预留`);}
  let sized=evaluate(units);
  if(sized.reserve>A){units--;if(units<minUnits)return invalid('当次资金不足以覆盖最小挂单数量及费用预留');sized=evaluate(units);}
  if(Number.isSafeInteger(units+1)){const next=evaluate(units+1);if(next.reserve<=A){units++;sized=next;}}
  if(sized.q<minimum||!positive(sized.q)||sized.reserve>A)return invalid('当次资金不足以覆盖挂单数量及费用预留');
  if(sized.q>maximum)return invalid(`本次预计挂单数量超过合约单笔上限 ${maximum} BTC，请减少当次资金`);
  const days=(expires-now)/86400000,netIncome=sized.gross-sized.openFee,term=netIncome/A,annual=term*365/days;
  const result={valid:true,quoteOnly:true,canSubmit:false,quoteMode:'ask_limit',conditional:true,fillGuaranteed:false,executionStatus:'unfilled_limit_quote',amount:A,...sized,netIncome,term,annual,days,
    bestAsk:price,bestAskQty:askQty,bestBid,bestBidQty:book.bids.length?number(book.bids[0].qty):null,averagePrice:price,levelsUsed:0,depthQty:null,
    unused:A-sized.capital,freeCash:Math.max(0,A-sized.reserve),expires,strike:K,quoteTime:timestamp,feeEstimateOnly:true,feeRateBasis:'published_standard'};
  const currency=coin(contract.settleCoin??contract.currency);if(['USDT','USDC'].includes(currency))result.settleCoin=currency;
  if(Object.values(result).some(v=>typeof v==='number'&&!finite(v)))return invalid('报价参数超出可计算范围');
  return result;
}


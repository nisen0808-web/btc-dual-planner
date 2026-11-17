const finite=v=>typeof v==='number'&&Number.isFinite(v);
const number=v=>typeof v==='number'?v:typeof v==='string'&&v.trim()!==''?Number(v):NaN;
const positive=v=>finite(v)&&v>0;
const decimals=v=>{const [m,e='0']=String(v).toLowerCase().split('e');return Math.max(0,(m.split('.')[1]||'').length-Number(e));};
const scaled=(v,places)=>{const [m,e='0']=String(v).toLowerCase().split('e');return BigInt(m.replace('.',''))*10n**BigInt(places+Number(e)-(m.split('.')[1]||'').length);};
const validSymbol=s=>typeof s==='string'&&/^BTC-\d{6}-(?:[1-9]\d{0,8})(?:\.\d{1,4})?-C$/.test(s);
function symbolExpiry(symbol){
 const date=symbol.split('-')[1],year=2000+Number(date.slice(0,2)),month=Number(date.slice(2,4)),day=Number(date.slice(4,6));
 const expiry=Date.UTC(year,month-1,day,8),check=new Date(expiry);
 return check.getUTCFullYear()===year&&check.getUTCMonth()===month-1&&check.getUTCDate()===day?expiry:null;
}

/** Quote a covered-size CALL sell; spot holdings are not options margin. */
export function calculateCallQuote(quantityBTC,contract,book,spot,serverTime,{quoteMode='ask_limit'}={}){
 const fail=reason=>({valid:false,quoteOnly:true,canSubmit:false,quoteMode,conditional:quoteMode==='ask_limit',fillGuaranteed:false,reason,errors:[reason]});
 const requestedBTC=number(quantityBTC),S0=number(spot),now=number(serverTime);
 if(!['ask_limit','bid_taker'].includes(quoteMode))return fail('请选择有效的报价方式');
 if(!positive(requestedBTC)||requestedBTC>1e9||decimals(requestedBTC)>14)return fail('请填写有效的本次高卖 BTC 数量');
 if(!positive(S0)||S0>1e15||!Number.isSafeInteger(now)||now<=0)return fail('BTC 指数价格或行情时间无效，请刷新');
 if(!contract||!validSymbol(contract.symbol)||contract.settleCoin!=='USDT'||contract.unit!==1)return fail('请先选择有效的 BTC/USDT CALL 合约');
 const K=number(contract.strike),expires=number(contract.expires),step=number(contract.step),minimum=number(contract.min),maximum=number(contract.max),tick=number(contract.priceTick);
 if(!positive(K)||K>1e15||number(contract.symbol.split('-')[2])!==K||!Number.isSafeInteger(expires)||expires<=now)return fail('高卖价无效或 CALL 合约已到期');
 if(symbolExpiry(contract.symbol)!==expires)return fail('CALL 合约代码日期与到期时刻不一致');
 if(!positive(step)||step>1||decimals(step)>14||!positive(minimum)||!positive(maximum)||maximum>1e9||minimum>maximum||decimals(minimum)>14)return fail('CALL 合约数量步长或单笔数量限制无效');
 if(!positive(tick)||tick>1e15||decimals(tick)>14)return fail('CALL 合约价格步长未核实');
 const rate=number(contract.taker),cap=number(contract.cap),delivery=number(contract.delivery),deliveryCap=number(contract.deliveryCap),spotRate=number(contract.spot);
 if(![rate,cap,delivery,deliveryCap,spotRate].every(v=>finite(v)&&v>=0&&v<=1))return fail('公开标准费率无效，请刷新');
 if(book?.symbol!==contract.symbol)return fail('CALL 合约与盘口不一致或盘口缺少合约标识');
 const quoteTime=number(book?.time);
 if(!Number.isSafeInteger(quoteTime)||quoteTime<=0||quoteTime>now+2000||now-quoteTime>=30000)return fail('CALL 盘口时间无效或已超过 30 秒，请刷新');
 if(!Array.isArray(book?.bids)||!Array.isArray(book?.asks)||book.bids.length>1000||book.asks.length>1000)return fail('CALL 盘口格式无效');
 const bids=[],asks=[];
 for(const [rows,output,bid]of [[book.bids,bids,true],[book.asks,asks,false]]){
  let previous=bid?Infinity:0;
  for(const level of rows){
   const price=number(level?.price),qty=number(level?.qty),places=Math.max(decimals(price),decimals(tick));
   if(!positive(price)||price>1e15||!positive(qty)||qty>1e9||bid&&price>=previous||!bid&&price<=previous)return fail('CALL 盘口价格、数量或档位顺序无效');
   if(places>14||scaled(price,places)%scaled(tick,places)!==0n)return fail('CALL 盘口价格不符合合约价格步长');
   output.push({price,qty});previous=price;
  }
 }
 if(bids.length&&asks.length&&bids[0].price>=asks[0].price)return fail('CALL 买卖盘交叉，等待新的报价');
 if(quoteMode==='ask_limit'&&!asks.length)return fail('当前没有有效 CALL 卖一，无法估算挂单收益');
 if(quoteMode==='bid_taker'&&!bids.length)return fail('当前没有有效 CALL 买盘，无法估算卖出收入');
 const places=Math.max(decimals(requestedBTC),decimals(step)),units=scaled(requestedBTC,places)/scaled(step,places);
 if(units>BigInt(Number.MAX_SAFE_INTEGER))return fail('BTC 数量超出可安全计算范围');
 const q=Number((Number(units)*step).toFixed(decimals(step)));
 if(q<minimum||q<=0)return fail('BTC 数量不足 CALL 合约最小交易量 '+minimum+' BTC');
 if(q>maximum)return fail('本次 CALL 数量超过单笔上限 '+maximum+' BTC，请减少数量');
 let gross=0,openFee=0,levelsUsed=0,remaining=q;
 const feePerCoin=price=>Math.min(rate*S0,cap*price);
 if(quoteMode==='ask_limit'){
  gross=q*asks[0].price;openFee=q*feePerCoin(asks[0].price);remaining=0;
 }else{
  for(const level of bids){
   const taken=Math.min(remaining,level.qty);if(taken<=0)continue;
   gross+=taken*level.price;openFee+=taken*feePerCoin(level.price);remaining-=taken;levelsUsed++;
   if(remaining<=q*Number.EPSILON*Math.max(32,bids.length*4))break;
  }
  if(remaining>q*Number.EPSILON*Math.max(32,bids.length*4))return fail('当前 CALL 买盘深度不足以覆盖整笔数量，不展示整笔成交收益');
 }
 const capitalBasis=requestedBTC*S0,netIncome=gross-openFee,days=(expires-now)/86400000,term=netIncome/capitalBasis;
 const result={valid:true,quoteOnly:true,canSubmit:false,quoteMode,conditional:quoteMode==='ask_limit',fillGuaranteed:false,executionStatus:quoteMode==='ask_limit'?'unfilled_limit_quote':'quoted',
  requestedBTC,q,leftoverBTC:Math.max(0,requestedBTC-q),spot:S0,amount:capitalBasis,capitalBasis,capitalBasisLabel:'本次 BTC 数量 × 当前指数',capital:capitalBasis,
  gross,openFee,netIncome,term,annual:term*365/days,days,expires,strike:K,quoteTime,
  bestAsk:asks[0]?.price??null,bestAskQty:asks[0]?.qty??null,bestBid:bids[0]?.price??null,bestBidQty:bids[0]?.qty??null,
  averagePrice:gross/q,levelsUsed,depthQty:quoteMode==='ask_limit'?null:bids.reduce((sum,l)=>sum+l.qty,0),
  feeEstimateOnly:true,feeRateBasis:'published_standard',openingFeeRate:rate,openingFeeCap:cap,deliveryFeeRate:delivery,deliveryFeeCap:deliveryCap,spotFeeRate:spotRate,
  settlementLoss:null,deliveryFee:null,spotFee:null,requiredMargin:null,settleCoin:'USDT',incomeScope:'premium_less_opening_fee_only',
  marginNote:'现货 BTC 不自动充当期权现金保证金；保证金需求须由账户核验，不能用现货市值代替。'};
 if(Object.values(result).some(v=>typeof v==='number'&&!finite(v)))return fail('CALL 报价超出可计算范围');
 return result;
}

export const calculateCallAskLimitQuote=(quantity,contract,book,spot,now)=>calculateCallQuote(quantity,contract,book,spot,now,{quoteMode:'ask_limit'});
export const calculateCallBidQuote=(quantity,contract,book,spot,now)=>calculateCallQuote(quantity,contract,book,spot,now,{quoteMode:'bid_taker'});

import { calculatePutQuote } from './put-quote.js';
export { calculatePutQuote } from './put-quote.js';
import { compareDual } from './dual.js';
import { compareBinanceDual } from './binance-dual.js';
import { compareOKXDual } from './okx-dual.js';

const TTL=30000;
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const positive=v=>finite(v)&&v>0;
const number=v=>typeof v==='number'?v:typeof v==='string'&&v.trim()!==''?Number(v):NaN;
const fail=reason=>({valid:false,quoteOnly:true,reason,errors:[reason]});
const coin=v=>typeof v==='string'?v.toUpperCase():'';
const optionFor=c=>c==='USDT'?'bybit':c==='USDC'?'deribit':null;
const comparer=p=>p==='bybit'?compareDual:p==='binance'?compareBinanceDual:p==='okx'?compareOKXDual:null;
const age=(x,now)=>positive(x?.receivedAt)&&x.receivedAt<=now?now-x.receivedAt:Infinity;
const fresh=(x,now)=>age(x,now)<TTL;
const order=(a,b)=>a<b?-1:a>b?1:0;
const pairOrder=(a,b)=>a.contract.expires-b.contract.expires||a.contract.strike-b.contract.strike||order(a.optionPlatform,b.optionPlatform)||order(a.dualPlatform||'',b.dualPlatform||'')||order(String(a.entry?.id||''),String(b.entry?.id||''));
function compare(platform,amount,model,data,now){try{return comparer(platform)(amount,model,data,now);}catch{return{valid:false,reason:'双币报价格式异常，无法安全校验'};}}
function levels(book){return Array.isArray(book?.bids)?book.bids.map(x=>({price:number(x?.price),qty:number(x?.qty)})).filter(x=>positive(x.price)&&x.price<=1e15&&positive(x.qty)).sort((a,b)=>b.price-a.price):[];}
function metrics(book){const bids=levels(book);return{bestBid:bids[0]?.price??null,bestBidQty:bids[0]?.qty??null,depthQty:bids.reduce((sum,x)=>sum+x.qty,0)};}
export function priceFilterProblem({strike=null,minStrike=null,maxStrike=null}={}){
  if(![strike,minStrike,maxStrike].every(v=>v===null||positive(v)&&v<=1e15))return '接币价筛选须为大于 0 的有效数值，未填写的一端请留空';
  if(minStrike!==null&&maxStrike!==null&&minStrike>maxStrike)return '最低接币价不能高于最高接币价';
  if(strike!==null&&(minStrike!==null&&strike<minStrike||maxStrike!==null&&strike>maxStrike))return '精确接币价不在所填区间内';
  return null;
}
export function matchesStrike(contract,filters={}){
  if(priceFilterProblem(filters)||!positive(contract?.strike))return false;
  const{strike=null,minStrike=null,maxStrike=null}=filters,K=contract.strike;
  return(strike===null||K===strike)&&(minStrike===null||K>=minStrike)&&(maxStrike===null||K<=maxStrike);
}
function reasonsFor(errors){const map=new Map();for(const e of errors){const old=map.get(e.code);if(old)old.count++;else map.set(e.code,{code:e.code,count:1,reason:e.reason});}return[...map.values()].sort((a,b)=>order(a.code,b.code));}
function filtersOf(input){return{strike:input.strike??null,minStrike:input.minStrike??null,maxStrike:input.maxStrike??null};}
function coverage(stats){return{scope:'provided_snapshots',benchmarkScope:'current_valid_quotes',completeMarketCoverage:false,maxDays:stats.maxDays,marketsChecked:stats.marketsUsed,contractsChecked:stats.contractsExamined,quoteEntriesChecked:stats.entriesProvided,note:'仅覆盖本次已读取的目录与当前有效报价；没有双币配对仍展示 PUT 盘口。'};}

/** Real quote matching. An absent/invalid dual quote never suppresses a valid PUT. */
export function findLiveCandidates(input={}){
  const{amount,currency,markets=[],entries=[],onlyBelowSpot=true,maxDays=7,now=Date.now()}=input;
  const cur=coin(currency),filters=filtersOf(input),errors=[],candidates=[];
  const stats={marketsProvided:Array.isArray(markets)?markets.length:0,marketsUsed:0,contractsExamined:0,activeContracts:0,
    entriesProvided:Array.isArray(entries)?entries.length:0,exactMatches:0,priceFiltered:0,expirationOutsideRange:0,
    candidates:0,candidateCount:0,pairedCandidates:0,unpairedCandidates:0,maxDays};
  const add=(code,reason,context={})=>errors.push({code,reason,...context});
  const finish=valid=>({valid,quoteOnly:true,currency:cur,maxDays,priceFilters:filters,candidates,stats,errors,reasons:reasonsFor(errors),coverage:coverage(stats)});
  const problem=priceFilterProblem(filters);
  if(!positive(number(amount))||number(amount)>1e15||!optionFor(cur)||!Array.isArray(markets)||!Array.isArray(entries)||!positive(now)||typeof onlyBelowSpot!=='boolean'||maxDays!==null&&(!positive(maxDays)||maxDays>3650)||problem){add('input_invalid',problem||'投入金额、币种、到期天数或目录参数无效');return finish(false);}
  const chosen=new Map();
  for(const market of markets){
    if(market?.platform!==optionFor(cur))continue;
    if(!positive(market.spot)||!positive(market.time)||!Array.isArray(market.contracts)){add('market_invalid','期权目录缺少有效指数、时间或合约列表');continue;}
    if(!fresh(market,now)){add('market_stale','期权目录接收后已超过 30 秒或时间无效');continue;}
    const old=chosen.get(market.platform);if(!old||old.receivedAt<market.receivedAt||old.receivedAt===market.receivedAt&&old.time<market.time)chosen.set(market.platform,market);
  }
  stats.marketsUsed=chosen.size;
  const eligible=entries.filter(e=>comparer(e?.platform)&&coin(e.currency)===cur&&positive(e.strike)&&positive(e.expires)&&Number.isInteger(e.expires)&&e.id!=null&&String(e.id).trim()!==''&&positive(e.data?.serverTime)&&fresh(e.data,now));
  const seen=new Set();
  for(const market of chosen.values()){
    const clock=market.time+age(market,now);
    for(const contract of market.contracts){
      stats.contractsExamined++;const context={optionPlatform:market.platform,symbol:contract?.symbol};
      if(!contract||typeof contract.symbol!=='string'||!contract.symbol||!positive(contract.strike)||!positive(contract.expires)||!Number.isInteger(contract.expires)||contract.expires<=clock||!positive(contract.bid)||contract.active===false||contract.is_active===false){add('contract_inactive','合约已失效或目录无有效买价',context);continue;}
      const remainingDays=(contract.expires-clock)/86400000;
      if(maxDays!==null&&contract.expires-clock>maxDays*86400000){stats.expirationOutsideRange++;add('expiration_outside_range','合约剩余到期时间超过所选上限',context);continue;}
      if(!matchesStrike(contract,filters)){stats.priceFiltered++;continue;}
      if(onlyBelowSpot&&contract.strike>market.spot)continue;
      const key=`${market.platform}|${contract.symbol}`;if(seen.has(key))continue;seen.add(key);stats.activeContracts++;
      const base={optionPlatform:market.platform,contract,market,currency:cur,remainingDays,quoteOnly:true};
      const matching=eligible.filter(e=>e.strike===contract.strike&&e.expires===contract.expires);
      const sourceSeen=new Set();let paired=0,lastReason='本次已读取报价中没有同币种、接币价和到期时刻的可用双币；仍展示 PUT 当前报价';
      for(const entry of matching.slice().sort((a,b)=>b.data.receivedAt-a.data.receivedAt||b.data.serverTime-a.data.serverTime)){
        const unique=`${entry.platform}|${String(entry.id)}`;if(sourceSeen.has(unique))continue;sourceSeen.add(unique);stats.exactMatches++;
        const model={valid:true,netIncome:0,days:remainingDays,strike:contract.strike,expires:contract.expires,settleCoin:cur};
        const precheck=compare(entry.platform,amount,model,entry.data,now);
        if(!precheck.valid){lastReason=precheck.reason||'同条件双币报价或金额规则校验失败';add('dual_precheck_failed',lastReason,{...context,dualPlatform:entry.platform,entryId:String(entry.id)});continue;}
        const id=[market.platform,contract.symbol,entry.platform,String(entry.id)].map(encodeURIComponent).join('|');
        candidates.push({...base,id,dualPlatform:entry.platform,entry,precheck});paired++;
      }
      if(!paired){candidates.push({...base,id:[market.platform,contract.symbol,'put-only'].map(encodeURIComponent).join('|'),dualPlatform:null,entry:null,unmatchedReason:lastReason});stats.unpairedCandidates++;}
      stats.pairedCandidates+=paired;
    }
  }
  candidates.sort(pairOrder);stats.candidates=stats.candidateCount=candidates.length;return finish(true);
}

/** Current cash-income comparison only; no fixing price or future portfolio is constructed. */
export function rankLiveQuotes(input={}){
  const{amount,books=[],now=Date.now()}=input,found=findLiveCandidates({...input,now});
  const errors=found.errors.slice(),rows=[],unavailableQuotes=[],stats={...found.stats,booksProvided:Array.isArray(books)?books.length:0,evaluatedPairs:0,rows:0,rowCount:0,pairedRows:0,unpairedRows:0,positiveRows:0,negativeRows:0,bestRows:0};
  const finish=valid=>({...found,valid,rows,unavailableQuotes,stats,errors,reasons:reasonsFor(errors),coverage:coverage(stats)});
  if(!found.valid)return finish(false);
  if(!Array.isArray(books)){errors.push({code:'books_invalid',reason:'买盘记录格式无效'});return finish(false);}
  const map=new Map();for(const r of books){if(!r||typeof r.platform!=='string'||typeof r.symbol!=='string')continue;const key=`${r.platform}|${r.symbol}`,old=map.get(key);if(!old||(r.receivedAt||0)>(old.receivedAt||0))map.set(key,r);}
  const add=(candidate,code,reason,bookRecord=null)=>{
    errors.push({code,reason,id:candidate.id,symbol:candidate.contract.symbol});
    const usable=bookRecord&&fresh(bookRecord,now);
    unavailableQuotes.push({...candidate,bookRecord,quoteOnly:true,reason,...(usable?metrics(bookRecord.book):{bestBid:null,bestBidQty:null,depthQty:null}),quoteTime:usable?bookRecord.book?.time:null});
  };
  for(const candidate of found.candidates){
    const{market,contract,entry}=candidate,record=map.get(`${candidate.optionPlatform}|${contract.symbol}`);
    if(!record){add(candidate,'book_missing','尚未取得此 PUT 的买盘深度');continue;}
    if(!fresh(record,now)||!positive(record.book?.time)){add(candidate,'book_stale','买盘接收后已超过 30 秒或时间无效',record);continue;}
    const clock=market.time+age(market,now);
    stats.evaluatedPairs++;const rawQuote=calculatePutQuote(amount,contract,record.book,market.spot,clock);
    if(!rawQuote.valid){add(candidate,/深度不足/.test(rawQuote.reason)?'depth_insufficient':'quote_invalid',rawQuote.reason,record);continue;}
    const quote={...rawQuote,settleCoin:found.currency};let dual=null,unmatchedReason=candidate.unmatchedReason||null;
    if(entry){
      if(Math.abs(record.book.time-entry.data.serverTime)>TTL)unmatchedReason='期权买盘与双币来源时间相差超过 30 秒，暂不比较';
      else{const checked=compare(entry.platform,amount,quote,entry.data,now);if(checked.valid)dual=checked;else unmatchedReason=checked.reason||'双币报价已失效';}
      if(!dual)errors.push({code:'dual_unavailable',reason:unmatchedReason,id:candidate.id});
    }
    const incomeDifference=dual?quote.netIncome-dual.income:null;
    rows.push({...candidate,quote,model:quote,dual,bookRecord:record,incomeDifference,difference:incomeDifference,
      quoteOnly:true,estimateOnly:true,bestForContract:!dual,unmatchedReason,
      benchmarkScope:'current_valid_quotes',quoteTime:record.book.time,dualQuoteTime:dual?entry.data.serverTime:null});
  }
  const grouped=new Map();for(const row of rows){if(!row.dual)continue;const key=`${row.optionPlatform}|${row.contract.symbol}`,all=grouped.get(key)||[];all.push(row);grouped.set(key,all);}
  for(const group of grouped.values()){
    const best=group.slice().sort((a,b)=>b.dual.income-a.dual.income||pairOrder(a,b))[0];best.bestForContract=true;
  }
  rows.sort((a,b)=>a.dual&&!b.dual?-1:!a.dual&&b.dual?1:a.dual&&b.dual?b.incomeDifference-a.incomeDifference||pairOrder(a,b):pairOrder(a,b));
  stats.rows=stats.rowCount=rows.length;stats.pairedRows=rows.filter(r=>r.dual).length;stats.unpairedRows=rows.length-stats.pairedRows;
  stats.positiveRows=rows.filter(r=>r.incomeDifference!==null&&r.incomeDifference>0).length;stats.negativeRows=rows.filter(r=>r.incomeDifference!==null&&r.incomeDifference<0).length;stats.bestRows=rows.filter(r=>r.bestForContract).length;
  return finish(true);
}

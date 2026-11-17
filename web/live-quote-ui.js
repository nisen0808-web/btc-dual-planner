import {platforms,loadMarket,loadBook} from './market.js';
import {loadDualCatalogues} from './dual-catalogue.js';
import {findLiveCandidates,rankLiveQuotes,matchesStrike,priceFilterProblem} from './live-quotes.js';
import {deriveStrategyCosts} from './strategy-costs.js';

const names={bybit:'Bybit',deribit:'Deribit',binance:'Binance 普通双币',okx:'OKX'};
const links={bybit:'https://www.bybit.com/en/earn/dual-asset',binance:'https://www.binance.com/en/dual-investment',okx:'https://www.okx.com/earn/dual'};
const num=(v,d=2)=>Number.isFinite(Number(v))?Number(v).toLocaleString('zh-CN',{maximumFractionDigits:d}):'—';
const pct=v=>Number.isFinite(v)?num(v*100,4)+'%':'—';
const dt=v=>Number.isFinite(v)&&v>0?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Singapore',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(v))+' SGT':'—';
const finite=v=>typeof v==='number'&&Number.isFinite(v);

/** One SELL PUT strategy, with every ordinary dual platform kept visible. */
export function groupStrategyRows(rows,{sources=[],errors=[],currency='USDT'}={}){
 const groups=new Map();
 for(const row of rows){const key=row.optionPlatform+'|'+row.contract.symbol;
  if(!groups.has(key))groups.set(key,{...row,id:key,quotedRows:[],comparisons:[]});
  groups.get(key).quotedRows.push(row);
 }
 for(const group of groups.values()){
  group.costs=deriveStrategyCosts(group.quote,group.contract,group.optionPlatform);
  group.comparisons=['binance','okx','bybit'].map(platform=>{
   const matches=group.quotedRows.filter(r=>r.dualPlatform===platform&&r.dual).sort((a,b)=>b.dual.income-a.dual.income);
   if(matches.length)return {platform,valid:true,row:matches[0],dual:matches[0].dual,products:matches.length,
    untriggeredDifference:group.quote.netIncome-matches[0].dual.income,
    triggeredFeeDifferenceLower:finite(group.costs.triggeredFeeNetLower)?group.costs.triggeredFeeNetLower-matches[0].dual.income:null};
   const unavailable=group.quotedRows.find(r=>r.dualPlatform===platform&&r.unmatchedReason),source=sources.find(s=>s.platform===platform);
   const error=errors.find(e=>e.symbol===group.contract.symbol&&e.dualPlatform===platform);
   const reason=currency==='USDC'&&['binance','okx'].includes(platform)?'当前公开双币通道为 BTC/USDT，不能与 USDC 按 1:1 比较':unavailable?.unmatchedReason||error?.reason||(source?.status!=='ready'?source?.reason:null)||'没有同币种、同接币价、同到期时刻且符合当次金额的有效公开产品';
   return {platform,valid:false,reason};
  });
  const valid=group.comparisons.filter(c=>c.valid);
  group.incomeDifference=valid.length?Math.min(...valid.map(c=>c.untriggeredDifference)):null;
 }
 return [...groups.values()].sort((a,b)=>finite(a.incomeDifference)&&finite(b.incomeDifference)?b.incomeDifference-a.incomeDifference:a.incomeDifference!==null?-1:b.incomeDifference!==null?1:a.contract.expires-b.contract.expires||a.contract.strike-b.contract.strike);
}

/** Only fixed public market/product/orderbook GETs; no account or trade requests. */
export async function collectLiveInputs(input,{marketLoader=loadMarket,catalogueLoader=loadDualCatalogues,bookLoader=loadBook,clock=Date.now,isCurrent=()=>true,onMarkets=()=>{},onProgress=()=>{}}={}){
 const maxDays=input.maxDays===undefined?7:input.maxDays,issue=priceFilterProblem(input);
 if(issue)throw Error(issue);
 if(!finite(input.amount)||input.amount<=0||input.amount>1e15)throw Error('请输入有效的当次投入资金');
 if(maxDays!==null&&(!finite(maxDays)||maxDays<=0||maxDays>3650))throw Error('请选择有效的到期天数');
 const ids=Object.keys(platforms).filter(id=>platforms[id].currency===input.currency),markets=[],errors=[];
 if(!ids.length)throw Error('请选择 USDT 或 USDC');
 const results=await Promise.allSettled(ids.map(async id=>({...await marketLoader(id),platform:id,receivedAt:clock()})));
 results.forEach((r,i)=>r.status==='fulfilled'?markets.push(r.value):errors.push((names[ids[i]]||ids[i])+' 公开行情读取失败'));
 if(!isCurrent())return null;onMarkets(markets);
 const now=clock(),contracts=markets.flatMap(m=>{
  const serverNow=m.time+Math.max(0,now-m.receivedAt);
  return m.contracts.filter(c=>c.expires>serverNow&&(maxDays===null||c.expires-serverNow<=maxDays*86400000)&&matchesStrike(c,input)&&(!input.onlyBelowSpot||c.strike<=m.spot));
 });
 const catalogue=await catalogueLoader(input.currency,contracts);if(!isCurrent())return null;
 const entries=catalogue.entries||[],found=findLiveCandidates({...input,markets,entries,now:clock()});
 if(!found.valid)throw Error(found.reasons?.[0]?.reason||found.errors?.[0]?.reason||'筛选条件无效');
 const tasks=[...new Map((found.candidates||[]).map(c=>[c.optionPlatform+'|'+c.contract.symbol,c])).values()],books=[];let cursor=0,done=0;
 onProgress({done,total:tasks.length});
 await Promise.all(Array.from({length:Math.min(6,tasks.length)},async()=>{
  while(isCurrent()&&cursor<tasks.length){const c=tasks[cursor++];
   try{const book=await bookLoader(c.optionPlatform,c.contract.symbol);if(isCurrent())books.push({platform:c.optionPlatform,symbol:c.contract.symbol,book,receivedAt:clock()});}
   catch{errors.push(c.contract.symbol+' 买盘读取失败');}
   if(isCurrent())onProgress({done:++done,total:tasks.length});
  }
 }));
 return isCurrent()?{markets,entries,books,sources:catalogue.sources||[],errors,requestedBooks:tasks.length,receivedAt:clock()}:null;
}

export function mountLiveQuoteBoard({doc=document,collect=collectLiveInputs,rank=rankLiveQuotes,clock=Date.now}={}){
 const el=id=>doc.getElementById(id),set=(id,value)=>{const n=el(id);if(n)n.textContent=value;};
 let snapshot=null,marketsForPrices=[],generation=0,running=false,destroyed=false,debounce=null,limit=20,lastView='',selectedStrategy=null;const dynamic=new Map();
 const numberInput=id=>el(id).value.trim()===''?null:Number(el(id).value);
 const input=()=>({amount:Number(el('scanAmount').value),currency:el('scanCurrency').value,strike:el('scanStrike').value==='all'?null:Number(el('scanStrike').value),minStrike:numberInput('scanMinStrike'),maxStrike:numberInput('scanMaxStrike'),maxDays:el('scanMaxDays').value==='all'?null:Number(el('scanMaxDays').value),onlyBelowSpot:el('scanBelowSpot').checked});
 function save(){try{localStorage.setItem('btc-live-quotes-v1',JSON.stringify({amount:el('scanAmount').value,currency:el('scanCurrency').value,strike:el('scanStrike').value,minStrike:el('scanMinStrike').value,maxStrike:el('scanMaxStrike').value,maxDays:el('scanMaxDays').value}));}catch{}}
 function conditions(){const p=input();set('scanAmountUnit',p.currency);set('scanConditions',`${p.currency==='USDT'?'Bybit USDT':'Deribit USDC'} · 当次投入 ${num(p.amount)} ${p.currency} · 接币价 ${p.strike===null?'全部真实价格':num(p.strike)}${p.minStrike!==null?'，最低 '+num(p.minStrike):''}${p.maxStrike!==null?'，最高 '+num(p.maxStrike):''} · ${p.maxDays===null?'全部期限':p.maxDays+' 天以内'} · 仅比较同币种、同接币价、同到期时刻`);}
 function clear(message){lastView='';dynamic.clear();el('scanResultsBody').replaceChildren();el('scanEmpty').hidden=false;set('scanEmpty',message);el('scanMore').hidden=true;set('scanCoverage','');set('scanUpdated','');el('scanSources').replaceChildren();}
 function showMarkets(markets){
  marketsForPrices=markets;const p=input(),market=markets[0];
  set('liveSpotValue',market?num(market.spot)+' '+p.currency:'—');set('liveSpotSource',market?.source||'公开行情暂不可用');set('liveSpotTime',market?dt(market.time):'');
  const now=clock(),strikes=[...new Set(markets.flatMap(m=>{
   const serverNow=m.time+Math.max(0,now-m.receivedAt);
   return m.contracts.filter(c=>c.bid>0&&c.expires>serverNow&&(p.maxDays===null||c.expires-serverNow<=p.maxDays*86400000)&&(!p.onlyBelowSpot||c.strike<=m.spot)).map(c=>c.strike);
  }))].sort((a,b)=>a-b),selected=el('scanStrike').value||'all';
  const option=(value,label)=>{const o=doc.createElement('option');o.value=String(value);o.textContent=label;return o;};
  el('scanStrike').replaceChildren(option('all','全部接币价'),...strikes.map(s=>option(s,num(s)+' '+p.currency)));
  if(selected!=='all'&&!strikes.includes(Number(selected)))el('scanStrike').append(option(selected,num(Number(selected))+' · 当前暂无有效买盘'));
  el('scanStrike').value=selected;el('scanStrike').disabled=false;set('scanPriceHint',strikes.length?`${strikes.length} 个真实执行价；可精确选择，也可填写价格范围`:'当前期限内暂无有效买盘；可调整到期天数');
 }
 function sourceList(items){el('scanSources').replaceChildren(...items.map(s=>{const n=doc.createElement('div');n.className='live-source '+(s.status==='ready'?'ready':'unavailable');n.textContent=(s.name||names[s.platform]||s.platform)+'：'+(s.status==='ready'?`${s.count??0} 条同条件公开报价`:(s.reason||'暂不可读'));return n;}));}
 function cell(row,label,value,details='',className=''){
  const td=doc.createElement('td');td.dataset.label=label;td.className=className;const strong=doc.createElement('strong');strong.textContent=value;td.append(strong);
  if(details){const small=doc.createElement('small');small.textContent=details;td.append(small);}row.append(td);return td;
 }
 function addRate(td,label,value){const block=doc.createElement('div'),caption=doc.createElement('span'),v=doc.createElement('b');block.className='live-rate';caption.textContent=label;v.textContent=pct(value);v.className=value<0?'negative':'positive';block.append(caption,v);td.append(block);return v;}
 function line(parent,text,className=''){const n=doc.createElement('p');n.className=className;n.textContent=text;parent.append(n);return n;}
 function link(parent,url,label){const a=doc.createElement('a');a.href=url;a.target='_blank';a.rel='noopener';a.textContent=label;parent.append(a);return a;}
 const signed=(n,cur)=>(n>=0?'多拿 ':'少拿 ')+num(Math.abs(n))+' '+cur;
 function drawSummary(groups){
  const area=el('strategySummary');if(!area)return;
  const r=groups.find(g=>g.id===selectedStrategy);area.replaceChildren();
  if(!r){line(area,selectedStrategy?'已选方案的报价已失效，请更新后重新选择。':'本次双币买入策略');line(area,'选择下方一个 SELL PUT 方案，汇总这笔资金、接币条件与全部费用规则。仅记录方案，不下单。');return;}
  const q=r.quote,c=r.contract,cur=r.currency;
  line(area,`已选：${names[r.optionPlatform]} ${c.symbol}`,'strategy-summary-title');
  line(area,`当次 ${num(q.amount)} ${cur} · 接币价 ${num(c.strike)} · 到期 ${dt(c.expires)} · 卖 PUT ${num(q.q,8)} BTC 名义量`);
  line(area,`当前买盘毛权利金 ${num(q.gross)}；开仓费 ${num(q.openFee)}；本金备资 ${num(q.capital)}；余款 ${num(q.unused)} ${cur}。均为未成交报价。`);
  line(area,`未触发（官方结算价高于接币价）：资金 + 权利金 − 开仓费，按当前报价为 ${num(q.amount+q.netIncome)} ${cur}；交割费和现货费为 0。`);
  line(area,'触发（官方结算价低于或等于接币价）：结算损失 L = 名义 BTC 数量 × max（接币价 − 官方结算价，0）；可买币资金 B = 当次资金 + 毛权利金 − 开仓费 − L − 交割费。');
  line(area,c.spotDeductBase===true?'接币规则：以 B 按真实现货买盘对面的卖价逐档买 BTC，再扣 BTC 现货手续费；按现货步长取整后保留余款。':'接币规则：先为现货手续费留资，以 B ÷（1 + 现货费率）按真实卖盘买 BTC，按现货步长取整后保留余款。');
  line(area,'到期结算价、实际买价、交割费与可接 BTC 数量现在未知；各平台结算指数可能不同。本页未连接账户，也不会执行到期买入。');
 }
 function feeLines(td,r){
  const q=r.quote,c=r.contract,cost=r.costs,cur=r.currency;
  line(td,`毛权利金 ${num(q.gross)} ${cur}；预计开仓费 ${num(q.openFee)} ${cur}`);
  line(td,`开仓：min(${pct(c.taker)} × 当前指数，${pct(c.cap)} × 每 BTC 成交权利金) × 数量。公开普通账户吃单口径，VIP/折扣未核验。`);
  if(c.deliveryExemptionConfirmed===true&&c.delivery===0)line(td,'交割：该日合约已确认免收，0；未触发也为 0。');
  else if(!(c.delivery>0))line(td,'交割：尚未确认免收资格或有效费率；实际费用未知，不把未确认的 0 当作免收。');
  else line(td,`交割：未触发为 0；触发后 min(${pct(c.delivery)} × 到期指数，${pct(c.deliveryCap)} × 到期内在价值) × 数量，实际金额待到期。${c.deliveryExemptionConfirmed!==true?'日合约减免资格未确认，不擅填 0。':''}`);
  line(td,`现货：未触发不买币，费用 0；触发后按 ${pct(c.spot)} 收取，${c.spotDeductBase===true?'从实际买到的 BTC 扣除，金额待成交':'在现货买入金额之外收取，金额待成交'}。`);
  line(td,'结算赔付是本金损失，另计；买卖价差和滑点不是手续费，未来实际金额未知。');
  const source=c.feeSourceURLs||{};link(td,source.opening||platforms[r.optionPlatform].feeUrl,'期权官方费率 ↗');
  link(td,source.spot||(r.optionPlatform==='bybit'?'https://www.bybit.com/en/help-center/article/Bybit-Spot-Fees-Explained':'https://support.deribit.com/hc/en-us/articles/31424969480093-Spot-Instruments'),'现货官方费率 ↗');
  line(td,'费率核对 '+(c.feeCheckedAt||'2026-10-23')+'；按当前公开规则，未来费率可能变化。');
  const details=doc.createElement('details'),summary=doc.createElement('summary');summary.textContent='查看全部手续费的保守边界';details.append(summary);
  if(finite(cost.futureFeeUpper)){
   line(details,`交割费严格上界 ${num(cost.deliveryFeeUpper)}；现货费上界 ${num(cost.spotFeeUpper)}；连同开仓费总上界 ${num(q.openFee+cost.futureFeeUpper)} ${cur}。`);
   line(details,'这是不假设到期价格、按费用封顶规则推导的宽上界，不是预计实际扣费；未扣期权本金损失及价差。');
   if(cost.fundingShortfall>0)line(details,`本金备资加该宽费用上界，超出当次资金 ${num(cost.fundingShortfall)} ${cur}。此数量不能声称已为极端费用全额备资。`,'negative');
  }else line(details,'交割豁免或费率封顶规则未确认，无法给出完整费用上界。');
  td.append(details);
 }
 function drawMatrix(td,r){
  td.textContent='';const grid=doc.createElement('div');grid.className='strategy-dual-grid';td.append(grid);
  for(const comparison of r.comparisons){const box=doc.createElement('section');box.className='strategy-dual-card';grid.append(box);
   const title=doc.createElement('strong');title.textContent=names[comparison.platform];box.append(title);
   if(!comparison.valid){line(box,'无同条件有效报价');line(box,comparison.reason);link(box,links[comparison.platform],'查看平台产品 ↗');continue;}
   const d=comparison.dual,cur=r.currency;
   addRate(box,'平台年化 APR',d.apr);line(box,`本期收入 ${num(d.income)} ${cur} · 本期收益率 ${pct(d.term)}（平台产品计息周期）`);
   line(box,`未触发：SELL PUT ${signed(comparison.untriggeredDifference,cur)}，已计当前开仓费，交割/现货费均为 0。`,comparison.untriggeredDifference>=0?'positive':'negative');
   line(box,comparison.untriggeredDifference>=0?`若触发，后续交割及现货费用合计超过 ${num(comparison.untriggeredDifference)} ${cur}，其权利金手续费后余额就低于该双币利息。`:'未触发时权利金净收入已低于该双币利息，发生后续费用会进一步减少。');
   line(box,'触发后的权利金手续费后差额 = 上述净差 − 实际交割费 − 实际现货费，当前金额待定；不代表最终 BTC 数量或总资产差。');
   if(finite(comparison.triggeredFeeDifferenceLower)){
    const detail=doc.createElement('details'),summary=doc.createElement('summary');summary.textContent='查看触发后的费用边界差额';detail.append(summary);
    line(detail,`按当前公开费率的宽边界，权利金手续费后余额差在 ${num(comparison.triggeredFeeDifferenceLower)} 至 ${num(comparison.untriggeredDifference)} ${cur} 之间；未计本金损失与买价偏差，不能称最终策略收益。`);box.append(detail);
   }
   line(box,`${d.estimateOnly?'个人资格/申购精度未核验':'按公开产品规则计算'}${comparison.products>1?'；此平台 '+comparison.products+' 条精确匹配产品，展示本期收入最高者':''}`);
   line(box,'双币来源 '+dt(comparison.row.dualQuoteTime));link(box,links[comparison.platform],'查看双币平台 ↗');
  }
 }
 function showRows(rows,unavailable=[]){
  const visible=rows.slice(0,limit),key=JSON.stringify([visible.map(r=>[r.id,r.quote?.q,r.quote?.gross,r.quote?.openFee,r.quote?.averagePrice,r.comparisons.map(d=>[d.platform,d.valid,d.dual?.income,d.dual?.apr,d.reason,d.row?.dualQuoteTime]),r.bookRecord?.receivedAt]),unavailable.map(r=>[r.contract?.symbol,r.reason])]);
  if(key!==lastView){lastView=key;dynamic.clear();el('scanResultsBody').replaceChildren(...visible.map((r,i)=>{
   const tr=doc.createElement('tr'),q=r.quote,c=r.contract,cur=r.currency;
   const first=cell(tr,'我的双币买入方案',`#${i+1} 接币价 ${num(c.strike)} ${cur}`,`${dt(c.expires)} · ${names[r.optionPlatform]} SELL PUT`),day=doc.createElement('small');first.append(day);
   cell(tr,'当前 PUT 买盘',num(q.bestBid)+' '+cur+' / BTC',`该笔均价 ${num(q.averagePrice)} ${cur}/BTC；买一量 ${num(q.bestBidQty,8)} BTC；总买盘 ${num(q.depthQty,8)} BTC`);
   const fees=cell(tr,'权利金与全部费用',num(q.q,8)+' BTC',`本金备资 ${num(q.capital)} ${cur}；余款含费用预留 ${num(q.unused)} ${cur}`);feeLines(fees,r);
   const put=cell(tr,'未触发：已扣全部适用手续费',num(q.netIncome)+' '+cur,'按当前买盘报价，尚未成交；交割费 0、现货费 0');addRate(put,'本期净收益率',q.term);const annual=addRate(put,'简单年化',q.annual);
   line(put,'触发：交割费与现货费待定，权利金手续费后余额 = 当前净权利金 − 这两项费用。');
   line(put,'实际到期资金还需扣期权本金损失；实际接 BTC 数量需等结算价、现货买价和深度确定。');
   const dual=cell(tr,'Binance / OKX / Bybit 逐项对比','');drawMatrix(dual,r);
   const comparison=cell(tr,'对比结论',finite(r.incomeDifference)?'未触发：对照最高双币利息 '+signed(r.incomeDifference,cur):'暂无可计算的同条件差额');
   line(comparison,'触发后两项未来费用已列出规则，但实际金额现在未知，不能把当前差额写成“扣完全部费用的最终收益”。');
   line(comparison,'不同平台的官方结算指数可能不同；同币种、接币价和到期时刻也不保证同一结算价或接币结果。');
   const source=cell(tr,'选择这笔策略 / 报价来源',dt(r.quoteTime??r.bookRecord?.book?.time));
   const choose=doc.createElement('button');choose.type='button';choose.className='strategy-select';choose.textContent='选用此 PUT 组建策略';choose.addEventListener('click',()=>{selectedStrategy=r.id;drawSummary(rows);});source.append(choose);
   link(source,platforms[r.optionPlatform].tradeUrl,'查看期权平台 ↗');
   const detail=doc.createElement('details'),summary=doc.createElement('summary'),raw=doc.createElement('p');summary.textContent='展开真实盘口';raw.textContent=c.symbol+'；'+q.levelsUsed+' 档买盘计价。 '+r.bookRecord.book.bids.slice(0,8).map(l=>`${num(Number(l.price))} ${cur} × ${num(Number(l.qty),8)} BTC`).join(' / ');detail.append(summary,raw);source.append(detail);
   dynamic.set(r.id,{annual,day});return tr;
  }));
  for(const u of unavailable.slice(0,10)){
   const tr=doc.createElement('tr'),c=u.contract||{},cur=u.currency||input().currency,book=u.bookRecord?.book||{},bids=Array.isArray(book.bids)?book.bids:[],best=finite(u.bestBid)?u.bestBid:Number(bids[0]?.price);
   cell(tr,'真实 PUT 合约',num(c.strike)+' '+cur,`${c.symbol||''} · ${dt(c.expires)}`);cell(tr,'当前 PUT 买盘',finite(best)?num(best)+' '+cur+' / BTC':'—','本次金额无法完整按此深度计算');cell(tr,'状态',u.reason||'当前金额或买盘深度不足');for(const label of ['净收入','双币','差额','来源'])cell(tr,label,'—');el('scanResultsBody').append(tr);
  }}
  for(const r of visible){const refs=dynamic.get(r.id),q=r.quote;if(refs){refs.annual.textContent=pct(q.annual);refs.annual.className=q.annual<0?'negative':'positive';refs.day.textContent=`剩余 ${num(q.days,4)} 天 · 真实公开报价，尚未成交`;}}
  el('scanMore').hidden=rows.length<=limit;set('scanMore',`显示更多（已显示 ${Math.min(limit,rows.length)}/${rows.length} 笔策略）`);el('scanEmpty').hidden=visible.length>0||unavailable.length>0;drawSummary(rows);
 }
 function render(){
  conditions();if(!snapshot)return;const p=input(),result=rank({...p,...snapshot,now:clock()}),all=result.rows||[];
  const rows=groupStrategyRows(all,{sources:snapshot.sources,errors:result.errors,currency:p.currency});
  const unavailable=[...new Map((result.unavailableQuotes||[]).filter(r=>finite(r.bestBid)&&r.bestBid>0).map(r=>[r.optionPlatform+'|'+r.contract.symbol,r])).values()];showRows(rows,unavailable);
  const index=marketsForPrices[0];if(index&&clock()-index.receivedAt>=30000){set('liveSpotValue','—');set('liveSpotSource','指数报价已过期，等待刷新');}
  const paired=rows.filter(r=>r.comparisons.some(c=>c.valid)),counts=rows.reduce((sum,r)=>sum+r.comparisons.filter(c=>c.valid).length,0);
  set('scanCoverage',`已读取 ${snapshot.books.length}/${snapshot.requestedBooks} 个真实 PUT 盘口 · ${rows.length} 笔 SELL PUT 策略 · ${counts} 个同条件平台双币报价${snapshot.errors.length?' · '+snapshot.errors.length+' 项读取失败':''}。每笔方案固定列出 Binance、OKX、Bybit；未匹配也列明原因。`);
  if(!running)set('scanStatus',rows.length?`按未触发时、扣全部适用手续费后的收入差排序；${paired.length} 笔有同条件双币。触发费用另列，不冒充最终收益。`:'当前条件下暂无有效方案报价；请调整接币价、范围或到期天数。');
  if(!rows.length&&!unavailable.length)set('scanEmpty',result.valid===false?(result.reasons?.[0]?.reason||'筛选条件无效'):'暂无符合条件的实时买盘。没有用旧报价、近似到期日或其他币种补数。');
  set('scanUpdated','读取 '+dt(snapshot.receivedAt)+' · 约每 15 秒更新，过期报价立即移除');
 }
 async function refresh(){
  const request=++generation,p=input();running=true;conditions();if(!snapshot)clear('正在读取真实盘口和双币产品报价…');el('scanRefresh').disabled=true;set('scanStatus','正在获取公开实时报价…');
  try{const data=await collect(p,{clock,isCurrent:()=>!destroyed&&request===generation,onMarkets:markets=>{if(request===generation)showMarkets(markets);},onProgress:({done,total})=>{if(request===generation)set('scanStatus',`正在读取真实买盘 ${done}/${total}…`);}});if(!data||request!==generation||destroyed)return;snapshot=data;sourceList(data.sources);running=false;render();}
  catch(e){if(request!==generation||destroyed)return;running=false;if(snapshot)render();else clear(e.message);set('scanStatus','报价读取失败：'+e.message);}
  finally{if(request===generation)el('scanRefresh').disabled=false;}
 }
 function changed(){generation++;running=false;snapshot=null;selectedStrategy=null;limit=20;el('strategySummary')?.replaceChildren();clear('条件已变更，正在重新读取真实报价…');set('scanStatus','筛选条件已变更，正在重新读取…');conditions();save();clearTimeout(debounce);debounce=setTimeout(refresh,350);}
 ['scanAmount','scanMinStrike','scanMaxStrike'].forEach(id=>el(id).addEventListener('input',changed));['scanCurrency','scanMaxDays','scanStrike','scanBelowSpot'].forEach(id=>el(id).addEventListener('change',()=>{if(id==='scanCurrency'){el('scanStrike').value='all';marketsForPrices=[];set('liveSpotValue','读取中…');}changed();}));
 el('scanBestOnly').addEventListener('change',()=>{limit=20;lastView='';render();});el('scanRefresh').addEventListener('click',refresh);el('scanMore').addEventListener('click',()=>{limit+=20;lastView='';render();});el('liveQuoteForm')?.addEventListener('submit',e=>{e.preventDefault();refresh();});
 const ticker=setInterval(()=>{if(!doc.hidden)render();},1000),updater=setInterval(()=>{if(!doc.hidden&&!running)refresh();},15000);refresh();
 return {refresh,destroy(){destroyed=true;generation++;clearTimeout(debounce);clearInterval(ticker);clearInterval(updater);}};
}

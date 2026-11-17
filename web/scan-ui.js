import {platforms,loadMarket,loadBook} from './market.js';
import {loadDualCatalogues} from './dual-catalogue.js';
import {findScanCandidates,rankScanCombinations} from './combination-scan.js';

const names={bybit:'Bybit',deribit:'Deribit',binance:'Binance 普通双币',okx:'OKX'};
const num=(v,d=2)=>Number(v).toLocaleString('zh-CN',{maximumFractionDigits:d});
const pct=v=>num(v*100,4)+'%';
const floorText=(v,d=2)=>num(Math.floor(v*10**d)/10**d,d);
const ceilText=(v,d=2)=>num(Math.ceil(v*10**d)/10**d,d);
 const date=v=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Singapore',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(v));

/** Public GETs only. Superseded scans stop launching queued requests. */
export async function collectScanInputs(input,{marketLoader=loadMarket,catalogueLoader=loadDualCatalogues,bookLoader=loadBook,clock=Date.now,isCurrent=()=>true,onProgress=()=>{}}={}){
 const maxDays=input.maxDays===undefined?7:input.maxDays;
 if(maxDays!==null&&!(typeof maxDays==='number'&&Number.isFinite(maxDays)&&maxDays>0&&maxDays<=3650))throw Error('请选择有效的到期天数上限');
 const ids=Object.keys(platforms).filter(id=>platforms[id].currency===input.currency),markets=[],errors=[];
 const results=await Promise.allSettled(ids.map(async id=>({...await marketLoader(id),platform:id,receivedAt:clock()})));
 results.forEach((r,i)=>r.status==='fulfilled'?markets.push(r.value):errors.push((names[ids[i]]||ids[i])+' 期权行情读取失败'));
 if(!isCurrent())return null;
 const catalogueNow=clock();
 const scopedContracts=markets.flatMap(m=>{
  const serverNow=m.time+Math.max(0,catalogueNow-m.receivedAt);
  return m.contracts.filter(c=>c.expires>serverNow&&(maxDays===null||c.expires-serverNow<=maxDays*86400000));
 });
 const catalogue=await catalogueLoader(input.currency,scopedContracts);
 if(!isCurrent())return null;
 const entries=catalogue.entries||[],candidates=findScanCandidates({...input,markets,entries,now:clock()}).candidates||[];
 const tasks=[...new Map(candidates.map(c=>[c.optionPlatform+'|'+c.contract.symbol,c])).values()],books=[];
 let cursor=0,done=0;
 onProgress({done,total:tasks.length});
 await Promise.all(Array.from({length:Math.min(6,tasks.length)},async()=>{
  while(isCurrent()&&cursor<tasks.length){
   const c=tasks[cursor++];
   try{const book=await bookLoader(c.optionPlatform,c.contract.symbol);if(isCurrent())books.push({platform:c.optionPlatform,symbol:c.contract.symbol,book,receivedAt:clock()});}
   catch{errors.push((names[c.optionPlatform]||c.optionPlatform)+' '+c.contract.symbol+' 买盘读取失败');}
   done++;if(isCurrent())onProgress({done,total:tasks.length});
  }
 }));
 return isCurrent()?{markets,entries,books,sources:catalogue.sources||[],errors,requestedBooks:tasks.length,receivedAt:clock()}:null;
}

export function mountCombinationScanner({doc=document,onApply=()=>{},collect=collectScanInputs,rank=rankScanCombinations,clock=Date.now}={}){
 const el=id=>doc.getElementById(id),set=(id,value)=>{const node=el(id);if(node)node.textContent=value;};
 if(!el('autoCombinations'))return {refresh:()=>{},destroy:()=>{}};
 let epoch=0,running=false,snapshot=null,currentRows=[],pageSize=20,debounce=null,destroyed=false,lastView='';
 const rateReferences=new Map();
 const input=()=>({amount:el('amount').value===''?NaN:Number(el('amount').value),currency:el('scanCurrency').value,maxDays:el('scanMaxDays')?.value==='all'?null:Number(el('scanMaxDays')?.value||'7'),dropRate:Number(el('scanDrop').value),gapRate:Number(el('spotGapRate').value),onlyBelowSpot:el('scanBelowSpot').checked});
 function conditions(){const p=input();set('scanAmountUnit',p.currency);set('scanConditions',`当次投入 ${Number.isFinite(p.amount)?num(p.amount):'—'} ${p.currency}；到期范围：${p.maxDays===null?'全部期限':num(p.maxDays)+' 天以内（含）'}；每组假设结算价＝接币价 × ${pct(1-p.dropRate)}；现货买价偏差 ${pct(p.gapRate)}。同组两边共用结算价。`);}
 function clear(message){currentRows=[];lastView='';rateReferences.clear();el('scanResultsBody').replaceChildren();el('scanEmpty').hidden=false;set('scanEmpty',message);el('scanMore').hidden=true;set('scanCoverage','等待本次公开报价与完整买盘深度');set('scanUpdated','');el('scanSources').replaceChildren();}
 function sources(items){
  el('scanSources').replaceChildren(...items.map(s=>{const span=doc.createElement('span');span.className='scan-source';span.textContent=(s.name||names[s.platform]||s.platform||'报价源')+'：'+(s.status==='ready'?`${s.count??0} 个精确匹配报价`:(s.reason||'暂不可读取'));return span;}));
 }
 function cell(tr,label,value,detail='',className=''){
  const td=doc.createElement('td');td.dataset.label=label;td.className=className;
  const strong=doc.createElement('strong');strong.textContent=value;td.append(strong);
  if(detail){const small=doc.createElement('small');small.textContent=detail;td.append(small);}
  tr.append(td);return td;
 }
 function showRows(rows){
  const describe=r=>`BTC/${r.currency} · 接币价 ${num(r.contract.strike)} · ${date(r.contract.expires)} SGT · 剩余 ${num(r.model.days,2)} 天${r.bestForContract?' · 当前有效报价最强基准':''}${r.estimateOnly?' · 数量估算，资格待核验':''}`;
  const visible=rows.slice(0,pageSize),key=JSON.stringify(visible.map(r=>[r.id,r.btcDifference,r.limits.extraFeeHeadroom,r.limits.maxGapRate,r.model.gross,r.model.scenarioNetIncome,r.model.scenarioTerm,r.dual.income]));
  if(key!==lastView){lastView=key;rateReferences.clear();el('scanResultsBody').replaceChildren(...visible.map((r,i)=>{
   const tr=doc.createElement('tr'),c=r.contract,m=r.model,d=r.dual,l=r.limits,cur=r.currency;
   const conditionCell=cell(tr,'匹配组合',`#${i+1} ${names[r.optionPlatform]||r.optionPlatform} PUT × ${names[r.dualPlatform]||r.dualPlatform}`,describe(r));
   cell(tr,'假设到期结算价',num(r.scenarioPrice)+' '+cur,'接币价下方 '+pct(input().dropRate)+'；较当前参考价 '+(r.scenarioPrice>r.market.spot?'高 ':'低 ')+pct(Math.abs(r.scenarioPrice/r.market.spot-1)));
   const putCell=cell(tr,'SELL PUT 净 BTC',num(m.btcReceived,8)+' BTC',`毛权利金 ${num(m.gross)}；总费用 ${num(m.totalFee)} ${cur}；余款 ${num(m.cash,8)} ${cur}`);
   const rates=doc.createElement('div');rates.className='scan-put-rates';
   for(const [label,value] of [['本情景扣费后本期率',m.scenarioTerm],['权利金简单年化',m.scenarioAnnual]]){
    const item=doc.createElement('div'),caption=doc.createElement('span'),valueNode=doc.createElement('b');caption.textContent=label;valueNode.textContent=Number.isFinite(value)?pct(value):'—';valueNode.className=value<0?'negative':'positive';item.append(caption,valueNode);rates.append(item);
   }
   putCell.append(rates);const netNote=doc.createElement('small');netNote.textContent='本情景净权利金 '+(Number.isFinite(m.scenarioNetIncome)?num(m.scenarioNetIncome)+' '+cur:'—')+'；本期率分母为当次全部投入';putCell.append(netNote);
   rateReferences.set(r.id,{annual:rates.children[1].children[1],conditions:conditionCell.children[1]});
   cell(tr,'双币净 BTC',num(d.dualBtc,8)+' BTC',`年化 ${pct(d.apr)}；本期 ${num(d.income)} ${cur}（${pct(d.term)}）；余款 ${num(d.dualCash,8)} ${cur}`);
   const incomeDiff=m.netIncome-d.income;
   cell(tr,'SELL PUT 多接 / 少接',(r.btcDifference>=0?'多接 ':'少接 ')+num(Math.abs(r.btcDifference),8)+' BTC',`相对双币 ${r.btcDifference>=0?'+':''}${pct(r.btcDifference/d.dualBtc)}；未触发时${incomeDiff>=0?'多拿':'少拿'} ${num(Math.abs(incomeDiff))} ${cur}`,r.btcDifference>=0?'positive':'negative');
   cell(tr,'额外费用余量',(l.extraFeeHeadroom>=0?'可再增加 '+floorText(l.extraFeeHeadroom):'已差 '+ceilText(Math.abs(l.extraFeeHeadroom)))+' '+cur,'保持当前情景买价；负值表示已不如双币',l.extraFeeHeadroom>=0?'positive':'negative');
   const gapRemaining=l.maxGapRate-input().gapRate;
   cell(tr,'现货价差余量',(gapRemaining>=0?'余量 '+floorText(gapRemaining*100,4):'超出 '+ceilText(Math.abs(gapRemaining)*100,4))+'%',`偏差上限 ${floorText(l.maxGapRate*100,4)}%；最高买价 ${floorText(l.maxPurchasePrice)} ${cur}${l.maxGapRate<0?'，须折价买入':''}`,gapRemaining>=0?'positive':'negative');
   const td=doc.createElement('td');td.dataset.label='查看模拟';const button=doc.createElement('button');button.type='button';button.className='scan-apply';button.textContent='代入本页模拟';button.addEventListener('click',()=>{
    if(destroyed||!snapshot){set('scanStatus','参数已改变，请等待重新筛选。');return;}
    const fresh=rank({...input(),...snapshot,now:clock()}).rows||[];
    const selected=fresh.find(row=>row.id===r.id);
    if(!selected){render();set('scanStatus','该组合报价已失效，请重新筛选。');return;}
    onApply(selected);
   });td.append(button);tr.append(td);return tr;
  }));}
  // Elapsed time updates the annual rate without replacing a focused button.
  for(const r of visible){const refs=rateReferences.get(r.id);if(refs){refs.annual.textContent=Number.isFinite(r.model.scenarioAnnual)?pct(r.model.scenarioAnnual):'—';refs.annual.className=r.model.scenarioAnnual<0?'negative':'positive';refs.conditions.textContent=describe(r);}}
  el('scanEmpty').hidden=rows.length>0;el('scanMore').hidden=rows.length<=pageSize;
  set('scanMore',`显示更多组合（已展示 ${Math.min(pageSize,rows.length)} / ${rows.length}）`);
 }
 function render(){
  conditions();if(!snapshot)return;
  const result=rank({...input(),...snapshot,now:clock()}),all=result.rows||[];
  currentRows=el('scanBestOnly').checked?all.filter(r=>r.bestForContract):all;
  showRows(currentRows);
  const stats=result.stats||{},reasons=result.reasons||[];
  const reasonsText=Array.isArray(reasons)?reasons.map(r=>typeof r==='string'?r:(r.reason||r.message||r.code||'')).filter(Boolean).slice(0,3).join('；'):'';
  const exclusions=reasons.filter(r=>!['no_exact_quote','strike_above_spot','contract_inactive','expiration_outside_range'].includes(r.code)).map(r=>`${r.reason}（${r.count} 项）`).slice(0,5).join('；');
  const incomplete=snapshot.sources.some(s=>s.platform!=='binance-rfq'&&s.status!=='ready');
  set('scanCoverage',`本次目录 ${snapshot.entries.length} 条报价；精确候选 ${stats.exactMatches??stats.candidates??'见来源'}；已读取 ${snapshot.books.length}/${snapshot.requestedBooks} 个 PUT 买盘；有效配对 ${all.length}；${el('scanBestOnly').checked?'当前有效报价最强基准':'全部配对'} ${currentRows.length} 组。${incomplete?'来源不完整，排名仅为当前可读样本。':'仅覆盖本次可读取目录。'}${snapshot.errors.length?' '+snapshot.errors.length+' 项读取失败。':''}${exclusions?' 排除原因：'+exclusions:''}`);
  if(!currentRows.length)set('scanEmpty',snapshot.entries.length?'所选到期范围内，没有通过金额、完整深度、时效及临界值校验的同币同价同到期组合。'+reasonsText:'所选币种和到期范围内没有可读取的精确匹配双币报价；可调整到期天数重新筛选。');
  if(!running)set('scanStatus',currentRows.length?`已按扣费后多接 BTC 降序排列；${currentRows.filter(r=>r.btcDifference>0).length} 组为正，负值也保留。`:'暂未找到有效组合，持续读取公开报价。');
  set('scanUpdated',`最近筛选 ${date(snapshot.receivedAt)} SGT · 每秒剔除过期结果 · 约每 15 秒重新读取 · 排名可能随报价变化`);
 }
 async function refresh(){
  const request=++epoch,p=input();running=true;if(!snapshot){pageSize=20;clear('正在自动匹配公开产品并核验当次投入的买盘深度…');}conditions();el('scanRefresh').disabled=true;set('scanStatus',snapshot?'正在更新报价，旧结果会按有效期自动移除…':'正在读取同币种期权和双币目录…');
  if(!Number.isFinite(p.amount)||p.amount<=0){running=false;el('scanRefresh').disabled=false;clear('请输入大于 0 的当次投入资金。');set('scanStatus','等待有效投入金额');return;}
  try{
   const data=await collect(p,{clock,isCurrent:()=>!destroyed&&request===epoch,onProgress:({done,total})=>{if(request===epoch)set('scanStatus',`正在核验买盘深度 ${done}/${total}，按当次投入计算净接币数量…`);}});
   if(!data||request!==epoch||destroyed)return;snapshot=data;sources(data.sources);running=false;render();
  }catch(error){if(request!==epoch||destroyed)return;running=false;if(snapshot)render();else clear('公开报价读取失败，请重新筛选。');set('scanStatus','更新失败，仅保留尚未过期的结果：'+error.message);}
  finally{if(request===epoch)el('scanRefresh').disabled=false;}
 }
 function schedule(){epoch++;running=false;snapshot=null;clear('参数已改变，正在重新筛选…');set('scanStatus','参数已改变，正在重新匹配…');conditions();clearTimeout(debounce);debounce=setTimeout(refresh,450);}
 if(el('scanAmount')){el('scanAmount').value=el('amount').value;el('scanAmount').addEventListener('input',()=>{el('amount').value=el('scanAmount').value;el('amount').dispatchEvent(new Event('input',{bubbles:true}));});}
 el('amount').addEventListener('input',()=>{if(el('scanAmount'))el('scanAmount').value=el('amount').value;schedule();});el('scanCurrency').addEventListener('change',schedule);el('scanBelowSpot').addEventListener('change',schedule);
 el('scanMaxDays')?.addEventListener('change',schedule);
 ['scanDrop','scanBestOnly','spotGapRate'].forEach(id=>el(id).addEventListener('change',()=>{pageSize=20;lastView='';if(snapshot)render();else if(!running)schedule();}));
 el('scanRefresh').addEventListener('click',refresh);el('scanMore').addEventListener('click',()=>{pageSize+=20;lastView='';render();});
 const expiryTimer=setInterval(()=>{if(!doc.hidden)render();},1000),refreshTimer=setInterval(()=>{if(!doc.hidden&&!running)refresh();},15000);
 refresh();
 return {refresh,destroy(){destroyed=true;epoch++;clearTimeout(debounce);clearInterval(expiryTimer);clearInterval(refreshTimer);}};
}

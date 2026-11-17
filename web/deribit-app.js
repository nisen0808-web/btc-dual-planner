import {collectDeribitDesk,compareDeskRates,deskRowFresh,money,percent,expiryLabel,timestamp,timeLeft} from './deribit-desk.js';
import {createLocalExecutionClient} from './local-execution.js';

export function mountDeribitDesk({doc=document,collect=collectDeribitDesk,localFactory=createLocalExecutionClient,clock=Date.now}={}){
 const el=id=>doc.getElementById(id),set=(id,value)=>{const n=el(id);if(n)n.textContent=value;};
 const make=(tag,text='',cls='')=>{const n=doc.createElement(tag);n.textContent=text;n.className=cls;return n;};
 let data=null,selected=null,maxDays=7,generation=0,loading=false,disposed=false,debounce=null,draft=null,preparing=false,confirming=false,tableKey='',datesKey='',actionMessage='';
 let connection={canSubmit:false,accountVerified:false,runnerOnline:false},statusGeneration=0;
 const local=localFactory(()=>refreshConnection());
 const input=()=>({amount:Number(el('strategyAmount').value),targetPrice:el('targetPrice').value.trim(),maxDays});
 const fingerprint=()=>JSON.stringify([input().amount,input().targetPrice,selected,el('buyBufferRate')?.value||'0.005']);
 const context=()=>data?.rows?.find(r=>r.contract.symbol===selected&&deskRowFresh(r,clock()));
 const ready=()=>connection.platform==='deribit'&&connection.currency==='USDC'&&connection.canSubmit===true&&connection.accountVerified===true&&connection.runnerOnline===true&&['testnet','mainnet'].includes(connection.environment);
 const expireDraft=()=>{draft=null;if(el('confirmPutOrder'))el('confirmPutOrder').disabled=true;};
 function save(){try{localStorage.setItem('deribit-ticket-v1',JSON.stringify({amount:el('strategyAmount').value,targetPrice:el('targetPrice').value}));}catch{}}
 function drawDates(){
  const times=data?.expiries||[],key=JSON.stringify([times,selected]);
  if(key!==datesKey){datesKey=key;el('expiryCards').replaceChildren(...times.map(t=>{
   const row=data.rows.find(r=>r.contract.expires===t),button=make('button','','expiry-card');button.type='button';button.dataset.expiry=String(t);button.setAttribute('aria-pressed',String(row?.contract.symbol===selected));
   const dateParts=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Singapore',year:'numeric',month:'numeric',day:'numeric',weekday:'short',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date(t)),part=type=>dateParts.find(p=>p.type===type)?.value||'';
   button.append(make('span',part('year')+'年','expiry-year'),make('strong',part('month')+'月'+part('day')+'日'),make('span',part('weekday')+' '+part('hour')+':'+part('minute')),make('small',timeLeft(t,clock())));
   button.addEventListener('click',()=>{if(!row){set('quoteStatus','请先填写资金和精确接币价');return;}selected=row.contract.symbol;expireDraft();tableKey='';render();});return button;
  }));if(!times.length)el('expiryCards').append(make('p',data?.reason||'暂无可用到期日','placeholder-message'));}
  const more=el('moreExpiries');if(more){more.hidden=!(data?.allExpiries?.some(t=>!times.includes(t)));more.textContent=maxDays<30?'查看更多到期日（30天）':maxDays<90?'查看更多到期日（90天）':'查看更多到期日';}
  set('expiryStatus',times.length?`${times.length} 个真实到期日 · 均为新加坡时间 · 到期后核对交割再处理接币`:'到期日来自 Deribit 真实合约，不使用推算日期。');
 }
 function rateSummary(row){const comparisons=compareDeskRates(row,data?.entries||[],clock());return comparisons.filter(c=>c.valid).map(c=>(c.platform==='binance'?'Binance':'OKX')+' '+(c.spreadPoints>=0?'+':'')+money(c.spreadPoints,2)+' 个百分点').join(' / ')||'暂无同价同到期双币利率';}
 function drawTable(){
  const rows=data?.rows||[],key=JSON.stringify([selected,rows.map(r=>[r.contract.symbol,r.quote?.gross,r.quote?.q,r.receivedAt,deskRowFresh(r,clock())]),(data?.entries||[]).map(e=>[e.id,e.data?.serverTime])]);
  if(key===tableKey)return;tableKey=key;
  el('putRows').replaceChildren(...rows.map(row=>{
   const tr=make('tr');tr.dataset.instrument=row.contract.symbol;tr.setAttribute('aria-selected',String(row.contract.symbol===selected));if(row.contract.symbol===selected)tr.className='is-selected';
   const add=(label,value,small='')=>{const td=make('td');td.dataset.label=label;td.append(make('strong',value));if(small)td.append(make('small',small));tr.append(td);return td;};
   add('到期日期',expiryLabel(row.contract.expires),timeLeft(row.contract.expires,clock()));
   if(!deskRowFresh(row,clock())){add('本次净权利金','—',row.quote?.reason||'报价已过期，等待刷新');for(const label of ['本期率','年化','双币利率差'])add(label,'—');const td=add('选择','');const b=make('button','不可下单');b.disabled=true;td.append(b);return tr;}
   const q=row.quote;add('本次净权利金',money(q.netIncome)+' USDC','卖出 '+money(q.q,8)+' BTC 名义量');add('本期率',percent(q.term));add('年化',percent(q.annual));add('双币利率差',rateSummary(row),'USDC PUT / USDT 双币 · 仅比公开年化');
   const td=add('选择',''),b=make('button',row.contract.symbol===selected?'已选择':'选择','select-put');b.type='button';b.addEventListener('click',()=>{selected=row.contract.symbol;expireDraft();tableKey='';render();});td.append(b);return tr;
  }));
 }
 function drawComparisons(row){
  const target=el('dualComparisonBody');if(!target)return;target.replaceChildren();
  if(!row){target.append(make('p','填入资金与接币价后，读取同名义价格、同到期时刻的 Binance / OKX 真实双币利率。'));return;}
  for(const c of compareDeskRates(row,data?.entries||[],clock())){const box=make('section','','dual-card');box.append(make('h3',c.name));
   if(c.valid){box.append(make('p','平台双币年化 '+percent(c.apr)+' · USDT'),make('strong',(c.spreadPoints>=0?'SELL PUT 年化高 ':'SELL PUT 年化低 ')+money(Math.abs(c.spreadPoints),2)+' 个百分点'),make('small','来源 '+timestamp(c.quoteTime)));}
   else{const source=data?.sources?.find(s=>s.platform===c.platform);box.append(make('p',c.reason),make('small',source?.status!=='ready'?source?.reason||'没有用其他接币价或到期日补数':'没有用其他接币价或到期日补数'));}
   target.append(box);
  }
 }
 function drawTicket(){
  const row=context(),connected=connection.accountVerified===true&&connection.runnerOnline===true;set('connectionStatus',connected?'已连接 · '+(connection.environment==='mainnet'?'实盘':'测试网')+(ready()?'':' · 新单暂停'):connection.runnerOnline?'本机在线 · 账户待核验':'未连接交易账户');
  const main=el('placePutOrder');main.disabled=loading||preparing||confirming||!row||connected&&!ready();main.textContent=preparing?'正在核对这笔订单…':ready()?'准备卖出 PUT':connected?'当前账户暂不可开新单':'连接 Deribit 并下单';
  if(!row){for(const id of ['selectedExpiry','selectedCountdown','activeExpiryCountdown','selectedStrike','selectedAmount','selectedQuantity','selectedLimitPrice','selectedNetPremium','selectedTermRate','selectedApr','selectedGrossPremium','selectedOpenFee','selectedCashAtExpiry','selectedQuoteTime','selectedInstrument'])set(id,'—');set('ticketTitle','填入资金和接币价');set('selectedDeliveryFee','选择合约后确定适用规则');set('selectedSpotFee','仅触发后买币收取');if(actionMessage)set('orderStatus',actionMessage);drawComparisons(null);return;}
  const {quote:q,contract:c}=row;
  set('ticketTitle','确认这一笔 SELL PUT');set('selectedExpiry',expiryLabel(c.expires));set('selectedCountdown',timeLeft(c.expires,clock()));set('activeExpiryCountdown',timeLeft(c.expires,clock()));
  set('selectedStrike',money(c.strike));set('selectedAmount',money(q.amount));set('selectedQuantity',money(q.q,8));set('selectedLimitPrice',money(q.averagePrice));
  set('selectedNetPremium',money(q.netIncome));set('selectedGrossPremium',money(q.gross)+' USDC');set('selectedOpenFee',money(q.openFee)+' USDC · 标准费率报价');set('selectedTermRate',percent(q.term));set('selectedApr',percent(q.annual));
  set('selectedDeliveryFee',c.deliveryExemptionConfirmed&&c.delivery===0?'日合约免收 · 0':`未触发 0；触发按 ${percent(c.delivery)}，金额待到期`);
  set('selectedSpotFee',`未触发 0；买入按 ${percent(c.spot)}，实际以成交费用回报为准`);set('selectedCashAtExpiry',money(q.amount+q.netIncome));
  set('selectedBuyRule','官方结算价 ≤ '+money(c.strike)+' USDC 时，先核对实际现金交割，再用本笔结算余款买 BTC；实际净数量按现货成交确定。');
  set('buyRuleStatus','触发后只用本笔资金，不动账户其他资金；未成交的 PUT 不收权利金，也不自动买币。');
  set('selectedInstrument',c.symbol);set('selectedQuoteTime','报价 '+timestamp(q.quoteTime));
  set('orderStatus',actionMessage||(ready()?'连接已核验。下单前将重新冻结真实数量、卖价和接币规则。':connection.reason||'先在本机安全连接 Deribit；密钥不会进入此站点或聊天。'));
  drawComparisons(row);
 }
 function render(){drawDates();drawTable();drawTicket();updateDraft();}
 function updateDraft(){
  if(!draft)return;const seconds=Math.floor(Math.min(draft.expiresAt-clock(),30000-(performance.now()-draft.receivedMono))/1000),changed=draft.uiFingerprint!==fingerprint();
  set('quoteCountdown',changed?'资金、接币价、到期日或价格保护已改变，请重新准备。':seconds>0?'这笔冻结订单剩余 '+seconds+' 秒':'报价已过期，请重新准备');
  el('confirmPutOrder').disabled=changed||seconds<=0||!ready()||confirming;
 }
 async function refresh(){
  const request=++generation;loading=true;el('refreshQuotes').disabled=true;set('quoteStatus','正在读取 Deribit 真实到期日和买盘…');
  try{const next=await collect(input(),{clock,isCurrent:()=>!disposed&&request===generation,onMarket:m=>{if(request===generation){set('spotValue',money(m.spot));set('spotUpdated',timestamp(m.time));}}});
   if(!next||request!==generation||disposed)return;data=next;if(selected===null)selected=next.rows.find(r=>r.quote.valid)?.contract.symbol||null;tableKey='';datesKey='';loading=false;
   set('quoteStatus',next.reason||`已读取 ${next.rows.length} 个真实合约；金额按当前买盘计算，尚未成交。`);render();
  }catch(e){if(request!==generation||disposed)return;loading=false;set('quoteStatus','公开行情暂不可用：'+e.message);render();}
  finally{if(request===generation){loading=false;el('refreshQuotes').disabled=false;drawTicket();}}
 }
 function changed(){generation++;data=null;selected=null;loading=false;tableKey='';datesKey='';actionMessage='';expireDraft();save();render();clearTimeout(debounce);debounce=setTimeout(refresh,350);}
 async function prepare(){
  if(!context())return;if(!ready()){if(!local.connect())set('orderStatus','请打开本机连接页 http://127.0.0.1:8788/connect；本机服务须在线。');return;}
  const current=context(),uiFingerprint=fingerprint();preparing=true;actionMessage='';expireDraft();drawTicket();
  try{const p=await local.api('prepare',{amount:String(current.quote.amount),symbol:current.contract.symbol,buyBufferRate:Number(el('buyBufferRate')?.value||.005)});
   if(uiFingerprint!==fingerprint())throw Error('接币条件已改变，请重新准备');
   if(typeof p?.id!=='string'||typeof p.fingerprint!=='string'||p.platform!=='deribit'||p.currency!=='USDC'||p.account!==connection.account||p.environment!==connection.environment||p.symbol!==current.contract.symbol||Number(p.amount)!==current.quote.amount||Number(p.strike)!==current.contract.strike||p.expiry!==current.contract.expires||!Number.isSafeInteger(p.expiresAt)||p.expiresAt<=clock()||p.expiresAt>clock()+30000||!(Number(p.q)>0)||!Number.isFinite(Number(p.estimatedOpenFee))||Number(p.estimatedOpenFee)<0||Math.abs(Number(p.estimatedGross)-Number(p.estimatedOpenFee)-Number(p.estimatedNetIncome))>1e-8||p.orderPayload?.instrument_name!==p.symbol||p.payloadReady!==true||p.spotBudgetMode!=='remaining_strategy_cash')throw Error('服务器未返回完全匹配的可确认订单');
   draft={...p,uiFingerprint,receivedMono:performance.now()};const body=el('reviewContent');body.replaceChildren();
   body.append(make('p',p.environment==='mainnet'?'实盘订单 · 确认后会使用你的真实资金':'测试网订单 · 使用测试资金'));
   const dl=make('dl');for(const [label,value] of [['到期时间',expiryLabel(p.expiry)],['当次投入',money(Number(p.amount))+' USDC'],['接币价',money(Number(p.strike))+' USDC'],['卖出 PUT 名义量',p.q+' BTC'],['委托权利金单价',p.limitPrice+' USDC / BTC'],['预计毛权利金',money(Number(p.estimatedGross))+' USDC'],['预计开仓费',money(Number(p.estimatedOpenFee))+' USDC'],['预计净权利金',money(Number(p.estimatedNetIncome))+' USDC']])dl.append(make('dt',label),make('dd',value));body.append(dl);
   body.append(make('p','卖单未成交不会收到权利金。若仅部分成交，权利金按实际数量减少；只要存在已成交 PUT 且到期触发，本笔完整投入的结算余款都用于买 BTC。'));
   body.append(make('p','到期未触发：保留本笔资金和实收净权利金。到期触发：核对最终现金交割后，按实际现货卖盘买 BTC；只使用本笔余款。'));
   body.append(make('p','买币保护价：最高为官方交割价上方 '+percent(Number(p.buyBufferRate))+'；到期后最多等待 5 分钟。超价、部分成交、离线或状态不明时保留已成交资产和余款，暂停并提示，不重复追单。'));
   el('confirmPutOrder').textContent=p.environment==='mainnet'?'确认卖出 PUT，并启用本笔到期接币':'确认测试网卖 PUT';el('orderReview').showModal();updateDraft();
  }catch(e){actionMessage=e.message;set('orderStatus',actionMessage);expireDraft();}finally{preparing=false;drawTicket();}
 }
 async function confirm(){
  updateDraft();if(!draft||el('confirmPutOrder').disabled)return;const p=draft;confirming=true;el('confirmPutOrder').disabled=true;
  try{const result=await local.api('confirm',{id:p.id,fingerprint:p.fingerprint,account:p.account,currency:'USDC',confirmed:true});
   if(result?.id!==p.id||!['put_submitting','put_reconciling','unknown','needs_attention','holding','no_fill'].includes(result.phase))throw Error('下单结果尚未核对，请检查订单记录，勿重复提交');
   draft=null;actionMessage='请在订单记录查看实际成交及权利金。';set('quoteCountdown','委托已进入真实订单对账，受理不代表成交。');set('orderStatus',actionMessage);el('confirmPutOrder').textContent='已提交，等待对账';await refreshConnection();
  }catch(e){expireDraft();set('quoteCountdown',e.message+'；先核对原订单，不自动重发。');}finally{confirming=false;}
 }
 async function refreshPlans(){
  try{const r=await local.api('plans'),plans=Array.isArray(r)?r:r?.plans;if(!Array.isArray(plans)||!plans.length){set('plansStatus','连接账户后显示真实委托、权利金和到期接币记录。');return;}
   const states={put_submitting:'提交卖 PUT',put_reconciling:'核对卖 PUT 成交',unknown:'订单结果待核对',holding:'PUT 已成交，等待到期',settlement_pending:'核对到期现金交割',spot_ready:'准备按余款买 BTC',spot_submitting:'提交 BTC 现货买入',spot_reconciling:'核对 BTC 实际成交',spot_unknown:'现货结果待核对',complete_cash:'到期未触发，保留 USDC',complete_btc:'到期接币完成',no_fill:'卖单未成交，权利金为 0',needs_attention:'自动处理已暂停，请检查'};
   set('plansStatus','以下均为本机执行器的实际记录');el('plansList').replaceChildren(...plans.slice(0,10).map(p=>{const box=make('article','','plan-card');box.append(make('h3',states[p.phase]||p.phase),make('p',p.symbol+' · '+expiryLabel(p.expiry)),make('p','实际卖出 '+(p.filledQty==null?'待对账':money(Number(p.filledQty),8))+' BTC · 实收权利金 '+(p.gross==null?'待对账':money(Number(p.gross)))+' USDC · 开仓费 '+(p.openFee==null?'待对账':money(Number(p.openFee)))+' USDC'));
    if(p.strategyCash!=null)box.append(make('p','本笔已结算现金 '+money(Number(p.strategyCash))+' USDC'));
    if(p.receivedBTC!=null)box.append(make('p','净收到 '+money(p.receivedBTC,8)+' BTC · 余款 '+money(p.remainingStrategyCash)+' USDC'));
    if(p.lastError?.reason)box.append(make('p',p.lastError.reason));if(p.reason)box.append(make('p',p.reason));
    if(!p.closed&&!p.automationPaused){const b=make('button','暂停后续自动买币（保留已成交持仓）');b.type='button';b.addEventListener('click',async()=>{b.disabled=true;try{await local.api('pause',{id:p.id});await refreshPlans();}catch{b.textContent='暂停结果待核对，请检查执行器';}});box.append(b);}return box;}));
  }catch{set('plansStatus','本机订单记录暂不可读；结果不明时不会自动重发订单。');}
 }
 async function refreshConnection(){const request=++statusGeneration;try{const r=await local.api('status');if(request!==statusGeneration||disposed)return;connection=r||{canSubmit:false};drawTicket();await refreshPlans();}catch{if(request===statusGeneration){connection={canSubmit:false};set('connectionStatus','本机未连接或暂不可达');drawTicket();}}}
 for(const id of ['strategyAmount','targetPrice'])el(id).addEventListener('input',changed);
 el('deribitStrategyForm').addEventListener('submit',e=>{e.preventDefault();refresh();});el('refreshQuotes').addEventListener('click',refresh);
 el('moreExpiries').addEventListener('click',()=>{maxDays=maxDays<30?30:maxDays<90?90:3650;refresh();});
 el('connectDeribit').addEventListener('click',()=>{if(!local.connect())set('orderStatus','请先启动本机连接服务，再打开 http://127.0.0.1:8788/connect');});
 el('placePutOrder').addEventListener('click',prepare);el('confirmPutOrder').addEventListener('click',confirm);el('closeOrderReview').addEventListener('click',()=>{expireDraft();el('orderReview').close();});
 el('buyBufferRate')?.addEventListener('change',()=>{expireDraft();set('quoteCountdown','接币保护已改变，请重新准备订单。');});
 const ticker=setInterval(()=>{if(!doc.hidden)render();},1000),quotesTimer=setInterval(()=>{if(!doc.hidden&&!loading)refresh();},15000),statusTimer=setInterval(refreshConnection,10000);
 refresh();refreshConnection();
 return {refresh,refreshConnection,destroy(){disposed=true;generation++;clearTimeout(debounce);clearInterval(ticker);clearInterval(quotesTimer);clearInterval(statusTimer);}};
}

if(typeof document!=='undefined'){
 try{const old=JSON.parse(localStorage.getItem('deribit-ticket-v1')||localStorage.getItem('btc-live-quotes-v1')||'null');if(Number(old?.amount)>0)document.getElementById('strategyAmount').value=String(old.amount);if(Number(old?.targetPrice)>0)document.getElementById('targetPrice').value=String(old.targetPrice);}catch{}
 mountDeribitDesk();
}

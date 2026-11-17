import {buildSettlementBreakdown} from './settlement-breakdown.js';

const number=(value,d=2)=>Number(value).toLocaleString('zh-CN',{maximumFractionDigits:d});
const money=(value,cur)=>number(value)+' '+cur;
const percent=value=>number(value*100)+'%';
const signed=(value,d=2)=>{const v=Math.abs(value)<.5*10**-d?0:value;return (v>0?'+':'')+number(v,d);};
const versus=(value,unit,d=2)=>Math.abs(value)<(d===8?5e-9:.005)?'相同':(value>0?'多 ':'少 ')+number(Math.abs(value),d)+' '+unit;
const item=(label,value,note='')=>({label,value,note});

export function settlementBreakdownView(put,dual,cur){
 const detail=buildSettlementBreakdown(put,dual);
 if(!detail.valid)return {...detail,putFlow:[],dualFlow:[]};
 const triggered=put.triggered,filled=put.purchaseExecuted;
 const comparison=detail.comparison,structure=detail.rows.find(x=>x.id==='conversion').value;
 const bridgeRows=detail.rows.map(r=>r.id==='conversion'?{...r,note:triggered?'双币本金和收益按目标价换币，按结算价估值比现金少 '+money((dual.amount+dual.income)*(1-put.expiryPrice/put.strike),cur)+'；PUT 现金赔付 '+money(put.payout,cur)+'。两者相减为 '+signed(structure)+' '+cur+'，不是额外收益或费用，赔付不再扣第二次。':'未触发，两边都不换币，本项为 0。'}:r);
 const netAdvantage=put.netIncome-dual.income;
 const diagnosis=!triggered
  ?'未触发时，SELL PUT 毛权利金为 '+money(put.gross,cur)+'，扣开仓费 '+money(put.openFee,cur)+' 后，净收入较双币'+versus(netAdvantage,cur)+'。没有买现货，交割费和现货费均为 0。'
  :!filled
   ?'已触发，但当前现货价格或最小买入要求不允许完成模拟买入。资金保留现金；下面只核对资金及资产差，不把待买入显示为已接币。'
   :'扣开仓费后的收入，SELL PUT 比双币'+versus(netAdvantage,cur)+'；触发后还计入交割费 '+money(put.deliveryFee,cur)+'、现货费 '+money(put.spotFee,cur)+'，以及当前 '+percent(put.spotGapRate)+' 买价偏差造成的 '+money(put.basisCost,cur)+' 估值影响。再加两种接币方式的估值差 '+signed(structure)+' '+cur+'，最终总资产'+versus(comparison.assetDifference,cur)+'，净接币'+versus(comparison.btcDifference,'BTC',8)+'。';
 const actualDays=put.days;
 const putFlow=[
  item('当次投入资金',money(put.amount,cur)),
  item('卖 PUT 名义数量',number(put.q,8)+' BTC','用于期权赔付计算，不是最后收到的 BTC。'),
  item('PUT 本金备资',money(put.capital,cur),'执行价 '+money(put.strike,cur)+' × 名义数量。'),
  item('其余策略资金',money(put.unused,cur),'含费用预留。触发后这笔余款也参与买币。'),
  item('毛权利金',money(put.gross,cur),'按真实买盘深度逐档估算，尚未成交锁定。'),
  item('减：卖出开仓费',money(put.openFee,cur)),
  item('开仓后净权利金',money(put.netIncome,cur),'本期 '+percent(put.term)+'；简单年化 '+percent(put.annual)+'；按当次全部资金、剩余 '+number(actualDays,4)+' 天折算。'),
  item('减：期权现金结算赔付',money(put.payout,cur),triggered?'名义数量 × max(目标价 − 结算价，0)。这是期权损益，不是手续费。':'未触发，无期权赔付。'),
  item('减：到期交割费',money(put.deliveryFee,cur),'仅按本情景实际适用的公开费率计算，不扣预留上限。'),
  item('结算后的可用现金',money(put.afterSettlementCash,cur),'本金 + 毛权利金 − 开仓费 − 现金赔付 − 交割费。'),
  item('模拟现货买价',filled?money(put.purchasePrice,cur):triggered?'待买入':'未触发，不买入',filled?'结算价 '+money(put.expiryPrice,cur)+' × (1 + '+percent(put.spotGapRate)+')。价差是假设，不是平台额外收费。':''),
  item('现货手续费',money(put.spotFee,cur),filled?(put.spotDeductBase?'从买到的 BTC 扣 '+number(put.grossBtc-put.btcReceived,10)+' BTC；此处为按现货买价折算的等值金额。':'从买币预算中以稳定币支付，已包含在下方花费内。'):'本情景未完成买入，不扣现货费。'),
  item('现货买入实际花费',money(put.purchaseCash,cur),!filled?'本情景没有完成现货买入，无买入支出，资金保留。':put.spotDeductBase?'资金花费为买入毛 BTC 的金额；现货费已从 BTC 数量扣除，不再扣一次现金。':'包含现货买入金额与稳定币手续费，不再重复扣费。'),
  item('买入毛 BTC',number(put.grossBtc,8)+' BTC',!filled?'本情景没有完成现货买入。':put.roundingKnown?'已按公开现货数量步长取整。':'现货数量精度未取得，按连续数量模型估算。'),
  item('最终净 BTC',number(put.btcReceived,8)+' BTC',filled?'扣完适用现货费用后的数量。':triggered?'待买入，不能视为接币成功。':'不买入，保留现金。'),
  item('最终剩余现金',number(put.cash,8)+' '+cur,filled?'数量取整产生的余款仍归本策略，不是费用。':'本情景资金保留为稳定币。'),
  item('预留费用（不再扣一次）',money(put.feeReserve,cur),'只用于限制期权名义数量，不是额外收费。预计实际费用只按本情景发生的项目列出。'),
 ];
 const dualFlow=[
  item('当次投入资金',money(put.amount,cur)),
  item('实际双币申购金额',money(dual.amount,cur),dual.estimateOnly?'按公开报价估算；个人资格、额度与申购精度仍以平台确认。':'已按公开申购金额精度取整。'),
  item('未申购余款',number(dual.leftover,8)+' '+cur,'保留稳定币，不自动换币，余款利息按 0 计。'),
  item('平台报价年化 APR',percent(dual.apr),'这是平台产品报价，并非已成交或未来收益保证。'),
  item('产品计息天数',number(dual.days,4)+' 天','本期收益使用平台自己的计息期限，不强行套用 PUT 的剩余天数。'),
  item('双币本期收入',money(dual.income,cur),'本期率按当次全部资金为 '+percent(dual.term)+'；按同一剩余时间折算年化 '+percent(dual.income/put.amount*365/actualDays)+'。'),
  item('参与到期结算的本息',money(dual.amount+dual.income,cur),'申购本金 + 平台本期收入；未申购余款另行保留。'),
  item('到期动作',triggered?'本金和收益一起换成 BTC':'保留本金和本期收益',triggered?'按本页约定：结算价 ≤ 目标价。':'结算价 > 目标价，不换币。'),
  item('双币换币价格',triggered?money(put.strike,cur):'未触发，不换币','触发时按约定目标价换币，不是按本页的现货成交价。'),
  item('本金换得 BTC',number(triggered?dual.amount/put.strike:0,8)+' BTC'),
  item('收益换得 BTC',number(triggered?dual.income/put.strike:0,8)+' BTC'),
  item('最终净 BTC',number(dual.dualBtc,8)+' BTC',triggered?'(申购本金 + 本期收入) ÷ 目标价。':'未触发，不买 BTC。'),
  item('最终剩余现金',number(dual.dualCash,8)+' '+cur),
  item('单列费用信息','公开报价未单列','按平台公开收益公式计算；不额外套用 SELL PUT 的开仓费、交割费或现货费，也不把平台内部成本写成 0。'),
 ];
 return {...detail,rows:bridgeRows,diagnosis,putFlow,dualFlow};
}

export function settlementBreakdownExportLines(put,dual,cur){
 const view=settlementBreakdownView(put,dual,cur);
 if(!view.valid)return ['到期过程拆解：'+view.reason+'；没有计算归因。'];
 return ['收益、费用和接币过程',view.diagnosis,'SELL PUT 资金流水',...view.putFlow.map(r=>r.label+'：'+r.value+(r.note?'；'+r.note:'')),dual.name+' 双币资金流水',...view.dualFlow.map(r=>r.label+'：'+r.value+(r.note?'；'+r.note:'')),'差额逐项对账（PUT减双币）',...view.rows.filter(r=>r.includeInAssetBridge||r.btcImpact!=null).map(r=>r.label+'：'+signed(r.value,8)+' '+cur+(r.btcImpact==null?'':'；折合 '+signed(r.btcImpact,10)+' BTC')+'；'+r.note),'前六项合计为到期总资产差：'+signed(view.assetBridgeSum,8)+' '+cur,view.btcBridgeSum==null?'未触发或待买入，不计算接币数量归因。':'含现金形态调整后 BTC 差：'+signed(view.btcBridgeSum,10)+' BTC','现金形态调整不是手续费；期权赔付已计入两种接币方式的估值差，不再重复扣除。价差为本页假设，不是已锁定报价。'];
}

/** Local display only. All amounts originate from the same validated simulation. */
export function mountSettlementBreakdown(doc=document){
 const get=id=>doc.getElementById(id),set=(id,value)=>{const el=get(id);if(el)el.textContent=value;};
 let lastKey='';
 function render(put,dual,cur){
  const key=JSON.stringify([cur,put,dual?.id,dual?.name,dual?.valid,dual?.reason,dual?.amount,dual?.income,dual?.dualBtc,dual?.dualCash,dual?.dualAssets,dual?.days,dual?.apr,dual?.estimateOnly]);
  if(key===lastKey)return;lastKey=key;
  const view=settlementBreakdownView(put,dual,cur),flow=get('settlementFlow'),body=get('settlementAttributionBody'),wrap=get('settlementAttributionWrap'),empty=get('settlementBreakdownEmpty'),zero=get('settlementZeroGap');
  if(zero)zero.disabled=!put?.valid||!put.triggered||put.spotGapRate===0;
  flow?.replaceChildren();body?.replaceChildren();if(wrap)wrap.hidden=!view.valid;if(empty)empty.hidden=view.valid;
  set('settlementDiagnosis',view.valid?view.diagnosis:'等待同条件报价，才能判断收益与接币差额。');
  set('settlementBreakdownEmpty',view.valid?'':view.reason||'暂不可比较');
  set('settlementAttributionTotal','—');set('settlementAttributionNote','—');
  if(!view.valid)return;
  const card=(title,rows)=>{
   const article=doc.createElement('article');article.className='settlement-flow-card';const h=doc.createElement('h4');h.textContent=title;const dl=doc.createElement('dl');
   for(const r of rows){const group=doc.createElement('div'),label=doc.createElement('dt'),value=doc.createElement('dd');label.textContent=r.label;value.textContent=r.value;group.append(label,value);if(r.note){const note=doc.createElement('small');note.textContent=r.note;group.append(note);}dl.append(group);}
   article.append(h,dl);return article;
  };
  flow?.replaceChildren(card('SELL PUT：先现金结算，再用余款买币',view.putFlow),card(dual.name+'：按约定规则结算',view.dualFlow));
  set('settlementAttributionHead',view.kind==='btc'?'每一项对最终 BTC 差额的影响':'每一项对到期总资产差的影响');
  body?.replaceChildren(...view.rows.filter(r=>r.includeInAssetBridge||r.btcImpact!=null).map(r=>{const tr=doc.createElement('tr'),label=doc.createElement('td'),value=doc.createElement('td'),btc=doc.createElement('td'),name=doc.createElement('strong'),note=doc.createElement('small');name.textContent=r.label;note.textContent=r.note;label.append(name,note);value.textContent=signed(r.value,8)+' '+cur;btc.textContent=r.btcImpact==null?'—':signed(r.btcImpact,10)+' BTC';value.dataset.label='折算金额（SELL PUT 减双币）';btc.dataset.label='折合 BTC 差';value.className=r.value<0?'negative':'positive';if(r.btcImpact!=null)btc.className=r.btcImpact<0?'negative':'positive';tr.append(label,value,btc);return tr;}));
  set('settlementAttributionTotal','前六项合计：总资产差 '+signed(view.assetBridgeSum)+' '+cur+(view.btcBridgeSum==null?'；未触发或待买入，暂不计算接币量差。':'。再计入剩余现金差，最终净 BTC 差 '+signed(view.btcBridgeSum,8)+' BTC。'));
  set('settlementAttributionNote','金额均为同一结算价情景下的估值差。六项合计为总资产差。'+(view.btcBridgeSum==null?'未触发或未完成买入，不把金额差换算成 BTC 差。':'再把剩余现金的不同换算为 BTC 数量差，现金仍归你，不是费用。各项金额 ÷ 假设结算价 = 折合 BTC 差。')+'期权赔付已体现在“接币方式估值差”，不再重复扣；买价偏差是情景假设，也不是手续费。');
 }
 return {render};
}

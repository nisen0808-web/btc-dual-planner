import {computeSettlementLimits} from './settlement-limits.js';

const number=(value,d=2)=>Number(value).toLocaleString('zh-CN',{maximumFractionDigits:d});
const money=(value,cur)=>number(value)+' '+cur;
const down=(value,d=2)=>Math.floor(value*10**d)/10**d;
const capMoney=(value,cur)=>money(down(value),cur);
const signed=(value,d=8)=>(value>0?'+':'')+number(Math.abs(value)<.5*10**-d?0:value,d);
const pct=value=>number(value*100,4)+'%';
const downPct=value=>number(down(value*100,4),4)+'%';

export function settlementLimitsView(put,dual,cur,rules){
 const limits=computeSettlementLimits(put,dual,rules);
 if(!limits.valid)return {...limits,labels:{},values:{},notes:{}};
 const isIncome=limits.kind==='income';
 const labels={budget:isIncome?'本期收入可容忍的总开仓费':'接币优势总预算',used:isIncome?'已计入的开仓费':'已占用：费用＋价差＋取整余款',fee:isIncome?'还能增加的开仓费':'按当前买价，还能增加的费用',gap:isIncome?'现货买价偏差临界值':'现货买价偏差临界值',price:'最高现货买价'};
 const values={budget:limits.budgetGross>=0?capMoney(limits.budgetGross,cur):'无正成本空间',used:money(limits.currentUse,cur),fee:limits.extraFeeHeadroom>=0?capMoney(limits.extraFeeHeadroom,cur):'已缺 '+money(Math.ceil(-limits.extraFeeHeadroom*100)/100,cur),gap:'不适用',price:'未触发，不买现货'};
 const notes={budget:isIncome?'毛权利金 − 双币本期收入；在这个范围内扣开仓费，净收入仍可不少于双币。':'用于覆盖开仓费、交割费、现货费、买价偏差，以及未换成 BTC 的取整余款。余款仍归你，不是手续费。',used:isIncome?'本情景不发生交割费、现货费及买价偏差。':'实际预计费用 '+money(limits.actualFees,cur)+' ＋ 买价偏差影响 '+money(limits.gapImpact,cur)+' ＋ 取整余款 '+money(limits.cashOccupancy,cur)+'。',fee:isIncome?'超过这部分额外开仓费后，扣费收入将低于双币。':'从买币前现金额外扣费，其余报价、期权数量、交割费、现货费率和当前买价不变。按现货扣费和数量取整另算，不等于前两卡简单相减。',gap:isIncome?'只有触发并可买入 BTC 时才计算买价阈值。':'仅改变现货买价，期权数量、开仓与交割费用、现货费率不变。'};
 let status,warning,proof;
 if(isIncome){
  status=limits.extraFeeHeadroom>=0?'未触发：目前扣费收入仍不少于双币。':'未触发：目前开仓费已超过收益优势，扣费收入低于双币。';
  warning=limits.budgetGross<0?'即使开仓费为 0，当前毛权利金也不足以追平双币收入。':'费用上限以当前公开报价为前提；年化高低不能替代本期金额比较。';
  proof='净收入差 '+signed(put.netIncome-dual.income,2)+' '+cur+'；不将未触发收入差换算成 BTC。';
 }else{
  const gap=limits.maxGapRate;
  values.gap=gap>=0?'≤ '+downPct(gap):'需折价 ≥ '+pct(-down(gap,6));
  values.price='≤ '+capMoney(limits.maxPurchasePrice,cur);
  notes.gap+='超过临界买价，将达不到双币的净 BTC 数量，或无法满足现货最小买入要求。';
  status=put.btcReceived>=dual.dualBtc?'当前模拟净接币仍不少于双币；可用下方余量判断额外成本。':'当前模拟净接币已少于双币；需要降低费用或买价才能追平。';
  warning=limits.budgetGross<0?'当前毛收益和期权数量下，即使零费用、零价差仍不足以追平；需要更低买价或更好的权利金报价。':gap<0?'现有费用下，即使买价等于结算价也不足以追平；需要低于结算价买入，或减少费用。':limits.extraFeeHeadroom<0?'当前买价已超过临界线。维持现有费用时，买价须降至 '+capMoney(limits.maxPurchasePrice,cur)+' 以内，才能达到双币净 BTC 数量。':'临界线按净 BTC 数量判断；两边剩余现金与总资产仍需一起看。';
  proof='阈值处预计净 BTC '+number(limits.atLimitBtc,10)+'，双币为 '+number(dual.dualBtc,10)+'。'+(limits.aboveLimitBtc==null?'越过阈值后无法完成模拟买入。':'略高于阈值时净 BTC '+number(limits.aboveLimitBtc,10)+'，已达不到双币数量。');
 }
 return {...limits,labels,values,notes,status,warning,proof};
}

export function settlementLimitsExportLines(put,dual,cur,rules){
 const view=settlementLimitsView(put,dual,cur,rules);
 if(!view.valid)return ['费用与价差临界线：'+(view.reason||'暂不可计算')+'；不生成阈值。'];
 return ['费用与价差临界线（仅模拟）',view.status,view.labels.budget+'：'+view.values.budget,view.labels.used+'：'+view.values.used,view.labels.fee+'：'+view.values.fee,view.labels.gap+'：'+view.values.gap,view.labels.price+'：'+view.values.price,...Object.values(view.notes),view.proof,view.warning,'费用和价差共用同一空间，不能把两项上限同时用满。阈值固定当前名义数量与收益报价，不代表重新卖 PUT 或锁定未来成交。'];
}

/** Pure presentation of quote-based break-even estimates; no execution. */
export function mountSettlementLimits(doc=document){
 const node=id=>doc.getElementById(id),set=(id,value)=>{const el=node(id);if(el)el.textContent=value;};
 let key='';
 function render(put,dual,cur,rules){
  const nextKey=JSON.stringify([cur,put,dual?.id,dual?.valid,dual?.reason,dual?.amount,dual?.income,dual?.dualBtc,dual?.dualCash,rules]);
  if(nextKey===key)return;key=nextKey;
  const view=settlementLimitsView(put,dual,cur,rules),container=node('settlementLimitsValues');if(container)container.hidden=!view.valid;
  ['limitBudgetValue','limitUsedValue','limitFeeHeadroomValue','limitGapValue','limitMaxPriceValue','limitBudgetNote','limitUsedNote','limitFeeHeadroomNote','limitGapNote','limitConditionsNote','limitRoundingNote','limitBoundaryProof','limitWarning'].forEach(id=>set(id,'—'));
  set('settlementLimitsStatus',view.valid?view.status:view.reason||'等待同条件报价与有效接币情景，暂不生成阈值。');
  set('settlementLimitsTitle',view.valid?(view.kind==='income'?'费用超过这条线，净收入就少于双币':'费用和买价，超过这条线就少接币'):'费用与买价临界线 · 仅模拟');
  if(!view.valid)return;
  for(const [key,id] of Object.entries({budget:'Budget',used:'Used',fee:'FeeHeadroom',gap:'Gap'})){
   set('limit'+id+'Label',view.labels[key]);set('limit'+id+'Value',view.values[key]);set('limit'+id+'Note',view.notes[key]);
  }
  set('limitMaxPriceLabel',view.labels.price);set('limitMaxPriceValue',view.values.price);
  set('limitConditionsNote','按所选双币、同笔资金、同币种、同接币价、同到期与当前假设结算价计算。额外费用和最高买价分别固定其它条件计算，共享同一预算，不能同时各自用满。临界买价是情景估算，尚未套用现货价格最小跳动，不代表可锁定的成交价。');
  set('limitRoundingNote',view.kind==='income'?'阈值金额向下显示至分；比较本期净收入。':(view.roundingKnown?'已按公开现货数量步长、手续费扣币方式与最小订单计算。':'未取得现货数量步长：阈值为连续数量模型估算。')+'上限金额与百分比向下显示，避免四舍五入放大可承受范围。');
  set('limitBoundaryProof',view.proof);set('limitWarning',view.warning);
  for(const id of ['limitFeeHeadroomValue','limitGapValue']){const el=node(id);if(el)el.className=view.kind==='income'&&id==='limitGapValue'?'':(view.extraFeeHeadroom<0||view.kind!=='income'&&view.maxGapRate<0)?'negative':'positive';}
 }
 return {render};
}

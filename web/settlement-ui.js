import {compareSettlement} from './settlement-comparison.js';
import {mountSettlementBreakdown,settlementBreakdownExportLines} from './settlement-breakdown-ui.js';
import {mountSettlementLimits,settlementLimitsExportLines} from './settlement-limits-ui.js';

const number=(value,d=2)=>Number(value).toLocaleString('zh-CN',{maximumFractionDigits:d});
const cash=(value,cur)=>(value>0&&value<.01?'<0.01':number(value))+' '+cur;
export function settlementDifferenceLabel(result,cur){
 if(!result?.valid)return '—';
 if(result.kind==='pending')return '待买入 · 暂不比较接币差额';
 const v=result.difference;
 if(Math.abs(v)<(result.kind==='btc'?.000000005:.005))return result.kind==='btc'?'接币量相同（按 8 位小数）':'收益相同（按分显示）';
 if(result.kind==='btc')return (v>0?'多接 ':v<0?'少接 ':'相同 ')+number(Math.abs(v),8)+' BTC';
 return (v>0?'多拿 ':v<0?'少拿 ':'相同 ')+number(Math.abs(v))+' '+cur;
}
export function settlementExportLines(put,row,cur,spotRules){
 const s=compareSettlement(put,row);
 if(!s.valid)return ['到期结果：'+(s.reason||'暂不可比较')+'；未计算到期差额。'];
 return [
  '到期情景：'+(s.triggered?'触发接币':'未触发，保留现金')+'；'+settlementDifferenceLabel(s,cur),
  'SELL PUT：净 '+number(s.putBtc,8)+' BTC，现金 '+number(s.putCash,8)+' '+cur+'，总资产 '+number(s.putAssets)+' '+cur,
  row.name+'：净 '+number(s.dualBtc,8)+' BTC，现金 '+number(s.dualCash,8)+' '+cur+'，总资产 '+number(s.dualAssets)+' '+cur,
  '总资产差（PUT减双币）：'+number(s.assetDifference)+' '+cur+(s.kind==='pending'?'（PUT 侧为待买入现金）':''),
  ...settlementBreakdownExportLines(put,row,cur),
  ...settlementLimitsExportLines(put,row,cur,spotRules),
 ];
}

/** Renders local calculations only; has no account, network or order operations. */
export function mountSettlementComparison(doc=document){
 const node=id=>doc.getElementById(id),set=(id,value)=>{const el=node(id);if(el)el.textContent=value;};
 let current=null,selected='',chosen=false,optionsKey='';
 const selector=node('settlementPlatform');
 const breakdownUI=mountSettlementBreakdown(doc);
 const limitsUI=mountSettlementLimits(doc);
 selector?.addEventListener('change',()=>{selected=selector.value;chosen=true;if(current)render(...current);});
 function render(put,rows,cur,spotRules){
  current=[put,rows,cur,spotRules];
  if(!chosen){const ready=rows.find(r=>r.valid);selected=ready?.id||selected||rows[0]?.id||'';if(ready)chosen=true;}
  const key=JSON.stringify(rows.map(r=>[r.id,r.name,r.valid]));
  if(key!==optionsKey){
   optionsKey=key;selector?.replaceChildren(...rows.map(r=>{const option=doc.createElement('option');option.value=r.id;option.textContent=r.name+(r.valid?'':' · 暂不可比');return option;}));
  }
  if(selector)selector.value=selected;
  const row=rows.find(r=>r.id===selected),s=compareSettlement(put,row);
  breakdownUI.render(put,row,cur);
  limitsUI.render(put,row,cur,spotRules);
  set('settlementDualName',row?.name||'所选双币');
  set('settlementScenarioNote',put?.valid?'假设结算价 '+number(put.expiryPrice)+' '+cur+' · '+(put.triggered?'低于或等于目标价，触发接币':'高于目标价，未触发')+(put.purchaseExecuted?'；假设现货买价 '+number(put.purchasePrice)+' '+cur:''):'等待有效情景和公开报价');
  set('settlementPutBtc',put?.valid?number(put.btcReceived,8)+' BTC':'—');
  set('settlementPutCash',put?.valid?cash(put.cash,cur):'—');
  set('settlementPutAssets',put?.valid?number(put.assets)+' '+cur:'—');
  ['settlementDualBtc','settlementDualCash','settlementDualAssets','settlementDifferenceValue','settlementAssetDifference'].forEach(id=>set(id,'—'));
  const delta=node('settlementDifferenceValue');if(delta)delta.className='';
  set('settlementDifferenceCaption',put?.triggered?'SELL PUT 到期接币数量差':'SELL PUT 未触发时净收益差');
  if(!s.valid){set('settlementComparisonStatus',s.reason||row?.reason||'没有同条件的有效双币报价，暂不可比较');return;}
  set('settlementDualBtc',number(s.dualBtc,8)+' BTC');set('settlementDualCash',cash(s.dualCash,cur));set('settlementDualAssets',number(s.dualAssets)+' '+cur);
  set('settlementDifferenceCaption','SELL PUT 相比 '+row.name+(s.triggered?' · 净接币数量差':' · 扣费收益差'));
  set('settlementDifferenceValue',settlementDifferenceLabel(s,cur));
  if(delta)delta.className=s.kind==='pending'?'':s.difference>=0?'positive':'negative';
  set('settlementAssetDifference','到期总资产：SELL PUT '+(s.assetDifference>=0?'多 ':'少 ')+number(Math.abs(s.assetDifference))+' '+cur+'（两边 BTC 均按假设结算价估值，含剩余现金'+(s.kind==='pending'?'；PUT 侧为待买入现金':'')+'）');
  set('settlementComparisonStatus',s.kind==='pending'?'已触发，但当前情景无法完成现货买入。SELL PUT 资金保留为现金，不能显示为已接币。':(row.estimateOnly?'公开真实报价 · 金额与接币量为估算，申购资格及精度以平台为准。':'同笔资金、同币种、同接币价、同到期时刻。')+(s.triggered?'双币将本金与收益按目标价转成 BTC；SELL PUT 先现金结算，再用全部余款买币。':'两边均保留本金；这里直接比较扣费后净收益。'));
 }
 return {render,selectPlatform(id){selected=id;chosen=true;if(current)render(...current);}};
}

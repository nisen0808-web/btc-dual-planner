const number=(value,d=2)=>Number(value).toLocaleString('zh-CN',{maximumFractionDigits:d});
const percent=value=>number(value*100)+'%';

/** Local presentation only: this module has no network or account operations. */
export function mountSimulationUI(getState,doc=document){
 const byId=id=>doc.getElementById(id),put=(id,value)=>{const node=byId(id);if(node)node.textContent=value;};
 let completed=false,lastSignature='';
 function render(){
  const {model:m,market,contract}=getState(),button=byId('runSimulation');
  if(!m?.valid||!market||!contract){
   if(button)button.disabled=true;completed=false;lastSignature='';
   ['scenarioPremiumValue','scenarioTermValue','scenarioAnnualValue','scenarioPortfolioRate','portfolioPnlValue','settlementLossValue','basisCostValue','purchaseCashValue','purchasePriceValue','spotFeeValue','deliveryFeeValue','cashBeforeBuyValue','finalBtcValue','finalCashValue'].forEach(id=>put(id,'—'));
   put('simulationState','等待公开行情和有效参数 · 无需登录');byId('simulationSteps')?.replaceChildren();return;
  }
  const cur=market.platform==='deribit'?'USDC':'USDT';
  const signature=JSON.stringify([contract.symbol,m.amount,m.q,m.gross,m.openFee,m.expiryPrice,m.spotGapRate,m.purchasePrice,m.btcReceived]);
  if(signature!==lastSignature){completed=false;lastSignature=signature;}
  if(button)button.disabled=false;
  put('scenarioPremiumValue',number(m.scenarioNetIncome)+' '+cur);
  put('scenarioTermValue',percent(m.scenarioTerm));put('scenarioAnnualValue',percent(m.scenarioAnnual));
  put('scenarioPortfolioRate',percent(m.portfolioTerm));
  put('portfolioPnlValue',(m.pnl>0?'+':'')+number(m.pnl)+' '+cur);
  const pnl=byId('portfolioPnlValue');if(pnl)pnl.className=m.pnl<0?'negative':'positive';
  put('settlementLossValue',number(m.payout)+' '+cur);put('basisCostValue',number(m.basisCost)+' '+cur);
  const rate=byId('scenarioPortfolioRate');if(rate)rate.className=m.portfolioTerm<0?'negative':'positive';
  put('purchaseCashValue',number(m.purchaseCash)+' '+cur);
  put('purchasePriceValue',m.purchaseExecuted?number(m.purchasePrice)+' '+cur:m.purchaseStatus==='below_spot_minimum'?'低于现货最小买入要求':m.triggered?'无有效买价':'未触发，不买入');
  put('spotFeeValue',number(m.spotFee)+' '+cur);put('deliveryFeeValue',number(m.deliveryFee)+' '+cur);
  put('cashBeforeBuyValue',number(m.afterSettlementCash)+' '+cur);
  put('finalBtcValue',number(m.btcReceived,8)+' BTC');put('finalCashValue',(m.cash>0&&m.cash<.01?'<0.01':number(m.cash))+' '+cur);
  put('simulationState',completed?(m.triggered&&!m.purchaseExecuted?'模拟完成 · 资金待买入，没有真实订单':'模拟完成 · 没有提交任何订单'):m.purchaseExecuted?'触发接币 · 模拟用全部剩余资金买 BTC':m.triggered?'已触发，等待有效现货买价或最小数量':'未触发 · 模拟保留本金和扣费后的权利金');
  if(!completed){byId('simulationSteps')?.replaceChildren();return;}
  const rows=[
   '模拟卖出 '+number(m.q,8)+' BTC 的 PUT，按当前买盘收取 '+number(m.gross)+' '+cur+' 权利金，开仓费 '+number(m.openFee)+' '+cur+'。',
   '模拟到期结算：现金赔付 '+number(m.payout)+' '+cur+'，交割费 '+number(m.deliveryFee)+' '+cur+'，本策略剩余 '+number(m.afterSettlementCash)+' '+cur+'。',
   m.purchaseExecuted?'将全部剩余资金用于现货买入，含现货费 '+number(m.spotFee)+' '+cur+'，预计净得 '+number(m.btcReceived,8)+' BTC，余款 '+number(m.cash,8)+' '+cur+'。':m.triggered?'当前情景无法完成买入，资金保留为 '+number(m.cash)+' '+cur+'，不会把未成交显示为接到 BTC。':'到期价高于接币价，不买 BTC；保留 '+number(m.cash)+' '+cur+'。',
   '以上均为本页计算，没有登录、连接账户或提交交易。'
  ];
  byId('simulationSteps')?.replaceChildren(...rows.map(value=>{const li=doc.createElement('li');li.textContent=value;return li;}));
 }
 byId('runSimulation')?.addEventListener('click',()=>{completed=true;render();});
 return {render};
}

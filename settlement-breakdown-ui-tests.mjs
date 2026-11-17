import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {calculateSimulation} from './web/calc.js';
import {compareBinanceDual} from './web/binance-dual.js';
import {settlementBreakdownView,mountSettlementBreakdown,settlementBreakdownExportLines} from './web/settlement-breakdown-ui.js';

const now=Date.UTC(2026,9,23),expiry=now+7*86400000;
const contract={strike:77000,expires:expiry,min:.01,step:.01,taker:.0003,cap:.07,delivery:.00015,deliveryCap:.125,spot:.001,spotDeductBase:true,spotStep:.000001,spotMin:.000001,spotMinNotional:1};
function fixture(price=73150,gap=.001){
 const put=calculateSimulation(80000,contract,{time:now,bids:[{price:400,qty:5}]},81117,now,price,0,gap);
 const product={id:'ordinary',optionType:'PUT',exercisedCoin:'BTC',investCoin:'USDT',strikePrice:'77000',duration:7,settleDate:expiry,purchaseDecimal:4,purchaseEndTime:now+86400000,canPurchase:true,apr:'0.2',minAmount:'10',maxAmount:'1000000'};
 const dual={...compareBinanceDual(80000,{...put,expires:expiry,settleCoin:'USDT'},{status:'ready',product,currency:'USDT',serverTime:now,fetchedAt:now,receivedAt:now,contract:{strike:77000,expires:expiry}},now),name:'Binance 普通双币',id:'binance'};
 assert.equal(put.valid,true);assert.equal(dual.valid,true);return {put,dual};
}
function fakeDocument(){
 class Node{constructor(){this.textContent='';this.children=[];this.listeners={};this.dataset={};this.hidden=false;}replaceChildren(...items){this.children=items;}append(...items){this.children.push(...items);}addEventListener(e,fn){this.listeners[e]=fn;}}
 const nodes=new Map();return {getElementById(id){if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id);},createElement(){return new Node();}};
}
test('extra net premium can still buy fewer BTC, and zero gap isolates the assumption without altering PUT sizing',()=>{
 const {put,dual}=fixture(),view=settlementBreakdownView(put,dual,'USDT');
 assert.ok(put.netIncome>dual.income);assert.ok(put.btcReceived<dual.dualBtc);assert.equal(view.valid,true);
 assert.match(view.diagnosis,/0.1% 买价偏差/);assert.match(view.diagnosis,/净接币少/);
 const noGap=fixture(73150,0);assert.equal(noGap.put.q,put.q);assert.equal(noGap.put.gross,put.gross);assert.equal(noGap.put.basisCost,0);assert.ok(noGap.put.btcReceived>noGap.dual.dualBtc);
 assert.doesNotMatch(settlementBreakdownExportLines(noGap.put,noGap.dual,'USDT').join('\n'),/-0(?: USDT| BTC)/);
 assert.ok(Math.abs(view.assetBridgeSum-(put.assets-dual.dualAssets))<1e-7);
 assert.ok(Math.abs(view.btcBridgeSum-(put.btcReceived-dual.dualBtc))<1e-10);
 const fee=view.putFlow.find(r=>r.label==='现货手续费');assert.match(fee.note,/按现货买价折算/);assert.match(fee.note,/BTC/);
 assert.match(view.putFlow.find(r=>r.label==='预留费用（不再扣一次）').note,/不是额外收费/);
 assert.equal(view.dualFlow.find(r=>r.label==='单列费用信息').value,'公开报价未单列');
});
test('flow and attribution update to untriggered and pending states without imaginary fees or BTC impacts',()=>{
 for(const price of [90000,0]){
  const {put,dual}=fixture(price),view=settlementBreakdownView(put,dual,'USDT');assert.equal(view.valid,true);
  assert.equal(view.btcBridgeSum,null);assert.ok(view.rows.every(r=>r.btcImpact===null));
  assert.equal(put.spotFee,0);assert.equal(put.basisCost,0);
  if(price===0)assert.match(view.diagnosis,/不能|不把待买入/);else assert.match(view.diagnosis,/没有买现货/);
 }
});
test('render and export share all amounts, clear expired data, and never request an account or network operation',()=>{
 const original=globalThis.fetch;globalThis.fetch=()=>assert.fail('Local-only breakdown');
 try{
  const {put,dual}=fixture(),doc=fakeDocument(),ui=mountSettlementBreakdown(doc);ui.render(put,dual,'USDT');
  assert.equal(doc.getElementById('settlementFlow').children.length,2);assert.equal(doc.getElementById('settlementAttributionBody').children.length,7);
  assert.equal(doc.getElementById('settlementZeroGap').disabled,false);assert.equal(doc.getElementById('settlementAttributionWrap').hidden,false);
  const text=settlementBreakdownExportLines(put,dual,'USDT').join('\n');assert.match(text,/现金形态调整不是手续费/);assert.match(text,/不再重复扣除/);assert.match(text,/BTC/);assert.match(text,/公开报价未单列/);
  ui.render(put,{...dual,valid:false,reason:'双币报价已失效'},'USDT');
  assert.equal(doc.getElementById('settlementFlow').children.length,0);assert.equal(doc.getElementById('settlementAttributionBody').children.length,0);
  assert.equal(doc.getElementById('settlementAttributionWrap').hidden,true);assert.match(doc.getElementById('settlementBreakdownEmpty').textContent,/失效/);
  assert.doesNotMatch(doc.getElementById('settlementDiagnosis').textContent,/净接币少/);
 }finally{globalThis.fetch=original;}
});
test('Binance entry has no settlement-scenario actions and archived breakdown components cannot submit orders',()=>{
 const html=fs.readFileSync(new URL('./web/index.html',import.meta.url),'utf8');
 assert.deepEqual([...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(m=>m[1]),['binance-app.js']);
 assert.doesNotMatch(html,/id="(?:settlementBreakdown|settlementDiagnosis|settlementFlow|settlementAttributionBody|settlementZeroGap|settlementComparison|scenario|runSimulation|scanDrop)"|代入(?:本页)?模拟/);
 assert.match(html,/按当前买盘深度和公开标准开仓费率计算/);assert.match(html,/实际以订单成交为准/);assert.match(html,/未连接账户时，只能查看真实报价；不会提交订单/);
 for(const file of ['settlement-breakdown.js','settlement-breakdown-ui.js'])assert.doesNotMatch(fs.readFileSync(new URL('./web/'+file,import.meta.url),'utf8'),/fetch\(|\/api\/execution|local-execution|8788/);
});


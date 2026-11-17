import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {calculateSimulation} from './web/calc.js';
import {compareBinanceDual} from './web/binance-dual.js';
import {settlementLimitsView,mountSettlementLimits,settlementLimitsExportLines} from './web/settlement-limits-ui.js';
import {mountSettlementComparison} from './web/settlement-ui.js';
const now=Date.UTC(2026,9,23),expiry=now+7*86400000;
const rules={strike:77000,expires:expiry,min:.01,step:.01,taker:.0003,cap:.07,delivery:.00015,deliveryCap:.125,spot:.001,spotDeductBase:true,spotStep:.000001,spotMin:.000001,spotMinNotional:1};
function fixture(price=73150,gap=0,bid=400){
 const put=calculateSimulation(80000,rules,{time:now,bids:[{price:bid,qty:5}]},81117,now,price,0,gap);
 const product={id:'ordinary',optionType:'PUT',exercisedCoin:'BTC',investCoin:'USDT',strikePrice:'77000',duration:7,settleDate:expiry,purchaseDecimal:4,purchaseEndTime:now+86400000,canPurchase:true,apr:'0.2',minAmount:'10',maxAmount:'1000000'};
 const dual={...compareBinanceDual(80000,{...put,expires:expiry,settleCoin:'USDT'},{status:'ready',product,currency:'USDT',serverTime:now,fetchedAt:now,receivedAt:now,contract:{strike:77000,expires:expiry}},now),name:'Binance 普通双币',id:'binance'};
 assert.equal(put.valid,true);assert.equal(dual.valid,true);return {put,dual};
}
function fakeDocument(){class Node{constructor(){this.textContent='';this.children=[];this.listeners={};this.dataset={};this.hidden=false;this.value='';}replaceChildren(...items){this.children=items;}append(...items){this.children.push(...items);}addEventListener(e,fn){this.listeners[e]=fn;}}const nodes=new Map();return {getElementById(id){if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id);},createElement(){return new Node();}};}
test('default zero gap produces useful, conservatively displayed limits without calls to an account',()=>{
 const old=globalThis.fetch;globalThis.fetch=()=>assert.fail('Local simulation only');
 try{
  const {put,dual}=fixture(),view=settlementLimitsView(put,dual,'USDT',rules);
  assert.equal(view.valid,true);assert.ok(view.extraFeeHeadroom>0);assert.ok(view.maxGapRate>0&&view.maxGapRate<.001);
  assert.match(view.status,/仍不少于双币/);assert.match(view.values.gap,/≤/);assert.match(view.proof,/阈值处预计净 BTC/);
  const cap=Number(view.values.price.replace(/[^\d.]/g,''));assert.ok(cap<=view.maxPurchasePrice);
  const percent=Number(view.values.gap.replace(/[^\d.]/g,''));assert.ok(percent/100<=view.maxGapRate);
  const html=fs.readFileSync(new URL('./web/index.html',import.meta.url),'utf8');
  const target=/<input[^>]*id="targetPrice"[^>]*>/.exec(html)?.[0];assert.ok(target);assert.doesNotMatch(target,/\bvalue=/);assert.match(target,/type="number"/);
  assert.doesNotMatch(html,/id="(?:scanMinStrike|scanMaxStrike|strikeMin|strikeMax)"/);
  assert.deepEqual([...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(m=>m[1]),['binance-app.js']);
  assert.doesNotMatch(html,/id="(?:spotGapRate|scanDrop|scenario|runSimulation|settlementLimits|settlementComparison)"|代入(?:本页)?模拟/);
  assert.match(html,/id="selectedDeliveryFee"/);assert.match(html,/id="selectedSpotFee"/);assert.match(html,/金额到期才能确定/);
 }finally{globalThis.fetch=old;}
});
test('over-limit prices are marked worse, while untriggered income never receives a spot-price threshold',()=>{
 let {put,dual}=fixture(73150,.01),view=settlementLimitsView(put,dual,'USDT',rules);
 assert.equal(view.valid,true);assert.ok(view.extraFeeHeadroom<0);assert.match(view.status,/已少于双币/);assert.match(view.warning,/超过临界线/);
 ({put,dual}=fixture(90000));view=settlementLimitsView(put,dual,'USDT',rules);
 assert.equal(view.kind,'income');assert.equal(view.values.gap,'不适用');assert.match(view.labels.budget,/开仓费/);assert.match(view.proof,/不将未触发收入差换算成 BTC/);
 ({put,dual}=fixture(73150,0,20));view=settlementLimitsView(put,dual,'USDT',rules);
 assert.ok(view.budgetGross<0);assert.equal(view.values.budget,'无正成本空间');assert.match(view.warning,/即使零费用、零价差仍不足以追平/);
});
test('selected platform changes and lost quotes clear all thresholds, including pending zero-price states',()=>{
 const doc=fakeDocument(),ui=mountSettlementComparison(doc),{put,dual}=fixture();
 ui.render(put,[dual,{id:'binance_rfq',name:'RFQ',valid:false,reason:'未取得独立询价'}],'USDT',rules);
 assert.equal(doc.getElementById('settlementLimitsValues').hidden,false);
 const select=doc.getElementById('settlementPlatform');select.value='binance_rfq';select.listeners.change();
 assert.equal(doc.getElementById('settlementLimitsValues').hidden,true);assert.equal(doc.getElementById('limitMaxPriceValue').textContent,'—');assert.match(doc.getElementById('settlementLimitsStatus').textContent,/询价/);
 const state=fixture(0),limits=mountSettlementLimits(doc);limits.render(state.put,state.dual,'USDT',rules);
 assert.equal(doc.getElementById('settlementLimitsValues').hidden,true);assert.equal(doc.getElementById('limitGapValue').textContent,'—');
 limits.render(put,{...dual,valid:false,reason:'报价已失效'},'USDT',rules);assert.match(doc.getElementById('settlementLimitsStatus').textContent,/失效/);
});
test('export contains shared-budget restrictions and new modules have no transaction or network capability',()=>{
 const {put,dual}=fixture(),text=settlementLimitsExportLines(put,dual,'USDT',rules).join('\n');
 assert.match(text,/不能把两项上限同时用满/);assert.match(text,/最高现货买价/);assert.match(text,/取整余款/);
 for(const file of ['settlement-limits.js','settlement-limits-ui.js'])assert.doesNotMatch(fs.readFileSync(new URL('./web/'+file,import.meta.url),'utf8'),/fetch\(|\/api\/execution|local-execution|8788/);
});



import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mountSettlementComparison,settlementExportLines,settlementDifferenceLabel} from './web/settlement-ui.js';
import {platformComparisons} from './web/dual-platforms.js';
import {calculateSimulation} from './web/calc.js';
const now=Date.UTC(2026,9,22,8),expiry=now+7*86400000;
function fakeDocument(){
 class Node{constructor(){this.textContent='';this.value='';this.children=[];this.listeners={};this.dataset={};}addEventListener(e,fn){this.listeners[e]=fn;}replaceChildren(...items){this.children=items;}append(...items){this.children.push(...items);}}
 const nodes=new Map();return {getElementById(id){if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id);},createElement(){return new Node();}};
}
const contract={strike:80000,expires:expiry,step:.01,min:.01,taker:.0003,cap:.125,delivery:.00015,deliveryCap:.125,spot:.0005};
const data={status:'ready',serverTime:now,receivedAt:now,currency:'USDT',contract:{strike:80000,expires:expiry},product:{productId:'p',baseCoin:'BTC',quoteCoin:'USDT',status:'Available',duration:'7d',subscribeStartAt:now-1000,subscribeEndAt:now+100000,remainingAmountQuote:1000000,settlementTime:expiry,orderPrecisionDigitalQuote:2,minPurchaseQuoteAmount:1},quote:{selectPrice:80000,apyE8:36500000,maxInvestmentAmount:1000000,expiredAt:now+20000}};
function scenario(price){
 const m=calculateSimulation(10000,contract,{time:now,bids:[{price:1000,qty:2}]},81000,now,price,0,.001);
 const rows=platformComparisons(10000,{...m,expires:expiry,settleCoin:'USDT'},data,now,now);
 return {m,rows};
}
test('public comparators feed changing final BTC/cash outcomes into UI and export without network',()=>{
 const doc=fakeDocument(),ui=mountSettlementComparison(doc),old=globalThis.fetch;globalThis.fetch=()=>assert.fail('Only local simulation');
 try{
  let {m,rows}=scenario(75000);ui.render(m,rows,'USDT');
  assert.match(doc.getElementById('settlementDualBtc').textContent,/0.125875 BTC/);
  assert.match(doc.getElementById('settlementDifferenceValue').textContent,/(多接|少接).*BTC/);
  assert.match(doc.getElementById('settlementAssetDifference').textContent,/剩余现金/);
  assert.match(settlementExportLines(m,rows[0],'USDT').join('\n'),/触发接币.*(多接|少接)/);
  ({m,rows}=scenario(90000));ui.render(m,rows,'USDT');
  assert.equal(doc.getElementById('settlementDualBtc').textContent,'0 BTC');
  assert.match(doc.getElementById('settlementDifferenceValue').textContent,/(多拿|少拿).*USDT/);
  assert.match(settlementExportLines(m,rows[0],'USDT').join('\n'),/未触发，保留现金/);
 }finally{globalThis.fetch=old;}
});
test('pending buy preserves cash and never reports a successful BTC advantage',()=>{
 const doc=fakeDocument(),ui=mountSettlementComparison(doc),{m,rows}=scenario(0);ui.render(m,rows,'USDT');
 assert.match(doc.getElementById('settlementDifferenceValue').textContent,/待买入/);
 assert.match(doc.getElementById('settlementComparisonStatus').textContent,/不能显示为已接币/);
 assert.equal(doc.getElementById('settlementPutBtc').textContent,'0 BTC');
 assert.doesNotMatch(settlementExportLines(m,rows[0],'USDT').join('\n'),/多接/);
});
test('expired or explicitly selected unavailable sources clear comparison and never switch benchmarks',()=>{
 const doc=fakeDocument(),ui=mountSettlementComparison(doc),{m,rows}=scenario(75000);ui.render(m,rows,'USDT');
 const select=doc.getElementById('settlementPlatform');select.value='binance_rfq';select.listeners.change();
 assert.equal(doc.getElementById('settlementDifferenceValue').textContent,'—');
 assert.equal(doc.getElementById('settlementDualBtc').textContent,'—');
 assert.match(doc.getElementById('settlementComparisonStatus').textContent,/询价/);
 ui.render(m,rows,'USDT');assert.equal(select.value,'binance_rfq');
 select.value='bybit';select.listeners.change();
 const stale=platformComparisons(10000,{...m,expires:expiry,settleCoin:'USDT'},data,now+20000,now);ui.render(m,stale,'USDT');
 assert.equal(doc.getElementById('settlementDifferenceValue').textContent,'—');assert.match(doc.getElementById('settlementComparisonStatus').textContent,/失效/);
 ui.render(null,stale,'USDT');assert.equal(doc.getElementById('settlementPutBtc').textContent,'—');
});
test('Binance page shows actual expiry and fees while retired outcome modules remain offline',()=>{
 const html=fs.readFileSync(new URL('./web/index.html',import.meta.url),'utf8');
 for(const id of ['expirySelect','quoteQuantity','selectedExpiry','selectedNetPremium','selectedCashAtExpiry','selectedDeliveryFee','selectedSpotFee','spotValue','spotUpdated'])assert.ok(html.includes('id="'+id+'"'),id);
 assert.deepEqual([...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(m=>m[1]),['binance-app.js']);
 assert.doesNotMatch(html,/id="(?:settlementComparison|settlementPlatform|settlementPutBtc|settlementDualBtc|scanDrop|scenario|runSimulation)"|代入(?:本页)?模拟/);
 const tables=[...html.matchAll(/<table class="comparison-table">[\s\S]*?<\/table>/g)].map(m=>m[0]);assert.equal(tables.length,2);for(const [index,bodyId]of ['dualComparisonBody','callComparisonBody'].entries()){assert.equal([...tables[index].matchAll(/<th\b/g)].length,5);assert.ok(tables[index].includes('id="'+bodyId+'"'));}for(const label of ['本次预计净收入','本期收益率','简单年化','SELL PUT 比它多拿'])assert.ok(html.includes(label),label);assert.match(html,/同 USDT、同接币价、同到期时刻/);assert.match(html,/按平台本期率|分别|真实计息|以下比较未触发时的预计现金收入/);
 for(const file of ['settlement-comparison.js','settlement-ui.js'])assert.doesNotMatch(fs.readFileSync(new URL('./web/'+file,import.meta.url),'utf8'),/fetch\(|\/api\/execution|local-execution|8788/);
});
test('rounded-to-zero differences are displayed as equal rather than more/less zero',()=>{
 assert.match(settlementDifferenceLabel({valid:true,kind:'btc',difference:-1e-10},'USDT'),/相同/);
 assert.match(settlementDifferenceLabel({valid:true,kind:'income',difference:.001},'USDT'),/相同/);
 assert.match(settlementDifferenceLabel({valid:true,kind:'btc',difference:-.00000001},'USDT'),/少接/);
});



import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {calculateSimulation} from './web/calc.js';
import {mountSimulationUI} from './web/simulation-ui.js';

function fakeDocument(){
 class Node{constructor(){this.textContent='';this.children=[];this.listeners={};}addEventListener(event,fn){this.listeners[event]=fn;}replaceChildren(...items){this.children=items;}click(){this.listeners.click?.();}}
 const nodes=new Map();return {nodes,getElementById(id){if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id);},createElement(){return new Node();}};
}
const now=Date.UTC(2026,9,23),contract={symbol:'BTC_USDC-30OCT26-80000-P',strike:80000,expires:now+7*86400000,step:.01,min:.01,taker:.0003,cap:.125,delivery:.00015,deliveryCap:.125,spot:.0005};
const book={time:now,bids:[{price:1000,qty:2}]};
function model(price=75000,options={}){return calculateSimulation(10000,{...contract,...options},book,81000,now,price,0,.001);}

test('local simulation renders all-balance BTC and steps without account or network operations',()=>{
 const doc=fakeDocument(),state={model:model(),market:{platform:'deribit'},contract};
 const original=globalThis.fetch;globalThis.fetch=()=>assert.fail('Local simulation may not fetch or trade');
 try{
  const ui=mountSimulationUI(()=>state,doc);ui.render();
  assert.equal(doc.getElementById('runSimulation').disabled,false);
  assert.match(doc.getElementById('finalBtcValue').textContent,/BTC/);
  assert.equal(doc.getElementById('finalCashValue').textContent,'0 USDC');
  doc.getElementById('runSimulation').click();
  assert.match(doc.getElementById('simulationState').textContent,/模拟完成/);
  assert.equal(doc.getElementById('simulationSteps').children.length,4);
  assert.match(doc.getElementById('simulationSteps').children[2].textContent,/全部剩余资金/);
  assert.match(doc.getElementById('simulationSteps').children[3].textContent,/没有登录/);
 }finally{globalThis.fetch=original;}
});
test('switching to untriggered or invalid inputs clears the prior simulated BTC and steps',()=>{
 const doc=fakeDocument(),state={model:model(),market:{platform:'deribit'},contract};const ui=mountSimulationUI(()=>state,doc);ui.render();doc.getElementById('runSimulation').click();
 state.model=model(90000);ui.render();
 assert.equal(doc.getElementById('finalBtcValue').textContent,'0 BTC');assert.match(doc.getElementById('simulationState').textContent,/未触发/);
 assert.equal(doc.getElementById('simulationSteps').children.length,0);
 doc.getElementById('runSimulation').click();assert.match(doc.getElementById('simulationSteps').children[2].textContent,/不买 BTC/);
 state.model=null;ui.render();assert.equal(doc.getElementById('runSimulation').disabled,true);assert.equal(doc.getElementById('finalBtcValue').textContent,'—');
});
test('a zero price or a spot minimum failure is visibly pending, never a successful BTC delivery',()=>{
 const doc=fakeDocument(),state={model:model(0),market:{platform:'deribit'},contract};const ui=mountSimulationUI(()=>state,doc);ui.render();doc.getElementById('runSimulation').click();
 assert.equal(doc.getElementById('finalBtcValue').textContent,'0 BTC');assert.match(doc.getElementById('simulationSteps').children[2].textContent,/无法完成买入/);
 state.model=model(75000,{spotMin:1});ui.render();assert.match(doc.getElementById('purchasePriceValue').textContent,/最小买入/);
 assert.equal(doc.getElementById('finalBtcValue').textContent,'0 BTC');
});
test('Binance page keeps unique strategy/order IDs without exposing hypothetical future prices',()=>{
 const html=fs.readFileSync(new URL('./web/index.html',import.meta.url),'utf8'),ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(x=>x[1]);assert.equal(ids.length,new Set(ids).size);
 for(const id of ['binanceStrategyForm','strategyAmount','targetPrice','expirySelect','settlementMode','quoteQuantity','placePutOrder','orderReview','confirmPutOrder','plansList'])assert.ok(ids.includes(id),id);
 const form=/<form[^>]*id="binanceStrategyForm"[^>]*>([\s\S]*?)<\/form>/.exec(html)?.[1];assert.ok(form);assert.deepEqual([...form.matchAll(/<input[^>]*id="([^"]+)"/g)].map(m=>m[1]),['strategyAmount','targetPrice']);
 assert.match(html,/填资金、接币价，选到期日/);assert.match(html,/卖 PUT 成交后，预计净收/);assert.match(html,/未触发到期预计保留/);assert.match(html,/到期触发后怎么处理/);assert.match(html,/先完成期权现金结算/);assert.match(html,/BTC 数量只能由真实结算及成交确定/);
 assert.match(html,/<tbody[^>]*id="dualComparisonBody"/);assert.match(html,/同 USDT、同接币价、同到期时刻/);assert.match(html,/SELL PUT 比它多拿/);assert.match(html,/<select[^>]*id="settlementMode"/);assert.match(html,/<option[^>]*value="cash"/);assert.match(html,/<option[^>]*value="buy_btc"/);
 for(const id of ['placePutOrder','confirmPutOrder'])assert.match(new RegExp('<button[^>]*id="'+id+'"[^>]*>').exec(html)?.[0],/\bdisabled\b/);
 assert.deepEqual([...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(m=>m[1]),['binance-app.js']);
 assert.doesNotMatch(html,/id="(?:strikeMin|strikeMax|scanMinStrike|scanMaxStrike|scanDrop|scenario|spotGapRate|runSimulation|simulationState|finalBtcValue|finalCashValue|settlementComparison|confirmExecution|prepareExecution|connectLocalExecution|executionDialog)"|代入(?:本页)?模拟/);
 assert.match(html,/开仓卖单未成交不收权利金/);assert.match(html,/未连接账户时，只能查看真实报价；不会提交订单/);
 for(const file of ['live-app.js','live-quote-ui.js','app.js','simulation-ui.js']){
  const js=fs.readFileSync(new URL('./web/'+file,import.meta.url),'utf8');
  assert.doesNotMatch(js,/mountExecutionUI|execution-ui|local-execution|\/api\/execution\/|127\.0\.0\.1:8788/);
  if(file!=='simulation-ui.js'){
   assert.doesNotMatch(js,/\/private\/|\/v5\/(?:account|position|order)\/|\/sapi\/v1\/account/);
   assert.doesNotMatch(js,/(?:from\s*|import\s*)['"]\.\/(?:calc|scan-ui|simulation-ui|settlement[^'"]*|combination-scan)\.js['"]/);
  }
  if(file==='simulation-ui.js')assert.doesNotMatch(js,/fetch\(/);
 }
});




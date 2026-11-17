import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as turn} from 'node:timers/promises';
import {readFile} from 'node:fs/promises';
import {mountBinanceDesk} from './web/binance-app.js';

// Synthetic display fixtures only; no exchange credentials, network or execution.
const NOW=Date.UTC(2026,9,27,8),EXP=NOW+86400000;
class Element{
 constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this._text='';this._value='';this.listeners={};this.dataset={};this.disabled=false;this.hidden=false;this.open=false;this.files=[];this.checked=false;this.attributes={};}
 set value(v){this._value=String(v);if(!v)this.files=[];}get value(){return this._value;}
 set textContent(v){this._text=String(v);this.children=[];}get textContent(){return this._text+this.children.map(n=>typeof n==='string'?n:n.textContent).join('');}
 replaceChildren(...nodes){this._text='';this.children=nodes;}append(...nodes){this.children.push(...nodes);}setAttribute(k,v){this.attributes[k]=String(v);}
 addEventListener(k,f){(this.listeners[k]??=[]).push(f);}removeEventListener(){}dispatch(k){return Promise.all((this.listeners[k]??[]).map(f=>f({preventDefault(){}})));}showModal(){this.open=true;}close(){this.open=false;}
}
function documentFixture(){const nodes=new Map(),doc={hidden:false,createElement:t=>new Element(t),getElementById:id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);}};for(const[k,v]of Object.entries({strategyAmount:'10000',targetPrice:'79000',expirySelect:'',settlementMode:'cash',buyBufferRate:'0.005',quoteMode:'ask_limit',connectionKeyType:'RSA'}))doc.getElementById(k).value=v;doc.getElementById('confirmPutOrder').disabled=true;return doc;}
function quoteFixture(mode='ask_limit'){
 const contract={symbol:'BTC-261028-79000-P',strike:79000,expires:EXP,step:.01,min:.01,max:100,settleCoin:'USDT',taker:.00024,cap:.1,delivery:.00015,deliveryCap:.1,spot:.001,feeSourceURLs:['https://www.binance.com/en/fee/optionsTrading']},market={spot:80000,time:NOW,receivedAt:NOW,contracts:[contract]},book={time:NOW,bids:[{price:100,qty:3}],asks:[{price:200,qty:.02}]};
 const quote={valid:true,quoteOnly:true,quoteMode:mode,conditional:mode==='ask_limit',fillGuaranteed:false,executionStatus:mode==='ask_limit'?'unfilled_limit_quote':'quoted',amount:10000,q:.12,gross:mode==='ask_limit'?24:12,openFee:mode==='ask_limit'?2.304:1.2,netIncome:mode==='ask_limit'?21.696:10.8,term:mode==='ask_limit'?.0021696:.00108,annual:mode==='ask_limit'?.791904:.3942,days:1,bestAsk:200,bestAskQty:.02,bestBid:100,averagePrice:mode==='ask_limit'?200:100,levelsUsed:mode==='ask_limit'?0:1,depthQty:mode==='ask_limit'?null:3,quoteTime:NOW};
 const product={id:'dual',investCoin:'USDT',exercisedCoin:'BTC',strikePrice:'79000',duration:1,settleDate:EXP,purchaseDecimal:4,purchaseEndTime:NOW+3600000,canPurchase:true,apr:'0.365',minAmount:'10',maxAmount:'20000',optionType:'PUT'};
 const entry={id:'binance:'+EXP,platform:'binance',currency:'USDT',strike:79000,expires:EXP,data:{status:'ready',currency:'USDT',sourceType:'sapi',serverTime:NOW,receivedAt:NOW,fetchedAt:NOW,snapshotAgeAtReceive:0,contract:{strike:79000,expires:EXP},product,quote:{expiredAt:NOW+30000}}};
 return{market,amount:10000,targetPrice:79000,settlementMode:'cash',quoteMode:mode,expiries:[EXP],selectedExpiry:EXP,row:{contract,market,book,quote,receivedAt:NOW},entries:[entry],sources:[{platform:'binance',status:'ready'}],reason:''};
}
async function until(fn){for(let i=0;i<80;i++){if(fn())return;await turn();}assert.fail('UI state was not reached');}
function setup(t,{collectHook}={}){const intervals=[],timeouts=[],calls=[],reads=[],stored=[],doc=documentFixture();let now=NOW;
 t.mock.method(globalThis,'setInterval',(f,ms)=>{intervals.push({f,ms});return intervals.length;});t.mock.method(globalThis,'clearInterval',()=>{});t.mock.method(globalThis,'setTimeout',f=>{timeouts.push(f);return timeouts.length;});t.mock.method(globalThis,'clearTimeout',()=>{});
 const old=Object.getOwnPropertyDescriptor(globalThis,'localStorage');Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{setItem(k,v){stored.push({k,value:JSON.parse(v)});}}});t.after(()=>{if(old)Object.defineProperty(globalThis,'localStorage',old);else delete globalThis.localStorage;});
 const local={readonly:true,async api(action){calls.push(action);assert.equal(action,'status');return{brokerConfigured:false,connected:false,canSubmit:false};}};
 const ui=mountBinanceDesk({doc,clock:()=>now,localFactory:()=>local,collect:async input=>{reads.push({...input});return collectHook?collectHook(input,reads.length):quoteFixture(input.quoteMode);}});t.after(()=>ui.destroy());
 return{doc,ui,reads,calls,stored,intervals,timeouts,setNow:v=>now=v};
}
const noTrades=f=>assert.ok(f.calls.every(action=>action==='status'));

test('HTML defaults to a compact ask-limit selector and keeps all order submission disabled',async()=>{const html=await readFile(new URL('./web/index.html',import.meta.url),'utf8');assert.match(html,/<select id="quoteMode"[^>]*><option value="ask_limit" selected>/);assert.match(html,/value="bid_taker"/);assert.match(html,/id="selectedPremiumLabel">若卖一挂单全部成交/);assert.match(html,/id="placePutOrder"[^>]*disabled/);});
test('ask quote displays a conditional premium and rate, never competing asks as executable depth',async t=>{const f=setup(t),el=id=>f.doc.getElementById(id);await until(()=>el('selectedNetPremium').textContent==='21.7');assert.equal(f.reads[0].quoteMode,'ask_limit');assert.equal(el('quoteBestPriceLabel').textContent,'卖一权利金单价');assert.equal(el('quoteAverageLabel').textContent,'拟挂单价');assert.match(el('quoteDepthLabel').textContent,/卖一挂卖量/);assert.equal(el('quoteBestBid').textContent,'200 USDT / BTC');assert.equal(el('quoteAverage').textContent,'200 USDT / BTC');assert.match(el('quoteDepth').textContent,/0\.02 BTC.*挂卖量/);assert.doesNotMatch(el('quoteDepth').textContent,/承接|可成交|可见买量|档/);assert.match(el('depthNote').textContent,/不代表买方可成交量/);assert.match(el('selectedPremiumLabel').textContent,/若.*全部成交/);assert.match(el('selectedQuoteAssumption').textContent,/全部成交.*年化按现在至到期.*实际成交时间和价格/);assert.match(el('selectedAprLabel').textContent,/条件/);assert.match(el('quoteStatus').textContent,/只有全部成交/);assert.match(el('dualComparisonBody').textContent,/若全部成交.*这笔预计多拿/);assert.match(el('comparisonNotes').textContent,/本期收益率.*年化.*收益差.*全部成交/);assert.equal(el('placePutOrder').disabled,true);assert.equal(el('confirmPutOrder').disabled,true);await el('placePutOrder').dispatch('click');await el('confirmPutOrder').dispatch('click');noTrades(f);});
test('switching to bid mode clears the old quote and preserves amount, exact price and expiry',async t=>{const f=setup(t),el=id=>f.doc.getElementById(id);await until(()=>el('selectedNetPremium').textContent==='21.7');const expiry=el('expirySelect').value;el('quoteMode').value='bid_taker';await el('quoteMode').dispatch('change');assert.equal(el('selectedNetPremium').textContent,'—');assert.equal(el('strategyAmount').value,'10,000');assert.equal(el('targetPrice').value,'79,000');assert.equal(el('expirySelect').value,expiry);await f.ui.refresh();assert.equal(f.reads.at(-1).quoteMode,'bid_taker');assert.equal(el('selectedNetPremium').textContent,'10.8');assert.equal(el('quoteBestPriceLabel').textContent,'买一权利金单价');assert.equal(el('quoteAverageLabel').textContent,'逐档成交均价');assert.match(el('quoteDepth').textContent,/1 档.*可见买量/);assert.doesNotMatch(el('dualComparisonBody').textContent,/若全部成交/);assert.equal(f.stored.at(-1).value.quoteMode,'bid_taker');noTrades(f);});
test('invalid quote modes are canonicalized and never saved as an arbitrary setting',async t=>{const f=setup(t);await until(()=>f.doc.getElementById('selectedNetPremium').textContent==='21.7');f.doc.getElementById('quoteMode').value='external_execution';await f.doc.getElementById('quoteMode').dispatch('change');await f.ui.refresh();assert.equal(f.reads.at(-1).quoteMode,'ask_limit');assert.equal(f.stored.at(-1).value.quoteMode,'ask_limit');assert.equal(f.stored.at(-1).value.amount,'10000');assert.equal(f.stored.at(-1).value.targetPrice,'79000');assert.equal(f.stored.at(-1).value.expiry,String(EXP));noTrades(f);});
test('a late ask quote cannot overwrite the later selected bid mode',async t=>{let release;const pending=new Promise(r=>release=r);const f=setup(t,{collectHook:(input,count)=>count===1?pending:quoteFixture(input.quoteMode)}),el=id=>f.doc.getElementById(id);try{await until(()=>f.reads.length===1);el('quoteMode').value='bid_taker';await el('quoteMode').dispatch('change');await f.ui.refresh();assert.equal(el('selectedNetPremium').textContent,'10.8');release(quoteFixture('ask_limit'));await turn();await turn();assert.equal(el('selectedNetPremium').textContent,'10.8');assert.equal(el('quoteBestPriceLabel').textContent,'买一权利金单价');assert.equal(el('quoteMode').value,'bid_taker');noTrades(f);}finally{release(quoteFixture('ask_limit'));}});
test('conditional ask income and comparison are removed at the original thirty-second deadline',async t=>{const f=setup(t),el=id=>f.doc.getElementById(id);await until(()=>el('selectedNetPremium').textContent==='21.7');f.setNow(NOW+30000);f.intervals.find(x=>x.ms===1000).f();assert.equal(el('selectedNetPremium').textContent,'—');assert.doesNotMatch(el('dualComparisonBody').textContent,/21\.7 USDT/);assert.match(el('quoteStatus').textContent,/超过 30 秒/);assert.equal(el('placePutOrder').disabled,true);noTrades(f);});

test('the chosen actual contract name is prominent, and changing the target clears it immediately',async t=>{
 const f=setup(t),el=id=>f.doc.getElementById(id);await until(()=>el('selectedNetPremium').textContent==='21.7');
 assert.equal(el('selectedContractName').textContent,'BTC-261028-79000-P');
 el('targetPrice').value='78,000';await el('targetPrice').dispatch('input');
 assert.equal(el('selectedContractName').textContent,'—');assert.equal(el('placePutOrder').disabled,true);noTrades(f);
});

test('an exact listed contract can be named when its order book fails, then disappears when market data expires',async t=>{
 const data=quoteFixture(),f=setup(t,{collectHook:()=>data}),el=id=>f.doc.getElementById(id);await until(()=>el('selectedNetPremium').textContent==='21.7');
 data.row.quote={valid:false,reason:'盘口暂不可读'};await f.ui.refresh();
 assert.equal(el('selectedContractName').textContent,'BTC-261028-79000-P');assert.equal(el('selectedNetPremium').textContent,'—');
 f.setNow(NOW+30000);f.intervals.find(x=>x.ms===1000).f();assert.equal(el('selectedContractName').textContent,'—');noTrades(f);
});

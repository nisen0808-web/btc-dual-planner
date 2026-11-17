import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as turn} from 'node:timers/promises';
import {mountDeribitDesk} from './web/deribit-app.js';
import {calculatePutQuote} from './web/live-quotes.js';
const NOW=Date.UTC(2026,9,23,8),expiry=NOW+86400000;
class Element{
 constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this._text='';this.value='';this.listeners={};this.dataset={};this.disabled=false;this.hidden=false;this.open=false;this.attributes={};}
 set textContent(t){this._text=String(t);this.children=[];}get textContent(){return this._text+this.children.map(n=>typeof n==='string'?n:n.textContent).join('');}
 replaceChildren(...a){this._text='';this.children=a;}append(...a){this.children.push(...a);}setAttribute(k,v){this.attributes[k]=String(v);}
 addEventListener(k,f){(this.listeners[k]??=[]).push(f);}dispatch(k){return Promise.all((this.listeners[k]||[]).map(f=>f({preventDefault(){}})));}showModal(){this.open=true;}close(){this.open=false;}
}
function doc(){const nodes=new Map(),d={hidden:false,createElement:t=>new Element(t),getElementById:id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);}};for(const[k,v]of Object.entries({strategyAmount:'10000',targetPrice:'80000',buyBufferRate:'0.005'}))d.getElementById(k).value=v;return d;}
function fixtures(){const contract={symbol:'BTC_USDC-24OCT26-80000-P',strike:80000,expires:expiry,step:.01,min:.01,bid:500,taker:.0003,cap:.125,delivery:0,deliveryExemptionConfirmed:true,deliveryCap:.125,spot:.0005,spotDeductBase:false};const market={platform:'deribit',spot:90000,time:NOW,receivedAt:NOW},book={bids:[{price:500,qty:2}],time:NOW};const quote=calculatePutQuote(10000,contract,book,market.spot,NOW);return {market,amount:10000,targetPrice:80000,allExpiries:[expiry],expiries:[expiry],rows:[{contract,market,book,quote,receivedAt:NOW}],entries:[],sources:[],receivedAt:NOW,reason:''};}
function timers(t){const intervals=[];t.mock.method(globalThis,'setInterval',(f,ms)=>{intervals.push({f,ms});return intervals.length;});t.mock.method(globalThis,'clearInterval',()=>{});t.mock.method(globalThis,'setTimeout',()=>1);t.mock.method(globalThis,'clearTimeout',()=>{});return intervals;}
async function until(fn){for(let i=0;i<30;i++){if(fn())return;await turn();}assert.fail('Expected desk state did not arrive');}
function setup(t,{preparedOverride={},confirmError=false,connectionOverride={}}={}){
 const intervals=timers(t),d=doc(),data=fixtures(),calls=[];let now=NOW,connects=0;
 const status={platform:'deribit',currency:'USDC',account:'local-account',environment:'mainnet',canSubmit:true,runnerOnline:true,accountVerified:true,...connectionOverride};
 const p={id:'prepared-only-mock',fingerprint:'server-frozen-fingerprint',platform:'deribit',currency:'USDC',account:status.account,environment:'mainnet',symbol:data.rows[0].contract.symbol,strike:'80000',amount:'10000',expiry,q:String(data.rows[0].quote.q),limitPrice:'500',estimatedGross:'60',estimatedNetIncome:'57',estimatedOpenFee:'3',openingFeeReserve:'3',buyBufferRate:'.005',expiresAt:NOW+30000,payloadReady:true,spotBudgetMode:'remaining_strategy_cash',orderPayload:{instrument_name:data.rows[0].contract.symbol},...preparedOverride};
 const client={connect(){connects++;return true;},async api(action,input){calls.push({action,input});if(action==='status')return status;if(action==='plans')return [];if(action==='prepare')return p;if(action==='confirm'){if(confirmError)throw Error('Unknown exchange result');return {id:p.id,phase:'put_reconciling'};}throw Error('Unexpected operation');}};
 const ui=mountDeribitDesk({doc:d,collect:async()=>data,localFactory:()=>client,clock:()=>now});t.after(()=>ui.destroy());
 return {d,data,p,calls,intervals,ui,setNow:n=>{now=n;},connects:()=>connects};
}

test('public desk never prepares or confirms merely by rendering, selecting expiry or refreshing',async t=>{
 const f=setup(t);await until(()=>f.d.getElementById('putRows').children.length===1&&f.d.getElementById('connectionStatus').textContent.includes('已连接'));
 assert.equal(f.calls.filter(c=>['prepare','confirm'].includes(c.action)).length,0);assert.equal(f.connects(),0);
 assert.match(f.d.getElementById('selectedExpiry').textContent,/2026.*10月24日.*16:00/);
 assert.equal(f.d.getElementById('selectedCashAtExpiry').textContent,(10000+f.data.rows[0].quote.netIncome).toLocaleString('zh-CN',{maximumFractionDigits:2}));
 await f.d.getElementById('expiryCards').children[0].dispatch('click');await f.ui.refresh();assert.equal(f.calls.filter(c=>c.action==='confirm').length,0);
});
test('prepare freezes the exact server order, and only a separate explicit confirmation sends its bound ID and fingerprint',async t=>{
 const f=setup(t);await until(()=>f.d.getElementById('placePutOrder').textContent==='准备卖出 PUT');
 await f.d.getElementById('placePutOrder').dispatch('click');assert.equal(f.d.getElementById('orderReview').open,true);assert.equal(f.calls.filter(c=>c.action==='confirm').length,0);
 assert.deepEqual(f.calls.find(c=>c.action==='prepare').input,{amount:'10000',symbol:f.p.symbol,buyBufferRate:.005});
 assert.match(f.d.getElementById('reviewContent').textContent,/本笔完整投入/);assert.equal(f.d.getElementById('confirmPutOrder').disabled,false);
 await f.d.getElementById('confirmPutOrder').dispatch('click');assert.deepEqual(f.calls.find(c=>c.action==='confirm').input,{id:f.p.id,fingerprint:f.p.fingerprint,account:f.p.account,currency:'USDC',confirmed:true});
 await f.d.getElementById('confirmPutOrder').dispatch('click');assert.equal(f.calls.filter(c=>c.action==='confirm').length,1);
});
test('changed price and expired 30-second preparation cannot submit an old order',async t=>{
 const f=setup(t);await until(()=>f.d.getElementById('placePutOrder').textContent==='准备卖出 PUT');await f.d.getElementById('placePutOrder').dispatch('click');
 f.d.getElementById('targetPrice').value='81000';await f.d.getElementById('targetPrice').dispatch('input');await f.d.getElementById('confirmPutOrder').dispatch('click');assert.equal(f.calls.filter(c=>c.action==='confirm').length,0);
 f.d.getElementById('targetPrice').value='80000';await f.ui.refresh();await f.d.getElementById('placePutOrder').dispatch('click');f.setNow(NOW+30000);f.intervals.find(i=>i.ms===1000).f();
 assert.equal(f.d.getElementById('confirmPutOrder').disabled,true);await f.d.getElementById('confirmPutOrder').dispatch('click');assert.equal(f.calls.filter(c=>c.action==='confirm').length,0);
});
test('unpaired account opens connection only, and a mismatched preparation stays blocked with a visible reason',async t=>{
 const f=setup(t,{connectionOverride:{canSubmit:false,accountVerified:false,runnerOnline:false}});await until(()=>f.d.getElementById('putRows').children.length===1);
 await f.d.getElementById('placePutOrder').dispatch('click');assert.equal(f.connects(),1);assert.equal(f.calls.filter(c=>['prepare','confirm'].includes(c.action)).length,0);
});
test('incorrect server amount cannot be confirmed or hidden by the next ticket repaint',async t=>{
 const f=setup(t,{preparedOverride:{amount:'9000'}});await until(()=>f.d.getElementById('placePutOrder').textContent==='准备卖出 PUT');await f.d.getElementById('placePutOrder').dispatch('click');
 assert.equal(f.d.getElementById('orderReview').open,false);assert.equal(f.d.getElementById('confirmPutOrder').disabled,true);assert.match(f.d.getElementById('orderStatus').textContent,/完全匹配/);assert.equal(f.calls.filter(c=>c.action==='confirm').length,0);
});
test('unknown submission is never retried by another click, a timer or a render',async t=>{
 const f=setup(t,{confirmError:true});await until(()=>f.d.getElementById('placePutOrder').textContent==='准备卖出 PUT');await f.d.getElementById('placePutOrder').dispatch('click');await f.d.getElementById('confirmPutOrder').dispatch('click');
 await f.d.getElementById('confirmPutOrder').dispatch('click');f.intervals.find(i=>i.ms===1000).f();assert.equal(f.calls.filter(c=>c.action==='confirm').length,1);assert.match(f.d.getElementById('quoteCountdown').textContent,/不自动重发/);
});

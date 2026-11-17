import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {collectLiveInputs,mountLiveQuoteBoard,groupStrategyRows} from './web/live-quote-ui.js';
import {rankLiveQuotes} from './web/live-quotes.js';

const NOW=Date.UTC(2026,9,23,8),DAY=86400000,EXPIRY=NOW+7*DAY;
const baseInput={amount:10000,currency:'USDT',strike:null,minStrike:null,maxStrike:null,maxDays:7,onlyBelowSpot:true};
const contract=(strike=80000,expires=EXPIRY)=>({symbol:`BTC-${expires}-${strike}-P-USDT`,strike,expires,bid:500,step:.01,min:.01,taker:.0003,cap:.07,delivery:.00015,deliveryCap:.125,spot:.001,spotDeductBase:true});
const market=contracts=>({platform:'bybit',contracts,spot:90000,time:NOW,receivedAt:NOW,source:'Bybit BTC/USDT 指数'});
function dualEntry(c){
 const product={id:'fixture-'+c.symbol,optionType:'PUT',exercisedCoin:'BTC',investCoin:'USDT',strikePrice:String(c.strike),duration:7,settleDate:c.expires,purchaseDecimal:4,purchaseEndTime:NOW+3600000,canPurchase:true,apr:'0.365',minAmount:'20',maxAmount:'1000000'};
 return {id:product.id,platform:'binance',currency:'USDT',strike:c.strike,expires:c.expires,data:{status:'ready',currency:'USDT',product,serverTime:NOW,fetchedAt:NOW,receivedAt:NOW,contract:{symbol:c.symbol,strike:c.strike,expires:c.expires}}};
}
function snapshot(c=contract(),tag='current',paired=true){return {tag,markets:[market([c])],entries:paired?[dualEntry(c)]:[],books:[{platform:'bybit',symbol:c.symbol,receivedAt:NOW,book:{time:NOW-1000,bids:[{price:500,qty:.05},{price:400,qty:2}]}}],sources:[{platform:'binance',name:'Binance 普通双币',status:paired?'ready':'unavailable',count:paired?1:0,reason:'没有同条件报价'}],errors:[],requestedBooks:1,receivedAt:NOW};}
const response=payload=>({ok:true,status:200,headers:{get:()=>new Date(NOW).toUTCString()},json:async()=>structuredClone(payload)});
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
async function until(predicate){for(let i=0;i<30;i++){if(predicate())return;await nextTurn();}assert.fail('Expected asynchronous state did not arrive');}

class Node{
 constructor(tag='div'){this.tagName=tag.toUpperCase();this._text='';this.children=[];this.listeners={};this.dataset={};this.hidden=false;this.disabled=false;this.value='';this.checked=false;this.className='';}
 set textContent(value){this._text=String(value);this.children=[];}
 get textContent(){return this._text+this.children.map(child=>typeof child==='string'?child:child.textContent).join('');}
 replaceChildren(...items){this._text='';this.children=items;}
 append(...items){this.children.push(...items);}
 addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);}
 dispatch(type,event={type,target:this}){return Promise.all((this.listeners[type]||[]).map(fn=>fn(event)));}
}
function documentFixture(){
 const nodes=new Map(),doc={hidden:false,getElementById(id){if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id);},createElement:tag=>new Node(tag)};
 for(const[id,value]of Object.entries({scanAmount:'10000',scanCurrency:'USDT',scanStrike:'all',scanMinStrike:'',scanMaxStrike:'',scanMaxDays:'7'}))doc.getElementById(id).value=value;
 doc.getElementById('scanBelowSpot').checked=true;doc.getElementById('scanBestOnly').checked=false;
 return doc;
}
function timers(t){
 const intervals=new Map(),timeouts=new Map();let sequence=0;
 t.mock.method(globalThis,'setInterval',(fn,ms)=>{const id=++sequence;intervals.set(id,{fn,ms});return id;});t.mock.method(globalThis,'clearInterval',id=>intervals.delete(id));
 t.mock.method(globalThis,'setTimeout',(fn,ms)=>{const id=++sequence;timeouts.set(id,{fn,ms});return id;});t.mock.method(globalThis,'clearTimeout',id=>timeouts.delete(id));
 return {intervals,timeouts};
}
const descendants=(node,predicate)=>[...(predicate(node)?[node]:[]),...node.children.flatMap(child=>typeof child==='string'?[]:descendants(child,predicate))];
const number=(v,d=2)=>Number(v).toLocaleString('zh-CN',{maximumFractionDigits:d});
const stamp=v=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Singapore',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(v))+' SGT';

test('default live collector uses public GETs and retains an eligible real PUT when every dual source has no match',async t=>{
 t.mock.method(Date,'now',()=>NOW);const selected=contract(),contracts=[selected,contract(79900),contract(80000,EXPIRY+1),contract(81000)],urls=[];
 t.mock.method(globalThis,'fetch',async(url,options={})=>{
  urls.push(String(url));assert.equal(options.method??'GET','GET');assert.equal(options.body,undefined);assert.equal(options.headers,undefined);
  const u=new URL(String(url),'https://live-quotes.test');
  if(u.pathname==='/api/binance-dual')return response({items:[],serverTime:NOW,fetchedAt:NOW,sourceType:'public_web',eligibility:{precisionKnown:false,purchaseWindowKnown:false,accountEligibilityVerified:false}});
  if(u.pathname==='/api/okx-dual')return response({code:0,serverTime:NOW,data:{products:[]}});
  assert.equal(u.origin,'https://api.bybit.com');assert.equal(options.credentials,'omit');
  if(u.pathname==='/v5/market/instruments-info'&&u.searchParams.get('category')==='option')return response({retCode:0,result:{list:contracts.map(c=>({symbol:c.symbol,optionsType:'Put',status:'Trading',settleCoin:'USDT',deliveryTime:String(c.expires),lotSizeFilter:{qtyStep:'.01',minOrderQty:'.01'},priceFilter:{tickSize:'5'},deliveryFeeRate:'.00015'}))}});
  if(u.pathname==='/v5/market/instruments-info'&&u.searchParams.get('category')==='spot')return response({retCode:0,result:{list:[{symbol:'BTCUSDT',lotSizeFilter:{basePrecision:'.000001',minOrderQty:'.000001',minOrderAmt:'1'}}]}});
  if(u.pathname==='/v5/market/tickers')return response({retCode:0,time:NOW,result:{list:contracts.map(c=>({symbol:c.symbol,bid1Price:'500',ask1Price:'510',bid1Size:'2',indexPrice:'90000'}))}});
  if(u.pathname==='/v5/earn/advance/product')return response({retCode:0,time:NOW,result:{list:[]}});
  if(u.pathname==='/v5/market/orderbook'){assert.equal(u.searchParams.get('symbol'),selected.symbol);return response({retCode:0,result:{b:[['500','2']],ts:NOW}});}
  assert.fail('Unexpected request: '+url);
 });
 const result=await collectLiveInputs({...baseInput,strike:80000,minStrike:79999,maxStrike:80000},{clock:()=>NOW});
 assert.equal(result.entries.length,0);assert.equal(result.requestedBooks,1);assert.equal(result.books[0].symbol,selected.symbol);assert.equal(result.markets[0].platform,'bybit');
 assert.equal(urls.filter(url=>url.includes('/market/orderbook')).length,1);assert.equal(urls.filter(url=>url==='/api/binance-dual').length,1);assert.equal(urls.filter(url=>url==='/api/okx-dual').length,1);
 assert.ok(urls.every(url=>!/(?:deribit|private|execution|rfq|account|wallet|sapi)/i.test(url)));
});

test('exact price, inclusive min/max and seven server-clock days scope both catalogue and PUT books without requiring dual entries',async()=>{
 const contracts=[contract(79000),contract(80000),contract(81000),contract(80000,EXPIRY+1),contract(80000,NOW+DAY),contract(95000),contract(80000,NOW)],cases=[
  {filters:{strike:80000,minStrike:80000,maxStrike:81000},wanted:[contracts[1],contracts[4]]},
  {filters:{strike:null,minStrike:79000,maxStrike:80000},wanted:[contracts[0],contracts[1],contracts[4]]},
  {filters:{strike:80000,maxDays:null},wanted:[contracts[1],contracts[3],contracts[4]]}
 ];
 for(const {filters,wanted}of cases){const passed=[],books=[];const result=await collectLiveInputs({...baseInput,...filters},{clock:()=>NOW,marketLoader:async id=>{assert.equal(id,'bybit');return market(contracts);},catalogueLoader:async(currency,list)=>{assert.equal(currency,'USDT');passed.push(...list.map(c=>c.symbol));return {entries:[],sources:[]};},bookLoader:async(platform,symbol)=>{assert.equal(platform,'bybit');books.push(symbol);return {time:NOW,bids:[{price:500,qty:2}]};}});const expected=wanted.map(c=>c.symbol).sort();assert.deepEqual(passed.sort(),expected);assert.deepEqual(books.sort(),expected);assert.equal(result.requestedBooks,wanted.length);}
 let reads=0;await assert.rejects(collectLiveInputs({...baseInput,strike:80000,minStrike:81000},{marketLoader:async()=>{reads++;return market(contracts);}}),/精确接币价/);assert.equal(reads,0);
});

test('book queue caps at six and stops launching or publishing results after its generation is cancelled',async()=>{
 const contracts=Array.from({length:14},(_,i)=>contract(70000+i*100)),seen=new Map();let active=0,maximum=0;
 const deps={clock:()=>NOW,marketLoader:async()=>market(contracts),catalogueLoader:async()=>({entries:[],sources:[]})};
 const complete=await collectLiveInputs(baseInput,{...deps,bookLoader:async(platform,symbol)=>{seen.set(symbol,(seen.get(symbol)||0)+1);active++;maximum=Math.max(maximum,active);await nextTurn();active--;return {time:NOW,bids:[{price:500,qty:2}]};}});
 assert.equal(maximum,6);assert.equal(complete.books.length,14);assert.equal(seen.size,14);assert.ok([...seen.values()].every(n=>n===1));
 const pending=defer(),calls=[],progress=[];let current=true;
 const obsolete=collectLiveInputs(baseInput,{...deps,isCurrent:()=>current,onProgress:value=>progress.push(value),bookLoader:async(platform,symbol)=>{calls.push(symbol);await pending.promise;return {time:NOW,bids:[{price:500,qty:2}]};}});
 await until(()=>calls.length===6);current=false;pending.resolve();assert.equal(await obsolete,null);assert.equal(calls.length,6);assert.deepEqual(progress,[{done:0,total:14}]);
});

test('Binance primary page has two strategy inputs and an exact real expiry dropdown; archived quote board still loads actual strikes',async t=>{
 timers(t);const html=readFileSync(new URL('./web/index.html',import.meta.url),'utf8');
 const form=/<form[^>]*id="binanceStrategyForm"[^>]*>([\s\S]*?)<\/form>/.exec(html)?.[1];assert.ok(form);
 assert.deepEqual([...form.matchAll(/<input[^>]*id="([^"]+)"/g)].map(m=>m[1]),['strategyAmount','targetPrice']);
 const target=/<input[^>]*id="targetPrice"[^>]*>/.exec(form)?.[0];assert.match(target,/type="number"/);assert.doesNotMatch(target,/\bvalue=/);
 for(const id of ['expirySelect','settlementMode','quoteQuantity','selectedExpiry','selectedNetPremium','placePutOrder','orderReview','confirmPutOrder'])assert.match(html,new RegExp('id="'+id+'"'));
 assert.match(html,/只显示所选到期日、精确接币价对应的这一笔 PUT/);assert.match(html,/src="binance-app\.js"/);assert.doesNotMatch(html,/id="(?:scanDrop|spotGapRate|scenario|expiryPrice|strikeMin|strikeMax|scanMinStrike|scanMaxStrike)"|代入(?:本页)?模拟|BTC 终值/);
 const doc=documentFixture(),pending=defer();let initial;
 const ui=mountLiveQuoteBoard({doc,clock:()=>NOW,collect:(input,options)=>{initial=input;options.onMarkets([market([contract(80000),contract(81000),{...contract(82000),bid:0},contract(83000,EXPIRY+1)])]);return pending.promise;}});t.after(()=>ui.destroy());
 assert.equal(initial.currency,'USDT');assert.equal(initial.maxDays,7);assert.deepEqual(doc.getElementById('scanStrike').children.map(n=>n.value),['all','80000','81000']);assert.equal(doc.getElementById('scanStrike').disabled,false);assert.match(doc.getElementById('scanPriceHint').textContent,/2 个真实执行价/);assert.match(doc.getElementById('liveSpotValue').textContent,/90,000 USDT/);
 pending.resolve(snapshot());await until(()=>doc.getElementById('scanRefresh').disabled===false);
});

test('changing target price immediately cancels old work and a late response cannot overwrite newer real quotes',async t=>{
 timers(t);const doc=documentFixture(),reads=[],ranked=[];
 const ui=mountLiveQuoteBoard({doc,clock:()=>NOW,collect:(input,options)=>{const d=defer();reads.push({...d,input,options});return d.promise;},rank:input=>{ranked.push(input.tag);return rankLiveQuotes(input);}});t.after(()=>ui.destroy());
 assert.equal(reads.length,1);doc.getElementById('scanStrike').value='80000';await doc.getElementById('scanStrike').dispatch('change');assert.equal(reads[0].options.isCurrent(),false);assert.equal(doc.getElementById('scanResultsBody').children.length,0);
 const latest=ui.refresh();assert.equal(reads[1].input.strike,80000);reads[1].options.onMarkets([market([contract(80000)])]);reads[1].resolve(snapshot(contract(80000),'latest'));await latest;
 const currentText=doc.getElementById('scanResultsBody').textContent,spot=doc.getElementById('liveSpotValue').textContent;assert.match(currentText,/80,000 USDT/);
 reads[0].options.onMarkets([{...market([contract(85000)]),spot:100000}]);reads[0].resolve(snapshot(contract(85000),'late'));await nextTurn();
 assert.equal(doc.getElementById('scanResultsBody').textContent,currentText);assert.equal(doc.getElementById('liveSpotValue').textContent,spot);assert.ok(!ranked.includes('late'));
});

test('board shows current bid/depth amounts, open-fee net rates and source timestamps, then removes stale rows without zero-APR substitutes',async t=>{
 const scheduled=timers(t),doc=documentFixture(),data=snapshot();let now=NOW;
 const ui=mountLiveQuoteBoard({doc,collect:async()=>data,clock:()=>now});t.after(()=>ui.destroy());await until(()=>doc.getElementById('scanResultsBody').children.length===1);
 const tr=doc.getElementById('scanResultsBody').children[0],quoted=rankLiveQuotes({...baseInput,...data,now}).rows[0].quote;
 assert.equal(tr.children.length,7);assert.match(tr.children[1].textContent,/500 USDT \/ BTC/);assert.ok(tr.children[1].textContent.includes('该笔均价 '+number(quoted.averagePrice)+' USDT/BTC'));
 for(const text of [number(quoted.q,8)+' BTC','毛权利金 '+number(quoted.gross)+' USDT','预计开仓费 '+number(quoted.openFee)+' USDT'])assert.ok(tr.children[2].textContent.includes(text));
 for(const text of [number(quoted.netIncome)+' USDT','本期净收益率'+number(quoted.term*100,4)+'%','简单年化'+number(quoted.annual*100,4)+'%'])assert.ok(tr.children[3].textContent.includes(text));
 assert.match(tr.children[4].textContent,/平台年化 APR36.5%/);assert.match(tr.children[4].textContent,/本期收入 70 USDT/);assert.ok(tr.children[6].textContent.includes(stamp(NOW-1000)));assert.ok(tr.children[4].textContent.includes('双币来源 '+stamp(NOW)));
 assert.equal(descendants(tr,node=>node.tagName==='BUTTON').length,1);assert.ok(descendants(tr,node=>node.tagName==='A').length>=4);assert.doesNotMatch(tr.textContent,/少接|多接|终值|代入/);assert.match(tr.children[2].textContent,/交割/);assert.match(tr.children[2].textContent,/现货/);assert.match(tr.children[2].textContent,/0.1%/);assert.match(tr.children[4].textContent,/OKX/);assert.match(tr.children[4].textContent,/Binance 普通双币/);assert.match(tr.children[4].textContent,/实际金额现在未知|当前金额待定/);
 const ticker=[...scheduled.intervals.values()].find(timer=>timer.ms===1000);assert.ok(ticker);now=NOW+30000;ticker.fn();assert.equal(doc.getElementById('scanResultsBody').children.length,0);assert.equal(doc.getElementById('scanEmpty').hidden,false);assert.doesNotMatch(doc.getElementById('scanResultsBody').textContent,/0%|36\.5%|70 USDT/);
});

test('one PUT strategy keeps Binance and OKX alongside each other, preserves negative fee room and never borrows another strike',()=>{
 const c=contract(),data=snapshot(c),base=rankLiveQuotes({...baseInput,...data,now:NOW}).rows[0];
 const rows=[{...base,dualPlatform:'binance',dual:{...base.dual,income:90},dualQuoteTime:NOW},
  {...base,id:'okx-same',dualPlatform:'okx',dual:{...base.dual,income:20},dualQuoteTime:NOW},
  {...base,id:'okx-other',contract:contract(79000),dualPlatform:'okx',dual:{...base.dual,income:1}}];
 const grouped=groupStrategyRows(rows,{currency:'USDT'}),same=grouped.find(r=>r.contract.strike===80000);
 assert.equal(grouped.length,2);assert.deepEqual(same.comparisons.map(c=>c.platform),['binance','okx','bybit']);
 assert.equal(same.comparisons[0].dual.income,90);assert.equal(same.comparisons[1].dual.income,20);
 assert.equal(same.comparisons[2].valid,false);assert.equal(same.incomeDifference,base.quote.netIncome-90);
 assert.ok(same.incomeDifference<0);assert.equal(same.comparisons[0].triggeredFeeDifferenceLower,same.costs.triggeredFeeNetLower-90);
 const usdc=groupStrategyRows([{...base,dual:null,dualPlatform:null,currency:'USDC'}],{currency:'USDC'})[0];
 assert.ok(usdc.comparisons.slice(0,2).every(c=>!c.valid&&/USDT.*USDC/.test(c.reason)));
});

test('selecting a quoted PUT only assembles a local strategy; expiration removes it and unknown fees stay unknown',async t=>{
 const scheduled=timers(t),doc=documentFixture(),data=snapshot();let now=NOW;
 data.markets[0].contracts[0].delivery=0;data.markets[0].contracts[0].deliveryExemptionConfirmed=false;
 const ui=mountLiveQuoteBoard({doc,collect:async()=>data,clock:()=>now});t.after(()=>ui.destroy());
 await until(()=>doc.getElementById('scanResultsBody').children.length===1);
 const tr=doc.getElementById('scanResultsBody').children[0],button=descendants(tr,n=>n.tagName==='BUTTON')[0];
 assert.match(tr.children[2].textContent,/未确认.*0|未确认.*费率/);assert.match(tr.children[2].textContent,/无法给出完整费用上界/);
 await button.dispatch('click');const selected=doc.getElementById('strategySummary').textContent;
 assert.match(selected,/已选/);assert.match(selected,/80,000/);assert.match(selected,/低于或等于接币价/);assert.match(selected,/本金|结算损失/);assert.match(selected,/不会执行/);
 now=NOW+30000;[...scheduled.intervals.values()].find(timer=>timer.ms===1000).fn();
 assert.match(doc.getElementById('strategySummary').textContent,/报价已失效/);assert.equal(doc.getElementById('scanResultsBody').children.length,0);
});


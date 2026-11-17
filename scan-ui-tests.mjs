import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {collectScanInputs,mountCombinationScanner} from './web/scan-ui.js';
import {rankScanCombinations} from './web/combination-scan.js';

const NOW=Date.UTC(2026,9,23,8),EXPIRY=NOW+7*86400000;
const input={amount:10000,currency:'USDT',maxDays:7,dropRate:0,gapRate:0,onlyBelowSpot:true};
const contract=(i=0)=>({symbol:`BTC-30OCT26-${80000+i*100}-P-USDT`,strike:80000+i*100,expires:EXPIRY,bid:500,step:.01,min:.01,taker:.0003,cap:.07,delivery:.00015,deliveryCap:.125,spot:.001,spotDeductBase:true,spotStep:.000001,spotMin:.000001,spotMinNotional:1});
function entry(c,index=0){
 const product={id:`p-${c.symbol}-${index}`,optionType:'PUT',exercisedCoin:'BTC',investCoin:'USDT',strikePrice:String(c.strike),duration:7,settleDate:c.expires,purchaseDecimal:4,purchaseEndTime:NOW+3600000,canPurchase:true,apr:'0.365',minAmount:'20',maxAmount:'1000000'};
 return {id:product.id,platform:'binance',currency:'USDT',strike:c.strike,expires:c.expires,data:{status:'ready',currency:'USDT',product,serverTime:NOW,fetchedAt:NOW,receivedAt:NOW,contract:{symbol:c.symbol,strike:c.strike,expires:c.expires}}};
}
const market=contracts=>({contracts,spot:90000,time:NOW,platform:'bybit'});
const snap=(tag='one')=>({tag,markets:[],entries:[],books:[],sources:[],errors:[],requestedBooks:0,receivedAt:NOW});
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
async function until(predicate){for(let i=0;i<30;i++){if(predicate())return;await nextTurn();}assert.fail('Expected asynchronous state did not arrive');}
const response=payload=>({ok:true,status:200,headers:{get:()=>new Date(NOW).toUTCString()},json:async()=>structuredClone(payload)});

class Node{
 constructor(tag='div'){this.tagName=tag.toUpperCase();this._text='';this.children=[];this.listeners={};this.dataset={};this.hidden=false;this.disabled=false;this.value='';this.checked=false;this.className='';}
 set textContent(value){this._text=String(value);this.children=[];}
 get textContent(){return this._text+this.children.map(child=>typeof child==='string'?child:child.textContent).join('');}
 replaceChildren(...items){this._text='';this.children=items;}
 append(...items){this.children.push(...items);}
 addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);}
 dispatch(type,event={type,target:this}){return Promise.all((this.listeners[type]||[]).map(fn=>fn(event)));}
 dispatchEvent(event){this.dispatch(event.type,event);return true;}
}
function documentFixture(){
 const nodes=new Map(),doc={hidden:false,getElementById(id){if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id);},createElement:tag=>new Node(tag)};
 const values={amount:'10000.000',scanAmount:'10000.000',platform:'deribit',scanCurrency:'USDT',scanMaxDays:'7',scanDrop:'0',spotGapRate:'0'};
 for(const [id,value] of Object.entries(values))doc.getElementById(id).value=value;
 for(const id of ['scanBestOnly','scanBelowSpot'])doc.getElementById(id).checked=true;
 return doc;
}
function fakeTimers(t){
 const intervals=new Map(),timeouts=new Map();let seq=0;
 t.mock.method(globalThis,'setInterval',(fn,ms)=>{const id=++seq;intervals.set(id,{fn,ms});return id;});
 t.mock.method(globalThis,'clearInterval',id=>intervals.delete(id));
 t.mock.method(globalThis,'setTimeout',(fn,ms)=>{const id=++seq;timeouts.set(id,{fn,ms});return id;});
 t.mock.method(globalThis,'clearTimeout',id=>timeouts.delete(id));
 return {intervals,timeouts};
}
function row(overrides={}){
 return {id:'negative',optionPlatform:'bybit',dualPlatform:'binance',currency:'USDT',contract:contract(),market:{spot:90000},bestForContract:true,estimateOnly:true,scenarioPrice:80000,btcDifference:-.0001,
  model:{btcReceived:.1249,totalFee:10,gross:70,netIncome:60,scenarioNetIncome:60,scenarioTerm:.006,scenarioAnnual:.312857,days:7,cash:.01,spotGapRate:0},dual:{dualBtc:.125,income:70,apr:.365,term:.007,dualCash:0},limits:{extraFeeHeadroom:-8,maxGapRate:-.001,maxPurchasePrice:79920},...overrides};
}
function rankResult(rows){return {rows,stats:{exactMatches:3,candidates:2},reasons:[]};}
function descendants(node,predicate){return [...(predicate(node)?[node]:[]),...node.children.flatMap(child=>typeof child==='string'?[]:descendants(child,predicate))];}

test('default collector uses only public GET market/catalogue/book routes for the requested currency',async t=>{
 t.mock.method(Date,'now',()=>NOW);const c=contract(),urls=[];
 const binance={...entry(c).data.product,purchaseDecimal:null,purchaseEndTime:null};
 const bybit={productId:'p1',baseCoin:'BTC',quoteCoin:'USDT',duration:'7d',status:'Available',isVipProduct:false,subscribeStartAt:String(NOW-1000),subscribeEndAt:String(NOW+3600000),settlementTime:String(EXPIRY-1000),minPurchaseQuoteAmount:'20',remainingAmountQuote:'1000000',orderPrecisionDigitalQuote:4};
 const okx={ndBrokerProductId:'o1',currency:'BTC',alternativeCurrency:'USDT',type:'PUT',productType:'DualCurrencyDeposit',dcdType:'Standard',status:1,launchTime:NOW-1000,stopTradingTime:NOW+3600000,expiryTime:EXPIRY,settlementTime:EXPIRY,interestAccrualTime:NOW,dcdTerm:'168',quoteResponseTime:NOW,strike:'80000',annualYield:'0.365',absYield:'0.007'};
 t.mock.method(globalThis,'fetch',async(url,options={})=>{
  urls.push(String(url));assert.equal(options.method??'GET','GET');assert.equal(options.body,undefined);assert.equal(options.headers,undefined);
  const u=new URL(String(url),'https://simulation.test');
  assert.ok(['https://api.bybit.com','https://simulation.test'].includes(u.origin));
  if(u.pathname==='/api/binance-dual')return response({items:[binance],serverTime:NOW,fetchedAt:NOW,sourceType:'public_web',eligibility:{precisionKnown:false,purchaseWindowKnown:false,accountEligibilityVerified:false}});
  if(u.pathname==='/api/okx-dual')return response({code:0,serverTime:NOW,data:{products:[okx]}});
  assert.equal(u.origin,'https://api.bybit.com');assert.equal(options.credentials,'omit');
  if(u.pathname==='/v5/market/instruments-info'&&u.searchParams.get('category')==='option')return response({retCode:0,result:{list:[{symbol:c.symbol,optionsType:'Put',status:'Trading',settleCoin:'USDT',deliveryTime:String(EXPIRY),lotSizeFilter:{qtyStep:'0.01',minOrderQty:'0.01'},priceFilter:{tickSize:'5'},deliveryFeeRate:'0.00015'}]}});
  if(u.pathname==='/v5/market/instruments-info'&&u.searchParams.get('category')==='spot')return response({retCode:0,result:{list:[{symbol:'BTCUSDT',lotSizeFilter:{basePrecision:'0.000001',minOrderQty:'0.000001',minOrderAmt:'1'}}]}});
  if(u.pathname==='/v5/market/tickers')return response({retCode:0,time:NOW,result:{list:[{symbol:c.symbol,bid1Price:'500',ask1Price:'510',bid1Size:'2',indexPrice:'90000'}]}});
  if(u.pathname==='/v5/earn/advance/product')return response({retCode:0,time:NOW,result:{list:[bybit]}});
  if(u.pathname==='/v5/earn/advance/product-extra-info')return response({retCode:0,time:NOW,result:{list:[{productId:'p1',buyLowPrice:[{selectPrice:'80000',apyE8:'36500000',maxInvestmentAmount:'1000000',expiredAt:String(NOW+20000)}]}]}});
  if(u.pathname==='/v5/market/orderbook')return response({retCode:0,result:{b:[['500','2']],ts:NOW}});
  assert.fail('Unapproved public request: '+url);
 });
 const result=await collectScanInputs(input,{clock:()=>NOW});
 assert.deepEqual(result.markets.map(m=>m.platform),['bybit']);assert.equal(result.books.length,1);assert.equal(result.entries.length,3);
 assert.equal(urls.filter(url=>url.includes('/market/orderbook')).length,1);assert.equal(urls.filter(url=>url==='/api/binance-dual').length,1);
 assert.ok(urls.every(url=>!url.includes('deribit')&&!/private|execution|rfq|account|wallet|sapi/.test(url)));
});

test('candidate expansion fetches each unique PUT book once and caps book concurrency at six',async()=>{
 const contracts=Array.from({length:13},(_,i)=>contract(i)),entries=contracts.flatMap(c=>[entry(c),entry(c,1)]);let active=0,maximum=0;const seen=new Map(),progress=[];
 const result=await collectScanInputs(input,{clock:()=>NOW,marketLoader:async id=>{assert.equal(id,'bybit');return market(contracts);},catalogueLoader:async(currency,passed)=>{assert.equal(currency,'USDT');assert.equal(passed.length,13);return {entries,sources:[]};},bookLoader:async(platform,symbol)=>{assert.equal(platform,'bybit');seen.set(symbol,(seen.get(symbol)||0)+1);active++;maximum=Math.max(maximum,active);await nextTurn();active--;return {time:NOW,bids:[{price:500,qty:2}]};},onProgress:p=>progress.push(p)});
 assert.equal(maximum,6);assert.equal(result.requestedBooks,13);assert.equal(result.books.length,13);assert.equal(seen.size,13);assert.ok([...seen.values()].every(n=>n===1));assert.deepEqual(progress.at(-1),{done:13,total:13});
});

test('superseded scans finish existing reads but never launch the remaining book queue or publish progress',async()=>{
 const contracts=Array.from({length:14},(_,i)=>contract(i)),pending=defer(),calls=[],progress=[];let current=true;
 const done=collectScanInputs(input,{clock:()=>NOW,isCurrent:()=>current,marketLoader:async()=>market(contracts),catalogueLoader:async()=>({entries:contracts.map(c=>entry(c)),sources:[]}),bookLoader:async(p,s)=>{calls.push(s);await pending.promise;return {time:NOW,bids:[{price:500,qty:2}]};},onProgress:p=>progress.push(p)});
 await until(()=>calls.length===6);current=false;pending.resolve();assert.equal(await done,null);assert.equal(calls.length,6);assert.deepEqual(progress,[{done:0,total:14}]);
 let catalogueCalls=0;const stale=await collectScanInputs(input,{clock:()=>NOW,isCurrent:()=>false,marketLoader:async()=>market(contracts),catalogueLoader:async()=>{catalogueCalls++;return {};}});assert.equal(stale,null);assert.equal(catalogueCalls,0);
});

test('one failed book does not erase successful peers, and a failed currency market cannot fetch other currencies',async()=>{
 const contracts=[contract(),contract(1),contract(2)];let catalogueCalls=0;
 const result=await collectScanInputs(input,{clock:()=>NOW,marketLoader:async()=>market(contracts),catalogueLoader:async()=>({entries:contracts.map(c=>entry(c)),sources:[{platform:'binance',status:'ready',count:3}]}),bookLoader:async(p,s)=>{if(s===contracts[1].symbol)throw Error('temporary public failure');return {time:NOW,bids:[{price:500,qty:2}]};}});
 assert.equal(result.books.length,2);assert.equal(result.errors.length,1);assert.match(result.errors[0],/买盘读取失败/);assert.equal(result.sources[0].count,3);
 const failed=await collectScanInputs({...input,currency:'USDC'},{clock:()=>NOW,marketLoader:async id=>{assert.equal(id,'deribit');throw Error('offline');},catalogueLoader:async(currency,passed)=>{catalogueCalls++;assert.equal(currency,'USDC');assert.deepEqual(passed,[]);return {entries:[],sources:[]};},bookLoader:()=>assert.fail('No book is available')});
 assert.equal(catalogueCalls,1);assert.equal(failed.books.length,0);assert.match(failed.errors[0],/Deribit/);
});

test('UI keeps negative results and distinguishes fee shortfalls from an exceeded spot-price allowance',async t=>{
 fakeTimers(t);const doc=documentFixture(),rows=[row(),row({id:'weaker-dual',bestForContract:false,btcDifference:.00002})],ui=mountCombinationScanner({doc,collect:async()=>snap(),rank:()=>rankResult(rows),clock:()=>NOW});t.after(()=>ui.destroy());
 await until(()=>doc.getElementById('scanResultsBody').children.length===1);
 let tr=doc.getElementById('scanResultsBody').children[0];assert.equal(tr.children.length,8);
 assert.match(tr.children[4].textContent,/少接/);assert.equal(tr.children[4].className,'negative');assert.match(tr.children[5].textContent,/已差 8 USDT/);assert.match(tr.children[6].textContent,/超出/);assert.match(tr.children[6].textContent,/须折价买入/);
 assert.match(doc.getElementById('scanCoverage').textContent,/精确候选 3/);assert.match(doc.getElementById('scanStatus').textContent,/负值也保留/);
 doc.getElementById('scanBestOnly').checked=false;await doc.getElementById('scanBestOnly').dispatch('change');assert.equal(doc.getElementById('scanResultsBody').children.length,2);
 assert.equal(doc.getElementById('platform').value,'deribit');assert.equal(doc.getElementById('amount').value,'10000.000');
});

test('a displayed apply button revalidates freshness and cannot apply its row at the 30-second boundary',async t=>{
 fakeTimers(t);const doc=documentFixture(),applied=[];let now=NOW;
 const ui=mountCombinationScanner({doc,collect:async()=>snap(),rank:args=>rankResult(args.now<NOW+30000?[row()]:[]),clock:()=>now,onApply:r=>applied.push(r)});t.after(()=>ui.destroy());
 await until(()=>doc.getElementById('scanResultsBody').children.length===1);const button=doc.getElementById('scanResultsBody').children[0].children[7].children[0];
 now=NOW+30000;await button.dispatch('click');assert.equal(applied.length,0);assert.equal(doc.getElementById('scanResultsBody').children.length,0);assert.match(doc.getElementById('scanStatus').textContent,/失效/);
});

test('currency changes clear old rows without changing the main platform/amount, and late scans cannot replace newer results',async t=>{
 fakeTimers(t);const doc=documentFixture(),reads=[],applied=[];
 const collect=(p,options)=>{const d=defer();reads.push({...d,p,options});return d.promise;};
 const rank=args=>{assert.ok(args.tag,'UI must not rerank a detached button without its snapshot');return rankResult([row({id:args.tag,currency:args.currency,optionPlatform:args.currency==='USDC'?'deribit':'bybit'})]);};
 const ui=mountCombinationScanner({doc,collect,rank,clock:()=>NOW,onApply:r=>applied.push(r)});t.after(()=>ui.destroy());
 assert.equal(reads[0].p.currency,'USDT');doc.getElementById('scanCurrency').value='USDC';await doc.getElementById('scanCurrency').dispatch('change');
 assert.equal(reads[0].options.isCurrent(),false);assert.equal(doc.getElementById('scanResultsBody').children.length,0);assert.equal(doc.getElementById('platform').value,'deribit');assert.equal(doc.getElementById('amount').value,'10000.000');
 const latest=ui.refresh();assert.equal(reads[1].p.currency,'USDC');reads[1].resolve(snap('new'));await latest;reads[0].resolve(snap('old'));await nextTurn();
 const button=doc.getElementById('scanResultsBody').children[0].children[7].children[0];await button.dispatch('click');assert.equal(applied.length,1);assert.equal(applied[0].id,'new');assert.equal(applied[0].currency,'USDC');assert.equal(doc.getElementById('platform').value,'deribit');assert.equal(doc.getElementById('amount').value,'10000.000');
 doc.getElementById('amount').value='11000';await doc.getElementById('amount').dispatch('input');assert.equal(doc.getElementById('scanResultsBody').children.length,0);await button.dispatch('click');assert.equal(applied.length,1,'A detached button must not apply after amount changes invalidate the snapshot');
});

test('periodic refresh preserves usable rows but expiry still removes them and rejects detached clicks while replacement data is pending',async t=>{
 const timers=fakeTimers(t),doc=documentFixture(),pending=defer(),applied=[];let calls=0,now=NOW;
 const ui=mountCombinationScanner({doc,collect:()=>++calls===1?Promise.resolve(snap('old')):pending.promise,rank:args=>rankResult(args.tag&&args.now-args.receivedAt<30000?[row({id:args.tag})]:[]),clock:()=>now,onApply:r=>applied.push(r)});t.after(()=>ui.destroy());
 await until(()=>doc.getElementById('scanResultsBody').children.length===1);const oldButton=doc.getElementById('scanResultsBody').children[0].children[7].children[0];
 const timer=[...timers.intervals.values()].find(x=>x.ms===15000);assert.ok(timer);now=NOW+15000;timer.fn();assert.equal(doc.getElementById('scanResultsBody').children.length,1);await oldButton.dispatch('click');assert.equal(applied[0].id,'old');
 now=NOW+30000;[...timers.intervals.values()].find(x=>x.ms===1000).fn();assert.equal(doc.getElementById('scanResultsBody').children.length,0);await oldButton.dispatch('click');assert.equal(applied.length,1);assert.match(doc.getElementById('scanStatus').textContent,/失效/);
 pending.resolve({...snap('fresh'),receivedAt:now});await until(()=>doc.getElementById('scanResultsBody').children.length===1);const freshButton=doc.getElementById('scanResultsBody').children[0].children[7].children[0];await freshButton.dispatch('click');assert.equal(applied[1].id,'fresh');
});

test('scanner amount mirrors the main amount as an exact input string and currency selection only changes the scanner unit',async t=>{
 fakeTimers(t);const doc=documentFixture(),ui=mountCombinationScanner({doc,collect:async()=>snap(),rank:()=>rankResult([]),clock:()=>NOW});t.after(()=>ui.destroy());await until(()=>doc.getElementById('scanRefresh').disabled===false);
 doc.getElementById('scanAmount').value='12345.6700';await doc.getElementById('scanAmount').dispatch('input');assert.equal(doc.getElementById('amount').value,'12345.6700');
 doc.getElementById('amount').value='00042.5000';await doc.getElementById('amount').dispatch('input');assert.equal(doc.getElementById('scanAmount').value,'00042.5000');
 doc.getElementById('scanCurrency').value='USDC';await doc.getElementById('scanCurrency').dispatch('change');assert.equal(doc.getElementById('scanAmountUnit').textContent,'USDC');assert.equal(doc.getElementById('platform').value,'deribit');assert.equal(doc.getElementById('amount').value,'00042.5000');assert.match(doc.getElementById('scanConditions').textContent,/42.5 USDC/);
});

test('destroy invalidates an in-flight result and clears both periodic timers',async t=>{
 const timers=fakeTimers(t),doc=documentFixture(),pending=defer();let options,rankCalls=0;
 const ui=mountCombinationScanner({doc,collect:(p,o)=>{options=o;return pending.promise;},rank:()=>{rankCalls++;return rankResult([row()]);},clock:()=>NOW});
 assert.equal(timers.intervals.size,2);assert.equal(options.isCurrent(),true);ui.destroy();assert.equal(options.isCurrent(),false);assert.equal(timers.intervals.size,0);pending.resolve(snap());await nextTurn();assert.equal(rankCalls,0);assert.equal(doc.getElementById('scanResultsBody').children.length,0);
});

test('collector scopes catalogue and unique book reads to seven inclusive server-clock days by default; null means all future terms',async()=>{
 const DAY=86400000,SERVER=NOW+3600000,ELAPSED=5000;
 const expiries=[SERVER+ELAPSED-1,SERVER+ELAPSED+DAY,SERVER+ELAPSED+7*DAY,SERVER+ELAPSED+7*DAY+1,SERVER+ELAPSED+14*DAY];
 const contracts=expiries.map((expires,i)=>({...contract(i),expires}));
 const entries=contracts.map(c=>{const e=entry(c);return {...e,data:{...e.data,serverTime:SERVER+ELAPSED,fetchedAt:NOW+ELAPSED,receivedAt:NOW+ELAPSED,product:{...e.data.product,purchaseEndTime:SERVER+ELAPSED+3600000}}};});
 async function collectScope(maxDays,omit=false){
  const seen=[],passed=[];let clockCalls=0;const {maxDays:unused,...base}=input;
  const data=await collectScanInputs(omit?base:{...input,maxDays},{clock:()=>clockCalls++===0?NOW:NOW+ELAPSED,marketLoader:async()=>({...market(contracts),time:SERVER}),catalogueLoader:async(currency,list)=>{assert.equal(currency,'USDT');passed.push(...list.map(c=>c.symbol));return {entries,sources:[]};},bookLoader:async(p,symbol)=>{seen.push(symbol);return {time:SERVER+ELAPSED,bids:[{price:500,qty:2}]};}});
  return {data,seen:seen.sort(),passed:passed.sort()};
 }
 const within=contracts.slice(1,3).map(c=>c.symbol).sort(),allFuture=contracts.slice(1).map(c=>c.symbol).sort();
 for(const result of [await collectScope(7),await collectScope(undefined,true)]){assert.deepEqual(result.passed,within);assert.deepEqual(result.seen,within);assert.equal(result.data.requestedBooks,2);}
 const all=await collectScope(null);assert.deepEqual(all.passed,allFuture);assert.deepEqual(all.seen,allFuture);assert.equal(all.data.requestedBooks,4);
});

test('ranking rechecks maxDays even when catalogue and market snapshots still include longer contracts',()=>{
 const DAY=86400000,contracts=[DAY,7*DAY,7*DAY+1,14*DAY].map((remaining,i)=>({...contract(i),expires:NOW+remaining}));
 const args={...input,markets:[{...market(contracts),receivedAt:NOW}],entries:contracts.map(c=>entry(c)),books:contracts.map(c=>({platform:'bybit',symbol:c.symbol,receivedAt:NOW,book:{time:NOW,bids:[{price:500,qty:2}]}})),now:NOW};
 const seven=rankScanCombinations(args),all=rankScanCombinations({...args,maxDays:null}),one=rankScanCombinations({...args,maxDays:1});
 assert.equal(seven.valid,true);assert.deepEqual(seven.rows.map(r=>r.contract.symbol).sort(),contracts.slice(0,2).map(c=>c.symbol).sort());
 assert.equal(all.rows.length,4);assert.equal(one.rows.length,1);assert.equal(one.rows[0].contract.symbol,contracts[0].symbol);
 const later=rankScanCombinations({...args,now:NOW+1});assert.equal(later.rows.length,3,'A contract one millisecond beyond the old cutoff enters only after server elapsed time advances');
});

test('max-days select defaults to seven, sends all as null, cancels prior work and blocks old buttons after a term change',async t=>{
 const timers=fakeTimers(t),doc=documentFixture(),pending=defer(),reads=[],ranks=[],applied=[];
 const collect=(p,options)=>{reads.push({p,options});return reads.length===2?pending.promise:Promise.resolve(snap('term-'+String(p.maxDays)));};
 const rank=args=>{assert.ok(args.tag,'No ranking without a current snapshot');ranks.push(args.maxDays);return rankResult([row({id:args.tag})]);};
 const ui=mountCombinationScanner({doc,collect,rank,clock:()=>NOW,onApply:r=>applied.push(r)});t.after(()=>ui.destroy());
 await until(()=>doc.getElementById('scanResultsBody').children.length===1);assert.equal(reads[0].p.maxDays,7);assert.equal(ranks.at(-1),7);
 const oldButton=doc.getElementById('scanResultsBody').children[0].children[7].children[0],oldRefresh=ui.refresh();
 doc.getElementById('scanMaxDays').value='all';await doc.getElementById('scanMaxDays').dispatch('change');assert.equal(reads[1].options.isCurrent(),false);assert.equal(doc.getElementById('scanResultsBody').children.length,0);await oldButton.dispatch('click');assert.equal(applied.length,0);
 assert.match(doc.getElementById('scanConditions').textContent,/全部期限/);const scheduled=[...timers.timeouts.values()].find(x=>x.ms===450);assert.ok(scheduled);await scheduled.fn();assert.equal(reads[2].p.maxDays,null);assert.equal(ranks.at(-1),null);
 pending.resolve(snap('obsolete-7'));await oldRefresh;const newButton=doc.getElementById('scanResultsBody').children[0].children[7].children[0];await newButton.dispatch('click');assert.equal(applied[0].id,'term-null');assert.equal(doc.getElementById('platform').value,'deribit');
 const html=readFileSync(new URL('./web/index.html',import.meta.url),'utf8');
 for(const id of ['expirySelect','settlementMode','targetPrice','strategyAmount'])assert.match(html,new RegExp('id="'+id+'"'));
 assert.match(html,/只显示所选到期日、精确接币价对应的这一笔 PUT/);const price=/<input[^>]*id="targetPrice"[^>]*>/.exec(html)?.[0];assert.ok(price);assert.doesNotMatch(price,/\bvalue=/);
 assert.doesNotMatch(html,/id="(?:scanMinStrike|scanMaxStrike|strikeMin|strikeMax|scanMaxDays)"/);
 assert.deepEqual([...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(m=>m[1]),['binance-app.js']);assert.doesNotMatch(html,/id="(?:scanDrop|scenario|runSimulation|settlementComparison)"|代入(?:本页)?模拟/);
});

test('PUT cards use signed scenario net rates and refresh annual/net figures without changing BTC or untriggered income',async t=>{
 const timers=fakeTimers(t),doc=documentFixture();let now=NOW,scenarioTerm=-.0025,scenarioAnnual=-.13,scenarioNetIncome=-25;
 const rank=()=>{const base=row();return rankResult([{...base,model:{...base.model,term:.77,annual:9.99,scenarioTerm,scenarioAnnual,scenarioNetIncome}}]);};
 const ui=mountCombinationScanner({doc,collect:async()=>snap(),rank,clock:()=>now});t.after(()=>ui.destroy());await until(()=>doc.getElementById('scanResultsBody').children.length===1);
 const putCell=()=>doc.getElementById('scanResultsBody').children[0].children[2],rates=()=>descendants(putCell(),node=>node.className==='scan-put-rates')[0];
 assert.equal(rates().children.length,2);let values=descendants(rates(),node=>node.tagName==='B');assert.equal(values.length,2);assert.equal(values[0].textContent,'-0.25%');assert.equal(values[1].textContent,'-13%');assert.ok(values.every(node=>node.className==='negative'));assert.match(putCell().textContent,/本情景净权利金 -25 USDT/);assert.doesNotMatch(putCell().textContent,/77%|999%/);
 const ticker=[...timers.intervals.values()].find(x=>x.ms===1000).fn,original=rates(),originalButton=doc.getElementById('scanResultsBody').children[0].children[7].children[0];now+=1000;scenarioAnnual=-.14;ticker();assert.equal(rates(),original);assert.equal(doc.getElementById('scanResultsBody').children[0].children[7].children[0],originalButton,'A time-only update preserves the button and keyboard focus');assert.equal(descendants(rates(),node=>node.tagName==='B')[1].textContent,'-14%');
 scenarioTerm=-.0026;now+=1000;ticker();assert.equal(descendants(rates(),node=>node.tagName==='B')[0].textContent,'-0.26%');scenarioNetIncome=-26;now+=1000;ticker();assert.match(putCell().textContent,/本情景净权利金 -26 USDT/);
 const html=readFileSync(new URL('./web/index.html',import.meta.url),'utf8');assert.match(html,/真实买盘|真实 PUT/);assert.match(html,/按当前买盘深度和公开标准开仓费率计算/);assert.match(html,/实际以订单成交为准/);for(const id of ['selectedOpenFee','selectedDeliveryFee','selectedSpotFee'])assert.match(html,new RegExp('id="'+id+'"'));
 assert.doesNotMatch(html,/id="(?:scanDrop|scenario|runSimulation|settlementComparison|settlementLimits)"|代入(?:本页)?模拟/);
});


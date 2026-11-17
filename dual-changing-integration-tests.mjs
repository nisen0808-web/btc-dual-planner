import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {loadBinanceCatalogue,loadBinanceDual,deriveBinanceDualIncome} from './web/binance-dual.js';
const code=await readFile(new URL('./worker/binance-dual-cloud.js',import.meta.url),'utf8');
const {createBinanceDualCloudReader}=await import('data:text/javascript;base64,'+Buffer.from(code+'\nexport {createBinanceDualCloudReader};').toString('base64'));
const NOW=Math.floor(Date.now()/1000)*1000,EXP=NOW+7*86400000;
const product={id:'exact',optionType:'PUT',exercisedCoin:'BTC',investCoin:'USDT',strikePrice:'79000',apr:'0.365',duration:7,settleDate:EXP,purchaseDecimal:null,purchaseEndTime:null,canPurchase:true,minAmount:'10',maxAmount:'1000000'};
const sample=()=>({status:'ready',source:'https://www.binance.com/bapi/earn/v5/friendly/pos/dc/project/list?investmentAsset=USDT&targetAsset=BTC&projectType=DOWN&sortType=APY_DESC&pageSize=100',sourceType:'public_web',serverTime:NOW,lastServerTime:NOW,fetchedAt:NOW,completedAt:NOW,total:1,pageCount:2,catalogueComplete:false,coverageReason:'changing_catalogue',reportedTotals:[101,99],rejectedConflictCount:1,eligibility:{precisionKnown:false,purchaseWindowKnown:false,accountEligibilityVerified:false},items:[{...product}]});
const req=()=>new Request('https://site.example/api/binance-dual');

test('cloud accepts only explicitly verified changing coverage, preserving all source times',async()=>{
 const reader=createBinanceDualCloudReader({now:()=>NOW,fetchImpl:async()=>Response.json(sample())});
 const r=await reader(req()),v=await r.json();assert.equal(r.status,200);assert.equal(v.catalogueComplete,false);assert.equal(v.serverTime,NOW);assert.equal(v.fetchedAt,NOW);assert.equal(v.total,1);assert.equal(v.pageCount,2);assert.deepEqual(v.reportedTotals,[101,99]);assert.equal(v.rejectedConflictCount,1);assert.equal(v.items[0].apr,'0.365');
});

test('partial coverage never bypasses count, timestamps, currency or duplicate checks',async()=>{
 for(const patch of [{pageCount:0},{pageCount:21},{reportedTotals:[]},{reportedTotals:[101,-1]},{coverageReason:'anything'},{rejectedConflictCount:-1},{total:2},{serverTime:NOW-30000},{catalogueComplete:'false'},{items:[{...product,investCoin:'USDC'}]},{total:2,items:[product,product]}]){
  const reader=createBinanceDualCloudReader({now:()=>NOW,fetchImpl:async()=>Response.json({...sample(),...patch})});const r=await reader(req());assert.equal(r.status,503,JSON.stringify(patch));assert.equal((await r.json()).items,undefined);
 }
});

test('known exact product retains real rate and coverage warning; unknown exact product is not called absent',async t=>{
 const cloud=await (await createBinanceDualCloudReader({now:()=>NOW,fetchImpl:async()=>Response.json(sample())})(req())).json();
 t.mock.method(globalThis,'fetch',async url=>{assert.equal(url,'/api/binance-dual');return Response.json(cloud)});
 const c=await loadBinanceCatalogue('USDT',[],{independent:true});assert.equal(c.source.catalogueComplete,false);assert.match(c.source.reason,/未覆盖完整列表/);assert.equal(c.entries.length,1);
 const income=deriveBinanceDualIncome(10000,{strike:79000,expires:EXP,settleCoin:'USDT'},c.entries[0].data);assert.equal(income.valid,true);assert.equal(income.apr,.365);assert.equal(income.income,70);assert.match(income.note,/未读到不代表平台没有/);
 const missing=await loadBinanceDual({strike:78000,expires:EXP},'USDT');assert.equal(missing.status,'unavailable');assert.match(missing.reason,/未覆盖完整列表/);assert.doesNotMatch(missing.reason,/普通双币没有相同/);
});

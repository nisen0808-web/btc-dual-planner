import test from 'node:test';
import assert from 'node:assert/strict';
import {platformComparisons} from './web/dual-platforms.js';
const now=Date.UTC(2026,9,22,8),expiry=now+7*86400000;
const data={status:'ready',serverTime:now,receivedAt:now,currency:'USDT',contract:{strike:80000,expires:expiry},product:{productId:'p',baseCoin:'BTC',quoteCoin:'USDT',status:'Available',duration:'7d',subscribeStartAt:now-1000,subscribeEndAt:now+100000,remainingAmountQuote:1000000,settlementTime:expiry,orderPrecisionDigitalQuote:2,minPurchaseQuoteAmount:1},quote:{selectPrice:80000,apyE8:36500000,maxInvestmentAmount:1000000,expiredAt:now+20000}};
const put={valid:true,netIncome:50,days:7,strike:80000,expires:expiry,settleCoin:'USDT'};
test('unauthorized and missing sources cannot fabricate income or zero-yield products',()=>{
 const rows=platformComparisons(10000,put,null,now,now,null);
 assert.equal(rows.length,4);
 for(const r of rows){assert.equal(r.valid,false);assert.equal(r.income,undefined);assert.equal(r.difference,undefined);}
 assert.equal(rows.find(x=>x.id==='binance').valid,false);
 assert.equal(rows.find(x=>x.id==='binance_rfq').status,'rfq_required');
});
test('negative premium advantage remains negative; matching data does not promise PUT wins',()=>{
 const row=platformComparisons(10000,put,data,now,now)[0];
 assert.equal(row.valid,true);assert.ok(Math.abs(row.income-70)<1e-8);assert.ok(Math.abs(row.difference+20)<1e-8);
});
test('time-skew and expiration checks apply to shared table and export results',()=>{
 assert.equal(platformComparisons(10000,put,data,now,now+30001)[0].valid,false);
 assert.equal(platformComparisons(10000,put,data,now+20000,now)[0].valid,false);
});
test('USDC investment cannot use USDT benchmark at par',()=>{
 assert.equal(platformComparisons(10000,{...put,settleCoin:'USDC'},data,now,now)[0].valid,false);
});


test('ordinary Binance quotes never substitute for amount-specific RFQ',()=>{
 const p={id:'ordinary',optionType:'PUT',exercisedCoin:'BTC',investCoin:'USDT',strikePrice:'80000',duration:7,settleDate:expiry,purchaseDecimal:4,purchaseEndTime:now+86400000,canPurchase:true,apr:'0.365',minAmount:'10',maxAmount:'1000000'};
 const binance={status:'ready',product:p,currency:'USDT',serverTime:now,fetchedAt:now,receivedAt:now,contract:{strike:80000,expires:expiry}};
 const rows=platformComparisons(10000,put,data,now,now,null,binance),ordinary=rows.find(x=>x.id==='binance'),rfq=rows.find(x=>x.id==='binance_rfq');
 assert.equal(ordinary.valid,true);assert.equal(ordinary.income,70);assert.equal(rfq.valid,false);assert.equal(rfq.apr,undefined);assert.equal(rfq.income,undefined);assert.equal(rfq.difference,undefined);
});
test('Binance authorization failures remain explicit without zero-return fallback',()=>{
 const rows=platformComparisons(10000,put,data,now,now,null,{status:'authorization_required',reason:'需要配置只读 Key'});
 const row=rows.find(x=>x.id==='binance');assert.equal(row.status,'authorization_required');assert.equal(row.income,undefined);
});

const publicResponse=payload=>({ok:true,status:200,json:async()=>structuredClone(payload)});
function mockBybitMarket(t,instruments){
 t.mock.method(globalThis,'fetch',async url=>{
  const u=new URL(url);assert.equal(u.origin,'https://api.bybit.com');
  if(u.pathname.endsWith('/instruments-info')&&u.searchParams.get('category')==='option')return publicResponse({retCode:0,result:{list:instruments}});
  if(u.pathname.endsWith('/instruments-info')&&u.searchParams.get('category')==='spot')return publicResponse({retCode:0,result:{list:[{symbol:'BTCUSDT',lotSizeFilter:{basePrecision:'.000001',minOrderQty:'.000001',minOrderAmt:'1'}}]}});
  if(u.pathname.endsWith('/tickers'))return publicResponse({retCode:0,time:now,result:{list:instruments.map(x=>({symbol:x.symbol,bid1Price:'500',ask1Price:'510',bid1Size:'1',indexPrice:'90000'}))}});
  assert.fail('Unexpected public route: '+url);
 });
}
function mockDeribitMarket(t,instruments,spotFee=.0005){
 t.mock.method(globalThis,'fetch',async url=>{
  const u=new URL(url);assert.equal(u.origin,'https://www.deribit.com');
  if(u.pathname.endsWith('/get_instruments'))return publicResponse({result:instruments});
  if(u.pathname.endsWith('/get_book_summary_by_currency'))return publicResponse({usOut:now*1000,result:instruments.map(x=>({instrument_name:x.instrument_name,bid_price:500,ask_price:510}))});
  if(u.pathname.endsWith('/get_index_price'))return publicResponse({result:{index_price:90000}});
  if(u.pathname.endsWith('/get_instrument'))return publicResponse({result:{instrument_name:'BTC_USDC',base_currency:'BTC',quote_currency:'USDC',min_trade_amount:.00000001,taker_commission:spotFee,is_cbe_routed:true}});
  assert.fail('Unexpected public route: '+url);
 });
}
const bybitInstrument=(id,deliveryTime,deliveryFeeRate)=>({symbol:`BTC-${id}-80000-P-USDT`,optionsType:'Put',status:'Trading',settleCoin:'USDT',deliveryTime:String(deliveryTime),deliveryFeeRate,lotSizeFilter:{qtyStep:'.01',minOrderQty:'.01'},priceFilter:{tickSize:'5'}});
const deribitInstrument=(id,expiration_timestamp,settlement_period,taker_commission=.0003)=>({instrument_name:`BTC_USDC-${id}-80000-P`,option_type:'put',is_active:true,state:'open',strike:80000,expiration_timestamp,settlement_period,taker_commission,min_trade_amount:.01,tick_size:5});

test('Bybit nominal delivery fees preserve public values and never infer an exemption from Friday, weekends, missing fields or short remaining time',async t=>{
 const friday=Date.UTC(2026,9,23,8),saturday=Date.UTC(2026,9,24,8),instruments=[
  bybitInstrument('FRI',friday,'.00015'),bybitInstrument('SAT',saturday,'.00015'),bybitInstrument('MISSING',now+3600000,undefined),
  bybitInstrument('EMPTY',friday,''),bybitInstrument('FALSE',saturday,false),bybitInstrument('ZERO',saturday,'0')
 ];
 mockBybitMarket(t,instruments);const {loadMarket}=await import('./web/market.js?fee-bybit-classification');const result=await loadMarket('bybit');assert.equal(result.contracts.length,6);
 for(const c of result.contracts){assert.equal(c.deliveryExemptionConfirmed,false);assert.equal(c.deliveryClassification,'unknown');assert.equal(c.cap,.07);assert.equal(c.deliveryCap,.125);assert.equal(c.feeCheckedAt,'2026-10-23');assert.equal(c.feeTier,'公开普通账户 / 当前公开接口');assert.equal(c.openingRateSource,'published_standard');assert.equal(c.spotRateSource,'published_standard');assert.equal(c.spot,.001);assert.match(c.feeSourceURLs.opening,/Bybit-Option-Fees-Explained$/);assert.match(c.feeSourceURLs.delivery,/Bybit-Option-Fees-Explained$/);assert.match(c.feeSourceURLs.spot,/Bybit-Spot-Fees-Explained$/);}
 const byId=id=>result.contracts.find(c=>c.symbol===`BTC-${id}-80000-P-USDT`);
 for(const id of ['FRI','SAT']){assert.equal(byId(id).delivery,.00015);assert.equal(byId(id).deliveryRateSource,'public_instrument');}
 for(const id of ['MISSING','EMPTY','FALSE']){assert.equal(byId(id).delivery,.00015);assert.equal(byId(id).deliveryRateSource,'published_standard');}
 assert.equal(byId('ZERO').delivery,0);assert.equal(byId('ZERO').deliveryRateSource,'public_instrument');assert.equal(byId('ZERO').deliveryExemptionConfirmed,false,'An explicit nominal zero does not identify the exemption category');
});

test('Deribit daily waiver follows explicit settlement_period rather than Friday or remaining days, while week/month retain standard delivery fees',async t=>{
 const instruments=[deribitInstrument('DAY-FRI',Date.UTC(2026,9,23,8),'day'),deribitInstrument('WEEK-SHORT',now+3600000,'week'),deribitInstrument('MONTH-SHORT',now+7200000,'month'),deribitInstrument('UNKNOWN-SHORT',now+1800000,undefined)];
 mockDeribitMarket(t,instruments);const {loadMarket}=await import('./web/market.js?fee-deribit-classification');const result=await loadMarket('deribit');assert.equal(result.contracts.length,4);
 const daily=result.contracts.find(c=>c.symbol.includes('DAY-FRI'));assert.equal(daily.delivery,0);assert.equal(daily.deliveryClassification,'daily');assert.equal(daily.deliveryExemptionConfirmed,true);assert.equal(daily.deliveryRateSource,'published_daily_exemption');
 for(const [id,classification]of [['WEEK-SHORT','week'],['MONTH-SHORT','month'],['UNKNOWN-SHORT','unknown']]){const c=result.contracts.find(x=>x.symbol.includes(id));assert.equal(c.delivery,.00015);assert.equal(c.deliveryClassification,classification);assert.equal(c.deliveryExemptionConfirmed,false);assert.equal(c.deliveryRateSource,'published_standard');}
 for(const c of result.contracts){assert.equal(c.cap,.125);assert.equal(c.deliveryCap,.125);assert.equal(c.spot,.0005);assert.equal(c.spotRateSource,'public_instrument');assert.equal(c.feeCheckedAt,'2026-10-23');assert.equal(c.feeTier,'公开普通账户 / 当前公开接口');assert.match(c.feeSourceURLs.opening,/25944746248989-Fees$/);assert.match(c.feeSourceURLs.delivery,/25944746248989-Fees$/);assert.match(c.feeSourceURLs.spot,/31424969480093-Spot-Instruments$/);}
});

test('Deribit fee metadata distinguishes a real public zero from absent or malformed commission fields',async t=>{
 let sequence=0;
 for(const {fee,expected,source}of [{fee:0,expected:0,source:'public_instrument'},{fee:null,expected:.0005,source:'published_standard'},{fee:'',expected:.0005,source:'published_standard'},{fee:false,expected:.0005,source:'published_standard'}]){
  const instruments=[deribitInstrument('PUBLIC-ZERO',expiry,'week',0),deribitInstrument('MISSING-FEE',expiry,'week',null)];mockDeribitMarket(t,instruments,fee);
  const {loadMarket}=await import('./web/market.js?fee-deribit-commissions-'+sequence++);const {contracts}=await loadMarket('deribit');
  for(const c of contracts){assert.equal(c.spot,expected);assert.equal(c.spotRateSource,source);}
  assert.equal(contracts[0].taker,0);assert.equal(contracts[0].openingRateSource,'public_instrument');assert.equal(contracts[1].taker,.0003);assert.equal(contracts[1].openingRateSource,'published_standard');
 }
});

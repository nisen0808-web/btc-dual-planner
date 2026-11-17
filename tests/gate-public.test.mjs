import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source = await readFile(new URL('../worker/gate-public.js',import.meta.url),'utf8');
const {createGatePublicReader} = await import('data:text/javascript;base64,'+Buffer.from(source+'\nexport {createGatePublicReader};').toString('base64'));
const expiry = Date.UTC(2026,10,19,8), now = expiry-1.3*86_400_000, ts=now/1000;
const symbol='BTC_USDT-20261119-71000-C';
const request=path=>new Request('https://site.test/api/gate/'+path,{headers:{cookie:'omit-me',authorization:'omit-me'}});
const contract = {name:symbol,underlying:'BTC_USDT',multiplier:'.01',is_active:true,strike_price:'71000',expiration_time:expiry/1000,
  is_call:true,order_size_min:1,order_size_max:10000,order_price_round:'1',tag:'day',maker_fee_rate:'0.0003',taker_fee_rate:'0.0003',
  price_limit_fee_rate:'0.125',settle_fee_rate:'0',settle_limit_fee_rate:'.125',underlying_price:'91000'};
const book={current:ts,update:ts-90,id:123,bids:[{p:'48',s:12}],asks:[{p:'50',s:9},{p:'51',s:20}]};
const product={id:123,type:'call',invest_currency:'BTC',exercise_currency:'USDT',exercise_price:71000,delivery_time:expiry/1000,
  start_time:0,end_time:expiry/1000-3600,status:'ONGOING',apy_display:'2.8',min_amount:'.00003'};
function reader(payload, date=now) {
  return createGatePublicReader({clock:()=>now,fetchImpl:async(input,options)=>{
    const url=new URL(input);
    assert.equal(url.origin,'https://api.gateio.ws');assert.equal(options.method,'GET');assert.equal(options.credentials,'omit');
    assert.deepEqual(options.headers,{accept:'application/json'});assert.equal(options.redirect,'manual');
    return Response.json(payload(url),{headers:{date:new Date(date).toUTCString()}});
  }});
}
test('Gate reads Gate option index, active instruments, per-contract fees and BTC multiplier',async()=>{
  const data = await (await reader(url => url.pathname.endsWith('contracts') ?
    [contract,{...contract, is_call:false},{...contract, name:symbol.replace('20261119','20261131')},{...contract,is_active:false}] :
    [{name:'BTC_USDT',index_time:ts,index_price:'70001'}])(request('market?type=CALL'))).json();
  assert.equal(data.platform,'gate');assert.equal(data.indexCoin,'USDT');assert.equal(data.spot,70001);assert.equal(data.contracts.length,1);
  const c=data.contracts[0];assert.equal(c.unit,.01);assert.equal(c.step,1);assert.equal(c.coin,'USDT');assert.equal(c.maker,.0003);
  assert.equal(c.cap,.125);assert.equal(c.delivery,0);assert.equal(c.expires,expiry);assert.equal(c.dailyExemptionVerified,true);
  const missing=await (await reader(u=>u.pathname.endsWith('contracts')?[{...contract,price_limit_fee_rate:null}]:[{name:'BTC_USDT',index_time:ts,index_price:'7'}])(request('market?type=CALL'))).json();
  assert.equal(missing.contracts[0].cap,null);
});
test('Gate book quote is per BTC; quantities are contracts, observation age separate from last modification',async()=>{
  const payload=await (await reader(url=>{assert.equal(url.searchParams.get('limit'),'50');assert.equal(url.searchParams.get('contract'),symbol);return book;})
    (request('book?symbol='+symbol))).json();
  assert.equal(payload.time,now);assert.equal(payload.lastChangeTime,now-90_000);
  assert.deepEqual(payload.bids,[{price:48,qty:12}]);assert.deepEqual(payload.asks,[{price:50,qty:9},{price:51,qty:20}]);
  for (const bad of [{current:ts-31},{asks:[{p:'47',s:2}]},{asks:[{p:'51',s:1.5}]},{asks:[{p:'51',s:5},{p:'50',s:2}]}]) {
    assert.equal((await reader(()=>({...book,...bad}))(request('book?symbol='+symbol))).status,503);
  }
});
test('Gate BTC and USDT dual products require matching currencies, open dates and native APR',async()=>{
  for (const direction of ['CALL','PUT']) {
    const row=direction==='CALL'?product:{...product,type:'put',invest_currency:'USDT',exercise_currency:'BTC'};
    const read=reader(url=>{assert.equal(url.searchParams.get('type'),row.type);
      return [row,row,{...row,id:456,exercise_currency:'GUSD'},{...row,id:789,end_time:ts},{...row,id:12,status:'ENDED'}];});
    const d=await (await read(request('dual?type='+direction))).json();
    assert.equal(d.products.length,1);const p=d.products[0];
    assert.equal(p.apr,2.8);assert.equal(p.days,1.3);assert.equal(p.term,2.8*1.3/365);assert.equal(p.termEstimated,true);
    assert.equal(p.purchaseEnd,expiry-3_600_000);assert.equal(p.min,.00003);assert.equal(p.max,null);assert.equal(p.coin,row.invest_currency);
  }
});
test('Gate public routes reject unsupported input, expired responses, and private operations',async()=>{
  const only=reader(()=>assert.fail('upstream should not be reached'));
  for (const p of ['market?type=unknown','market?type=CALL&type=PUT','book?symbol=../../orders',
    'book?symbol=BTC_USDT-20260231-70000-C','book?symbol=ETH_USDT-20261119-71000-C','dual?url=x']) assert.equal((await only(request(p))).status,400);
  assert.equal((await only(request('orders'))).status,404);
  assert.equal((await only(new Request('https://site.test/api/gate/dual?type=CALL',{method:'POST'}))).status,405);
  assert.equal((await reader(()=>[],now-30_000)(request('dual?type=CALL'))).status,503);
  assert.equal((await reader(url=>url.pathname.endsWith('contracts')?[contract]:[{name:'BTC_USDT',index_time:ts-30,index_price:'10'}])(request('market?type=CALL'))).status,503);
});
test('Gate dual plans consume every page and reject overlap or an unfinished catalogue', async()=>{
  const full=Array.from({length:1000},(_,i)=>({...product,id:i+1}));
  const pages=[];
  const fetchPages=second=>reader(u=>{
    const p=Number(u.searchParams.get('page'));pages.push(p);return p===1?full:second;
  });
  const complete=await (await fetchPages([{...product,id:1001}])(request('dual?type=CALL'))).json();
  assert.deepEqual(pages,[1,2]);assert.equal(complete.products.length,1001);
  assert.equal((await fetchPages(full)(request('dual?type=CALL'))).status,503);
  const endless=reader(u=>full.map((r,i)=>({...r,id:1000*Number(u.searchParams.get('page'))+i})));
  assert.equal((await endless(request('dual?type=CALL'))).status,503);
});
test('Gate authentication errors are explicit; prior verified rates expire after 30 seconds and never cross sides',async()=>{
  let time=now, calls=0;
  const handle=createGatePublicReader({clock:()=>time,fetchImpl:async()=>{
    calls++;
    return calls===1?Response.json([product],{headers:{date:new Date(time).toUTCString()}}):
      Response.json({label:'MISSING_REQUIRED_HEADER',message:'Missing required header: Timestamp'},{status:400});
  }});
  const initial=await (await handle(request('dual?type=CALL'))).json();assert.equal(initial.products.length,1);
  time+=10_000;
  const fallback=await (await handle(request('dual?type=CALL'))).json();
  assert.equal(fallback.time,initial.time);assert.equal(fallback.products[0].time,initial.time);
  assert.match(fallback.refreshWarning,/认证/);
  const other=await handle(request('dual?type=PUT'));assert.equal(other.status,503);assert.match((await other.json()).reason,/认证/);
  time+=20_000;
  const expired=await handle(request('dual?type=CALL'));assert.equal(expired.status,503);assert.match((await expired.json()).reason,/HTTP 400/);
});


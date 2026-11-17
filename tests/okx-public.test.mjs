import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const moduleText = await readFile(new URL('../worker/okx-public.js',import.meta.url),'utf8');
const {createOkxPublicReader} = await import('data:text/javascript;base64,' + Buffer.from(moduleText + '\nexport {createOkxPublicReader}').toString('base64'));
const expiry = Date.UTC(2026,10,16,8), now = expiry-48*3_600_000;
const id = 'BTC-USD-261116-72000-C', query = path => new Request('https://comparison.test/api/okx/'+path,{headers:{cookie:'test-cookie',authorization:'test-auth'}});
const instrument = {instId:id,state:'live',uly:'BTC-USD',instFamily:'BTC-USD',instType:'OPTION',ctType:'inverse',ctValCcy:'BTC',settleCcy:'BTC',ctVal:'1',ctMult:'0.01',expTime:String(expiry),stk:'72000',optType:'C',lotSz:'1',minSz:'1',maxLmtSz:'1000000'};
const product = {ndBrokerProductId:'BTC-USDT-261116-72000-C',productType:'DualCurrencyDeposit',dcdType:'Standard',protectionProduct:false,type:'CALL',currency:'BTC',alternativeCurrency:'USDT',index:'BTC-USD',status:1,launchTime:now-3_600_000,stopTradingTime:expiry-14_400_000,strike:'72000',expiryTime:expiry,settlementTime:expiry,absYield:'0.0015',annualYield:'0.27461',dcdTerm:'48',interestAccrualTime:now,quoteResponseTime:now,vipAnnualYieldPercentageList:[{yield:'50.05'}]};
function reader(answer,httpTime=now) {
  return createOkxPublicReader({clock:()=>now,fetchImpl:async(url,opts)=>{
    assert.equal(new URL(url).origin,'https://www.okx.com');
    assert.equal(opts.method,'GET');assert.equal(opts.credentials,'omit');assert.equal(opts.redirect,'manual');
    assert.deepEqual(opts.headers,{accept:'application/json'});
    const payload = answer(new URL(url)); if (payload instanceof Response) return payload;
    return Response.json({code:'0',data:payload},{headers:{date:new Date(httpTime).toUTCString()}});
  }});
}
test('OKX inverse options preserve real BTC multiplier, USD strike and separately timed USDT valuation',async()=>{
  const read=reader(url=>{
    if (url.pathname.endsWith('/instruments')) return [instrument,{...instrument,settleCcy:'USDT'}, {...instrument,optType:'P'}, {...instrument,ctMult:''}];
    const pair=url.searchParams.get('instId');
    return [{instId:pair,idxPx:pair==='BTC-USD'?'70000':'69840',ts:String(now-125)}];
  });
  const data=await (await read(query('market?type=CALL'))).json();
  assert.equal(data.status,'ready');assert.equal(data.contracts.length,1);
  assert.equal(data.index,70000);assert.equal(data.spotUSDT,69840);assert.equal(data.indexUSDTTime,now-125);
  const c=data.contracts[0];assert.equal(c.unit,.01);assert.equal(c.coin,'BTC');assert.equal(c.strikeCoin,'USD');assert.equal(c.min,1);assert.equal(c.taker,.0003);assert.equal(c.cap,.07);
});
test('OKX dual uses product native APR and period yield and excludes VIP, wrong currency, stale quotes and expired window',async()=>{
  const read=reader(()=>({isVip:false,products:[product,{...product,alternativeCurrency:'USDC'},{...product,quoteResponseTime:now-30000},{...product,stopTradingTime:now},{...product,settlementTime:expiry+86400000},{...product,dcdTerm:'0'}]}));
  const data=await (await read(query('dual?type=CALL'))).json();
  assert.equal(data.products.length,1);
  const d=data.products[0];assert.equal(d.term,.0015);assert.equal(d.apr,.27461);assert.equal(d.coin,'BTC');assert.equal(d.days,2);assert.equal(d.amountRulesVerified,false);assert.equal(d.max,null);
  assert.equal((await reader(()=>({isVip:true,products:[product]}))(query('dual?type=CALL'))).status,503);
  assert.equal((await reader(()=>({products:[{...product,quoteResponseTime:now-31_000}]}))(query('dual?type=CALL'))).status,503);
  const lowProduct={...product,type:'PUT',ndBrokerProductId:'BTC-USDT-261116-72000-P'};
  const low=await (await reader(()=>({isVip:false,products:[lowProduct]}))(query('dual?type=PUT'))).json();
  assert.equal(low.products[0].coin,'USDT');assert.equal(low.products[0].direction,'PUT');
});
test('OKX book native premiums and contract depth are retained, stale/crossed data rejects',async()=>{
  const book={ts:String(now),asks:[['0.0011','40','0','2']],bids:[['0.001','70','0','1']]};
  const path='book?symbol='+id;
  const q=await (await reader(()=>[book])(query(path))).json();
  assert.deepEqual(q.asks,[{price:.0011,qty:40}]);assert.deepEqual(q.bids,[{price:.001,qty:70}]);
  for(const patch of [{ts:String(now-30000)},{asks:[['.001','1']]},{bids:[['.001','0']]},{bids: [['.001','2'],['.002','4']]}])assert.equal((await reader(()=>[{...book,...patch}])(query(path))).status,503);
  assert.equal((await reader(()=>[book],now-30000)(query(path))).status,503);
});
test('Invalid OKX paths, directions, families, dates and private methods make no upstream calls',async()=>{
  const read=reader(()=>assert.fail('should not read upstream'));
  for (const path of ['book?symbol=BTC-USD-261331-72000-C','book?symbol=BTC-USD-261116-72000-C&symbol=X','book?symbol=ETH-USD-261116-72000-P','book?symbol=A','market?type=spot','dual?url=https://example.org'])assert.equal((await read(query(path))).status,400);
  assert.equal((await read(new Request('https://example.test/api/okx/dual?type=PUT',{method:'POST'}))).status,405);
  assert.equal((await read(query('private?type=PUT'))).status,404);
});

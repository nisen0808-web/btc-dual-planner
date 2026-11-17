import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source = await readFile(new URL('../worker/bitget-public.js', import.meta.url), 'utf8');
const {createBitgetPublicReader} = await import('data:text/javascript;base64,' + Buffer.from(source+'\nexport {createBitgetPublicReader}').toString('base64'));
const expiry = Date.UTC(2027,0,6,8), now = expiry - 46.5 * 3_600_000;
const path = s => new Request('https://planner.test/api/bitget/'+s,{headers:{cookie:'private',authorization:'private'}});
function reader(side,{changeRow = x=>x,changeList = x=>x,pairCoin='USDT',age=0} = {}) {
  const direction = side === 'CALL' ? 1 : 0, tradeTokenId = direction ? 1 : 2, coin = direction ? 'BTC' : 'USDT';
  return createBitgetPublicReader({clock:()=>now,fetchImpl: async(url,opts)=>{
    assert.equal(new URL(url).origin,'https://www.bitget.com');
    assert.equal(opts.method,'POST');assert.equal(opts.credentials,'omit');assert.equal(opts.redirect,'manual');
    assert.deepEqual(opts.headers,{accept:'application/json','content-type':'application/json'});
    const pair = {direction,tradeTokenId,productTokenId:1,productTokenName:'BTC',tradeTokenName:coin};
    let data;
    if (url.endsWith('/template/list/v2')) {
      assert.deepEqual(JSON.parse(opts.body),{});
      data=[{tokenId:1,tokenName:'BTC',marketType:1,directionList:[{...pair,marketType:1,preTokenName:pairCoin}]}];
    } else {
      assert.equal(new URL(url).pathname,'/v1/finance/dualInvest/product/list/v3');
      assert.deepEqual(JSON.parse(opts.body),{productTokenId:1,tradeTokenId,direction,pageNum:1,pageSize:1000,timeRange:null,expirationTime:null,vipProduct:0});
      const row = {...pair,productSubId:'1505619578880016418',targetPrice:'64500',settleDate:expiry,expirationTime:expiry,
        leaveEndTime:String(expiry-now),leaveEndHours:'46',apy:'204.61',status:2,stickType:0};
      const items = [changeRow(row),{...row,stickType:6},{...row,status:6},{...row,tradeTokenId:4}];
      data={pageProduct:changeList({hasNextPage:false,items,total:items.length,pages:1,page:1})};
    }
    return Response.json({code:'200',data},{headers:{date:new Date(now-age).toUTCString()}});
  }});
}
test('both Bitget ordinary BTC dual directions use the official APR and complete interest hours',async()=>{
  for (const [side,coin] of [['CALL','BTC'],['PUT','USDT']]) {
    const response=await reader(side)(path('dual?type='+side));
    assert.equal(response.status,200);
    const {products} = await response.json();
    assert.equal(products.length,1);
    const p=products[0];assert.equal(p.coin,coin);assert.equal(p.direction,side);
    assert.equal(p.strike,64500);assert.equal(p.apr,2.0461);assert.equal(p.days,46/24);
    assert.equal(p.term,2.0461*46/(365*24));assert.equal(p.purchaseEnd,null);
    assert.equal(p.min,null);assert.equal(p.availabilityUntil,now+30_000);
  }
});
test('Bitget refuses stale, inconsistent or incomplete ordinary product quotes',async()=>{
  for (const options of [{age:30_000},{pairCoin:'USDC'},{changeList:l=>({...l,hasNextPage:true})},
    {changeRow:r=>({...r,leaveEndTime:String(expiry-now+31_000)})},{changeRow:r=>({...r,apy:null})},
    {changeRow:r=>({...r,leaveEndHours:'47'})}]) {
    assert.equal((await reader('CALL',options)(path('dual?type=CALL'))).status,503);
  }
});
test('one expired or almost-expired product does not hide the remaining verified products',async()=>{
  const tweak=list=>({...list,total:list.items.length+17,items:[...list.items,
    {...list.items[0],settleDate:now-1000,leaveEndTime:'0'},
    {...list.items[0],settleDate:now+1800000,expirationTime:now+1800000,leaveEndHours:'0',leaveEndTime:'1800000'}]});
  const response=await reader('CALL',{changeList:tweak})(path('dual?type=CALL'));
  assert.equal(response.status,200);assert.equal((await response.json()).products.length,1);
});
test('unsupported BTC vanilla options and input errors never query a substitute market',async()=>{
  const r=createBitgetPublicReader({fetchImpl:()=>assert.fail('unexpected upstream read')});
  for (const url of ['market?type=CALL','book?symbol=BTC-261117-64750-C']){
    const v=await r(path(url));assert.equal(v.status,404);
  }
  assert.equal((await r(path('dual?type=CALL&url=abc'))).status,400);
  assert.equal((await r(new Request(path('dual?type=PUT'),{method:'POST'}))).status,405);
});

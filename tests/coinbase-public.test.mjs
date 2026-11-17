import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';

const source = await readFile(new URL('../worker/coinbase-public.js', import.meta.url), 'utf8');
const {createCoinbasePublicReader} = await import('data:text/javascript;base64,' +
  Buffer.from(source + '\nexport {createCoinbasePublicReader};').toString('base64'));

const now = Date.UTC(2026, 10, 14, 9), expires = Date.UTC(2026, 10, 16, 8);
const symbol = 'BTC_USDC-16NOV26-72000-C';
function instrument(overrides = {}) {
  return {instrument_name: symbol, state: 'open', price_index: 'btc_usdc', kind: 'option', instrument_type: 'linear',
    expiration_timestamp: expires, is_active: true, contract_size: 1, tick_size: 5, strike: 72000,
    option_type:'call', min_trade_amount: 0.01, settlement_currency:'USDC', base_currency:'BTC', quote_currency:'USDC',
    lot_size: 1, maker_commission: 0, taker_commission: 0.0003, ...overrides};
}
const book = {instrument_name: symbol, state:'open', timestamp:now, change_id:21, index_price:67000,
  bids:[[20,2],[15,2.5]], asks:[[25,0.05],[30,1.04]]};

function service(overrides = {}, replyOverrides = {}) {
  const requests = [];
  const responses = {get_instruments: [instrument(),instrument({instrument_name:'BTC_USDC-16NOV26-72000-P',option_type:'put'}),instrument({settlement_currency:'BTC'}),instrument({instrument_type:'reversed'})],
    get_index_price: {index_price:67000}, get_order_book: book, ...overrides};
  const read = createCoinbasePublicReader({clock:()=>now, fetchImpl:async (url,options) => {
    const target=new URL(url);
    assert.equal(target.origin,'https://www.deribit.com');
    assert.deepEqual(options.headers,{accept:'application/json'});
    assert.equal(options.credentials,'omit');
    assert.equal(options.redirect,'manual');
    assert.equal(options.method,'GET');
    requests.push(target);
    const method=target.pathname.split('/').at(-1);
    return Response.json({jsonrpc:'2.0',testnet:false,usOut:now*1000,result:responses[method],...replyOverrides});
  }});
  return {requests,read:(path,method='GET')=>read(new Request('https://comparison.invalid'+path,{method,headers:{authorization:'private-test-only'}}))};
}
test('Coinbase App reads the Deribit linear USDC listing and native index, distinguishes retail fees from exchange commission', async()=>{
  const {read,requests}=service();
  const call=await (await read('/api/coinbase/market?type=CALL')).json();
  assert.equal(call.status,'ready');
  assert.equal(call.spot,67000);assert.equal(call.indexCoin,'USDC');assert.equal(call.contracts.length,1);
  const c=call.contracts[0];
  assert.deepEqual([c.symbol,c.unit,c.step,c.min,c.coin,c.strikeCurrency,c.maker,c.taker,c.cap,c.delivery],
    [symbol,1,.01,.01,'USDC','USDC',.001,.001,.125,null]);
  const put=await (await read('/api/coinbase/market?type=PUT')).json();
  assert.equal(put.contracts.length,1);assert.equal(put.contracts[0].direction,'PUT');
  assert.equal(requests.length,2);
});
test('Coinbase exact USDC book preserves actual two-sided depth, returns quantities in fractional one-BTC contracts',async()=>{
  const {read}=service();
  const data=await(await read('/api/coinbase/book?symbol='+symbol)).json();
  assert.equal(data.time,now);assert.equal(data.symbol,symbol);assert.equal(data.venue,'Deribit');
  assert.deepEqual(data.asks,[{price:25,qty:.05},{price:30,qty:1.04}]);
  assert.deepEqual(data.bids,[{price:20,qty:2},{price:15,qty:2.5}]);
});
test('Coinbase rejects expired RPC responses, testnet and mismatched or crossed depth',async()=>{
  for(const [changed,meta] of [
    [{timestamp:now-30000},{}],[{},{usOut:(now-30000)*1000}],[{},{testnet:true}],[{instrument_name:'BTC_USDC-16NOV26-72000-P'},{}],
    [{asks:[[10,5]]},{}],[{asks:[[25,2],[25,1]]},{}],[{state:'settled'},{}],[{index_price:0},{}]
  ]){
    const {read}=service({get_order_book:{...book,...changed}},meta);
    assert.equal((await read('/api/coinbase/book?symbol='+symbol)).status,503);
  }
});
test('Coinbase rejects foreign symbols, invalid dates, extra parameters and every write without upstream calls',async()=>{
  const {read, requests}=service();
  for (const [path,expected] of [['/api/coinbase/account',404],['/api/coinbase/book?symbol=BTC-16NOV26-72000-C',400],
    ['/api/coinbase/book?symbol=BTC_USDC-31NOV26-72000-C',400],['/api/coinbase/market?type=CALL&type=CALL',400],
    ['/api/coinbase/market?type=CALL&auth=1',400],['/api/coinbase/market?type=SIDE',400]]) assert.equal((await read(path)).status,expected);
  assert.equal((await read('/api/coinbase/market?type=CALL','POST')).status,405);
  assert.equal(requests.length,0);
});

test('a locked USDC market still lists both sides; each exact live book determines when yields can resume', async()=>{
  const strikes = [[17,60000,'P'],[18,62000,'P'],[18,63000,'P'],[18,65000,'C']];
  const listed = strikes.map(([day,strike,side]) => instrument({
    instrument_name:'BTC_USDC-'+day+'NOV26-'+strike+'-'+side, strike, state:'locked',
    expiration_timestamp:Date.UTC(2026,10,day,8), option_type:side==='P'?'put':'call'
  }));
  let state='locked', stamp=now, directoryReads=0;
  const handle=createCoinbasePublicReader({clock:()=>stamp,fetchImpl:async url=>{
    const uri=new URL(url), method=uri.pathname.split('/').at(-1);
    if(method==='get_instruments') directoryReads++;
    const result=method==='get_instruments'?listed:method==='get_index_price'?{index_price:67000}:
      {...book,instrument_name:uri.searchParams.get('instrument_name'),state,timestamp:stamp};
    const observed=method==='get_instruments'?now-58_000:stamp;
    return Response.json({jsonrpc:'2.0',testnet:false,usOut:observed*1000,result});
  }});
  const read=async path=>(await handle(new Request('https://comparison.invalid/api/coinbase/'+path))).json();
  const [puts,calls]=await Promise.all([read('market?type=PUT'),read('market?type=CALL')]);
  assert.deepEqual(puts.contracts.map(c=>c.strike),[60000,62000,63000]);
  assert.deepEqual(calls.contracts.map(c=>c.strike),[65000]);
  assert.equal(puts.time,now);assert.equal(puts.catalogueTime,now-58_000);
  for(const c of [...puts.contracts,...calls.contracts]){
    const blocked=await read('book?symbol='+c.symbol);
    assert.equal(blocked.status,'unavailable');assert.equal(blocked.symbol,c.symbol);
    assert.equal(blocked.bookState,'locked');assert.match(blocked.reason,/已锁盘/);
    assert.equal(blocked.bids,undefined);assert.equal(blocked.asks,undefined);
  }
  state='open';stamp+=10_000;
  assert.equal((await read('market?type=PUT')).indexTime,stamp);
  const reopened=await read('book?symbol='+calls.contracts[0].symbol);
  assert.equal(reopened.status,'ready');assert.equal(reopened.time,stamp);
  assert.equal(reopened.asks[0].price,25);assert.equal(directoryReads,1);
});

test('directory validity never relaxes live index, exact book, or terminal contract checks',async()=>{
  const list=[instrument({state:'delivered'}),instrument({state:'inactive'}),instrument({is_active:false})];
  assert.deepEqual((await(await service({get_instruments:list}).read('/api/coinbase/market?type=CALL')).json()).contracts,[]);
  const aged=(metadataAge,indexAge)=>createCoinbasePublicReader({clock:()=>now,fetchImpl:async url=>{
    const catalogue=url.includes('get_instruments');
    return Response.json({jsonrpc:'2.0',testnet:false,usOut:(now-(catalogue?metadataAge:indexAge))*1000,
      result:catalogue?[instrument()]:{index_price:67000}});
  }});
  for(const [catalogue,index] of [[120_000,0],[0,30_000]]){
    assert.equal((await aged(catalogue,index)(new Request('https://comparison.invalid/api/coinbase/market?type=CALL'))).status,503);
  }
  const {read}=service({get_order_book:{...book,state:'locked',timestamp:now-30_000}});
  assert.equal((await read('/api/coinbase/book?symbol='+symbol)).status,503);
});

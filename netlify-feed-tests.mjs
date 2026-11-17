import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';

execFileSync(process.execPath,['scripts/build-netlify-feed.mjs'],{cwd:import.meta.dirname});
const {createCloudQuoteHandler,config}=await import('./dist-netlify/netlify/functions/quotes.mjs');
const token='netlify-test-token',symbol='BTC-261030-79000-P';
const quote={status:'ready',time:1,receivedAt:2,serverTime:3,fetchedAt:4,bids:[[100,0.1]],asks:[[110,0.2]]};
const makeHandler=overrides=>createCloudQuoteHandler({token,optionsReader:{loadMarket:async()=>quote,loadBook:async()=>quote},dualReader:async()=>quote,...overrides});
const req=(path,{authorized=true,method='GET',headers={}}={})=>new Request('https://quote.example'+path,{method,headers:{...(authorized?{authorization:'Bearer '+token}:{}),...headers}});

test('build embeds current readers, fixed Netlify routes, and no region or client token',async()=>{
 const artifact=await readFile(new URL('./dist-netlify/netlify/functions/quotes.mjs',import.meta.url),'utf8');
 for(const path of ['worker/binance.js','worker/binance-options.js'])assert.ok(artifact.includes(await readFile(new URL('./'+path,import.meta.url),'utf8')));
 assert.deepEqual(config.path,['/health','/market','/book','/dual']);
 const toml=await readFile(new URL('./dist-netlify/netlify.toml',import.meta.url),'utf8');assert.doesNotMatch(toml,/region/i);assert.match(toml,/NODE_VERSION = "22"/);
 const page=await readFile(new URL('./dist-netlify/public/index.html',import.meta.url),'utf8');assert.doesNotMatch(page,/QUOTE_READ_TOKEN|netlify-test-token/);
 assert.throws(()=>createCloudQuoteHandler({token:''}),/QUOTE_READ_TOKEN/);
});
test('health is not an upstream claim; all quotes require exact bearer authorization',async()=>{
 const handler=makeHandler();
 assert.deepEqual(await (await handler(req('/health',{authorized:false}))).json(),{serviceReady:true});
 for(const path of ['/market','/book?symbol='+symbol,'/dual']){
  assert.equal((await handler(req(path,{authorized:false}))).status,401);
  assert.equal((await handler(req(path,{headers:{authorization:'Bearer wrong'}}))).status,401);
  assert.equal((await handler(req(path))).status,200);
 }
});
test('strict GET/query/credential rejection and reader argument isolation',async()=>{
 const calls=[];
 const handler=makeHandler({optionsReader:{loadMarket:async(...args)=>{calls.push(args);return quote;},loadBook:async(...args)=>{calls.push(args);return quote;}},dualReader:async(...args)=>{calls.push(args);return quote;}});
 for(const path of ['/market?url=https://evil.example','/dual?key=secret','/book','/book?symbol='+symbol+'&symbol='+symbol,'/book?symbol=ETH-261030-1000-P'])assert.equal((await handler(req(path))).status,400,path);
 assert.equal((await handler(req('/account'))).status,404);assert.equal((await handler(req('/market',{method:'POST'}))).status,405);
 for(const name of ['cookie','x-mbx-apikey','x-api-key','proxy-authorization'])assert.equal((await handler(req('/market',{headers:{[name]:'secret'}}))).status,400);
 await handler(req('/market'));await handler(req('/book?symbol='+symbol));await handler(req('/dual',{headers:{'x-forwarded-host':'ignored.example'}}));
 assert.deepEqual(calls,[[],[symbol],[{}]]);
});
test('source denial stops only that source, preserves timestamps/depth, and rejects oversized output',async()=>{
 let dualCalls=0;
 const handler=makeHandler({dualReader:async()=>{dualCalls++;return {status:'unavailable',reason:'HTTP 451'};}});
 assert.equal((await (await handler(req('/dual'))).json()).upstreamStatus,451);assert.equal((await handler(req('/dual'))).status,503);assert.equal(dualCalls,1);
 const market=await handler(req('/market'));assert.equal(market.headers.get('cache-control'),'no-store');assert.deepEqual(await market.json(),quote);
 assert.deepEqual(await (await handler(req('/book?symbol='+symbol))).json(),quote);
 let optionCalls=0;
 const denied=makeHandler({optionsReader:{loadMarket:async()=>{optionCalls++;throw Error('HTTP 403');}}});
 assert.equal((await denied(req('/market'))).status,503);assert.equal((await denied(req('/market'))).status,503);assert.equal(optionCalls,1);assert.equal((await denied(req('/dual'))).status,200);
 const large=makeHandler({dualReader:async()=>({...quote,data:'x'.repeat(4*1024*1024)})});assert.equal((await large(req('/dual'))).status,503);
 const stale=makeHandler({dualReader:async()=>({status:'unavailable',serverTime:0,fetchedAt:1})});assert.equal((await stale(req('/dual'))).status,503);
});

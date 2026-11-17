import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createBinanceExecutionService} from './execution/binance-service.mjs';

const SITE='https://btc-dual-planner-oct22.phyrex-ni.chatgpt.site',LOCAL='http://127.0.0.1:8789';
const html=readFileSync(new URL('./execution/binance-local-setup.html',import.meta.url),'utf8');
const setupSource=html.match(/<script nonce="__NONCE__">([\s\S]*?)<\/script>/)?.[1];
const clientSource=readFileSync(new URL('./web/binance-local-execution.js',import.meta.url),'utf8');
const plain=x=>JSON.parse(JSON.stringify(x));
const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};

function setupFixture({hasOpener=true,siteOrigin=SITE}={}){
 const nodes=new Map();for(const [,id]of html.matchAll(/id="([^"]+)"/g))nodes.set(id,{value:'',checked:false,disabled:false,textContent:'',className:'',dataset:{},listeners:{},addEventListener(type,handler){this.listeners[type]=handler;}});
 nodes.get('environment').value='mainnet';
 const requests=[],messages=[],listeners={},intervals=new Map(),opened=[];let seq=0;
 const target={closed:false,postMessage:(body,targetOrigin)=>messages.push({body:plain(body),targetOrigin})};
 const f={nodes,requests,messages,listeners,intervals,target,opened,respond:null};
 const context=vm.createContext({URL,AbortController,Date,Error,document:{getElementById:id=>nodes.get(id),querySelector:q=>({content:q.includes('csrf')?'fixture-nonce':siteOrigin})},window:{opener:hasOpener?target:null,addEventListener:(type,handler)=>listeners[type]=handler,open:(url,name)=>{opened.push({url,name});return target;}},localStorage:{getItem(){assert.fail('Setup must never read persistent browser storage');},setItem(){assert.fail('Setup must never store account keys');}},sessionStorage:{getItem(){assert.fail('Setup must never read session storage');},setItem(){assert.fail('Setup must never store account keys');}},setTimeout:()=>++seq,clearTimeout:()=>{},setInterval:handler=>{intervals.set(++seq,handler);return seq;},clearInterval:id=>intervals.delete(id),fetch:async(path,options)=>{
  requests.push({path,options:plain({...options,signal:undefined})});if(f.respond)return f.respond(path,options);
  return {ok:true,json:async()=>path==='/local/pair'?{token:'B'.repeat(43),expiresAt:Date.now()+60000,siteOrigin}:path==='/local/revoke'?{revoked:true}:{configured:false,accountVerified:false,runnerOnline:true,canSubmit:false}};
 }});
 new vm.Script(setupSource).runInContext(context);f.click=async id=>{await nodes.get(id).listeners.click();await flush();};
 f.submit=async()=>{await nodes.get('configure-form').listeners.submit({preventDefault(){}});await flush();};return f;
}
function clientFixture({hasOpener=false,stored={}}={}){
 const requests=[],messages=[],listeners={},intervals=new Map(),opened=[],storage=new Map(Object.entries(stored));let seq=0,changed=0;
 const target={closed:false,postMessage:(body,targetOrigin)=>messages.push({body:plain(body),targetOrigin})};
 const f={requests,messages,listeners,intervals,opened,storage,target,respond:null};
 const context=vm.createContext({Date,Error,JSON,AbortSignal,window:{opener:hasOpener?target:null,addEventListener:(type,handler)=>listeners[type]=handler,open:(url,name)=>{opened.push({url,name});return target;}},sessionStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},setInterval:handler=>{intervals.set(++seq,handler);return seq;},clearInterval:id=>intervals.delete(id),fetch:async(url,options)=>{requests.push({url,options:plain({...options,signal:undefined})});return f.respond?f.respond(url,options):{ok:true,status:200,json:async()=>({status:'ready',platform:'binance',currency:'USDT'})};}});
 new vm.Script(clientSource.replace('export function createBinanceLocalExecutionClient','function createBinanceLocalExecutionClient')+';globalThis.makeClient=createBinanceLocalExecutionClient;').runInContext(context);
 f.client=context.makeClient(()=>changed++);f.changes=()=>changed;f.message=(data,origin=LOCAL,source=target)=>listeners.message({origin,source,data});return f;
}

test('Binance setup is self-contained, password-only, nonce protected and never auto-pairs or orders',async()=>{
 assert.equal(typeof setupSource,'string');new vm.Script(setupSource);assert.match(html,/<input[^>]*id="api-key"[^>]*type="password"/);assert.match(html,/<input[^>]*id="api-secret"[^>]*type="password"/);assert.match(html,/<script nonce="__NONCE__">/);
 assert.doesNotMatch(html,/<(?:script|link|iframe)[^>]+(?:src|href)=/i);assert.doesNotMatch(setupSource,/localStorage|sessionStorage|console\./);
 const f=setupFixture();await flush();assert.deepEqual(f.requests.map(x=>x.path),['/local/status']);assert.equal(f.messages.length,0);assert.equal(f.nodes.get('trading-enabled').checked,false);assert.match(f.nodes.get('account-status').textContent,/尚未/);assert.equal(f.requests[0].options.headers['X-Local-CSRF'],'fixture-nonce');
});
test('saving synthetic Binance keys sends them only to localhost configure, clears fields and never confirms a trade',async()=>{
 const f=setupFixture();await flush();for(const enabled of [false,true]){
  f.nodes.get('api-key').value='synthetic-binance-api-key';f.nodes.get('api-secret').value='synthetic-binance-api-secret';f.nodes.get('trading-enabled').checked=enabled;await f.submit();
  const request=f.requests.filter(x=>x.path==='/local/configure').at(-1);assert.equal(request.options.method,'POST');assert.equal(request.options.credentials,'omit');assert.equal(request.options.redirect,'error');assert.deepEqual(JSON.parse(request.options.body),{apiKey:'synthetic-binance-api-key',apiSecret:'synthetic-binance-api-secret',environment:'mainnet',tradingEnabled:enabled});
  assert.equal(f.nodes.get('api-key').value,'');assert.equal(f.nodes.get('api-secret').value,'');assert.equal(f.nodes.get('trading-enabled').checked,false);assert.match(f.nodes.get('configure-message').textContent,/尚未下单/);
 }
 assert.equal(f.messages.length,0);assert.equal(f.requests.every(x=>['/local/status','/local/configure'].includes(x.path)),true);
 f.nodes.get('trading-enabled').checked=true;f.nodes.get('environment').listeners.change();assert.equal(f.nodes.get('trading-enabled').checked,false);
});
test('failed local configuration clears credentials and does not pair or claim trading is enabled',async()=>{
 const f=setupFixture();await flush();f.respond=async()=>({ok:false,json:async()=>({status:'unavailable'})});f.nodes.get('api-key').value='synthetic-binance-api-key';f.nodes.get('api-secret').value='synthetic-binance-api-secret';f.nodes.get('trading-enabled').checked=true;await f.submit();
 assert.equal(f.nodes.get('api-key').value,'');assert.equal(f.nodes.get('api-secret').value,'');assert.equal(f.nodes.get('trading-enabled').checked,false);assert.equal(f.messages.length,0);assert.equal(f.nodes.get('configure-message').dataset.state,'error');
});
test('runtime installation constructs local adapters without account calls and stores only non-secret status fields',async()=>{
 const source=readFileSync(new URL('./execution/binance-local-server.mjs',import.meta.url),'utf8'),install=source.slice(source.indexOf('async function install('),source.indexOf('\nasync function configure('));let privateCalls=0;const adapters=[],services=[];
 const context=vm.createContext({runtime:'synthetic-runtime',journal:null,pending:null,service:null,settings:null,configLoadError:false,resolve:(...parts)=>parts.join('/'),ExecutionJournal:class{list(){return [];}close(){}},createBinanceExecution:config=>{adapters.push(config);return {getAccountEvidence(){privateCalls++;},createSellPut(){privateCalls++;}};},createBinanceExecutionService:config=>{services.push(config);return {};},createBinancePublicMarket:()=>({publicOnly:true})});
 new vm.Script(install+';globalThis.installFixture=install;').runInContext(context);
 for(const tradingEnabled of [false,true])await context.installFixture({apiKey:'synthetic-runtime-key',apiSecret:'synthetic-runtime-secret',environment:'mainnet',tradingEnabled});
 assert.equal(privateCalls,0);assert.equal(adapters.length,2);assert.equal(services.length,2);assert.equal(adapters[0].liveEnabled,false);assert.equal(adapters[1].liveEnabled,true);assert.deepEqual(Object.keys(context.settings).sort(),['currency','environment','platform','tradingEnabled']);assert.doesNotMatch(JSON.stringify(context.settings),/synthetic-runtime/);
 context.journal={list:()=>[{closed:false}]};await assert.rejects(context.installFixture({apiKey:'synthetic-runtime-key',apiSecret:'synthetic-runtime-secret',environment:'mainnet',tradingEnabled:true}),/unfinished strategy/);assert.equal(adapters.length,2);
});
test('pairing forwards only a short bridge token to the exact trusted origin after a human click',async()=>{
 const f=setupFixture();await flush();f.nodes.get('api-key').value='synthetic-never-forward';f.nodes.get('api-secret').value='synthetic-never-forward-secret';await f.click('pair-site');
 assert.deepEqual(f.requests.map(x=>x.path),['/local/status','/local/pair']);assert.equal(f.requests[1].options.body,'{}');assert.equal(f.messages.length,1);assert.equal(f.messages[0].targetOrigin,SITE);assert.deepEqual(Object.keys(f.messages[0].body).sort(),['expiresAt','token','type']);assert.equal(f.messages[0].body.type,'binance-local-paired');assert.doesNotMatch(JSON.stringify(f.messages),/synthetic-never-forward/);
});
test('new-window pairing requires a matching Site origin, exact window and readiness message',async()=>{
 const f=setupFixture({hasOpener:false});await flush();await f.click('pair-site');assert.deepEqual(f.opened.map(x=>x.url),[SITE]);
 for(const event of [{origin:'https://evil.invalid',source:f.target,data:{type:'binance-local-site-ready',ready:true}},{origin:SITE,source:{},data:{type:'binance-local-site-ready',ready:true}},{origin:SITE,source:f.target,data:{type:'binance-local-site-ready'}}]){f.listeners.message(event);await flush();assert.equal(f.requests.length,1);}
 f.listeners.message({origin:SITE,source:f.target,data:{type:'binance-local-site-ready',ready:true}});await flush();assert.equal(f.requests.filter(x=>x.path==='/local/pair').length,1);assert.equal(f.messages.length,1);assert.equal(f.intervals.size,0);
});
test('unpaired strategy client cannot request an account or submit; connecting opens only localhost',async()=>{
 const f=clientFixture();assert.equal((await f.client.api('status')).canSubmit,false);assert.deepEqual(plain(await f.client.api('plans')),[]);await assert.rejects(f.client.api('prepare',{settlementMode:'cash'}),/先连接/);await assert.rejects(f.client.api('confirm',{confirmed:true}),/先连接/);assert.equal(f.requests.length,0);
 assert.equal(f.client.connect(),true);assert.equal(f.opened[0].url,LOCAL+'/connect');for(const tick of f.intervals.values())tick();assert.equal(f.requests.length,0);assert.equal(f.storage.size,0);assert.equal(f.messages[0].targetOrigin,LOCAL);
});
test('strategy pairing rejects wrong source and saves only Binance session fields, never exchange keys',async()=>{
 const f=clientFixture();f.client.connect();const data={type:'binance-local-paired',token:'A'.repeat(43),expiresAt:Date.now()+60000,apiKey:'synthetic-forbidden-key',apiSecret:'synthetic-forbidden-secret'};
 f.message(data,'https://evil.invalid');f.message(data,LOCAL,{});f.message({...data,type:'deribit-local-paired'});assert.equal(f.client.paired(),false);assert.equal(f.storage.size,0);
 f.message(data);assert.equal(f.client.paired(),true);assert.equal(f.requests.length,0);assert.equal(f.storage.size,1);const stored=JSON.parse(f.storage.get('binance-local-session-v1'));assert.deepEqual(Object.keys(stored).sort(),['expiresAt','token']);assert.doesNotMatch(JSON.stringify([...f.storage]),/synthetic-forbidden/);
 await f.client.api('status');assert.equal(f.requests.length,1);assert.equal(f.requests[0].url,LOCAL+'/v1/status');assert.equal(f.requests[0].options.credentials,'omit');assert.equal(f.requests[0].options.headers.Authorization,'Bearer '+data.token);assert.doesNotMatch(JSON.stringify(f.requests),/synthetic-forbidden/);
});
test('Binance session does not reuse Deribit storage and expired authentication is removed without retry',async()=>{
 const deribit=JSON.stringify({token:'D'.repeat(43),expiresAt:Date.now()+60000}),unpaired=clientFixture({stored:{'deribit-local-session-v1':deribit}});assert.equal(unpaired.client.paired(),false);await unpaired.client.api('status');assert.equal(unpaired.requests.length,0);
 const f=clientFixture({stored:{'binance-local-session-v1':JSON.stringify({token:'B'.repeat(43),expiresAt:Date.now()+60000})}});f.respond=async()=>({ok:false,status:401,json:async()=>({})});await assert.rejects(f.client.api('status'),/已过期/);assert.equal(f.requests.length,1);assert.equal(f.client.paired(),false);assert.equal(f.storage.size,0);await f.client.api('status');assert.equal(f.requests.length,1);
});
test('invalid maturity mode cannot reach market, account factory or order submission',async()=>{
 let marketCalls=0,privateCalls=0;const service=createBinanceExecutionService({journal:{get:()=>null,list:()=>[],create:()=>assert.fail('Invalid mode must not journal an order'),update:()=>assert.fail('Invalid mode must not change plans')},marketProvider:{prepare:async()=>{marketCalls++;throw Error('must not reach market');},spot:async()=>{},settlement:async()=>{}},exchangeFactory:()=>{privateCalls++;throw Error('must not reach account');},liveEnabled:true});
 for(const settlementMode of ['BUY_BTC','withdraw','buy_put','',undefined,null])await assert.rejects(service.prepare({amount:'10000',symbol:'BTC-261024-80000-P',settlementMode}),/到期处理方式/);
 await assert.rejects(service.confirm({id:'synthetic-intent',fingerprint:'synthetic-fingerprint',account:'binance-dedicated-usdt',currency:'USDT',confirmed:true,settlementMode:'buy_btc'}),/完整服务器草案/);assert.equal(marketCalls,0);assert.equal(privateCalls,0);
});

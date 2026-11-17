import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const html=readFileSync(new URL('./execution/local-setup.html',import.meta.url),'utf8');
const source=html.match(/<script nonce="__NONCE__">([\s\S]*?)<\/script>/)?.[1];
const origin='https://strategy.example';
const flush=async()=>{for(let n=0;n<30;n++)await Promise.resolve();};
function fixture({hasOpener=true,siteOrigin=origin}={}){
  const nodes=new Map();
  for(const [,id]of html.matchAll(/id="([^"]+)"/g))nodes.set(id,{value:'',checked:false,textContent:'',className:'',dataset:{},disabled:false,listeners:{},addEventListener(type,handler){this.listeners[type]=handler;}});
  nodes.get('environment').value='testnet';
  const requests=[],messages=[],listeners={},intervals=new Map();let sequence=0;
  const target={closed:false,postMessage:(body,targetOrigin)=>messages.push({body,targetOrigin})};
  const f={nodes,requests,messages,listeners,intervals,target,opened:[],respond:null};
  const window={opener:hasOpener?target:null,addEventListener:(type,handler)=>listeners[type]=handler,open:(url,name)=>{f.opened.push({url,name});return target;}};
  const context=vm.createContext({document:{getElementById:id=>nodes.get(id),querySelector:selector=>({content:selector.includes('csrf')?'fixture-nonce':siteOrigin})},window,URL,AbortController,Date,Error,setTimeout:()=>++sequence,clearTimeout:()=>{},setInterval:handler=>{intervals.set(++sequence,handler);return sequence;},clearInterval:id=>intervals.delete(id),fetch:async(path,options)=>{
    requests.push({path,options});
    if(f.respond)return f.respond(path,options);
    return {ok:true,json:async()=>path==='/local/pair'?{token:'fixture_pair_token_long_enough',expiresAt:Date.now()+60000,siteOrigin}:path==='/local/revoke'?{revoked:true}:{configured:false,accountVerified:false,runnerOnline:false,canSubmit:false}};
  }});
  new vm.Script(source).runInContext(context);
  f.click=async id=>{await nodes.get(id).listeners.click();await flush();};
  return f;
}

test('local setup stays self-contained, nonce protected and starts without an account/trade claim',async()=>{
  assert.equal(typeof source,'string');new vm.Script(source);
  assert.match(html,/<style nonce="__NONCE__">/);assert.match(html,/<script nonce="__NONCE__">/);
  assert.equal(/<(?:script|link|iframe)[^>]+(?:src|href)=/i.test(html),false);
  assert.equal(/localStorage|sessionStorage|console\./.test(source),false);
  const f=fixture();await flush();
  assert.deepEqual(f.requests.map(row=>row.path),['/local/status']);assert.equal(f.messages.length,0);
  assert.equal(f.nodes.get('trading-enabled').checked,false);assert.equal(f.nodes.get('environment').value,'testnet');
  assert.match(f.nodes.get('account-status').textContent,/尚未/);assert.match(f.nodes.get('runner-status').textContent,/尚无/);
  assert.equal(f.requests[0].options.headers['X-Local-CSRF'],'fixture-nonce');
});

test('pairing needs a click and passes only the short bridge token to the exact opener origin',async()=>{
  const f=fixture();await flush();await f.click('pair-site');
  const paired=f.requests.find(row=>row.path==='/local/pair');assert.ok(paired);assert.equal(paired.options.method,'POST');assert.equal(paired.options.body,'{}');
  assert.equal(paired.options.credentials,'omit');assert.equal(paired.options.headers['Content-Type'],'application/json');
  assert.equal(f.messages.length,1);assert.equal(f.messages[0].targetOrigin,origin);
  assert.deepEqual(Object.keys(f.messages[0].body).sort(),['expiresAt','token','type']);assert.equal(f.messages[0].body.type,'deribit-local-paired');
  assert.equal(f.requests.some(row=>/confirm|order|buy|sell/.test(row.path)),false);
});

test('a newly opened site must prove readiness from the exact origin and window',async()=>{
  const f=fixture({hasOpener:false});await flush();await f.click('pair-site');
  assert.deepEqual(f.opened.map(row=>row.url),[origin]);assert.equal(f.requests.length,1);
  for(const event of [{origin:'https://evil.example',source:f.target,data:{type:'deribit-local-site-ready',ready:true}},{origin,source:{},data:{type:'deribit-local-site-ready',ready:true}},{origin,source:f.target,data:{type:'deribit-local-site-ready'}}]){f.listeners.message(event);await flush();assert.equal(f.requests.length,1);}
  f.listeners.message({origin,source:f.target,data:{type:'deribit-local-site-ready',ready:true}});await flush();
  assert.equal(f.requests.filter(row=>row.path==='/local/pair').length,1);assert.equal(f.messages.length,1);
  assert.equal(f.intervals.size,0);
});

test('credential configuration posts only to local service and clears both password fields',async()=>{
  const f=fixture();await flush();f.nodes.get('client-id').value='synthetic-id';f.nodes.get('client-secret').value='synthetic-secret';
  await f.nodes.get('configure-form').listeners.submit({preventDefault(){}});await flush();
  const request=f.requests.find(row=>row.path==='/local/configure');assert.equal(request.options.method,'POST');
  assert.deepEqual(JSON.parse(request.options.body),{clientId:'synthetic-id',clientSecret:'synthetic-secret',environment:'testnet',tradingEnabled:false});
  assert.equal(f.nodes.get('client-id').value,'');assert.equal(f.nodes.get('client-secret').value,'');assert.equal(f.nodes.get('trading-enabled').checked,false);assert.equal(f.messages.length,0);
  f.nodes.get('trading-enabled').checked=true;f.nodes.get('environment').value='mainnet';f.nodes.get('environment').listeners.change();assert.equal(f.nodes.get('trading-enabled').checked,false);
});

test('mainnet configuration requires an explicit trade switch and saving never submits an order',async()=>{
  const f=fixture();await flush();
  f.nodes.get('trading-enabled').checked=true;
  f.nodes.get('environment').value='mainnet';f.nodes.get('environment').listeners.change();
  assert.equal(f.nodes.get('trading-enabled').checked,false);
  assert.match(f.nodes.get('environment-note').textContent,/真实资金/);
  for(const enabled of [false,true]){
    f.nodes.get('client-id').value='synthetic-mainnet-id';f.nodes.get('client-secret').value='synthetic-mainnet-secret';
    f.nodes.get('trading-enabled').checked=enabled;
    await f.nodes.get('configure-form').listeners.submit({preventDefault(){}});await flush();
    const request=f.requests.filter(row=>row.path==='/local/configure').at(-1);
    assert.deepEqual(JSON.parse(request.options.body),{clientId:'synthetic-mainnet-id',clientSecret:'synthetic-mainnet-secret',environment:'mainnet',tradingEnabled:enabled});
    assert.match(f.nodes.get('configure-message').textContent,/尚未下单/);
    assert.equal(f.nodes.get('trading-enabled').checked,false);
  }
  assert.equal(f.requests.every(row=>['/local/status','/local/configure'].includes(row.path)),true);
  assert.equal(f.messages.length,0);
});

test('failed configuration still clears inputs without claiming an account or completed trade',async()=>{
  const f=fixture();await flush();f.respond=async()=>({ok:false,json:async()=>({ok:false})});
  f.nodes.get('client-id').value='synthetic-id';f.nodes.get('client-secret').value='synthetic-secret';f.nodes.get('environment').value='mainnet';f.nodes.get('trading-enabled').checked=true;
  await f.nodes.get('configure-form').listeners.submit({preventDefault(){}});await flush();
  assert.equal(f.nodes.get('client-id').value,'');assert.equal(f.nodes.get('client-secret').value,'');assert.equal(f.nodes.get('configure-message').dataset.state,'error');assert.match(f.nodes.get('configure-message').textContent,/核对账户环境和密钥/);assert.doesNotMatch(f.nodes.get('configure-message').textContent,/测试网完整流程/);assert.match(f.nodes.get('account-status').textContent,/尚未/);
});

test('runtime mainnet installation uses only the explicit trade permission and keeps service gates',async()=>{
  const runtimeSource=readFileSync(new URL('./execution/local-server.mjs',import.meta.url),'utf8');
  const installSource=runtimeSource.slice(runtimeSource.indexOf('async function install('),runtimeSource.indexOf('\nasync function configure('));
  const opened=[],adapters=[],services=[];let privateCalls=0;
  const context=vm.createContext({runtime:'synthetic-runtime',journal:null,pending:null,service:null,settings:null,resolve:(...parts)=>parts.join('/'),
    ExecutionJournal:class{constructor(path){opened.push(path);}list(){return [];}close(){}},
    createDeribitExecution:config=>{adapters.push(config);return {getApiInfo(){privateCalls++;}};},
    createDeribitExecutionService:config=>{services.push(config);return {};},createDeribitPublicMarket:config=>config});
  new vm.Script(installSource+'; globalThis.installFixture=install;').runInContext(context);
  const config={clientId:'synthetic-id',clientSecret:'synthetic-secret',environment:'mainnet',tradingEnabled:false};
  await context.installFixture(config);
  assert.equal(adapters[0].baseUrl,'https://www.deribit.com');assert.equal(adapters[0].liveEnabled,false);assert.equal(services[0].liveEnabled,false);
  await context.installFixture({...config,tradingEnabled:true});
  assert.equal(adapters[1].liveEnabled,true);assert.equal(services[1].liveEnabled,true);
  assert.deepEqual(opened,['synthetic-runtime/mainnet.sqlite','synthetic-runtime/mainnet.sqlite']);
  assert.equal(privateCalls,0);assert.equal(context.settings.tradingEnabled,true);
  await assert.rejects(context.installFixture({...config,tradingEnabled:undefined}),/Invalid local configuration/);
  context.journal={list:()=>[{closed:false}]};
  await assert.rejects(context.installFixture(config),/unfinished strategy/);
  assert.equal(adapters.length,2);
  assert.equal(services.every(config=>config.accountLabel==='deribit-dedicated-usdc'&&typeof config.exchangeFactory==='function'),true);
});

test('revoking pairing sends its own explicit local request and preserves strategy semantics',async()=>{
  const f=fixture({hasOpener:false});await flush();await f.click('pair-site');await f.click('revoke-site');
  const request=f.requests.find(row=>row.path==='/local/revoke');assert.equal(request.options.method,'POST');assert.equal(request.options.body,'{}');assert.equal(request.options.headers['X-Local-CSRF'],'fixture-nonce');
  assert.equal(f.intervals.size,0);assert.equal(f.requests.some(row=>row.path==='/local/pair'),false);assert.match(f.nodes.get('pair-message').textContent,/不会暂停或平仓/);assert.equal(f.messages.length,0);
});

test('invalid site origin and unverified revoke responses never produce a success claim',async()=>{
  const f=fixture({siteOrigin:'https://strategy.example/path'});await flush();assert.equal(f.nodes.get('pair-site').disabled,true);await f.click('pair-site');assert.equal(f.messages.length,0);
  f.respond=async()=>({ok:true,json:async()=>({revoked:false})});await f.click('revoke-site');assert.equal(f.nodes.get('pair-message').dataset.state,'error');assert.match(f.nodes.get('pair-message').textContent,/未能确认/);
});

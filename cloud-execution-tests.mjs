import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {BinanceCloudVault} from './execution/binance-cloud-vault.mjs';
import {createBinanceCloudHttp} from './execution/binance-cloud-http.mjs';
import {createBinanceCloudBroker} from './execution/binance-cloud-server.mjs';
import {ExecutionJournal} from './execution/journal.mjs';

const ORIGIN='https://btc-dual-planner-oct22.phyrex-ni.chatgpt.site',SECRET='service-test-'+ 's'.repeat(40),KEY='public_key_12345678',APISECRET='private_secret_12345678';
const evidence=uid=>({uid,checkedAt:Date.now(),restriction:{ipRestrict:true,enableReading:true,enableVanillaOptions:true,enableWithdrawals:false,enableMargin:false,enableFutures:false,enablePortfolioMarginTrading:false,enableFixApiTrade:false}});
function fixture(t,overrides={}){
  const directory=mkdtempSync(join(tmpdir(),'btc-cloud-')),calls={read:0,write:0,recoveryWrites:0},masterKey=randomBytes(32);let uid='101';
  const exchangeFactory=({apiKey})=>({getAccountEvidence:async()=>{calls.read++;return {ok:true,data:evidence(apiKey==='other_key_12345678'?'202':uid)};},getExecutionState:()=>({reconciliationRequired:false})});
  const serviceFactory=({journal,accountLabel})=>({
    status:async()=>({account:accountLabel,accountId:accountLabel.slice(4),connected:true,accountVerified:true,checkedAt:Date.now(),canSubmit:!journal.list().some(p=>!p.closed),cashCanSubmit:true,buyBTCCanSubmit:true,runnerOnline:true}),
    tick:async()=>{for(const p of journal.list())if(!p.closed&&p.phase==='transfer_ready'&&!p.automationPaused)calls.recoveryWrites++;return {running:true,outcomes:journal.list().map(p=>({id:p.id,phase:p.phase}))};},
    prepare:async input=>({id:'intent',account:accountLabel,currency:'USDT',...input}),
    confirm:async input=>{const old=journal.get(input.id);if(old)return old;if(journal.list().some(p=>!p.closed))throw Error('active');calls.write++;return journal.create({id:input.id,account:accountLabel,platform:'binance',phase:'put_unknown',closed:false});},
    listPlans:()=>journal.list(),pause:async input=>{const old=journal.get(input.id);if(!old||old.account!==accountLabel)throw Error('missing');return journal.update(old.id,old.version,{automationPaused:true});}
  });
  const options={directory,masterKey,serviceConfigured:true,persistentConfirmed:true,fixedEgressIp:'203.0.113.15',egressConfirmed:true,liveEnabled:true,exchangeFactory,serviceFactory,marketFactory:()=>({}),...overrides};
  const broker=createBinanceCloudBroker(options);t.after(async()=>{await broker.close();rmSync(directory,{recursive:true,force:true});});
  return {broker,directory,masterKey,calls,options};
}
async function httpFixture(t,broker){const {server}=createBinanceCloudHttp({broker,serviceSecret:SECRET,siteOrigin:ORIGIN});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));return async(path,{method='GET',body,cookie,csrf,authorized=true,origin=ORIGIN}={})=>{const response=await fetch('http://127.0.0.1:'+server.address().port+path,{method,headers:{...(authorized?{Authorization:'Bearer '+SECRET}:{}),Origin:origin,'X-Forwarded-Proto':'https',...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,cookie:response.headers.get('set-cookie'),body:await response.json()};};}

test('vault encrypts and authenticates credentials, including UID AAD; journal paths cannot traverse',t=>{
  const directory=mkdtempSync(join(tmpdir(),'btc-vault-')),key=randomBytes(32),vault=new BinanceCloudVault({directory,masterKey:key});t.after(()=>{vault.close();rmSync(directory,{recursive:true,force:true});});
  vault.put('101',{apiKey:KEY,apiSecret:APISECRET});assert.deepEqual(vault.get('101'),{apiKey:KEY,apiSecret:APISECRET});assert.throws(()=>vault.journalPath('../outside'));
  const raw=Buffer.concat(readdirSync(directory).map(name=>readFileSync(join(directory,name))));assert.equal(raw.includes(Buffer.from(APISECRET)),false);assert.equal(raw.includes(Buffer.from(KEY)),false);
  vault.db.prepare("UPDATE accounts SET uid='202' WHERE uid='101'").run();assert.throws(()=>vault.get('202'));
});

test('unconfigured/live-disabled broker refuses credentials and performs zero exchange calls',async t=>{
  const {broker,calls}=fixture(t,{liveEnabled:false});assert.equal((await broker.status()).brokerConfigured,false);await assert.rejects(()=>broker.connect({apiKey:KEY,apiSecret:APISECRET}),/broker_not_configured/);assert.deepEqual(calls,{read:0,write:0,recoveryWrites:0});
});

test('unauthorized origin/Bearer/CSRF never calls broker; 256-bit HttpOnly session is not response JSON',async t=>{
  const {broker,calls}=fixture(t),request=await httpFixture(t,broker);
  assert.equal((await request('/v1/status',{authorized:false})).status,403);assert.equal((await request('/v1/status',{origin:'https://evil.invalid'})).status,403);
  const boot=await request('/v1/status');assert.match(boot.cookie,/__Host-btc_put_session=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict/);assert.equal(JSON.stringify(boot.body).includes(boot.cookie.split('=')[1].split(';')[0]),false);
  assert.equal((await request('/v1/connect',{method:'POST',cookie:boot.cookie.split(';')[0],body:{apiKey:KEY,apiSecret:APISECRET,tradingEnabled:true}})).status,403);assert.equal(calls.read,0);
});

test('connect is signed-read-only; visitor cookies isolate accounts and CSRF; invalid trading consent rejected',async t=>{
  const {broker,calls}=fixture(t),request=await httpFixture(t,broker),a=await request('/v1/status'),b=await request('/v1/status');const ca=a.cookie.split(';')[0],cb=b.cookie.split(';')[0];
  assert.notEqual(ca,cb);assert.notEqual(a.body.csrf,b.body.csrf);
  const bad=await request('/v1/connect',{method:'POST',cookie:ca,csrf:a.body.csrf,body:{apiKey:KEY,apiSecret:APISECRET}});assert.equal(bad.status,400);assert.equal(calls.read,0);
  const linked=await request('/v1/connect',{method:'POST',cookie:ca,csrf:a.body.csrf,body:{apiKey:KEY,apiSecret:APISECRET,tradingEnabled:true}});assert.equal(linked.status,200);assert.equal(linked.body.account,'uid_101');assert.equal(calls.write,0);assert.equal(calls.read,1);assert.equal(JSON.stringify(linked.body).includes(APISECRET),false);
  assert.equal((await request('/v1/plans',{cookie:cb})).status,401);assert.equal((await request('/v1/prepare',{method:'POST',cookie:ca,csrf:b.body.csrf,body:{}})).status,403);
  const other=await request('/v1/connect',{method:'POST',cookie:cb,csrf:b.body.csrf,body:{apiKey:'other_key_12345678',apiSecret:APISECRET,tradingEnabled:true}});assert.equal(other.body.account,'uid_202');
  const crossed=await request('/v1/confirm',{method:'POST',cookie:cb,csrf:b.body.csrf,body:{id:'x',account:'uid_101',confirmed:true}});assert.equal(crossed.status,409);assert.equal(calls.write,0);
});

test('withdraw-enabled or IP-unrestricted key fails closed before persisting',async t=>{
  for(const field of ['enableWithdrawals','ipRestrict']){
    const {broker,directory}=fixture(t,{exchangeFactory:()=>({getAccountEvidence:async()=>({ok:true,data:{...evidence('101'),restriction:{...evidence('101').restriction,[field]:field==='enableWithdrawals'}}})})});
    await assert.rejects(()=>broker.connect({apiKey:KEY,apiSecret:APISECRET}),/permission_invalid/);const vault=new BinanceCloudVault({directory,masterKey:Buffer.alloc(32)});assert.deepEqual(vault.list(),[]);vault.close();
  }
});

test('durable unknown write is never resent; disconnect retains active strategy but deletes idle credentials',async t=>{
  const {broker,calls,directory,masterKey}=fixture(t);await broker.connect({apiKey:KEY,apiSecret:APISECRET});
  await broker.confirm('101',{id:'same_intent',account:'uid_101',confirmed:true});await broker.confirm('101',{id:'same_intent',account:'uid_101',confirmed:true});assert.equal(calls.write,1);
  const status=await broker.status('101');assert.equal(status.reconciliationRequired,true);assert.equal(status.canSubmit,false);
  assert.equal((await broker.disconnect('101')).activePlansContinue,true);const vault=new BinanceCloudVault({directory,masterKey});assert.deepEqual(vault.list(),['101']);vault.close();
  await broker.connect({apiKey:'other_key_12345678',apiSecret:APISECRET});assert.equal((await broker.disconnect('202')).activePlansContinue,false);
});

test('restart first pass masks automation before any new action and durable phase remains locked',async t=>{
  const {broker,calls,options}=fixture(t);await broker.connect({apiKey:KEY,apiSecret:APISECRET});await broker.confirm('101',{id:'unknown_restart',account:'uid_101',confirmed:true});await broker.close();
  const resumed=createBinanceCloudBroker(options);try{await resumed.tick();assert.equal(calls.write,1);assert.equal((await resumed.status('101')).reconciliationRequired,true);await resumed.confirm('101',{id:'unknown_restart',account:'uid_101',confirmed:true});assert.equal(calls.write,1);}finally{await resumed.close();}
});

test('restart recovery cannot execute a previously authorized transfer until after the read-only pass',async t=>{
  const {broker,calls,options,directory,masterKey}=fixture(t);await broker.connect({apiKey:KEY,apiSecret:APISECRET});await broker.confirm('101',{id:'pending_transfer',account:'uid_101',confirmed:true});await broker.close();
  const vault=new BinanceCloudVault({directory,masterKey}),journal=new ExecutionJournal(vault.journalPath('101')),plan=journal.get('pending_transfer');journal.update(plan.id,plan.version,{phase:'transfer_ready',automationPaused:false});journal.close();vault.close();
  const resumed=createBinanceCloudBroker(options);try{await resumed.tick();assert.equal(calls.recoveryWrites,0);assert.equal((await resumed.plans('101'))[0].automationPaused,false);await resumed.tick();assert.equal(calls.recoveryWrites,1);}finally{await resumed.close();}
});

test('query/body schema rejects unsupported transport; status includes stable UI guard fields',async t=>{
  const {broker}=fixture(t),request=await httpFixture(t,broker);assert.equal((await request('/v1/status?apiKey=never')).status,400);const r=await request('/v1/status');
  for(const field of ['brokerConfigured','csrf','connected','accountVerified','checkedAt','heartbeatAt','accountFeeVerified','canSubmit','cashCanSubmit','buyBTCCanSubmit','runnerOnline','autoSettleReady','reconciliationRequired','currency','environment','account','readOnlyKey','reason'])assert.ok(Object.hasOwn(r.body,field),field);
});

test('SQLite ownership excludes a second broker before vault/network, and close releases ownership',async t=>{
 const {broker,options,calls}=fixture(t),second=createBinanceCloudBroker(options);
 try{assert.equal((await second.status()).brokerConfigured,false);await assert.rejects(()=>second.connect({apiKey:KEY,apiSecret:APISECRET}),/broker_not_configured/);assert.equal(calls.read,0);}finally{await second.close();}
 await broker.close();const third=createBinanceCloudBroker(options);try{assert.equal((await third.status()).brokerConfigured,true);}finally{await third.close();}
});

test('wrong master key releases the exclusive directory lock after failing closed',async t=>{
 const {broker,options}=fixture(t);await broker.connect({apiKey:KEY,apiSecret:APISECRET});await broker.close();
 const wrong=createBinanceCloudBroker({...options,masterKey:randomBytes(32)});try{assert.equal((await wrong.status()).brokerConfigured,false);}finally{await wrong.close();}
 const correct=createBinanceCloudBroker(options);try{assert.equal((await correct.status()).brokerConfigured,true);}finally{await correct.close();}
});

function childOptions(options){return {directory:options.directory,masterKey:options.masterKey.toString('base64'),serviceConfigured:true,persistentConfirmed:true,fixedEgressIp:options.fixedEgressIp,egressConfirmed:true,liveEnabled:true};}
test('separate Node process cannot take a live lock or call any exchange method',async t=>{
 const {options}=fixture(t),module=new URL('./execution/binance-cloud-server.mjs',import.meta.url).href;
 const script=`import {createBinanceCloudBroker} from ${JSON.stringify(module)};let calls=0;const b=createBinanceCloudBroker({...${JSON.stringify(childOptions(options))},exchangeFactory:()=>{calls++;throw Error('must not call');}});const s=await b.status();try{await b.connect({apiKey:'public_key_12345678',apiSecret:'secret_key_12345678'});}catch{}console.log(JSON.stringify({configured:s.brokerConfigured,calls}));await b.close();`;
 const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',script],{windowsHide:true,timeout:10000});assert.deepEqual(JSON.parse(stdout.trim()),{configured:false,calls:0});
});

test('OS termination releases a different-process exclusive lock without a lease timeout',async t=>{
 const {broker,options}=fixture(t);await broker.close();const module=new URL('./execution/binance-cloud-server.mjs',import.meta.url).href;
 const script=`import {createBinanceCloudBroker} from ${JSON.stringify(module)};const b=createBinanceCloudBroker(${JSON.stringify(childOptions(options))});console.log(JSON.stringify(await b.status()));setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{windowsHide:true,stdio:['ignore','pipe','pipe']});let exited=false;child.once('close',()=>exited=true);
 try{let text='';await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('child timeout')),10000);child.once('error',reject);child.stdout.on('data',data=>{text+=data;if(text.includes('\n')){clearTimeout(timer);resolve();}});});assert.equal(JSON.parse(text.trim()).brokerConfigured,true);
  const blocked=createBinanceCloudBroker(options);try{assert.equal((await blocked.status()).brokerConfigured,false);}finally{await blocked.close();}
  const ended=once(child,'close');child.kill('SIGKILL');await ended;const resumed=createBinanceCloudBroker(options);try{assert.equal((await resumed.status()).brokerConfigured,true);}finally{await resumed.close();}
 }finally{if(!exited){const ended=once(child,'close');child.kill('SIGKILL');await ended;}}
});

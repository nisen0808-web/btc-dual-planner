import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomBytes} from 'node:crypto';
import {createBinanceCloudHttp} from './execution/binance-cloud-http.mjs';

const ORIGIN='https://btc-dual-planner-oct22.phyrex-ni.chatgpt.site',SECRET='test_service_secret_'+ 's'.repeat(43),COOKIE='__Host-btc_put_session',TTL=28800000;
const credentials=(key='test_key_for_101')=>({apiKey:key,apiSecret:'fake_secret_never_sent_outside_test',tradingEnabled:true});
const sessionCookie=response=>response.cookie.split(';')[0];
function signedCookie(issuedAt){const payload=Buffer.alloc(16);randomBytes(8).copy(payload);payload.writeBigUInt64BE(BigInt(issuedAt),8);const tag=createHmac('sha256',SECRET).update('binance-cloud-session-v1\0').update(payload).digest().subarray(0,16);return COOKIE+'='+Buffer.concat([payload,tag]).toString('base64url');}
function csrfFor(cookie){return createHmac('sha256',SECRET).update('binance-cloud-csrf-v1\0').update(cookie.split('=')[1]).digest('base64url');}
async function fixture(t,options={}){
  let time=1900000000000;const calls={connect:[],status:[],disconnect:[],plans:[],prepare:[]};
  const broker={
    status:async uid=>{calls.status.push(uid);return {connected:!!uid,account:uid?'uid_'+uid:null,canSubmit:!!uid};},
    connect:async(input,previousUid)=>{calls.connect.push({key:input.apiKey,previousUid});if(options.connect)return options.connect(input,previousUid);const uid=input.apiKey.endsWith('202')?'202':'101';return {uid,status:{connected:true,account:'uid_'+uid}};},
    disconnect:async uid=>{calls.disconnect.push(uid);return {activePlansContinue:false};},
    plans:async uid=>{calls.plans.push(uid);return [{account:'uid_'+uid}];},
    prepare:async(uid,input)=>{calls.prepare.push(uid);return {account:'uid_'+uid,...input};}
  };
  const transport=createBinanceCloudHttp({broker,serviceSecret:SECRET,siteOrigin:ORIGIN,now:()=>time,...options.http});
  await new Promise(resolve=>transport.server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{transport.server.close(resolve);transport.server.closeAllConnections();}));
  const request=async(path,{method='GET',cookie,csrf,body,secret=SECRET,origin=ORIGIN}={})=>{
    const response=await fetch('http://127.0.0.1:'+transport.server.address().port+'/v1/'+path,{method,headers:{Authorization:'Bearer '+secret,Origin:origin,'X-Forwarded-Proto':'https',...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    return {status:response.status,cookie:response.headers.get('set-cookie'),body:await response.json()};
  };
  const guest=async()=>{const response=await request('status');return {cookie:sessionCookie(response),csrf:response.body.csrf,response};};
  const connect=guest=>request('connect',{method:'POST',cookie:guest.cookie,csrf:guest.csrf,body:credentials()});
  return {...transport,request,guest,connect,calls,setTime:value=>time=value,advance:value=>time+=value,now:()=>time};
}

test('1000 anonymous status requests allocate no connected slots; normal verified connect still succeeds',async t=>{
  const f=await fixture(t,{http:{maxSessions:1}});
  for(let i=0;i<1000;i++){const response=await f.request('status');assert.equal(response.status,200);assert.equal(response.body.connected,false);assert.match(response.cookie,new RegExp('^'+COOKIE+'=[A-Za-z0-9_-]{43}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=28800$'));}
  assert.equal(f.calls.connect.length,0);const a=await f.guest();assert.equal((await f.connect(a)).status,200);assert.equal(f.calls.connect.length,1);
  assert.equal((await f.request('status',{cookie:a.cookie})).body.account,'uid_101');
  const b=await f.guest();assert.equal((await f.connect(b)).status,429);assert.equal(f.calls.connect.length,1);
});

test('forged, expired, future and duplicate signed cookies are rejected before broker calls',async t=>{
  const f=await fixture(t),a=await f.guest(),before=f.calls.status.length;
  const valid=a.cookie.split('=')[1],bytes=Buffer.from(valid,'base64url');bytes[0]^=1;
  for(const cookie of [COOKIE+'='+bytes.toString('base64url'),signedCookie(f.now()-TTL),signedCookie(f.now()+2001),a.cookie+'; '+a.cookie]){
    assert.equal((await f.request('status',{cookie})).status,401);
    assert.equal((await f.request('connect',{method:'POST',cookie,csrf:a.csrf,body:credentials()})).status,401);
  }
  assert.equal(f.calls.status.length,before);assert.equal(f.calls.connect.length,0);
  const within=signedCookie(f.now()+2000);assert.equal((await f.request('status',{cookie:within})).status,200);
  assert.equal((await f.request('connect',{method:'POST',cookie:a.cookie,csrf:'wrong_csrf',body:credentials()})).status,403);assert.equal(f.calls.connect.length,0);
});

test('verified sessions isolate UIDs; disconnecting one does not affect another',async t=>{
  const f=await fixture(t),a=await f.guest(),b=await f.guest();assert.equal(a.csrf,csrfFor(a.cookie));assert.notEqual(a.csrf,b.csrf);
  assert.equal((await f.connect(a)).status,200);
  assert.equal((await f.request('connect',{method:'POST',cookie:b.cookie,csrf:b.csrf,body:credentials('test_key_for_202')})).status,200);
  assert.equal((await f.request('plans',{cookie:a.cookie})).body.data[0].account,'uid_101');
  assert.equal((await f.request('plans',{cookie:b.cookie})).body.data[0].account,'uid_202');
  assert.equal((await f.request('prepare',{method:'POST',cookie:b.cookie,csrf:a.csrf,body:{}})).status,403);assert.equal(f.calls.prepare.length,0);
  assert.equal((await f.request('disconnect',{method:'POST',cookie:a.cookie,csrf:a.csrf,body:{}})).status,200);assert.deepEqual(f.calls.disconnect,['101']);
  assert.equal((await f.request('plans',{cookie:a.cookie})).status,401);assert.equal((await f.request('status',{cookie:a.cookie})).body.connected,false);
  assert.equal((await f.request('plans',{cookie:b.cookie})).body.data[0].account,'uid_202');
});

test('idle expiry and memory revocation turn a signed cookie back into an unprivileged guest',async t=>{
  const f=await fixture(t),a=await f.guest();await f.connect(a);f.advance(900001);
  assert.equal((await f.request('plans',{cookie:a.cookie})).status,401);assert.equal((await f.request('status',{cookie:a.cookie})).body.connected,false);
  await f.connect(a);f.revokeAll();assert.equal((await f.request('status',{cookie:a.cookie})).body.connected,false);assert.equal((await f.request('plans',{cookie:a.cookie})).status,401);
  await f.connect(a);f.advance(TTL);assert.equal((await f.request('plans',{cookie:a.cookie})).status,401);
});

test('a new transport with the same signing secret cannot recover an old cookie account',async t=>{
  const before=await fixture(t),a=await before.guest();await before.connect(a);assert.equal((await before.request('status',{cookie:a.cookie})).body.account,'uid_101');
  const restarted=await fixture(t);assert.equal((await restarted.request('status',{cookie:a.cookie})).body.connected,false);assert.equal((await restarted.request('plans',{cookie:a.cookie})).status,401);assert.deepEqual(restarted.calls.status,[null]);assert.equal(restarted.calls.connect.length,0);
});

test('pending anonymous connect is bounded before serialization; extra attempts make zero broker calls',async t=>{
  let release,started;const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>started=resolve);
  const f=await fixture(t,{connect:async()=>{started();await gate;return {uid:'101',status:{connected:true,account:'uid_101'}};}});
  const a=await f.guest(),b=await f.guest(),first=f.connect(a);await entered;
  try{for(let i=0;i<10;i++)assert.equal((await f.connect(b)).status,429);assert.equal(f.calls.connect.length,1);}finally{release();}
  assert.equal((await first).status,200);
});

test('global guest token bucket limits failed credential probes and refills without queuing them',async t=>{
  const f=await fixture(t,{connect:async()=>{throw Object.assign(Error('private credentials must never surface'),{code:'account_unverified'});}}),a=await f.guest();
  for(let i=0;i<4;i++){const response=await f.connect(a);assert.equal(response.status,409);assert.equal(JSON.stringify(response.body).includes('private credentials'),false);}
  assert.equal((await f.connect(a)).status,429);assert.equal(f.calls.connect.length,4);
  f.advance(2000);assert.equal((await f.connect(a)).status,409);assert.equal(f.calls.connect.length,5);
});

test('short or non-URL-safe service secrets never create guest cookies or call broker',async t=>{
  for(const serviceSecret of ['s'.repeat(42),'s'.repeat(43)+'+']){const f=await fixture(t,{http:{serviceSecret}}),response=await f.request('status',{secret:serviceSecret});assert.equal(response.status,403);assert.equal(response.cookie,null);assert.equal(f.calls.status.length,0);}
});

import http from 'node:http';
import {randomBytes,createHash,createHmac,timingSafeEqual} from 'node:crypto';

const COOKIE='__Host-btc_put_session',hash=value=>createHash('sha256').update(value).digest(),same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length<2048&&timingSafeEqual(hash(a),hash(b));
const error=(code,message)=>({ok:false,error:{code,message}});
const SESSION_TTL=28800000,IDLE_TTL=900000,COOKIE_CLEAR=COOKIE+'=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0';
async function readBody(req){
  if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw Object.assign(Error('请发送 JSON 请求。'),{code:'invalid_request'});
  let size=0,text='';const timer=setTimeout(()=>req.destroy(),5000);
  try{for await(const chunk of req){size+=chunk.length;if(size>16384)throw Error('body too large');text+=chunk;}const body=JSON.parse(text);if(!body||typeof body!=='object'||Array.isArray(body))throw Error('invalid body');return body;}finally{clearTimeout(timer);}
}
/** Private transport behind the same-origin Site proxy; never a public broker API. */
export function createBinanceCloudHttp({broker,serviceSecret,siteOrigin='https://btc-dual-planner-oct22.phyrex-ni.chatgpt.site',now=Date.now,maxSessions=1000,maxGuestConnects=1,guestConnectsPerMinute=30,guestConnectBurst=4}={}){
  if(!broker||new URL(siteOrigin).origin!==siteOrigin||!siteOrigin.startsWith('https://')||typeof now!=='function'||!Number.isSafeInteger(maxSessions)||maxSessions<1||!Number.isSafeInteger(maxGuestConnects)||maxGuestConnects<1||!Number.isFinite(guestConnectsPerMinute)||guestConnectsPerMinute<=0||!Number.isFinite(guestConnectBurst)||guestConnectBurst<1)throw Error('Invalid cloud HTTP configuration');
  const serviceReady=typeof serviceSecret==='string'&&/^[A-Za-z0-9_-]{43,128}$/.test(serviceSecret);
  const sessions=new Map();let queue=Promise.resolve(),guestConnects=0,bucket=guestConnectBurst,bucketAt=now();
  const serial=fn=>{const p=queue.then(fn,fn);queue=p.catch(()=>{});return p;};
  function reply(res,status,value,cookie){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer',...(cookie?{'set-cookie':cookie}:{})});res.end(JSON.stringify(value));}
  const denied=(res,status=403,code='unauthorized',message='请求未获授权。')=>reply(res,status,error(code,message));
  const mac=(label,value)=>createHmac('sha256',serviceSecret).update(label).update(value).digest();
  const csrfFor=token=>mac('binance-cloud-csrf-v1\0',token).toString('base64url');
  function mintToken(){const payload=Buffer.alloc(16);randomBytes(8).copy(payload);payload.writeBigUInt64BE(BigInt(now()),8);return Buffer.concat([payload,mac('binance-cloud-session-v1\0',payload).subarray(0,16)]).toString('base64url');}
  function tokenIssuedAt(token){
    if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))return null;
    const bytes=Buffer.from(token,'base64url');if(bytes.length!==32||bytes.toString('base64url')!==token||!timingSafeEqual(bytes.subarray(16),mac('binance-cloud-session-v1\0',bytes.subarray(0,16)).subarray(0,16)))return null;
    const stamp=bytes.readBigUInt64BE(8);if(stamp>BigInt(Number.MAX_SAFE_INTEGER))return null;const issuedAt=Number(stamp),time=now();return issuedAt>time+2000||issuedAt+SESSION_TTL<=time?null:issuedAt;
  }
  function cookieToken(header){
    if(header===undefined)return {token:null,invalid:false};if(typeof header!=='string'||header.length>8192)return {token:null,invalid:true};
    const matches=header.split(';').map(s=>s.trim()).filter(s=>s.startsWith(COOKIE+'='));if(!matches.length)return {token:null,invalid:false};
    const token=matches.length===1?matches[0].slice(COOKIE.length+1):null;return {token,invalid:tokenIssuedAt(token)===null};
  }
  function session(token){const key=token?hash(token).toString('hex'):null,row=key?sessions.get(key):null;if(!row||row.expiresAt<=now()||now()-row.lastUsed>IDLE_TTL){if(key)sessions.delete(key);return null;}row.lastUsed=now();return row;}
  function sweep(){const time=now();for(const [key,row]of sessions)if(row.expiresAt<=time||time-row.lastUsed>IDLE_TTL)sessions.delete(key);}
  function admitGuestConnect(){const time=now();bucket=Math.min(guestConnectBurst,bucket+Math.max(0,time-bucketAt)*guestConnectsPerMinute/60000);bucketAt=Math.max(bucketAt,time);if(guestConnects>=maxGuestConnects||bucket<1)return false;bucket--;guestConnects++;return true;}
  const server=http.createServer(async(req,res)=>{
    if(!serviceReady||!same(req.headers.authorization,'Bearer '+serviceSecret)||req.headers.origin!==siteOrigin||req.headers['x-forwarded-proto']!=='https')return denied(res);
    let url;try{url=new URL(req.url,'https://broker.invalid');}catch{return denied(res,400,'invalid_request','请求地址无效。');}
    if(url.search||url.hash)return denied(res,400,'invalid_request','不接受查询参数。');
    const action=({'GET /v1/status':'status','GET /v1/plans':'plans','POST /v1/connect':'connect','POST /v1/disconnect':'disconnect','POST /v1/prepare':'prepare','POST /v1/confirm':'confirm','POST /v1/pause':'pause'})[req.method+' '+url.pathname];
    if(!action)return denied(res,405,'method_not_allowed','接口或请求方法不受支持。');
    const parsed=cookieToken(req.headers.cookie);if(parsed.invalid)return reply(res,401,error('session_invalid','连接凭证无效或已过期，请重新连接。'),COOKIE_CLEAR);
    let token=parsed.token,row=session(token),setCookie,guestAdmitted=false;
    if(action==='status'&&!token){token=mintToken();setCookie=COOKIE+'='+token+'; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=28800';}
    if(!token)return denied(res,401,'session_expired','连接已过期，请重新连接。');
    const csrf=csrfFor(token);if(req.method==='POST'&&!same(req.headers['x-csrf-token'],csrf))return denied(res);
    try{
      const input=req.method==='POST'?await readBody(req):undefined;
      if(action==='connect'){
        if(Object.keys(input).some(k=>!['apiKey','apiSecret','tradingEnabled'].includes(k))||input.tradingEnabled!==true||typeof input.apiKey!=='string'||!/^[A-Za-z0-9_-]{8,256}$/.test(input.apiKey)||typeof input.apiSecret!=='string'||input.apiSecret.length<8||input.apiSecret.length>512||/[\r\n\0]/.test(input.apiSecret))return denied(res,400,'invalid_credentials','API 配置格式无效，且需本人明确启用交易连接。');
        row=session(token);if(!row){if(!admitGuestConnect())return denied(res,429,'connect_limit','账户核验繁忙，请稍后重试。');guestAdmitted=true;}
      }
      return await serial(async()=>{
        if(tokenIssuedAt(token)===null)return reply(res,401,error('session_expired','连接已过期。'),COOKIE_CLEAR);row=session(token);
        if(action==='status')return reply(res,200,{ok:true,...await broker.status(row?.uid??null),csrf},setCookie);
        if(action==='connect'){
          sweep();if(!row&&sessions.size>=maxSessions)return denied(res,429,'session_limit','连接过多，请稍后重试。');
          const result=await broker.connect(input,row?.uid??null);if(typeof result?.uid!=='string'||!/^\d{1,30}$/.test(result.uid))throw Error('Unverified account');
          const issuedAt=tokenIssuedAt(token);if(issuedAt===null)return reply(res,401,error('session_expired','连接已过期。'),COOKIE_CLEAR);
          // Only a successfully verified account owns an in-memory session.
          sessions.set(hash(token).toString('hex'),{uid:result.uid,expiresAt:issuedAt+SESSION_TTL,lastUsed:now()});return reply(res,200,{ok:true,...result.status,csrf});
        }
        if(action==='disconnect'){
          if(Object.keys(input).length)return denied(res,400,'invalid_request','断开请求不接受额外字段。');
          const result=row?.uid?await broker.disconnect(row.uid):{activePlansContinue:false};sessions.delete(hash(token).toString('hex'));return reply(res,200,{ok:true,disconnected:true,...result},COOKIE_CLEAR);
        }
        if(!row?.uid)return denied(res,401,'not_connected','请先连接并核验 Binance 账户。');
        const data=await broker[action](row.uid,input);return reply(res,200,{ok:true,data});
      });
    }catch(e){return denied(res,409,/^[a-z_]{1,64}$/.test(e?.code||'')?e.code:'operation_unavailable',typeof e?.publicMessage==='string'?e.publicMessage:'账户、报价或执行证据尚未完整核验，操作已停止。');}finally{if(guestAdmitted)guestConnects--;}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;return {server,revokeAll:()=>sessions.clear()};
}

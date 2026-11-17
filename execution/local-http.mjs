import http from 'node:http';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {readFileSync} from 'node:fs';

const TRUSTED_SITE='https://btc-dual-planner-oct22.phyrex-ni.chatgpt.site';
const digest=value=>createHash('sha256').update(value).digest();
const same=(a,b)=>typeof a==='string'&&a.length<2048&&timingSafeEqual(digest(a),digest(b));
async function body(req){
  if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw Error('invalid request');
  let size=0,text='';const timer=setTimeout(()=>req.destroy(),5000);
  try{for await(const chunk of req){size+=chunk.length;if(size>16384)throw Error('invalid request');text+=chunk;}return JSON.parse(text);}finally{clearTimeout(timer);}
}

/** Only a loopback socket may expose this server. Pairing happens on the local page,
 * independently of exchange credentials. The remote Site never receives those keys. */
export function createLocalExecutionHttp({serviceProvider,configure,setupStatus=()=>({configured:false}),siteOrigin=TRUSTED_SITE,port=8788,now=Date.now,setupTemplate}={}){
  if(new URL(siteOrigin).origin!==siteOrigin||!siteOrigin.startsWith('https://')||!Number.isInteger(port)||port<1||port>65535||typeof serviceProvider!=='function'||typeof configure!=='function')throw Error('Invalid loopback configuration');
  const localOrigin='http://127.0.0.1:'+port,nonce=randomBytes(32).toString('base64url'),sessions=new Map();let queue=Promise.resolve();
  const run=task=>{const next=queue.then(task,task);queue=next.catch(()=>{});return next;};
  const template=setupTemplate??readFileSync(new URL('./local-setup.html',import.meta.url),'utf8');
  const html=template.replaceAll('__NONCE__',nonce).replaceAll('__SITE_ORIGIN__',siteOrigin);
  function validSession(token,touch=false){
    const row=sessions.get(digest(token).toString('hex'));
    if(!row||row.expiresAt<=now()||now()-row.lastUsed>=900000)return false;
    if(touch)row.lastUsed=now();return true;
  }
  function reply(res,status,data,origin,contentType='application/json; charset=utf-8'){
    const headers={'content-type':contentType,'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','x-frame-options':'DENY',Vary:'Origin'};
    if(origin===siteOrigin)Object.assign(headers,{'access-control-allow-origin':siteOrigin,'access-control-allow-methods':'GET, POST, OPTIONS','access-control-allow-headers':'authorization, content-type, x-strategy-local','access-control-allow-private-network':'true'});
    if(contentType.startsWith('text/html'))headers['content-security-policy']="default-src 'none'; script-src 'nonce-"+nonce+"'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
    res.writeHead(status,headers);res.end(typeof data==='string'?data:JSON.stringify(data));
  }
  const unavailable=(res,status=403,origin)=>reply(res,status,{status:'unavailable',reason:'本机执行请求尚未授权或未通过核验。'},origin);
  const server=http.createServer(async(req,res)=>{
    const remote=req.socket.remoteAddress;
    if(!['127.0.0.1','::ffff:127.0.0.1'].includes(remote)||req.headers.host!=='127.0.0.1:'+port)return unavailable(res);
    const origin=req.headers.origin;let path;try{const url=new URL(req.url,localOrigin);if(url.search)throw Error('query');path=url.pathname;}catch{return unavailable(res,400);}
    if(req.method==='GET'&&path==='/health')return reply(res,200,{service:'deribit-local-execution'});
    if(req.method==='GET'&&(path==='/setup'||path==='/connect')){
      if(origin&&origin!==localOrigin&&origin!==siteOrigin)return unavailable(res);
      return reply(res,200,html,null,'text/html; charset=utf-8');
    }
    if(path.startsWith('/local/')){
      if((req.method==='GET'?origin&&origin!==localOrigin:origin!==localOrigin)||!same(req.headers['x-local-csrf'],nonce))return unavailable(res);
      try{
        if(req.method==='GET'&&path==='/local/status')return reply(res,200,await setupStatus());
        if(req.method==='POST'&&path==='/local/configure'){
          const input=await body(req);
          if(!input||Object.keys(input).some(k=>!['clientId','clientSecret','environment','tradingEnabled'].includes(k))||!['testnet','mainnet'].includes(input.environment)||typeof input.tradingEnabled!=='boolean'||typeof input.clientId!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(input.clientId)||typeof input.clientSecret!=='string'||input.clientSecret.length<8||input.clientSecret.length>512||/[\r\n\0]/.test(input.clientSecret))return unavailable(res,400);
          return await run(async()=>{sessions.clear();const result=await configure(input);return reply(res,200,result);});
        }
        if(req.method==='POST'&&path==='/local/pair'){
          await body(req);for(const [key,value] of sessions)if(value.expiresAt<=now()||now()-value.lastUsed>=900000)sessions.delete(key);
          if(sessions.size>=8)return unavailable(res,429);
          const token=randomBytes(32).toString('base64url'),expiresAt=now()+8*60*60*1000;sessions.set(digest(token).toString('hex'),{expiresAt,lastUsed:now()});
          return reply(res,200,{token,expiresAt,siteOrigin});
        }
        if(req.method==='POST'&&path==='/local/revoke'){await body(req);sessions.clear();return reply(res,200,{revoked:true});}
      }catch{return unavailable(res,409);}
      return unavailable(res,404);
    }
    if(origin!==siteOrigin)return unavailable(res);
    if(req.method==='OPTIONS'){
      const method=req.headers['access-control-request-method'],headers=(req.headers['access-control-request-headers']||'').toLowerCase().split(',').map(x=>x.trim()).filter(Boolean);
      if(!['GET','POST'].includes(method)||headers.some(x=>!['authorization','content-type','x-strategy-local'].includes(x)))return unavailable(res);
      return reply(res,204,'',origin);
    }
    if(req.headers['x-strategy-local']!=='deribit-v1'||typeof req.headers.authorization!=='string'||!req.headers.authorization.startsWith('Bearer '))return unavailable(res,403,origin);
    if(!validSession(req.headers.authorization.slice(7)))return unavailable(res,401,origin);
    const routes={'GET /v1/status':'status','GET /v1/plans':'list','POST /v1/prepare':'prepare','POST /v1/confirm':'confirm','POST /v1/pause':'pause'};
    const action=routes[req.method+' '+path];if(!action)return unavailable(res,404,origin);
    try{
      const input=req.method==='POST'?await body(req):undefined;
      return await run(async()=>{
        if(!validSession(req.headers.authorization.slice(7),true))return unavailable(res,401,origin);
        const service=serviceProvider();if(!service)return reply(res,200,{status:'not_configured',platform:'deribit',currency:'USDC',canSubmit:false,runnerOnline:true,accountVerified:false,reason:'请先在本机设置页连接账户。'},origin);
        const result=await service[action](input);return reply(res,200,result,origin);
      });
    }catch{return unavailable(res,409,origin);}
  });
  return {server,localOrigin,revoke:()=>sessions.clear()};
}

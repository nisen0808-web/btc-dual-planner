import http from 'node:http';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {readFileSync} from 'node:fs';

const SITE='https://btc-dual-planner-oct22.phyrex-ni.chatgpt.site';
const hash=value=>createHash('sha256').update(value).digest();
const same=(a,b)=>typeof a==='string'&&a.length<2048&&timingSafeEqual(hash(a),hash(b));
const SYMBOL=/^BTC-\d{6}-\d+(?:\.\d+)?-P$/;
async function body(req){
  if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw Error('Invalid content type');
  let size=0,text='';const timer=setTimeout(()=>req.destroy(),5000);
  try{for await(const chunk of req){size+=chunk.length;if(size>16384)throw Error('Invalid size');text+=chunk;}return JSON.parse(text);}finally{clearTimeout(timer);}
}

/** A separate loopback service, session and encrypted account for Binance. */
export function createBinanceLocalExecutionHttp({serviceProvider,configure,setupStatus=()=>({configured:false}),publicReader,siteOrigin=SITE,port=8789,now=Date.now,setupTemplate}={}){
  if(new URL(siteOrigin).origin!==siteOrigin||!siteOrigin.startsWith('https://')||!Number.isInteger(port)||port<1||port>65535||typeof serviceProvider!=='function'||typeof configure!=='function')throw Error('Invalid Binance loopback configuration');
  const localOrigin='http://127.0.0.1:'+port,nonce=randomBytes(32).toString('base64url'),sessions=new Map();let queue=Promise.resolve();
  const run=task=>{const next=queue.then(task,task);queue=next.catch(()=>{});return next;};
  const template=setupTemplate??readFileSync(new URL('./binance-local-setup.html',import.meta.url),'utf8');
  const html=template.replaceAll('__NONCE__',nonce).replaceAll('__SITE_ORIGIN__',siteOrigin);
  function sessionValid(token,touch=false){
    const row=sessions.get(hash(token).toString('hex'));
    if(!row||row.expiresAt<=now()||now()-row.lastUsed>=900000)return false;
    if(touch)row.lastUsed=now();return true;
  }
  function reply(res,status,data,origin,type='application/json; charset=utf-8'){
    const headers={'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','x-frame-options':'DENY',Vary:'Origin'};
    if(origin===siteOrigin)Object.assign(headers,{'access-control-allow-origin':siteOrigin,'access-control-allow-methods':'GET, POST, OPTIONS','access-control-allow-headers':'authorization, content-type, x-strategy-local','access-control-allow-private-network':'true'});
    if(type.startsWith('text/html'))headers['content-security-policy']="default-src 'none'; script-src 'nonce-"+nonce+"'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
    res.writeHead(status,headers);res.end(typeof data==='string'?data:JSON.stringify(data));
  }
  const deny=(res,status=403,origin)=>reply(res,status,{status:'unavailable',reason:'Binance 本机请求未获授权或尚未通过核验。'},origin);
  const server=http.createServer(async(req,res)=>{
    if(!['127.0.0.1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||req.headers.host!=='127.0.0.1:'+port)return deny(res);
    const origin=req.headers.origin;let url;try{url=new URL(req.url,localOrigin);}catch{return deny(res,400);}
    const path=url.pathname;
    if(req.method==='GET'&&path==='/health'&&!url.search)return reply(res,200,{service:'binance-local-execution'});
    if(req.method==='GET'&&['/setup','/connect'].includes(path)&&!url.search){
      if(origin&&![localOrigin,siteOrigin].includes(origin))return deny(res);
      return reply(res,200,html,null,'text/html; charset=utf-8');
    }
    if(path.startsWith('/public/binance-options/')){
      if(origin!==siteOrigin)return deny(res);
      if(req.method==='OPTIONS'){
        const requested=req.headers['access-control-request-method'],headers=(req.headers['access-control-request-headers']||'').trim();
        return requested==='GET'&&!headers?reply(res,204,'',origin):deny(res,403,origin);
      }
      if(req.method!=='GET'||typeof publicReader!=='function')return deny(res,405,origin);
      const action=path.slice('/public/binance-options/'.length),keys=[...url.searchParams.keys()];
      if(action==='market'&&keys.length||action==='book'&&(keys.length!==1||keys[0]!=='symbol'||!SYMBOL.test(url.searchParams.get('symbol')||''))||!['market','book'].includes(action))return deny(res,400,origin);
      try{return reply(res,200,await publicReader(action,url.searchParams.get('symbol')),origin);}catch{return reply(res,502,{status:'unavailable',reason:'本机 Binance 匿名公开行情暂不可用。'},origin);}
    }
    if(url.search)return deny(res,400,origin);
    if(path.startsWith('/local/')){
      if((req.method==='GET'?origin&&origin!==localOrigin:origin!==localOrigin)||!same(req.headers['x-local-csrf'],nonce))return deny(res);
      try{
        if(req.method==='GET'&&path==='/local/status')return reply(res,200,await setupStatus());
        if(req.method==='POST'&&path==='/local/configure'){
          const input=await body(req);
          if(!input||Object.keys(input).some(k=>!['apiKey','apiSecret','environment','tradingEnabled'].includes(k))||input.environment!=='mainnet'||typeof input.tradingEnabled!=='boolean'||typeof input.apiKey!=='string'||!/^[A-Za-z0-9_-]{8,256}$/.test(input.apiKey)||typeof input.apiSecret!=='string'||input.apiSecret.length<8||input.apiSecret.length>512||/[\r\n\0]/.test(input.apiSecret))return deny(res,400);
          return await run(async()=>{sessions.clear();return reply(res,200,await configure(input));});
        }
        if(req.method==='POST'&&path==='/local/pair'){
          const input=await body(req);if(!input||Object.keys(input).length)return deny(res,400);
          for(const [key,value]of sessions)if(value.expiresAt<=now()||now()-value.lastUsed>=900000)sessions.delete(key);
          if(sessions.size>=8)return deny(res,429);
          const token=randomBytes(32).toString('base64url'),expiresAt=now()+28800000;sessions.set(hash(token).toString('hex'),{expiresAt,lastUsed:now()});
          return reply(res,200,{token,expiresAt,siteOrigin});
        }
        if(req.method==='POST'&&path==='/local/revoke'){await body(req);sessions.clear();return reply(res,200,{revoked:true});}
      }catch{return deny(res,409);}
      return deny(res,404);
    }
    if(origin!==siteOrigin)return deny(res);
    if(req.method==='OPTIONS'){
      const method=req.headers['access-control-request-method'],headers=(req.headers['access-control-request-headers']||'').toLowerCase().split(',').map(x=>x.trim()).filter(Boolean);
      if(!['GET','POST'].includes(method)||headers.some(x=>!['authorization','content-type','x-strategy-local'].includes(x)))return deny(res,403,origin);
      return reply(res,204,'',origin);
    }
    if(req.headers['x-strategy-local']!=='binance-v1'||typeof req.headers.authorization!=='string'||!req.headers.authorization.startsWith('Bearer '))return deny(res,403,origin);
    const token=req.headers.authorization.slice(7);if(!sessionValid(token))return deny(res,401,origin);
    const action=({'GET /v1/status':'status','GET /v1/plans':'list','POST /v1/prepare':'prepare','POST /v1/confirm':'confirm','POST /v1/pause':'pause'})[req.method+' '+path];
    if(!action)return deny(res,404,origin);
    try{
      const input=req.method==='POST'?await body(req):undefined;
      return await run(async()=>{
        if(!sessionValid(token,true))return deny(res,401,origin);
        const service=serviceProvider();if(!service)return reply(res,200,{status:'not_configured',platform:'binance',currency:'USDT',environment:'mainnet',canSubmit:false,runnerOnline:true,accountVerified:false,reason:'请先在本机连接 Binance 账户并核验交易权限。'},origin);
        return reply(res,200,await service[action](input),origin);
      });
    }catch{return deny(res,409,origin);}
  });
  return {server,localOrigin,revoke:()=>sessions.clear()};
}

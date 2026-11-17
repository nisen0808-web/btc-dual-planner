import http from 'node:http';
import {createHmac,timingSafeEqual} from 'node:crypto';

function authorized(value,token){
  if(typeof value!=='string'||value.length>1024)return false;
  const digest=text=>createHmac('sha256',token).update(text).digest();
  return timingSafeEqual(digest(value),digest('Bearer '+token));
}
const reply=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(body));};
async function jsonBody(req){
  if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw Error('body');
  let size=0,text='';
  const timer=setTimeout(()=>req.destroy(),5000);
  try{for await(const chunk of req){size+=chunk.length;if(size>16384)throw Error('body');text+=chunk;}return JSON.parse(text);}finally{clearTimeout(timer);}
}

/** Server-to-server only. The owner-private Site holds the gateway token; no browser CORS access. */
export function createExecutionHttp({service,token,siteOrigin}){
  if(typeof token!=='string'||token.length<32||token.length>512||new URL(siteOrigin).origin!==siteOrigin||!siteOrigin.startsWith('https://'))throw Error('Execution gateway authorization is not configured');
  return http.createServer(async(req,res)=>{
    if(!authorized(req.headers.authorization,token)||req.headers['x-strategy-site']!==siteOrigin)return reply(res,403,{status:'unavailable',reason:'执行服务访问未获授权。'});
    let path;try{path=new URL(req.url,'http://localhost').pathname;}catch{return reply(res,400,{status:'unavailable',reason:'执行请求无效。'});}
    const routes={
      'GET /v1/status':()=>service.status(),
      'GET /v1/plans':()=>service.list(),
      'POST /v1/prepare':async()=>service.prepare(await jsonBody(req)),
      'POST /v1/confirm':async()=>service.confirm(await jsonBody(req)),
      'POST /v1/pause':async()=>service.pause(await jsonBody(req)),
    };
    const route=routes[req.method+' '+path];if(!route)return reply(res,404,{status:'unavailable',reason:'执行接口不存在。'});
    try{return reply(res,200,await route());}catch{return reply(res,409,{status:'unavailable',reason:'执行请求未通过核验；请刷新账户与委托状态后再检查。'});}
  });
}

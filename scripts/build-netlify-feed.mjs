import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const output=resolve(root,'dist-netlify');
const readers=await Promise.all(['worker/binance.js','worker/binance-options.js'].map(path=>readFile(resolve(root,path),'utf8')));
const runtime=String.raw`
import {createHash,timingSafeEqual} from 'node:crypto';
const NETLIFY_FEED_LIMIT=4*1024*1024;
const quoteHash=value=>createHash('sha256').update(value).digest();
export const config={path:['/health','/market','/book','/dual']};
export function createCloudQuoteHandler({optionsReader,dualReader,token=process.env.QUOTE_READ_TOKEN}={}){
 if(typeof token!=='string'||!token.trim())throw Error('QUOTE_READ_TOKEN is required');
 const expected=quoteHash(token),options=optionsReader||createBinanceOptionsReader(),dual=dualReader||createBinanceReader();
 const stopped={options:0,dual:0};let active=0;
 function reply(status,value,extra={}){
  let body;
  try{body=JSON.stringify(value);}catch{status=503;body='{"status":"unavailable","reason":"Quote response is invalid.","time":0,"receivedAt":0}';}
  if(typeof body!=='string'||Buffer.byteLength(body)>NETLIFY_FEED_LIMIT){status=503;body='{"status":"unavailable","reason":"Quote response exceeded the size limit.","time":0,"receivedAt":0}';}
  return new Response(body,{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...extra}});
 }
 const blocked=value=>{
  const code=Number(value?.upstreamStatus||value?.httpStatus);
  if(code===403||code===451)return code;
  const match=String(value?.reason||value?.message||'').match(/\b(403|451)\b/);
  return match?Number(match[1]):0;
 };
 const unavailable=source=>({status:'unavailable',reason:stopped[source]?'Binance source stopped after HTTP '+stopped[source]+'. No alternate host or automatic retry is used.':'Public quote source is unavailable.',...(stopped[source]?{upstreamStatus:stopped[source]}:{}),time:0,receivedAt:0});
 return async function quoteHandler(request){
  if(request.method!=='GET')return reply(405,{status:'unavailable',reason:'GET only.'},{allow:'GET'});
  let url;try{url=new URL(request.url);}catch{return reply(400,{status:'unavailable',reason:'Invalid request.'});}
  const route=url.pathname,keys=[...url.searchParams.keys()];
  if(url.username||url.password||url.hash||!['http:','https:'].includes(url.protocol))return reply(400,{status:'unavailable',reason:'Invalid request.'});
  if(!['/health','/market','/book','/dual'].includes(route))return reply(404,{status:'unavailable',reason:'Unknown route.'});
  if((route!=='/book'&&keys.length)||(route==='/book'&&(keys.length!==1||keys[0]!=='symbol'||!bnoSymbol(url.searchParams.get('symbol')))))return reply(400,{status:'unavailable',reason:'Invalid quote parameters.'});
  if(['cookie','x-mbx-apikey','x-api-key','proxy-authorization'].some(name=>request.headers.has(name))||request.body!==null)return reply(400,{status:'unavailable',reason:'Credentials and request bodies are not accepted.'});
  if(route==='/health')return reply(200,{serviceReady:true});
  const authorization=request.headers.get('authorization');
  if(typeof authorization!=='string'||authorization.length>4096||!authorization.startsWith('Bearer ')||!timingSafeEqual(expected,quoteHash(authorization.slice(7))))return reply(401,{status:'unavailable',reason:'Unauthorized.'},{'www-authenticate':'Bearer'});
  const source=route==='/dual'?'dual':'options';
  if(stopped[source])return reply(503,unavailable(source));
  if(active>=4)return reply(503,{status:'unavailable',reason:'Quote service is busy.',time:0,receivedAt:0});
  active++;
  try{
   // Only fixed public reader methods are used; inbound headers and account keys never enter them.
   const value=route==='/market'?await options.loadMarket():route==='/book'?await options.loadBook(url.searchParams.get('symbol')):await dual({});
   const code=blocked(value);if(code)stopped[source]=code;
   if(stopped[source]||value?.status!=='ready')return reply(503,unavailable(source));
   return reply(200,value);
  }catch(error){const code=blocked(error);if(code)stopped[source]=code;return reply(503,unavailable(source));}
  finally{active--;}
 };
}
let defaultHandler;
export default async function handler(request){
 if(!defaultHandler){
  try{defaultHandler=createCloudQuoteHandler();}
  catch{return Response.json({serviceReady:false,status:'unavailable',reason:'Quote service is not configured.'},{status:503,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});}
 }
 return defaultHandler(request);
}
`;
await mkdir(resolve(output,'netlify/functions'),{recursive:true});
await mkdir(resolve(output,'public'),{recursive:true});
await writeFile(resolve(output,'netlify/functions/quotes.mjs'),'// Generated from the current public Binance readers. Node.js 22+.\n'+readers.join('\n')+'\n'+runtime);
await writeFile(resolve(output,'netlify.toml'),'[build]\n  publish = "public"\n  functions = "netlify/functions"\n\n[build.environment]\n  NODE_VERSION = "22"\n');
await writeFile(resolve(output,'public/index.html'),'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>只读报价服务</title><p>仅供已授权服务读取 Binance 公开报价；不连接账户，不执行交易。</p></html>\n');
await writeFile(resolve(output,'README.md'),`# Netlify 只读报价服务\n\n这是待验证的部署包，尚未部署，也不保证 Binance 允许此云端出口取数。\n\n- 用户仍须本人登录 Netlify 并决定是否部署。本脚本不创建账号或资源。\n- 使用 Node.js 22。将本目录作为 Netlify 项目根目录，配置仅 Functions 可见的服务器环境变量 QUOTE_READ_TOKEN；不要写进仓库或网页。无 Binance 账户 Key，不登录 Binance，不含 RFQ、账户或交易接口。\n- Free 方案为每月 300 credits 硬上限；流量、请求与计算等共同消耗，耗尽会暂停服务。上线前核对账户的现行套餐条款和余量，不能承诺无限免费或持续可用。\n- 本包不设置 region。Free 默认 Ohio；只有 Pro/Enterprise 可更改 Functions region，不能承诺 Binance 读取成功。\n- GET /health 匿名仅返回 serviceReady，不表示 Binance 上游可用。GET /market、/book?symbol=真实BTC-PUT合约、/dual 均需 Authorization: Bearer <QUOTE_READ_TOKEN>。只允许固定参数；不能转发账户凭据或任意 URL。\n- 上线前分别验证真实期权 exchangeInfo/index、所选合约完整深度、普通双币 APR 三类数据和原始时间戳。健康检查成功不能代替这些验证。不得用 mark price、零盘口、普通双币或模拟数据填补缺失来源/RFQ。\n- 两个 worker reader 保留原始校验、时间戳与深度语义，服务不续命、不增加深度或覆盖来源；过期或读取失败应保持不可用。响应最多 4MB，最多四个并发报价。\n- 403/451 会停止当前实例中对应的数据源并返回 503，另一个源不受影响。serverless 冷启动会新建实例，因此实例内闩锁不是跨实例的永久禁用；不得据此自动切主机、地区、IP或循环重试。需先解决来源授权或访问限制，再由用户决定恢复。\n\n本地验证：在源码仓库运行 node --test netlify-feed-tests.mjs。测试仅用 mock，不访问外网。\n`);
console.log('Built dist-netlify read-only Functions bundle');

import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const output=resolve(root,'dist-netlify-dual');
const original=await readFile(resolve(root,'worker/binance.js'),'utf8');
if(!original.includes('export function createBinanceReader()'))throw Error('The current ordinary dual reader export changed.');
const source=original.match(/const publicSource='([^']+)';/)?.[1];
if(!source||!source.startsWith('https://www.binance.com/bapi/earn/'))throw Error('The fixed ordinary dual source is missing.');
const reader=original.replace('export function createBinanceReader()','function createBinanceReader()');

const runtime=String.raw`
// Generated from the complete current ordinary-dual reader. No account configuration is read.
const PUBLIC_SOURCE=__PUBLIC_SOURCE__;
const LIMIT=4*1024*1024,TTL=30000,FUTURE_SKEW=2000,TOTAL_READ_MS=15000;
const RETRYABLE_PAGINATION=new Set(['Binance 产品列表在分页期间发生变化，请刷新后重新读取。','Binance 产品分页存在重复条目，未使用不完整报价。','Binance 产品分页不完整，未使用部分报价。']);
const encoder=new TextEncoder();
export const config={path:['/dual','/health']};

export function createAnonymousDualHandler({fetchImpl=(...args)=>globalThis.fetch(...args),now=()=>globalThis.Date.now()}={}){
 const Date={now,parse:globalThis.Date.parse};
 let stopped=0,pending=null,bytes=0,fetchIssue='',failureCache=null,activeRead=null,partialSnapshot=null;
 const unavailable=reason=>({status:'unavailable',reason,source:PUBLIC_SOURCE,sourceType:'public_web',serverTime:0,fetchedAt:0});
 const stoppedValue=()=>({...unavailable('Binance 公开双币来源返回 HTTP '+stopped+'，当前实例已停止读取，不切换主机或自动重试。'),upstreamStatus:stopped,sourceStopped:true});
 function reply(status,value,headers={}){
  let body=JSON.stringify(value);
  if(encoder.encode(body).byteLength>LIMIT){status=503;body=JSON.stringify(unavailable('公开双币响应超过 4MB 上限，未提供部分数据。'));}
  return new Response(body,{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','access-control-allow-origin':'*','x-quote-reader':'changing-catalogue-v1',...headers}});
 }
 // Lexical fetch is the only transport available to the embedded reader.
 // The incoming Request, headers, environment and URL never enter it.
 function checkDeadline(budget){
  if(!budget||budget.controller.signal.aborted||now()-budget.startedAt>=TOTAL_READ_MS){
   if(budget&&!budget.controller.signal.aborted)budget.controller.abort();
   fetchIssue='读取 Binance 产品列表超时，请稍后刷新。';
   const error=Error(fetchIssue);error.name='TimeoutError';throw error;
  }
 }
 async function fetch(input,options={}){
  if(stopped)throw Error('Public source stopped.');
  const budget=activeRead;checkDeadline(budget);
  const prefix=PUBLIC_SOURCE+'&pageIndex=';
  const suffix=typeof input==='string'&&input.startsWith(prefix)?input.slice(prefix.length):'';
  if(!/^(?:[1-9]|1[0-9]|20)$/.test(suffix)||input!==prefix+suffix||options.method!=='GET')throw Error('Only the fixed public ordinary-dual source is allowed.');
  const response=await Promise.race([fetchImpl(input,{method:'GET',credentials:'omit',redirect:'manual',cache:'no-store',signal:budget.controller.signal,headers:{clienttype:'web',lang:'en',Accept:'application/json','User-Agent':'BTCStrategyStudio/1.0 (+https://btc-dual-planner-oct22.phyrex-ni.chatgpt.site)'}}),budget.deadline]);
  if(response.status===403||response.status===451)stopped=response.status;
  const date=response.headers.get('date');
  if(response.status!==200){await response.body?.cancel().catch(()=>{});return new Response(null,{status:response.status,headers:date?{date}:{}});}
  checkDeadline(budget);
  const declared=response.headers.get('content-length');
  if(declared&&Number(declared)>LIMIT-bytes){
   fetchIssue='公开双币分页响应超过累计 4MB 上限，未提供部分数据。';
   await response.body?.cancel().catch(()=>{});throw Error(fetchIssue);
  }
  const stream=response.body?.getReader();
  if(!stream){fetchIssue='Binance 未返回公开产品数据。';throw Error(fetchIssue);}
  const decoder=new TextDecoder();let text='';
  try{
   for(;;){
    checkDeadline(budget);
    const chunk=await Promise.race([stream.read(),budget.deadline]);checkDeadline(budget);if(chunk.done)break;
    bytes+=chunk.value.byteLength;
    if(bytes>LIMIT){fetchIssue='公开双币分页响应超过累计 4MB 上限，未提供部分数据。';await stream.cancel();throw Error(fetchIssue);}
    text+=decoder.decode(chunk.value,{stream:true});
   }
   text+=decoder.decode();checkDeadline(budget);
  }finally{stream.releaseLock();}
  return new Response(text,{status:200,headers:{'content-type':'application/json',...(date?{date}:{})}});
 }

 /* CURRENT_ORDINARY_READER */

 const read=createBinanceReader();
 function verify(value){
  if(value?.status!=='ready')return value;
  const time=now(),fresh=t=>Number.isSafeInteger(t)&&t>0&&t<=time+FUTURE_SKEW&&time-t<TTL;
  if(![value.serverTime,value.lastServerTime,value.fetchedAt,value.completedAt].every(fresh)||value.fetchedAt>value.completedAt||value.serverTime>value.lastServerTime||value.serverTime<value.fetchedAt-FUTURE_SKEW||value.lastServerTime>value.completedAt+FUTURE_SKEW)return unavailable('Binance 公开双币原始时间无效或已超过 30 秒，停止提供收益比较。');
  const partial=value.catalogueComplete===false;
  const pagesValid=partial?value.total>0&&value.coverageReason==='changing_catalogue'&&Number.isSafeInteger(value.pageCount)&&value.pageCount>=1&&value.pageCount<=20&&value.total<=value.pageCount*100&&Array.isArray(value.reportedTotals)&&value.reportedTotals.length===value.pageCount&&value.reportedTotals.every(n=>Number.isSafeInteger(n)&&n>=0&&n<=2000)&&Number.isSafeInteger(value.rejectedConflictCount)&&value.rejectedConflictCount>=0&&value.rejectedConflictCount<=2000:(value.catalogueComplete==null||value.catalogueComplete===true)&&value.pageCount===Math.max(1,Math.ceil(value.total/100));
  if(value.source!==PUBLIC_SOURCE||value.sourceType!=='public_web'||!Array.isArray(value.items)||value.items.length!==value.total||!Number.isSafeInteger(value.total)||value.total<0||value.total>2000||!pagesValid||value.eligibility?.precisionKnown!==false||value.eligibility?.purchaseWindowKnown!==false||value.eligibility?.accountEligibilityVerified!==false)return unavailable('Binance 公开双币列表或覆盖范围标识无效，未提供数据。');
  return value;
 }
 async function load(){
  if(stopped)return stoppedValue();
  if(partialSnapshot){
   const age=now()-partialSnapshot.completedAt;
   if(age>=0&&age<10000){const current=verify(partialSnapshot);if(current.status==='ready')return current;}
   partialSnapshot=null;
  }
  if(failureCache&&now()<failureCache.until)return failureCache.value;
  if(pending)return pending;
  const task=(async()=>{
   bytes=0;fetchIssue='';
   const budget={startedAt:now(),controller:new AbortController(),timer:null,deadline:null};
   budget.deadline=new Promise((_,reject)=>{budget.timer=setTimeout(()=>{budget.controller.abort();const error=Error('读取 Binance 产品列表超时，请稍后刷新。');error.name='TimeoutError';fetchIssue=error.message;reject(error);},TOTAL_READ_MS);});
   activeRead=budget;
   try{
    // Only these exact full-batch consistency failures permit one fresh walk.
    // Both batches share one deadline, AbortSignal and cumulative byte counter.
    let value=await read({});
    if(!stopped&&!fetchIssue&&value?.status==='unavailable'&&RETRYABLE_PAGINATION.has(value.reason)){
     checkDeadline(budget);
     value=await read.changingPublic();
    }
    checkDeadline(budget);
    value=stopped?stoppedValue():fetchIssue?unavailable(fetchIssue):verify(value);
    if(value.status!=='ready')failureCache={value,until:now()+3000};
    else failureCache=null;
    partialSnapshot=value.status==='ready'&&value.catalogueComplete===false?value:null;
    return value;
   }catch{
    const value=stopped?stoppedValue():unavailable(fetchIssue||'Binance 普通双币公开报价暂不可用。');
    failureCache={value,until:now()+3000};return value;
   }finally{clearTimeout(budget.timer);if(activeRead===budget)activeRead=null;}
  })();
  pending=task;
  try{return await task;}
  finally{if(pending===task)pending=null;}
 }
 return async function handle(request){
  if(request.method!=='GET')return reply(405,unavailable('仅允许匿名 GET 读取公开报价。'),{allow:'GET'});
  let url;try{url=new URL(request.url);}catch{return reply(400,unavailable('请求地址无效。'));}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash||url.search)return reply(400,unavailable('此公开接口不接受查询参数或账户配置。'));
  if(url.pathname==='/health')return reply(200,{serviceReady:true,readOnly:true});
  if(url.pathname!=='/dual')return reply(404,unavailable('未知公开报价路径。'));
  try{const value=await load();return reply(value?.status==='ready'?200:503,value);}
  catch{return reply(503,stopped?stoppedValue():unavailable('Binance 普通双币公开报价暂不可用。'));}
 };
}
let defaultHandler;
export default function handler(request){
 defaultHandler??=createAnonymousDualHandler();
 return defaultHandler(request);
}
`;

const generated=runtime.replace('__PUBLIC_SOURCE__',JSON.stringify(source)).replace('/* CURRENT_ORDINARY_READER */',reader);
await mkdir(resolve(output,'netlify/functions'),{recursive:true});
await mkdir(resolve(output,'public'),{recursive:true});
await writeFile(resolve(output,'netlify/functions/dual.mjs'),generated);
await writeFile(resolve(output,'netlify.toml'),'[build]\n  command = "node --check netlify/functions/dual.mjs"\n  publish = "public"\n\n[build.environment]\n  NODE_VERSION = "22"\n\n[functions]\n  directory = "netlify/functions"\n  node_bundler = "esbuild"\n');
await writeFile(resolve(output,'public/index.html'),'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Binance 公开双币报价</title><body><h1>Binance 普通双币公开报价</h1><p>仅匿名读取 BTC/USDT 普通双币，不连接交易账户，不执行交易。GET /dual 返回完整公开产品；GET /health 仅检查服务。</p><p>报价超过 30 秒停止比较。未核实个人资格、申购精度及截止时间，不将普通双币替代大额询价。</p><p>Netlify Free 每月 300 credits 硬上限，部署、计算、流量和请求共同计量；耗尽会暂停，不启用付费或自动充值。尚需验证真实上游可用性。</p></body></html>\n');
console.log('Built dist-netlify-dual anonymous ordinary-dual Functions bundle.');

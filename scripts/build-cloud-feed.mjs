import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const target=resolve(root,'dist-cloud/binance-cloud-feed.mjs');
// Embed the current readers verbatim so their validation and calculations stay shared.
const readers=await Promise.all(['worker/binance.js','worker/binance-options.js'].map(path=>readFile(resolve(root,path),'utf8')));
const runtime=String.raw`
import {createServer} from 'node:http';
import {timingSafeEqual,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {AsyncLocalStorage} from 'node:async_hooks';

const FEED_MAX_BYTES=4*1024*1024,FEED_MAX_ACTIVE=4;
const feedHash=value=>createHash('sha256').update(value).digest();
const feedRequestScope=new AsyncLocalStorage();
// Observe upstream status without modifying URLs, headers, responses or reader logic.
// Lexical fetch also covers the product reader, which has no fetch injection option.
const fetch=async(...args)=>{
 const scope=feedRequestScope.getStore();
 if(scope?.blocked())throw Error('Binance source HTTP '+scope.blocked());
 const response=await globalThis.fetch(...args);
 if([403,418,429,451].includes(response.status))scope?.stop(response.status);
 return response;
};
export function createQuoteService({optionsReader,dualReader,token=process.env.QUOTE_READ_TOKEN}={}){
 if(typeof token!=='string'||!token.trim())throw Error('QUOTE_READ_TOKEN is required');
 const expected=feedHash(token);
 const options=optionsReader||createBinanceOptionsReader();
 const dual=dualReader||createBinanceReader();
 let active=0;
 const stopped={options:0,dual:0};
 const unavailable=(source)=>({status:'unavailable',reason:stopped[source]?'Binance source stopped (HTTP '+stopped[source]+'); restart only after access or rate limits are resolved.':'Public quote source is unavailable.',...(stopped[source]?{upstreamStatus:stopped[source]}:{}),time:0,receivedAt:0});
 function reply(response,status,value,extra={}){
  let body;
  try{body=JSON.stringify(value);}catch{status=503;body=JSON.stringify(unavailable());}
  if(typeof body!=='string'||Buffer.byteLength(body)>FEED_MAX_BYTES){status=503;body=JSON.stringify({status:'unavailable',reason:'Quote response exceeded the size limit.',time:0,receivedAt:0});}
  response.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-length':Buffer.byteLength(body),...extra});
  response.end(body);
 }
 const denied=value=>{
  const explicit=Number(value?.upstreamStatus||value?.httpStatus);
  if([403,418,429,451].includes(explicit))return explicit;
  const match=String(value?.reason||value?.message||'').match(/\b(403|418|429|451)\b/);
  return match?Number(match[1]):0;
 };
 const server=createServer({maxHeaderSize:8192,requestTimeout:20000,headersTimeout:10000},async(request,response)=>{
  if(request.method!=='GET'){request.resume();return reply(response,405,{status:'unavailable',reason:'GET only.'},{allow:'GET'});}
  let url;
  try{url=new URL(request.url,'http://quote.local');}catch{return reply(response,400,{status:'unavailable',reason:'Invalid request.'});}
  const route=url.pathname,keys=[...url.searchParams.keys()];
  if(url.origin!=='http://quote.local'||url.username||url.password||url.hash||request.url.split('?')[0]!==route)return reply(response,400,{status:'unavailable',reason:'Invalid request.'});
  if(!['/health','/market','/book','/dual'].includes(route))return reply(response,404,{status:'unavailable',reason:'Unknown route.'});
  if((route!=='/book'&&keys.length)||(route==='/book'&&(keys.length!==1||keys[0]!=='symbol'||!bnoSymbol(url.searchParams.get('symbol')))))return reply(response,400,{status:'unavailable',reason:'Invalid quote parameters.'});
  // Client credentials and arbitrary target/header forwarding are never accepted.
  if(['cookie','x-mbx-apikey','x-api-key','proxy-authorization'].some(name=>request.headers[name]!==undefined)||request.headers['transfer-encoding']||Number(request.headers['content-length']||0)!==0){request.resume();return reply(response,400,{status:'unavailable',reason:'Credentials and request bodies are not accepted.'});}
  if(route==='/health')return reply(response,200,{serviceReady:true});
  const authorization=request.headers.authorization;
  if(typeof authorization!=='string'||authorization.length>4096||!authorization.startsWith('Bearer ')||!timingSafeEqual(expected,feedHash(authorization.slice(7))))return reply(response,401,{status:'unavailable',reason:'Unauthorized.'},{'www-authenticate':'Bearer'});
  const source=route==='/dual'?'dual':'options';
  if(stopped[source])return reply(response,503,unavailable(source));
  if(active>=FEED_MAX_ACTIVE)return reply(response,503,{status:'unavailable',reason:'Quote service is busy.',time:0,receivedAt:0});
  active++;
  try{
   // No inbound headers, Binance keys, account data or request objects enter readers.
   const value=await feedRequestScope.run({blocked:()=>stopped[source],stop:status=>{stopped[source]=status;}},()=>route==='/market'?options.loadMarket():route==='/book'?options.loadBook(url.searchParams.get('symbol')):dual({}));
   if(denied(value))stopped[source]=denied(value);
   if(stopped[source]||value?.status!=='ready')return reply(response,503,unavailable(source));
   return reply(response,200,value);
  }catch(error){if(denied(error))stopped[source]=denied(error);return reply(response,503,unavailable(source));}
  finally{active--;}
 });
 return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const port=Number(process.env.PORT||8080);
 if(!Number.isInteger(port)||port<1||port>65535)throw Error('PORT is invalid');
 const server=createQuoteService();
 server.listen(port,'0.0.0.0');
 const stop=()=>server.close(()=>process.exit(0));
 process.once('SIGTERM',stop);process.once('SIGINT',stop);
}
`;
await mkdir(dirname(target),{recursive:true});
await writeFile(target,'// Generated from the current read-only Binance readers. Node.js 22+.\n'+readers.join('\n')+'\n'+runtime);
console.log('Built dist-cloud/binance-cloud-feed.mjs');

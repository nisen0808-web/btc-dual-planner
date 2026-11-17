import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),output=resolve(root,'dist-netlify-probe');
const sources=await Promise.all(['worker/binance.js','worker/binance-options.js'].map(path=>readFile(resolve(root,path),'utf8')));
const runtime=String.raw`
export const config={path:['/health','/verify']};
export function createPublicQuoteProbe({options=createBinanceOptionsReader(),dual=createBinanceReader(),now=Date.now}={}){
 let pending=null,last=null;
 const reply=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff','x-robots-tag':'noindex'}});
 const failed=reason=>({status:'failed',reason:String(reason||'Upstream unavailable').slice(0,250)});
 return async request=>{
  const url=new URL(request.url);
  if(request.method!=='GET'||url.search)return reply({status:'failed',reason:'Only fixed, parameter-free GET is supported'},400);
  if(url.pathname==='/health')return reply({serviceReady:true,mode:'public-data-verification-only',trading:false});
  if(url.pathname!=='/verify')return reply({status:'failed',reason:'Unknown route'},404);
  if(last&&now()-last.checkedAt<60000)return reply(last);
  if(!pending)pending=(async()=>{
   let market;const result={checkedAt:now(),mode:'public-data-verification-only',binanceLogin:false,trading:false};
   try{
    market=await options.loadMarket();
    result.optionsMarket={status:'ready',sourceURLs:market.sourceURLs,exchangeTime:market.time,contracts:market.contracts.length,index:market.spot,currency:market.currency};
   }catch(error){result.optionsMarket=failed(error.message);}
   if(market?.status==='ready'){
    const listed=market.contracts.filter(x=>x.expires>now()&&x.strike<=market.spot).sort((a,b)=>a.expires-b.expires||b.strike-a.strike),contract=listed[0]||market.contracts[0];
    if(contract)try{
     const book=await options.loadBook(contract.symbol);
     result.optionsBook={status:'ready',symbol:contract.symbol,strike:contract.strike,expiry:contract.expires,exchangeTime:book.time,source:book.source,depthLimit:book.depthLimit,bidLevels:book.bids.length,askLevels:book.asks.length,bestBid:book.bids[0]||null,bestAsk:book.asks[0]||null};
    }catch(error){result.optionsBook=failed(error.message);}
   }else result.optionsBook={status:'not_tested',reason:'No verified listed contract was returned'};
   try{
    const data=await dual({});
    result.dual=data?.status==='ready'?{status:'ready',source:data.source,sourceType:data.sourceType,exchangeTime:data.serverTime,productCount:data.items.length,products:data.items.slice(0,3).map(p=>({id:p.id,investCoin:p.investCoin,exercisedCoin:p.exercisedCoin,strikePrice:p.strikePrice,settleDate:p.settleDate,apr:p.apr,canPurchase:p.canPurchase}))}:failed(data?.reason);
   }catch(error){result.dual=failed(error.message);}
   result.status=['optionsMarket','optionsBook','dual'].every(key=>result[key]?.status==='ready')?'all_sources_ready':'not_ready';
   result.checkedAt=now();return result;
  })();
  try{last=await pending;return reply(last);}finally{pending=null;}
 };
}
const probe=createPublicQuoteProbe();
export default request=>probe(request);
`;
await mkdir(resolve(output,'netlify/functions'),{recursive:true});await mkdir(resolve(output,'public'),{recursive:true});
await writeFile(resolve(output,'netlify/functions/verify.mjs'),sources.join('\n')+'\n'+runtime);
await writeFile(resolve(output,'netlify.toml'),'[build]\n  command = "node --check netlify/functions/verify.mjs"\n  publish = "public"\n\n[functions]\n  directory = "netlify/functions"\n  node_bundler = "esbuild"\n\n[build.environment]\n  NODE_VERSION = "22"\n');
await writeFile(resolve(output,'public/index.html'),'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Binance 公开行情验证</title><style>body{font:20px/1.7 sans-serif;max-width:760px;margin:60px auto;padding:20px}a{display:inline-block;padding:14px 24px;background:#20513e;color:white;border-radius:8px}</style><h1>Binance 公开行情验证</h1><p>只读取期权挂牌、指数、真实盘口及普通双币报价，不连接交易账户，不执行交易。</p><p><a href="/verify">检查真实行情来源</a></p><p>只有三类数据均返回有效结果，才能确认此云服务可用于后续接入。</p></html>');
console.log('Built dist-netlify-probe (no credentials, no trading)');

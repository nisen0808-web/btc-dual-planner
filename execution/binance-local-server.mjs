import {resolve,dirname} from 'node:path';
import {readFile,writeFile,mkdir,rm,rename} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ExecutionJournal} from './journal.mjs';
import {createBinanceLocalExecutionHttp} from './binance-local-http.mjs';
import {createBinanceExecution} from './binance.mjs';
import {createBinanceExecutionService} from './binance-service.mjs';
import {createBinancePublicMarket} from './binance-market.mjs';
import {createBinanceOptionsReader} from '../worker/binance-options.js';

const root=dirname(fileURLToPath(import.meta.url)),args=process.argv.slice(2),runtimeIndex=args.indexOf('--runtime');
if(runtimeIndex<0||!args[runtimeIndex+1]||process.platform!=='win32')throw Error('Windows Binance runtime directory is required');
const runtime=resolve(args[runtimeIndex+1]),configPath=resolve(runtime,'binance-credentials.dpapi');
await mkdir(runtime,{recursive:true});
function crypt(mode,value){
  return new Promise((resolve,reject)=>{
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./protect-config.ps1',import.meta.url)),'-Mode',mode],{windowsHide:true,stdio:['pipe','pipe','ignore']});
    let data='',size=0;const timer=setTimeout(()=>{child.kill();reject(Error('Secure Binance configuration timed out'));},10000);
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>32768){child.kill();return;}data+=chunk;});
    child.on('error',()=>{clearTimeout(timer);reject(Error('Secure Binance configuration unavailable'));});
    child.on('close',code=>{clearTimeout(timer);code===0&&size<=32768?resolve(data.trim()):reject(Error('Secure Binance configuration unavailable'));});
    child.stdin.on('error',()=>{});child.stdin.end(value);
  });
}
let service=null,journal=null,settings=null,pending=null,stopping=false,configuring=false,configLoadError=false;
async function install(config,persist=false){
  if(!config||config.environment!=='mainnet'||typeof config.tradingEnabled!=='boolean'||typeof config.apiKey!=='string'||typeof config.apiSecret!=='string')throw Error('Invalid Binance local configuration');
  if(journal?.list().some(plan=>!plan.closed))throw Error('An unfinished strategy prevents changing account configuration');
  const nextJournal=new ExecutionJournal(resolve(runtime,'binance-mainnet.sqlite'));
  try{
    const exchange=createBinanceExecution({apiKey:config.apiKey,apiSecret:config.apiSecret,liveEnabled:config.tradingEnabled,accountLabel:'binance-dedicated-usdt'});
    const nextService=createBinanceExecutionService({journal:nextJournal,exchangeFactory:()=>exchange,marketProvider:createBinancePublicMarket(),liveEnabled:config.tradingEnabled,accountLabel:'binance-dedicated-usdt'});
    if(persist){const encrypted=await crypt('Protect',JSON.stringify(config));await writeFile(configPath+'.tmp',encrypted,{mode:0o600});await rename(configPath+'.tmp',configPath);}
    if(pending)await pending;journal?.close();journal=nextJournal;service=nextService;settings={platform:'binance',currency:'USDT',environment:'mainnet',tradingEnabled:config.tradingEnabled};configLoadError=false;
  }catch(error){nextJournal.close();throw error;}
}
async function configure(config){
  if(configuring)throw Error('Binance configuration update is in progress');configuring=true;
  try{if(pending)await pending;await install(config,true);return {configured:true,...settings,accountVerified:false,reason:'账户配置已加密保存在本机，保存不会下单；仍须核验账户、卖方权限与余额。'};}finally{configuring=false;}
}
try{const encrypted=await readFile(configPath,'utf8');await install(JSON.parse(await crypt('Unprotect',encrypted)));}catch(error){configLoadError=error?.code!=='ENOENT';}
const setupStatus=async()=>({configured:!!service,...settings,accountVerified:false,runnerOnline:true,liveOrdersEnabled:settings?.tradingEnabled===true,reason:configLoadError?'已有加密配置暂无法读取；未启用账户或交易。':service?'配置在本机；请在策略页面核验账户并逐笔确认。':'尚未配置 Binance 账户，真实下单关闭。'});
const publicQuotes=createBinanceOptionsReader();
const gateway=createBinanceLocalExecutionHttp({serviceProvider:()=>service,configure,setupStatus,publicReader:(action,symbol)=>action==='market'?publicQuotes.loadMarket():publicQuotes.loadBook(symbol)});
const tick=()=>{if(stopping||configuring||pending||!service)return;pending=Promise.resolve().then(()=>service.tick()).catch(()=>{}).finally(()=>{pending=null;});};
const timer=setInterval(tick,5000);
gateway.server.on('error',()=>{clearInterval(timer);journal?.close();console.error('Binance 本机服务无法启动，请检查端口是否已被占用。');process.exitCode=1;});
gateway.server.listen(8789,'127.0.0.1',async()=>{await writeFile(resolve(runtime,'binance-local-server.pid'),String(process.pid));console.log('Binance 本机服务运行于 127.0.0.1:8789。未连接账户时不会请求私有接口或交易。');tick();});
const stop=()=>{if(stopping)return;stopping=true;clearInterval(timer);gateway.revoke();gateway.server.close(async()=>{if(pending)await pending;journal?.close();try{await rm(resolve(runtime,'binance-local-server.pid'));}catch{}process.exit(0);});};
process.on('SIGTERM',stop);process.on('SIGINT',stop);

import {resolve,dirname} from 'node:path';
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ExecutionJournal} from './journal.mjs';
import {createLocalExecutionHttp} from './local-http.mjs';
import {createDeribitExecution} from './deribit.mjs';
import {createDeribitExecutionService} from './deribit-service.mjs';
import {createDeribitPublicMarket} from './deribit-market.mjs';

const root=dirname(fileURLToPath(import.meta.url));
const args=process.argv.slice(2),runtimeIndex=args.indexOf('--runtime');
if(runtimeIndex<0||!args[runtimeIndex+1]||process.platform!=='win32')throw Error('Windows local runtime directory is required');
const runtime=resolve(args[runtimeIndex+1]),configPath=resolve(runtime,'credentials.dpapi');
await mkdir(runtime,{recursive:true});
function crypt(mode,value){
  return new Promise((resolve,reject)=>{
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',resolvePath('protect-config.ps1'),'-Mode',mode],{windowsHide:true,stdio:['pipe','pipe','ignore']});
    let data='',size=0;const timer=setTimeout(()=>{child.kill();reject(Error('Secure configuration timed out'));},10000);
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>32768){child.kill();return;}data+=chunk;});
    child.on('error',()=>{clearTimeout(timer);reject(Error('Secure configuration is unavailable'));});
    child.on('close',code=>{clearTimeout(timer);code===0&&size<=32768?resolve(data.trim()):reject(Error('Secure configuration is unavailable'));});
    child.stdin.on('error',()=>{});child.stdin.end(value);
  });
}
function resolvePath(file){return resolve(root,file);}
let service=null,journal=null,settings=null,pending=null,stopping=false,configuring=false;
async function install(config,persist=false){
  if(!config||!['testnet','mainnet'].includes(config.environment)||typeof config.tradingEnabled!=='boolean'||typeof config.clientId!=='string'||typeof config.clientSecret!=='string')throw Error('Invalid local configuration');
  if(journal?.list().some(plan=>!plan.closed))throw Error('An unfinished strategy prevents changing account configuration');
  const database=resolve(runtime,config.environment+'.sqlite'),nextJournal=new ExecutionJournal(database);
  // Environment and the explicit local trade switch select the adapter only.
  // Account verification and each prepare/confirm remain service requirements.
  const baseUrl=config.environment==='testnet'?'https://test.deribit.com':'https://www.deribit.com';
  try{
    const exchange=createDeribitExecution({clientId:config.clientId,clientSecret:config.clientSecret,baseUrl,liveEnabled:config.tradingEnabled});
    const nextService=createDeribitExecutionService({journal:nextJournal,exchangeFactory:()=>exchange,marketProvider:createDeribitPublicMarket({baseUrl}),liveEnabled:config.tradingEnabled,accountLabel:'deribit-dedicated-usdc'});
    if(persist){
      const encrypted=await crypt('Protect',JSON.stringify(config));await writeFile(configPath+'.tmp',encrypted,{mode:0o600});
      const {rename}=await import('node:fs/promises');await rename(configPath+'.tmp',configPath);
    }
    if(pending)await pending;journal?.close();journal=nextJournal;service=nextService;settings={environment:config.environment,tradingEnabled:config.tradingEnabled};
  }catch(error){nextJournal.close();throw error;}
}
async function configure(config){
  if(configuring)throw Error('Configuration update is in progress');configuring=true;
  try{
    if(pending)await pending;await install(config,true);
    return {configured:true,...settings,accountVerified:false,reason:config.tradingEnabled?'账户已在本机保存，仍需核验权限、余额和完整执行能力。':'已保存到本机，交易开关保持关闭。'};
  }finally{configuring=false;}
}
try{const encrypted=await readFile(configPath,'utf8');await install(JSON.parse(await crypt('Unprotect',encrypted)));}catch{}
const setupStatus=async()=>({configured:!!service,...settings,accountVerified:false,runnerOnline:true,liveOrdersEnabled:settings?.environment==='mainnet'&&settings?.tradingEnabled===true,reason:service?'账户配置只保存在本机；是否可下单以策略页完整核验结果为准。':'尚未输入交易账户，真实下单关闭。'});
const gateway=createLocalExecutionHttp({serviceProvider:()=>service,configure,setupStatus});
const tick=()=>{if(stopping||configuring||pending||!service)return;pending=Promise.resolve().then(()=>service.tick()).catch(()=>{}).finally(()=>{pending=null;});};
const timer=setInterval(tick,5000);
gateway.server.on('error',()=>{clearInterval(timer);journal?.close();console.error('本机执行器无法启动，请检查是否已有同一实例运行。');process.exitCode=1;});
gateway.server.listen(8788,'127.0.0.1',async()=>{await writeFile(resolve(runtime,'local-server.pid'),String(process.pid));console.log('Deribit 本机执行器已启动，仅监听 127.0.0.1:8788。未连接账户时不会交易。');tick();});
const stop=()=>{if(stopping)return;stopping=true;clearInterval(timer);gateway.revoke();gateway.server.close(async()=>{if(pending)await pending;journal?.close();try{await rm(resolve(runtime,'local-server.pid'));}catch{}process.exit(0);});};
process.on('SIGTERM',stop);process.on('SIGINT',stop);

import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ExecutionJournal} from './journal.mjs';
import {createBybitExecution} from './bybit.mjs';
import {createBybitPublicMarket} from './public-market.mjs';
import {createExecutionService} from './service.mjs';
import {createExecutionHttp} from './http.mjs';

export function createConfiguredExecutionServer(env=process.env){
  if(!env.EXECUTION_DB_PATH||!env.EXECUTION_GATEWAY_TOKEN)throw Error('Configure persistent execution storage and the private gateway token first');
  const baseUrl=env.BYBIT_ENV==='testnet'?'https://api-testnet.bybit.com':'https://api.bybit.com';
  const liveEnabled=env.LIVE_EXECUTION==='true'&&(env.BYBIT_ENV==='testnet'||env.MAINNET_ACCEPTED==='yes');
  const journal=new ExecutionJournal(resolve(env.EXECUTION_DB_PATH));
  const service=createExecutionService({journal,liveEnabled,accountLabel:'bybit-dedicated-usdt',exchangeFactory:()=>createBybitExecution({apiKey:env.BYBIT_API_KEY||'',apiSecret:env.BYBIT_API_SECRET||'',baseUrl,liveEnabled}),marketProvider:createBybitPublicMarket({baseUrl})});
  const server=createExecutionHttp({service,token:env.EXECUTION_GATEWAY_TOKEN,siteOrigin:env.STRATEGY_SITE_ORIGIN||'https://btc-dual-planner-oct22.phyrex-ni.chatgpt.site'});
  return {server,service,journal};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    const port=Number(process.env.PORT||8787);if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid server port');
    const {server,service,journal}=createConfiguredExecutionServer();
    let pending=null,stopping=false;
    const tick=()=>{if(stopping||pending)return;pending=Promise.resolve().then(()=>service.tick()).catch(()=>{}).finally(()=>{pending=null;});};
    const timer=setInterval(tick,5000);tick();
    const stop=()=>{if(stopping)return;stopping=true;clearInterval(timer);server.close(async()=>{if(pending)await pending;journal.close();process.exit(0);});};
    process.on('SIGTERM',stop);process.on('SIGINT',stop);
    server.listen(port,process.env.PORT?'0.0.0.0':'127.0.0.1',()=>console.log('Execution gateway started; live orders require verified account, explicit confirmation and enabled configuration.'));
  }catch{console.error('Execution server configuration is incomplete or invalid. No order was submitted.');process.exitCode=1;}
}

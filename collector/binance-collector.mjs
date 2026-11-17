import {createBinanceReader} from '../worker/binance.js';
import {readFile,writeFile,mkdir,open,unlink,stat,appendFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const destination='https://btc-dual-planner-oct22.phyrex-ni.chatgpt.site/api/binance-snapshot';
const runtime=new URL('../../../binance-collector/',import.meta.url);
const statusFile=new URL('status.json',runtime),lockFile=new URL('collector.lock',runtime),stopFile=new URL('collector.stop',runtime),logFile=new URL('collector.log',runtime);
const once=process.argv.includes('--once'),interval=12000;
const read=createBinanceReader();
let config,ownsLock=false,lastSent=0,lastLogged=0,lastState='';
async function record(status,extra={}){
  const entry={status,checkedAt:Date.now(),pid:process.pid,...extra};
  await writeFile(statusFile,JSON.stringify(entry));
  if(once||status!==lastState||Date.now()-lastLogged>=60000){
    await appendFile(logFile,JSON.stringify(entry)+'\n');lastLogged=Date.now();lastState=status;
    if(once)console.log(JSON.stringify(entry));
  }
  return entry;
}
async function readConfiguration(){
  if(process.stdin.isTTY)throw Error('Use the protected launcher');
  process.stdin.setEncoding('utf8');let text='';
  for await(const chunk of process.stdin){text+=chunk;if(text.length>32768)throw Error('Input too large');if(/[\r\n]/.test(text))break;}
  let value;try{value=JSON.parse(text);}catch{throw Error('Invalid collector configuration');}text='';
  if(typeof value.serviceToken!=='string'||value.serviceToken.length<20||typeof value.collectorToken!=='string'||!/^[0-9a-f]{64}$/.test(value.collectorToken))throw Error('Invalid collector configuration');
  return {serviceToken:value.serviceToken,collectorToken:value.collectorToken};
}
async function acquireLock(){
  await mkdir(runtime,{recursive:true});
  try{const lock=await open(lockFile,'wx');await lock.writeFile(String(process.pid));await lock.close();ownsLock=true;}
  catch(error){
    if(error.code!=='EEXIST')throw error;
    const oldPid=Number(await readFile(lockFile,'utf8'));let active=false;
    if(Number.isSafeInteger(oldPid)&&oldPid>0){try{process.kill(oldPid,0);active=true;}catch{}}
    if(active)throw Error('Collector already running');
    await unlink(lockFile);const lock=await open(lockFile,'wx');await lock.writeFile(String(process.pid));await lock.close();ownsLock=true;
  }
  try{await unlink(stopFile);}catch(error){if(error.code!=='ENOENT')throw error;}
}
async function tick(){
  const snapshot=await read({});
  if(snapshot.status!=='ready'){
    await record('source_unavailable',{reason:snapshot.reason||'Public source unavailable'});
    // Respect an explicit access refusal instead of cycling requests against it.
    if(/HTTP (?:403|451)|未允许本次读取/.test(snapshot.reason||''))return false;
    return !once;
  }
  if(Date.now()-snapshot.fetchedAt>=25000){await record('source_stale');return !once;}
  if(snapshot.fetchedAt<=lastSent)return true;
  const response=await fetch(destination,{
    method:'POST',redirect:'manual',signal:AbortSignal.timeout(12000),
    headers:{'content-type':'application/json','OAI-Sites-Authorization':'Bearer '+config.serviceToken,'x-binance-collector-token':config.collectorToken},
    body:JSON.stringify(snapshot)
  });
  if(response.status===401||response.status===403||response.status>=300&&response.status<400){await response.body?.cancel();await record('service_access_denied',{httpStatus:response.status});return false;}
  if(!response.ok){
    let reason='',diagnostic={};try{
      const body=await response.json();if(typeof body.reason==='string')reason=body.reason.slice(0,180);
      for(const key of ['validationCode','validationField'])if(typeof body[key]==='string'&&/^[A-Za-z_]{1,60}$/.test(body[key]))diagnostic[key]=body[key];
      for(const key of ['serverReceivedAt','serverValidatedAt','timeDeltaMs','itemIndex'])if(Number.isSafeInteger(body[key]))diagnostic[key]=body[key];
    }catch{}
    await record('publish_unavailable',{httpStatus:response.status,reason,...diagnostic,responseDate:response.headers.get('date'),timing:{fetchedAt:snapshot.fetchedAt,completedAt:snapshot.completedAt,serverTime:snapshot.serverTime,lastServerTime:snapshot.lastServerTime}});return !once;
  }
  const ack=await response.json();
  if(ack?.ok!==true){await record('publish_unavailable',{httpStatus:response.status});return !once;}
  lastSent=snapshot.fetchedAt;
  await record('ready',{snapshotAt:snapshot.fetchedAt,completedAt:snapshot.completedAt,total:snapshot.total,pages:snapshot.pageCount,publishedAt:Date.now()});
  return !once;
}
try{
  config=await readConfiguration();await acquireLock();
  for(;;){
    const started=Date.now();let proceed;
    try{proceed=await tick();}catch{await record('network_unavailable');proceed=!once;}
    if(!proceed){if(lastState!=='ready'&&lastState!=='stopped')process.exitCode=1;break;}
    await new Promise(resolve=>setTimeout(resolve,Math.max(1000,interval-(Date.now()-started))));
    try{await stat(stopFile);await record('stopped');break;}catch(error){if(error.code!=='ENOENT')throw error;}
  }
}catch{
  try{await mkdir(runtime,{recursive:true});await record('initialization_failed');}catch{}
  process.exitCode=1;
}finally{
  if(config){config.serviceToken='';config.collectorToken='';config=null;}
  if(ownsLock)try{await unlink(lockFile);}catch{}
}

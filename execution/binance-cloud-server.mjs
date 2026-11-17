import {resolve,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isIP} from 'node:net';
import {BinanceCloudVault,acquireBinanceCloudLock} from './binance-cloud-vault.mjs';
import {createBinanceCloudHttp} from './binance-cloud-http.mjs';
import {createBinanceExecution} from './binance.mjs';
import {createBinanceExecutionService} from './binance-service.mjs';
import {createBinancePublicMarket} from './binance-market.mjs';
import {ExecutionJournal} from './journal.mjs';

const fail=(code,publicMessage)=>{throw Object.assign(Error(code),{code,publicMessage});};
const copy=value=>JSON.parse(JSON.stringify(value));
const clean=value=>{if(typeof value==='string')return value.replaceAll('本机','云端');if(Array.isArray(value))return value.map(clean);if(value&&typeof value==='object'){const out={};for(const [key,item]of Object.entries(value))if(!/secret|api.?key|authorization|signature|password|bearer|token|acknowledgement/i.test(key))out[key]=clean(item);return out;}return value;};
/** One process only, one durable journal per verified Binance UID. */
export function createBinanceCloudBroker({directory,masterKey,serviceConfigured=false,persistentConfirmed=false,fixedEgressIp='',egressConfirmed=false,liveEnabled=false,now=Date.now,exchangeFactory=createBinanceExecution,serviceFactory=createBinanceExecutionService,journalFactory=path=>new ExecutionJournal(path),marketFactory=createBinancePublicMarket}={}){
  let vault=null,directoryLock=null;const configured=serviceConfigured&&persistentConfirmed&&isAbsolute(directory||'')&&isIP(fixedEgressIp)!==0&&egressConfirmed===true&&liveEnabled===true;
  if(configured)try{directoryLock=acquireBinanceCloudLock(directory);vault=new BinanceCloudVault({directory,masterKey,now});}catch{directoryLock?.close();directoryLock=null;}
  const records=new Map();let queue=Promise.resolve(),lastTick=0,closed=false;
  const serial=fn=>{const task=queue.then(fn,fn);queue=task.catch(()=>{});return task;};
  const available=()=>{if(!vault||closed)fail('broker_not_configured','云执行器尚未完成固定出口、持久存储和安全配置，账户连接关闭。');};
  function create(uid,credentials){
    const journal=journalFactory(vault.journalPath(uid)),record={uid,journal,recovering:true,verified:false,heartbeatAt:null,service:null,exchange:null};
    const masked=value=>value&&record.recovering?{...copy(value),automationPaused:true}:value;
    const recoveryJournal={get:id=>masked(journal.get(id)),list:()=>journal.list().map(masked),create:value=>masked(journal.create(value)),update:(...args)=>masked(journal.update(...args))};
    const exchange=exchangeFactory({...credentials,liveEnabled:true,accountLabel:'uid_'+uid,now});record.exchange=exchange;
    // A recovery pass exposes every plan as paused without changing durable flags:
    // real orders/ledgers are reconciled first; no transfer or BUY can run in it.
    record.service=serviceFactory({journal:recoveryJournal,exchangeFactory:()=>exchange,marketProvider:marketFactory(),liveEnabled:true,accountLabel:'uid_'+uid,now});records.set(uid,record);return record;
  }
  function get(uid){available();if(!/^\d{1,30}$/.test(uid||''))fail('not_connected','账户尚未连接。');let record=records.get(uid);if(!record){const credentials=vault.get(uid);if(!credentials)fail('not_connected','账户连接已撤销。');record=create(uid,credentials);}return record;}
  async function recover(record){const outcome=await record.service.tick();if(outcome?.running!==true||outcome.outcomes?.some(row=>row.code))return false;record.heartbeatAt=now();record.recovering=false;return true;}
  function active(record){return record.journal.list().some(plan=>!plan.closed);}
  async function status(uid){
    const base={brokerConfigured:!!vault&&!closed,autoSettleReady:false,connected:false,accountVerified:false,checkedAt:null,heartbeatAt:null,accountFeeVerified:false,canSubmit:false,cashCanSubmit:false,buyBTCCanSubmit:false,runnerOnline:false,reconciliationRequired:false,account:null,readOnlyKey:false,platform:'binance',currency:'USDT',environment:'mainnet',fixedEgressIp:!!vault?fixedEgressIp:null,liveEnabled:!!vault,reason:!vault?'云执行器未启用，公开行情仍可查看。':'请连接 Binance API 并核验专用账户。'};
    if(!uid||!vault)return base;const record=get(uid),result=clean(await record.service.status());
    const unresolved=record.journal.list().some(p=>!p.closed&&['put_submitting','put_unknown','put_reconciling','transfer_submitting','transfer_unknown','transfer_reconciling','spot_submitting','spot_unknown','spot_reconciling'].includes(p.phase)),ready=!record.recovering&&!unresolved;
    return {...base,...result,connected:true,accountFeeVerified:result.accountVerified===true,heartbeatAt:record.heartbeatAt,reconciliationRequired:unresolved||record.recovering||record.exchange.getExecutionState?.().reconciliationRequired===true,canSubmit:ready&&result.canSubmit===true,cashCanSubmit:ready&&result.cashCanSubmit===true,buyBTCCanSubmit:ready&&result.buyBTCCanSubmit===true,autoSettleReady:ready&&result.runnerOnline===true&&result.accountVerified===true,recoveryPending:record.recovering};
  }
  const api={status,
    connect:(credentials,previousUid)=>serial(async()=>{
      available();if(previousUid){const old=get(previousUid);if(active(old))fail('active_plan','当前会话已有未结束策略，不能更换账户。');}
      const probe=exchangeFactory({...credentials,liveEnabled:true,accountLabel:'connection_probe',now}),evidence=await probe.getAccountEvidence();
      if(evidence?.ok!==true||!/^\d{1,30}$/.test(evidence.data?.uid||''))fail('account_unverified','真实账户身份或权限无法核验。');
      const e=evidence.data,r=e.restriction;if(!Number.isSafeInteger(e.checkedAt)||e.checkedAt<=0||e.checkedAt>now()+2000||now()-e.checkedAt>=15000||r?.ipRestrict!==true||r.enableReading!==true||r.enableVanillaOptions!==true||r.enableWithdrawals!==false||r.enableMargin!==false||r.enableFutures!==false||r.enablePortfolioMarginTrading!==false||r.enableFixApiTrade!==false)fail('permission_invalid','需开启 IP 白名单、读取与期权权限，并关闭提现、杠杆、合约、组合保证金及 FIX 交易。');
      const uid=e.uid,existing=records.get(uid)||(vault.get(uid)?get(uid):null);
      if(existing&&active(existing))return {uid,status:await status(uid)}; // Reattach proven UID, never replace its active credentials.
      // Validate all original dedicated-account and fee gates before persisting.
      if(existing){existing.journal.close?.();records.delete(uid);}
      const record=create(uid,credentials),checked=await record.service.status();
      if(checked.accountVerified!==true||checked.accountId!==uid){record.journal.close?.();records.delete(uid);fail('account_unverified',typeof checked.reason==='string'?clean(checked.reason):'专用账户、权限或实际费率核验未通过。');}
      vault.put(uid,credentials);record.verified=true;await recover(record);if(previousUid&&previousUid!==uid){const old=records.get(previousUid);if(old){old.journal.close?.();records.delete(previousUid);}vault.delete(previousUid);}
      return {uid,status:await status(uid)};
    }),
    disconnect:uid=>serial(async()=>{const record=get(uid),ongoing=active(record);if(!ongoing){vault.delete(uid);record.journal.close?.();records.delete(uid);}return {activePlansContinue:ongoing,notice:ongoing?'浏览器已断开；已经逐笔确认的到期处理继续运行。':'连接凭据已删除。'};}),
    prepare:(uid,input)=>serial(async()=>{const record=get(uid);if(record.recovering)fail('recovery_pending','执行器正在核对已有记录，暂不接受新策略。');return clean(await record.service.prepare(input));}),
    confirm:(uid,input)=>serial(async()=>{const record=get(uid);if(record.recovering)fail('recovery_pending','已有委托尚未核对，禁止新写入。');if(input?.account!=='uid_'+uid)fail('account_mismatch','确认账户与当前会话不一致。');return clean(await record.service.confirm(input));}),
    plans:uid=>serial(async()=>clean(get(uid).service.listPlans())),
    pause:(uid,input)=>serial(async()=>clean(await get(uid).service.pause(input))),
    tick:()=>serial(async()=>{if(!vault||closed)return {running:false};for(const uid of vault.list()){
      let record;try{record=get(uid);if(record.recovering){await recover(record);continue;}await record.service.tick();record.heartbeatAt=now();}catch{if(record)record.recovering=true;}
    }lastTick=now();return {running:true,checkedAt:lastTick};}),
    close:()=>serial(async()=>{closed=true;try{for(const record of records.values())record.journal.close?.();records.clear();vault?.close();}finally{vault=null;directoryLock?.close();directoryLock=null;}})
  };return api;
}

export async function startBinanceCloudServer(env=process.env){
  const siteOrigin=env.BINANCE_SITE_ORIGIN||'https://btc-dual-planner-oct22.phyrex-ni.chatgpt.site',serviceSecret=env.BINANCE_SERVICE_SECRET||'';
  const broker=createBinanceCloudBroker({directory:env.BINANCE_DATA_DIR,masterKey:env.BINANCE_MASTER_KEY,serviceConfigured:/^[A-Za-z0-9_-]{43,128}$/.test(serviceSecret),persistentConfirmed:env.BINANCE_PERSISTENT_STORAGE_CONFIRMED==='true',fixedEgressIp:env.BINANCE_FIXED_EGRESS_IP,egressConfirmed:env.BINANCE_FIXED_EGRESS_CONFIRMED==='true',liveEnabled:env.BINANCE_LIVE_ENABLED==='true'});
  const {server}=createBinanceCloudHttp({broker,serviceSecret,siteOrigin});let pending=null,stopping=false;
  const tick=()=>{if(stopping||pending)return;pending=broker.tick().catch(()=>{}).finally(()=>pending=null);};tick();const timer=setInterval(tick,5000);
  const port=Number(env.PORT||8080);if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid port');await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'0.0.0.0',resolve);});
  const stop=async()=>{if(stopping)return;stopping=true;clearInterval(timer);await new Promise(resolve=>server.close(resolve));if(pending)await pending;await broker.close();};return {server,broker,stop};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const running=await startBinanceCloudServer();for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>running.stop().then(()=>process.exit(0)));}

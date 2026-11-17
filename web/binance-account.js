import {timestamp,money} from './binance-desk.js';
const ACTIONS=new Set(['status','connect','recheck','disconnect']),MAX_PEM=16384;
const own=(v,k)=>v!=null&&Object.hasOwn(v,k),safeObject=v=>v&&typeof v==='object'&&!Array.isArray(v);
const EMPTY={ok:true,signedIn:false,configured:false,hasCredential:false,connected:false,phase:'not_connected',report:null,canSubmit:false,tradingEnabled:false};
function safeSession(value){
 if(!safeObject(value)||value.ok!==true||typeof value.signedIn!=='boolean'||typeof value.configured!=='boolean'||typeof value.connected!=='boolean')throw Error('账户服务未返回可核验状态');
 const report=safeObject(value.report)&&value.report.readOnly===true&&value.report.canSubmit===false&&value.report.tradingEnabled===false?value.report:null;
 const uid=typeof value.account?.uid==='string'||typeof value.account?.uid==='number'?String(value.account.uid):null;
 return {...EMPTY,signedIn:value.signedIn,configured:value.configured,hasCredential:value.signedIn&&value.hasCredential===true,connected:value.signedIn&&value.hasCredential===true&&value.connected,phase:typeof value.phase==='string'?value.phase:'unknown',checkedAt:value.signedIn&&Number.isSafeInteger(value.checkedAt)?value.checkedAt:null,keyType:value.signedIn&&value.hasCredential===true&&['RSA','Ed25519'].includes(value.keyType)?value.keyType:null,keyHint:value.signedIn&&value.hasCredential===true&&typeof value.keyHint==='string'&&value.keyHint.length<=40&&/[*…]/.test(value.keyHint)?value.keyHint:null,account:value.signedIn&&uid&&/^\d{1,32}$/.test(uid)?{uid}:null,report:value.signedIn?report:null,canSubmit:false,tradingEnabled:false};
}
export function accountConnectionState(session={}){
 const report=session.report,verified=report?.accountVerified===true;
 return {brokerConfigured:session.signedIn===true,connected:session.connected===true,platform:'binance',currency:'USDT',environment:'mainnet',accountVerified:verified,accountFeeVerified:false,readOnlyKey:true,canSubmit:false,cashCanSubmit:false,buyBTCCanSubmit:false,autoSettleReady:false,runnerOnline:false,checkedAt:session.checkedAt??report?.checkedAt??null,heartbeatAt:null,reason:'当前仅核验账户、权限与实际费率，不提交期权、现货或划转。',readOnly:true,rawSession:session};
}
/** Same-origin, owner-session-bound account reads only. No caller-supplied user identifier or trade route. */
export function createBinanceAccountClient({fetchImpl=(...args)=>fetch(...args)}={}){
 let state={...EMPTY},generation=0,mutation=false,disposed=false;const listeners=new Set();
 const emit=next=>{state={...next,canSubmit:false,tradingEnabled:false};for(const listener of listeners)listener(state);return state;};
 async function request(action,payload){
  const read=action==='session',options={method:read?'GET':'POST',credentials:'same-origin',cache:'no-store',redirect:'error',headers:{accept:'application/json',...(!read?{'Content-Type':'application/json','X-Account-Request':'1'}:{})},signal:AbortSignal.timeout(read?15000:45000)};
  if(!read)options.body=JSON.stringify(payload);
  try{const response=await fetchImpl('/api/binance-account/'+action,options);let body;try{body=await response.json();}catch{throw Error('账户服务未返回可核验结果');}
   if(response.status===401){const error=Error('请先使用 ChatGPT 登录本站');error.code='sign_in_required';throw error;}
   if(!response.ok||body?.ok!==true){const code=typeof body?.error?.code==='string'?body.error.code:typeof body?.code==='string'?body.code:'account_request_failed';const error=Error('只读核验未完成，请检查配置与 API 权限后重试');error.code=/^[a-z_]{1,64}$/.test(code)?code:'account_request_failed';throw error;}return body;
  }finally{if(options.body)options.body='';}
 }
 async function session(){if(disposed)throw Error('账户入口已关闭');if(mutation)return state;const token=++generation;try{const next=safeSession(await request('session'));if(token!==generation||disposed)return state;return emit(next);}catch(error){if(token===generation&&!disposed)emit({...EMPTY,signedIn:error.code!=='sign_in_required'&&state.signedIn,phase:error.code==='sign_in_required'?'signed_out':'unavailable'});throw error;}}
 async function mutate(action,input){
  if(disposed||mutation)throw Error('当前核验正在处理，请稍候');
  if(state.signedIn!==true)throw Error('请先使用 ChatGPT 登录本站');
  const payload=input===undefined?{}:input;if(!safeObject(payload))throw Error('账户请求格式无效');
  if(action==='connect'){
   if(Object.keys(payload).some(k=>!['apiKey','privateKeyPem','keyType','consent'].includes(k))||typeof payload.apiKey!=='string'||!payload.apiKey.trim()||payload.apiKey.length>512||typeof payload.privateKeyPem!=='string'||payload.privateKeyPem.length>MAX_PEM||!['RSA','Ed25519'].includes(payload.keyType)||payload.consent!==true)throw Error('请本人提供 API Key 和 PKCS8 私钥，并同意只读核验及加密保存');
   if(state.configured!==true)throw Error('云端只读核验服务尚未就绪，当前不接收密钥');
  }else if(Object.keys(payload).length)throw Error('账户请求不接受用户或账户标识参数');
  const token=++generation;mutation=true;emit({...state,connected:false,account:null,report:null,phase:action==='disconnect'?'disconnecting':'checking'});
  try{await request(action,payload);if(token!==generation||disposed)return state;const next=safeSession(await request('session'));if(token!==generation||disposed)return state;return emit(next);}
  catch(error){if(token===generation&&!disposed)emit({...EMPTY,signedIn:error.code!=='sign_in_required'&&state.signedIn,configured:state.configured,phase:action==='disconnect'?'disconnect_unverified':'unavailable'});throw error;}
  finally{if(action==='connect'){payload.apiKey='';payload.privateKeyPem='';}mutation=false;}
 }
 async function api(action,input){try{if(!ACTIONS.has(action))throw Error('本站只读核验入口禁止交易、划转和订单操作');if(action==='status')return accountConnectionState(await session());return accountConnectionState(await mutate(action,input));}finally{if(action==='connect'&&safeObject(input)){input.apiKey='';input.privateKeyPem='';}}}
 const connect=async input=>{try{return await mutate('connect',input);}finally{if(safeObject(input)){input.apiKey='';input.privateKeyPem='';}}};
 return {readonly:true,api,session,connect,recheck:()=>mutate('recheck',{}),disconnect:()=>mutate('disconnect',{}),getSession:()=>state,subscribe(listener){listeners.add(listener);listener(state);return()=>listeners.delete(listener);},destroy(){disposed=true;generation++;listeners.clear();state={...EMPTY};}};
}
const CHECKS={restrictions:'API 权限',spot:'现货账户',options:'期权账户',optionFees:'实际期权开仓费率',spotFees:'实际现货费率'};
const FLAGS={enableReading:'读取权限',enableWithdrawals:'提现权限',enableSpotAndMarginTrading:'现货及杠杆交易权限',enableMargin:'杠杆权限',enableFutures:'合约权限',enableVanillaOptions:'期权权限',enableInternalTransfer:'内部划转权限',permitsUniversalTransfer:'通用划转权限',ipRestrict:'IP 白名单限制',enablePortfolioMarginTrading:'组合保证金权限',canTrade:'账户可交易标记',canDeposit:'账户可充值标记',canWithdraw:'账户可提现标记',isOptionsEnabled:'已开通期权',reduceOnly:'仅减仓标记',isLocked:'账户锁定标记'};
const tri=v=>v===true?'是 · 已核实':v===false?'否 · 已核实':'尚未核实';
const fee=v=>v===null||v===undefined||typeof v==='boolean'||typeof v==='string'&&!v.trim()?'尚未核实':Number.isFinite(Number(v))&&Math.abs(Number(v))<=1?money(Number(v)*100,8)+'%':'尚未核实';
const first=(data,keys)=>keys.find(k=>own(data,k))===undefined?undefined:data[keys.find(k=>own(data,k))];
export function mountBinanceAccountPanel({doc=document,client,onState=()=>{},confirmDelete=()=>globalThis.confirm('断开此账户，并删除本站保存的加密 API 密钥？这不会删除 Binance 上的 API Key，也不会提交交易。')}={}){
 const el=id=>doc.getElementById(id),set=(id,value)=>{const n=el(id);if(n)n.textContent=value;},make=(tag,text='',cls='')=>{const n=doc.createElement(tag);n.textContent=text;n.className=cls;return n;};
 let state=client.getSession?.()||{...EMPTY},working=false,disposed=false,panelGeneration=0;
 const clear=()=>{el('connectionApiKey').value='';el('connectionPrivateKeyFile').value='';el('connectionReadConsent').checked=false;};
 const row=(dl,label,value)=>{dl.append(make('dt',label),make('dd',value));};
 function renderReport(){const report=state.report,target=el('accountChecks');target.replaceChildren();el('accountReportPanel').hidden=!state.signedIn||!state.hasCredential&&!report;
  set('accountUid',report?.accountVerified===true&&/^\d{1,32}$/.test(String(report.account?.uid??''))?String(report.account.uid):'尚未核实');set('accountCheckedAt',timestamp(report?.checkedAt??state.checkedAt));set('accountKeyType',state.keyType||'尚未核实');set('accountKeyHint',state.keyHint||'—');
  for(const [key,label]of Object.entries(CHECKS)){const check=report?.checks?.[key],verified=check?.status==='verified',data=verified&&safeObject(check.data)?check.data:{};const section=make('section','','account-check');section.append(make('h3',label),make('p',verified?'已取得真实 API 返回':check?.status==='failed'?'核验未通过':'尚未核实',verified?'positive':'account-unknown'));const dl=make('dl','','account-check-facts');
   if(key==='restrictions'){for(const field of ['enableReading','enableWithdrawals','enableSpotAndMarginTrading','enableVanillaOptions','enableInternalTransfer','permitsUniversalTransfer','enableMargin','enableFutures','enablePortfolioMarginTrading','ipRestrict'])row(dl,FLAGS[field],tri(data[field]));}
   if(key==='spot'||key==='options'){for(const field of key==='spot'?['canTrade','canDeposit','canWithdraw']:['canTrade','isOptionsEnabled','reduceOnly','isLocked'])row(dl,FLAGS[field],tri(data[field]));}
   if(key==='optionFees'){row(dl,'Maker 开仓费率',fee(first(data,['makerFee','maker','makerCommission','makerFeeRate'])));row(dl,'Taker 开仓费率',fee(first(data,['takerFee','taker','takerCommission','takerFeeRate'])));row(dl,'交割费率','此接口尚未核实，仍单独使用公开规则说明');}
   if(key==='spotFees'){for(const [group,name]of [['standardCommission','标准费率'],['specialCommission','特殊费率'],['taxCommission','税费率']]){const rates=safeObject(data[group])?data[group]:{};for(const side of ['maker','taker','buyer','seller'])row(dl,name+' · '+side,fee(rates[side]));}const discount=safeObject(data.discount)?data.discount:{};row(dl,'账户 BNB 优惠资格',tri(discount.enabledForAccount));row(dl,'BTCUSDT BNB 优惠资格',tri(discount.enabledForSymbol));row(dl,'优惠资产',typeof discount.discountAsset==='string'&&/^[A-Z0-9]{1,12}$/.test(discount.discountAsset)?discount.discountAsset:'尚未核实');row(dl,'优惠比例',fee(discount.discount));row(dl,'BNB 余额及实际抵扣','尚未核实；不推断最终成交费用');}
   section.append(dl);if(check?.status==='failed')section.append(make('p','该项 API 未完成只读核验；请核对账户、权限及网络状态。','data-note'));target.append(section);
  }
 }
 function draw(){const signedIn=state.signedIn===true,configured=state.configured===true,hasCredential=state.hasCredential===true,connected=state.connected===true,unknown=['unavailable','disconnect_unverified'].includes(state.phase);el('accountSignin').hidden=signedIn;el('accountSigninDialog').hidden=signedIn;el('connectionForm').hidden=!signedIn||!configured;for(const id of ['connectionApiKey','connectionKeyType','connectionPrivateKeyFile','connectionReadConsent','connectAccountSubmit'])el(id).disabled=!signedIn||!configured||working;el('recheckBinance').disabled=!signedIn||!hasCredential||working;el('disconnectBinance').hidden=!signedIn||!hasCredential;el('disconnectBinance').disabled=working;el('connectBinance').disabled=working;set('connectBinance',connected?'我的 API · 只读核验':'连接我的 Binance API');set('accountAccessState',working?'只读核验处理中…':unknown?'账户状态尚未核实 · 请刷新':connected?'我的账户 · 只读已连接':hasCredential?'已保存密钥 · 等待核验':signedIn?'已登录本站 · 未绑定 API':'未登录本站 · 只看行情');set('accountAccessHint',unknown?'暂时不能确认密钥保存或删除状态，请重新读取本站账户状态；不会提交任何交易。':signedIn?'只查询账户、权限与真实费率，所有下单和划转均未开放。':'公开行情无需登录；绑定本人 API 前使用 ChatGPT 登录本站。');set('accountAccessDescription','每位用户只绑定自己的 Binance API。资金仍在 Binance，本站本轮仅核验读取权限及实际费率，不交易。');set('connectionServiceNotice',!configured?'云端只读核验服务尚未就绪，当前不接收密钥。':signedIn?'请选择 RSA 或 Ed25519 自生成 API Key，并导入对应的 PKCS8 .pem 私钥文件。不是 Binance 登录密码。':'绑定 API 前请先通过本站的 ChatGPT 登录入口登录。公开行情可继续查看。');set('ticketAccessLabel','公开标准费率报价 · 账户只读');el('plansPanel').hidden=true;set('plansStatus','订单查询及交易未开放');set('autoSettleStatus','本次仅只读核验，不启用期权交易、划转或到期自动买 BTC。');el('autoBuyModeOption').disabled=true;renderReport();}
 function receive(next){if(disposed)return;state=next;draw();onState(next);}
 const unsubscribe=client.subscribe?.(receive)||(()=>{});if(!client.subscribe)draw();
 function close(){panelGeneration++;clear();el('connectionDialog').close();}
 function open(){const token=++panelGeneration;clear();set('connectionMessage','API Key 与私钥只用于本人账户的只读核验，保存连接不会下单。');el('connectionDialog').showModal();draw();client.session?.().catch(()=>{if(!disposed&&token===panelGeneration)set('connectionMessage','本站账户状态暂不可核实，请稍后刷新；当前不接收密钥。');});}
 async function submit(event){event?.preventDefault();if(working||!state.signedIn||!state.configured){clear();return;}const token=++panelGeneration;working=true;let privateKeyPem='',payload=null;const apiKey=el('connectionApiKey').value,keyType=el('connectionKeyType').value,file=el('connectionPrivateKeyFile').files?.[0],consent=el('connectionReadConsent').checked===true;set('connectionMessage','正在读取所选私钥并核验…');draw();
  try{if(!apiKey.trim()||apiKey.length>512||!['RSA','Ed25519'].includes(keyType)||consent!==true)throw Error('请填写本人 API Key，选择密钥算法，并勾选只读核验及云端加密保存同意。');if(!file||file.size<=0||file.size>MAX_PEM||!String(file.name).toLowerCase().endsWith('.pem'))throw Error('请本人选择不超过 16 KiB 的 PKCS8 .pem 私钥文件。');privateKeyPem=await file.text();if(disposed||token!==panelGeneration)return;if(privateKeyPem.length>MAX_PEM||!/^-----BEGIN PRIVATE KEY-----\s+[A-Za-z0-9+/=\r\n]+\s+-----END PRIVATE KEY-----\s*$/.test(privateKeyPem))throw Error('私钥须为未加密的 PKCS8 PEM 格式（BEGIN PRIVATE KEY）。');payload={apiKey,privateKeyPem,keyType,consent:true};clear();await client.connect(payload);if(!disposed&&token===panelGeneration)set('connectionMessage','只读核验请求已完成，请查看每项真实返回结果。保存不代表全部权限已通过核验。');}
  catch(error){if(!disposed&&token===panelGeneration)set('connectionMessage',error?.code?'只读核验未完成，请检查 API 配置和权限后重试。':error.message==='账户服务未返回可核验状态'?'账户服务未返回可核验状态，请稍后刷新。':error.message?.startsWith('请')||error.message?.startsWith('私钥须')?error.message:'只读核验未完成，请检查 API 配置和权限后重试。');}
  finally{privateKeyPem='';if(payload){payload.apiKey='';payload.privateKeyPem='';}clear();working=false;if(!disposed)draw();}
 }
 async function recheck(){if(working||!state.hasCredential)return;panelGeneration++;clear();working=true;draw();set('connectionMessage','正在重新读取账户权限及实际费率…');try{await client.recheck();set('connectionMessage','只读核验已刷新，请查看最新读取时间和各项结果。');}catch{set('connectionMessage','刷新核验未完成，旧核验结果不会冒充最新数据。');}finally{working=false;if(!disposed)draw();}}
 async function disconnect(){clear();if(working||!state.hasCredential)return;if(!await confirmDelete())return;panelGeneration++;working=true;draw();try{await client.disconnect();set('connectionMessage','已断开，并删除本站保存的加密密钥；Binance 上的 API Key 未删除。');}catch{set('connectionMessage','删除结果尚未核实，请刷新账户状态后再次检查。');}finally{working=false;clear();if(!disposed)draw();}}
 el('connectBinance').addEventListener('click',open);el('connectionForm').addEventListener('submit',submit);el('closeConnectionDialog').addEventListener('click',close);el('connectionDialog').addEventListener('cancel',()=>{panelGeneration++;clear();});el('recheckBinance').addEventListener('click',recheck);el('disconnectBinance').addEventListener('click',disconnect);el('cancelConnection').addEventListener('click',close);
 return {open,clear,render:draw,destroy(){disposed=true;panelGeneration++;clear();unsubscribe();}};
}




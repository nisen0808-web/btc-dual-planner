const ACTIONS=new Set(['status','connect','disconnect','prepare','confirm','plans','pause']);
const READS=new Set(['status','plans']);
export function createBinanceCloudExecutionClient({fetchImpl=(...args)=>fetch(...args)}={}){
 let csrf='',configured=false,connected=false;
 function clear(){csrf='';connected=false;}
 async function api(action,input){
  if(!ACTIONS.has(action))throw Error('未知账户操作');
  const read=READS.has(action);
  if(!read&&(!configured||!csrf))throw Error('执行服务未配置或连接校验已失效，请先重新检查连接。');
  if(['prepare','confirm'].includes(action)&&!connected)throw Error('未连接交易账户，当前只能查看真实行情。');
  let payload=input===undefined?{}:input;
  if(!read&&(!payload||typeof payload!=='object'||Array.isArray(payload)))throw Error('账户请求格式无效');
  if(action==='connect'&&(Object.keys(payload).some(k=>!['apiKey','apiSecret','tradingEnabled'].includes(k))||typeof payload.apiKey!=='string'||!payload.apiKey.trim()||payload.apiKey.length>512||typeof payload.apiSecret!=='string'||!payload.apiSecret||payload.apiSecret.length>2048||payload.tradingEnabled!==true))throw Error('请本人填写 API Key、Secret，并明确同意仅交易权限。');
  try{
   const response=await fetchImpl('/api/execution/'+action,{method:read?'GET':'POST',credentials:'same-origin',cache:'no-store',redirect:'error',headers:{accept:'application/json',...(!read?{'content-type':'application/json','X-Strategy-CSRF':csrf}:{})},...(!read?{body:JSON.stringify(payload)}:{}),signal:AbortSignal.timeout(action==='confirm'?25000:15000)});
   let body;try{body=await response.json();}catch{throw Error('执行服务未返回可核验结果');}
   if(response.status===401)clear();
   if(!response.ok||body?.ok===false){const error=Error(action==='connect'?'连接未通过，请核对密钥权限及执行服务状态。':String(body?.error?.message||body?.reason||'账户操作未完成，请检查状态。'));error.code=body?.error?.code;throw error;}
   const value=body?.ok===true&&Object.hasOwn(body,'data')?body.data:body;
   if(action==='status'){
    configured=value?.brokerConfigured===true;connected=value?.connected===true;
    csrf=configured&&typeof value.csrf==='string'&&/^[A-Za-z0-9_-]{16,256}$/.test(value.csrf)?value.csrf:'';
   }
   return value;
  }catch(error){if(action==='confirm')error.unknownOutcome=true;throw error;}
  finally{if(action==='connect'){payload.apiKey='';payload.apiSecret='';}if(action==='disconnect')clear();}
 }
 return {readonly:false,api,disconnect:()=>api('disconnect',{}),clear};
}

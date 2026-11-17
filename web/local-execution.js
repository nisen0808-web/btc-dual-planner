const ORIGIN='http://127.0.0.1:8788',KEY='deribit-local-session-v1';
export function createLocalExecutionClient(onChange=()=>{}){
  let session=null,setupWindow=window.opener||null,timer=null;
  try{const saved=JSON.parse(sessionStorage.getItem(KEY)||'null');if(saved&&typeof saved.token==='string'&&saved.token.length===43&&Number.isSafeInteger(saved.expiresAt)&&saved.expiresAt>Date.now()&&saved.expiresAt-Date.now()<=28800000)session=saved;}catch{}
  const clear=()=>{session=null;try{sessionStorage.removeItem(KEY);}catch{}onChange();};
  const paired=()=>!!session&&session.expiresAt>Date.now();
  window.addEventListener('message',event=>{
    if(event.origin!==ORIGIN||!setupWindow||event.source!==setupWindow)return;
    const d=event.data;
    if(d?.type==='deribit-local-site-ready'&&d.ready!==true){event.source.postMessage({type:'deribit-local-site-ready',ready:true},ORIGIN);return;}
    if(d?.type!=='deribit-local-paired'||typeof d.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(d.token)||!Number.isSafeInteger(d.expiresAt)||d.expiresAt<=Date.now()||d.expiresAt-Date.now()>28800000)return;
    session={token:d.token,expiresAt:d.expiresAt};try{sessionStorage.setItem(KEY,JSON.stringify(session));}catch{}
    clearInterval(timer);timer=null;onChange();
  });
  function connect(){
    setupWindow=window.open(ORIGIN+'/connect','deribit-local-setup');
    if(!setupWindow)return false;
    clearInterval(timer);let attempts=0;
    timer=setInterval(()=>{if(++attempts>60||setupWindow.closed){clearInterval(timer);timer=null;return;}setupWindow.postMessage({type:'deribit-local-site-ready',ready:true},ORIGIN);},500);
    return true;
  }
  async function api(action,input){
    if(!['status','plans','prepare','confirm','pause'].includes(action))throw Error('本机接口不存在。');
    if(!paired()){
      if(action==='status')return {status:'local_pair_required',platform:'deribit',currency:'USDC',canSubmit:false,runnerOnline:false,accountVerified:false,reason:'请先连接本机 Deribit 执行器。'};
      if(action==='plans')return [];
      throw Error('请先连接本机 Deribit 执行器。');
    }
    const response=await fetch(ORIGIN+'/v1/'+action,{method:input?'POST':'GET',mode:'cors',credentials:'omit',cache:'no-store',headers:{Authorization:'Bearer '+session.token,'X-Strategy-Local':'deribit-v1',...(input?{'Content-Type':'application/json'}:{})},body:input?JSON.stringify(input):undefined,signal:AbortSignal.timeout(25000)});
    if(response.status===401){clear();throw Error('本机会话已过期，请重新连接。');}
    const result=await response.json();if(!response.ok||result?.status==='unavailable')throw Error(result?.reason||'本机执行器尚未通过核验，请先检查原订单。');return result;
  }
  return {connect,api,paired,disconnect:clear};
}

import {prepareExecutionIntent,executionFingerprint} from './execution-plan.js';
import {createLocalExecutionClient} from './local-execution.js';

const $=id=>document.getElementById(id);
const format=(value,digits=2)=>Number(value).toLocaleString('zh-CN',{maximumFractionDigits:digits});
const timestamp=value=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Singapore',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value));
const currency=context=>context?.market?.platform==='deribit'?'USDC':'USDT';
const reasons=items=>items.map(item=>typeof item==='string'?item:item?.message||'执行条件未通过核验').join('；');
function rows(target,values){
  target.replaceChildren(...values.flatMap(([name,value])=>{
    const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=name;dd.textContent=value;return [dt,dd];
  }));
}

export function mountExecutionUI(getContext,onPolicyChange){
  let draft=null,preparing=false,confirming=false,statusGeneration=0,connection={status:'not_configured',canSubmit:false,runnerOnline:false};
  const dialog=$('executionDialog');
  const local=createLocalExecutionClient(()=>refreshStatus());
  const ready=()=>connection.canSubmit===true&&connection.runnerOnline===true&&connection.accountVerified===true&&getContext()?.market?.platform===(connection.platform||'bybit');
  const api=async(action,body)=>{
    if($('platform').value==='deribit')return local.api(action,body);
    const response=await fetch('/api/execution/'+action,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(25000)});
    const data=await response.json();if(!response.ok||data?.status==='unavailable')throw Error(data?.reason||'执行服务暂不可用，请先对账。');return data;
  };
  const fingerprint=context=>executionFingerprint({platform:context?.market?.platform,amount:context?.amount,strike:context?.contract?.strike,expiry:context?.contract?.expires,symbol:context?.contract?.symbol})+'|'+$('buyBufferRate').value;
  const message=text=>{const p=document.createElement('p');p.textContent=text;return p;};
  const showRequirements=()=>{
    draft=null;$('executionDialogTitle').textContent='一次连接，以后每笔确认';
    const steps=document.createElement('ol');steps.className='connection-requirements';
    for(const item of [
      '使用专用子账户，单独存放本策略的稳定币；避免与其他衍生品仓位共用保证金。',
      '在本机设置页输入 Deribit 子账户 Client ID 和 Client Secret。凭证以 Windows 账户加密保存，不发送到线上站点。仅使用交易、账户读取权限，关闭提现和划转权限。',
      '本机执行器持续跟踪委托和到期流程。浏览器关闭后继续运行，电脑需要保持开机联网；重启后先读取原订单并对账。',
      '先完成测试环境的部分成交、断线恢复和真实到期接币验证，再启用实盘。'
    ]){const li=document.createElement('li');li.textContent=item;steps.append(li);}
    $('executionDialogBody').replaceChildren(steps,message('首次先连接测试账户，完成实际到期流程验证后才允许开启实盘。线上页面只保留短效本机会话，账户密钥始终留在这台电脑。'));
    $('executionQuoteCountdown').textContent='连接完成后，每笔重新预检余额、数量、最低卖价及接币规则。';
    $('executionDialogDisclaimer').textContent='当前仅查看连接要求，没有提交订单或启用自动接币。';
    $('confirmExecution').textContent='交易账户与执行器尚未就绪';$('confirmExecution').disabled=true;
    if(!dialog.open)dialog.showModal();
  };
  const updateDraftValidity=()=>{
    if(!draft||!dialog.open)return;
    const current=getContext(),changed=draft.uiFingerprint!==fingerprint(current),left=Math.max(0,Math.ceil(Math.min(draft.expiresAt-Date.now(),30000-(performance.now()-draft.receivedMono))/1000));
    $('executionQuoteCountdown').textContent=changed?'接币条件或价格保护已变化，请关闭并重新生成。':left?'本次委托预览剩余 '+left+' 秒，过期后需重新准备。':'本次委托预览已过期，请关闭并重新生成。';
    $('confirmExecution').disabled=confirming||!(ready()&&draft.serverPrepared&&!changed&&left>0);
  };
  const prepare=async()=>{
    if(preparing)return;
    const context=getContext();
    const orderLinkId='sp-'+crypto.randomUUID().replaceAll('-','').slice(0,30);
    const preparedFingerprint=fingerprint(context);let result,serverPrepared=false;
    preparing=true;$('prepareExecution').disabled=true;
    try{
      if(ready()){
        result=await api('prepare',{amount:context.amount,symbol:context.contract.symbol,buyBufferRate:Number($('buyBufferRate').value)});serverPrepared=true;
      }else result=prepareExecutionIntent({...context,now:Date.now(),orderLinkId});
    }catch(error){$('executionAvailability').textContent=error.message;return;}
    finally{preparing=false;render();}
    if(preparedFingerprint!==fingerprint(getContext())){$('executionAvailability').textContent='接币条件已变化，请重新生成执行单。';return;}
    if(!result?.valid){$('executionAvailability').textContent=reasons(result?.errors||result?.blockers||['当前条件不能生成执行单']);return;}
    draft={...result,serverPrepared,receivedMono:performance.now(),uiFingerprint:preparedFingerprint};
    const m=context.model,cur=currency(context),c=context.contract;
    $('executionDialogTitle').textContent='检查本次执行单';
    const dl=document.createElement('dl');dl.className='dialog-ticket';
    rows(dl,[['投入资金上限',format(result.amount??context.amount)+' '+cur],['接币条件',format(result.strike??c.strike)+' '+cur+' · '+timestamp(result.expiry??c.expires)+' SGT'],['卖出数量',format(result.q??m.q,8)+' BTC'],['最低委托卖价',result.orderPayload?.price?format(result.orderPayload.price)+' '+cur+' / BTC':'交易规则尚未核验'],['全额备资＋费用＋缓冲',format(result.fullFundReserve??m.reserve)+' '+cur],['当前盘口预计净权利金',format(result.estimatedNetIncome??m.netIncome)+' '+cur]]);
    const p=message('到期规则：以交易所最终结算价判断。低于或等于接币价时，在结算价上方 '+format(m.buyBufferRate*100)+'% 内限价买入；最多等待 5 分钟，超价或状态不明时暂停。按实际成交数量接币，不重复发送状态未明的订单。');
    const blockers=message(serverPrepared?'确认将提交这笔卖 PUT 委托，并授权按上述规则处理到期接币。成交数量与收入以交易所回报为准。':'当前未通过账户和执行器核验。确认卖出按钮保持关闭；委托草案不是实际订单。');
    $('executionDialogBody').replaceChildren(dl,message('最低卖价约束每 BTC 的权利金。若只部分成交，本次收入和后续接币数量都按实际成交量缩减。'),p,blockers);
    if(result.blockers?.length)$('executionDialogBody').append(message(reasons(result.blockers)));
    if(serverPrepared)$('executionDialogBody').prepend(message(connection.environment==='testnet'?'测试环境 · 使用测试资金，不会在真实账户下单。':'实盘环境 · 确认后将提交真实交易订单。'));
    $('confirmExecution').textContent=serverPrepared?'确认卖 PUT，并启用本笔到期接币':'账户连接并验证后，才可确认卖 PUT';$('confirmExecution').disabled=true;
    $('executionDialogDisclaimer').textContent=serverPrepared?'确认仅针对这一笔冻结的委托与接币规则；实际成交后由常驻执行器跟踪。':'当前仅生成执行草案，没有提交订单，也没有启用到期接币。';
    if(!dialog.open)dialog.showModal();updateDraftValidity();
  };
  const render=()=>{
    const context=getContext(),m=context?.model,cur=currency(context);
    $('connectLocalExecution').hidden=$('platform').value!=='deribit';
    $('executionConnection').textContent=ready()?'账户已核验 · 执行器在线':connection.runnerOnline&&connection.accountVerified?'执行器在线 · 新单暂停':connection.runnerOnline?'账户待核验':'交易账户未连接';
    $('executionGlobalStatus').textContent=$('executionConnection').textContent;
    $('executionGlobalHint').textContent=ready()?'每笔确认后执行':connection.accountVerified?'已有策略由执行器跟踪':'当前不会提交任何交易';
    $('prepareExecution').disabled=preparing||!m?.valid||!context?.contract||!context?.book;
    $('executionDraftLabel').textContent=m?.valid?'报价草案 · 尚未提交':'等待有效行情';
    if(!m?.valid){rows($('executionTicketValues'),[['选择接币条件后自动生成','—']]);updateDraftValidity();return;}
    rows($('executionTicketValues'),[
      ['卖出 PUT 数量',format(m.q,8)+' BTC'],['接币本金预留',format(m.capital)+' '+cur],['费用预留',format(m.feeReserve)+' '+cur],['接币价差缓冲',format(m.buyBufferReserve)+' '+cur],['备资合计',format(m.reserve)+' '+cur],['未占用余款',format(m.freeCash)+' '+cur],['预计净权利金',format(m.netIncome)+' '+cur]
    ]);
    $('executionAvailability').textContent=ready()?'执行器在线，确认前将重新核验账户资金和真实委托条件。':connection.status==='not_configured'?'执行账户与常驻执行器未连接，当前可准备和检查委托。真实下单与到期自动接币尚未启用。':'执行服务状态未通过校验，真实下单保持关闭。';
    if(context?.market?.platform==='deribit')$('executionAvailability').textContent=ready()?(connection.environment==='testnet'?'本机执行器在线 · Deribit 测试环境。每笔确认后才提交测试订单。':'本机执行器在线 · Deribit USDC 实盘。每笔确认后才执行。'):(connection.reason||'请连接本机 Deribit 执行器，并完成账户、资金和交易权限核验。');
    updateDraftValidity();
  };
  $('prepareExecution').addEventListener('click',prepare);
  $('showConnectionRequirements').addEventListener('click',showRequirements);
  $('connectLocalExecution').addEventListener('click',()=>{if(!local.connect())$('executionAvailability').textContent='请允许打开本机设置页 http://127.0.0.1:8788/connect，并先启动本机执行器。';});
  $('platform').addEventListener('change',()=>{connection={status:'not_configured',canSubmit:false,runnerOnline:false};draft=null;refreshStatus();});
  $('closeExecutionDialog').addEventListener('click',()=>dialog.close());
  $('confirmExecution').addEventListener('click',async()=>{
    updateDraftValidity();if($('confirmExecution').disabled||!draft?.serverPrepared)return;
    confirming=true;$('confirmExecution').disabled=true;
    try{
      const result=await api('confirm',{id:draft.id,fingerprint:draft.fingerprint,account:draft.account,currency:draft.currency,confirmed:true});
      if(result?.id!==draft.id||!['put_submitting','put_reconciling','unknown','needs_attention','holding','no_fill'].includes(result.phase))throw Error('执行服务未返回本笔订单的可核对记录。');
      draft=null;$('executionDialogTitle').textContent='委托已进入对账流程';
      $('executionDialogBody').replaceChildren(message('执行服务已接收本笔确认，正在核实交易所订单与成交。受理不等于成交，请在本笔策略记录中查看实际数量和费用。'));
      $('executionQuoteCountdown').textContent='状态：'+(result.phase||result.status||'等待对账');$('confirmExecution').textContent='已确认，等待成交对账';
      $('executionDialogDisclaimer').textContent='请在策略记录中核对实际成交；订单结果不明时先对账。';refreshStatus();
    }catch(error){draft=null;$('executionQuoteCountdown').textContent=error.message+' 请先检查策略记录和交易所订单，不要重复提交。';}
    finally{confirming=false;}
  });
  $('buyBufferRate').addEventListener('change',()=>{draft=null;if(dialog.open)dialog.close();onPolicyChange();});
  const refreshPlans=async()=>{
    try{
      const result=await api('plans'),plans=Array.isArray(result)?result:result.plans;
      if(!Array.isArray(plans)||!plans.length)return;
      const states={put_submitting:'正在提交卖 PUT',put_reconciling:'核对 PUT 成交',unknown:'订单未知，等待对账',holding:'PUT 持仓中',settlement_pending:'等待最终结算',spot_ready:'准备到期接币',spot_submitting:'正在提交现货买入',spot_reconciling:'核对现货成交',spot_unknown:'现货订单等待对账',complete_cash:'已完成，保留稳定币',complete_btc:'已完成，BTC 已接入',needs_attention:'暂停，需检查处理',no_fill:'未成交，备资已释放'};
      const target=$('executionPositions');target.hidden=false;
      target.replaceChildren(...plans.slice(0,8).map(plan=>{
        const item=document.createElement('div'),name=document.createElement('strong'),detail=document.createElement('p');
        name.textContent=states[plan.phase]||'等待执行器核对';
        const coin=plan.currency==='USDC'?'USDC':'USDT';
        detail.textContent=(plan.orderPayload?.symbol||plan.symbol||'BTC PUT')+' · PUT 实成交 '+format(plan.filledQty||0,8)+' BTC'+(plan.gross!=null?' · 实收权利金 '+format(plan.gross)+' '+coin+' · 开仓费 '+format(plan.openFee||0)+' '+coin:'')+(plan.receivedBTC!=null?' · 净接币 '+format(plan.receivedBTC,8)+' BTC':'')+(plan.automationPaused?' · 后续自动接币已暂停，已成交持仓仍保留':'');item.append(name,detail);
        if(plan.id&&!plan.closed&&!plan.automationPaused){
          const pause=document.createElement('button');pause.type='button';pause.className='execution-secondary';pause.textContent='暂停后续自动接币（保留持仓）';
          pause.addEventListener('click',async()=>{pause.disabled=true;try{await api('pause',{id:plan.id});await refreshPlans();}catch{detail.textContent+=' · 暂停请求未确认，请检查执行器状态。';}});item.append(pause);
        }
        return item;
      }));
    }catch{}
  };
  const refreshStatus=()=>{
    const generation=++statusGeneration,platform=$('platform').value;
    return api('status').then(status=>{if(generation!==statusGeneration||platform!==$('platform').value)return;connection=typeof status?.canSubmit==='boolean'?status:{status:'unverified',canSubmit:false};render();refreshPlans();}).catch(()=>{if(generation!==statusGeneration||platform!==$('platform').value)return;connection={status:'unavailable',canSubmit:false};render();});
  };
  refreshStatus();setInterval(refreshStatus,10000);
  setInterval(updateDraftValidity,1000);
  return {render};
}

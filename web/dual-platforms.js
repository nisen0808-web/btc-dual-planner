import {compareDual} from './dual.js';
import {compareOKXDual} from './okx-dual.js';
import {compareBinanceDual} from './binance-dual.js';

export const dualPlatforms = [
  {id:'bybit',name:'Bybit',url:'https://www.bybit.com/en/earn/dual-asset'},
  {id:'binance',name:'Binance 普通双币',url:'https://www.binance.com/en/dual-investment'},
  {id:'binance_rfq',name:'Binance 双币大额投资（RFQ）',url:'https://www.binance.com/en/dual-investment-rfq',reason:'按当次金额、接币价和到期日独立询价；尚未取得已授权的 RFQ 报价通道。'},
  {id:'okx',name:'OKX',url:'https://www.okx.com/earn/dual'}
];

// Public quotes are read through the server; no credentials are collected here.
// Missing quotes never become zero-return products, and RFQ stays independent.
export function platformComparisons(amount,put,data,now=Date.now(),bookTime=null,okxData=null,binanceData=null) {
  return dualPlatforms.map(platform=>{
    if(platform.id==='binance_rfq')return {...platform,status:'rfq_required',valid:false};
    const snapshot=platform.id==='okx'?okxData:platform.id==='binance'?binanceData:data;
    const result=platform.id==='okx'?compareOKXDual(amount,put,snapshot,now):platform.id==='binance'?compareBinanceDual(amount,put,snapshot,now):compareDual(amount,put,snapshot,now);
    if(!result.valid)return {...platform,...result,status:snapshot?.status==='loading'?'loading':result.status||'unavailable'};
    if(bookTime!=null&&Math.abs(Number(bookTime)-Number(snapshot?.serverTime))>30000)
      return {...platform,status:'unavailable',valid:false,reason:'两边报价时间相差超过 30 秒，刷新后再比较。'};
    return {...platform,...result,status:result.estimateOnly?'estimate':'ready'};
  });
}

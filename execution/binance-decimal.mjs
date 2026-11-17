// Exact monetary arithmetic shared by the local Binance adapter and runner.
export const SCALE=10n**18n;
export function units(value,signed=false){
  let text=typeof value==='number'&&Number.isFinite(value)?String(value):value;
  if(typeof text==='string'&&/[eE]/.test(text)){
    const [mantissa,exponent]=text.toLowerCase().split('e'),negative=mantissa.startsWith('-'),[whole,fraction='']=(negative?mantissa.slice(1):mantissa).split('.'),digits=whole+fraction,point=whole.length+Number(exponent);
    if(!Number.isSafeInteger(point)||Math.abs(point)>40)throw Error('Invalid decimal');
    text=(negative?'-':'')+(point<=0?'0.'+'0'.repeat(-point)+digits:point>=digits.length?digits+'0'.repeat(point-digits.length):digits.slice(0,point)+'.'+digits.slice(point));
  }
  if(typeof text!=='string'||!(signed?/^-?(?:0|[1-9]\d{0,14})(?:\.\d{1,18})?$/:/^(?:0|[1-9]\d{0,14})(?:\.\d{1,18})?$/).test(text))throw Error('Invalid decimal');
  const negative=text.startsWith('-'),[whole,fraction='']=(negative?text.slice(1):text).split('.');
  return (negative?-1n:1n)*(BigInt(whole)*SCALE+BigInt(fraction.padEnd(18,'0')));
}
export function decimal(value){const negative=value<0n,digits=(negative?-value:value).toString().padStart(19,'0');return (negative?'-':'')+(digits.slice(0,-18)+'.'+digits.slice(-18)).replace(/\.?0+$/,'');}
export const multiply=(a,b)=>a*b/SCALE;
export const multiplyUp=(a,b)=>(a*b+SCALE-1n)/SCALE;
export const closeMoney=(a,b)=>{const d=units(a,true)-units(b,true);return (d<0n?-d:d)<=10000000000n;};
export const fresh=(stamp,now,ttl=30000)=>Number.isSafeInteger(stamp)&&stamp>0&&stamp<=now+2000&&now-stamp<ttl;
export const isId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(value);
export const optionSymbol=value=>typeof value==='string'&&/^BTC-\d{6}-\d+(?:\.\d+)?-P$/.test(value);

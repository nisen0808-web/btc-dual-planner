// One bounded check of the currently documented public options index stream.
// This is not an order API and does not accept an upstream URL or credentials.
export function createBinanceCloudCheck({fetchImpl=(...args)=>fetch(...args),now=Date.now,timeout=8000}={}){
 const source='https://fstream.binance.com/market/ws/!index@arr';
 let cached=null,pending=null;
 async function check(){
  if(cached&&now()-cached.checkedAt<60000)return cached;
  if(pending)return pending;
  pending=(async()=>{
   const started=now();let socket;
   try{
    const response=await fetchImpl(source,{method:'GET',headers:{Upgrade:'websocket'},redirect:'manual',signal:AbortSignal.timeout(timeout)});
    if(response.status!==101||!response.webSocket)return {status:'unavailable',source,upstreamStatus:response.status,checkedAt:now(),reason:'官方公开实时通道未接受云端连接'};
    socket=response.webSocket;
    const result=await new Promise(resolve=>{
     let done=false;const finish=value=>{if(done)return;done=true;clearTimeout(timer);resolve(value);};
     const timer=setTimeout(()=>finish({status:'unavailable',reason:'官方实时通道未在时限内返回有效 BTC 指数'}),timeout);
     socket.addEventListener('message',event=>{
      if(typeof event.data!=='string'||event.data.length>262144)return;
      let data;try{data=JSON.parse(event.data);}catch{return;}
      const rows=Array.isArray(data)?data:Array.isArray(data?.data)?data.data:[];
      const row=rows.find(x=>x.e==='indexPrice'&&x.s==='BTCUSDT');
      if(!row||!Number.isSafeInteger(row.E)||row.E>now()+2000||now()-row.E>=30000||!/^\d+(?:\.\d+)?$/.test(String(row.p))||!(Number(row.p)>0))return;
      finish({status:'ready',symbol:'BTCUSDT',indexPrice:row.p,exchangeTime:row.E});
     });
     socket.addEventListener('error',()=>finish({status:'unavailable',reason:'官方实时通道连接失败'}));
     socket.addEventListener('close',()=>finish({status:'unavailable',reason:'官方实时通道在收到有效指数前关闭'}));
     socket.accept();
    });
    return {...result,source,upstreamStatus:101,checkedAt:now(),elapsedMs:now()-started};
   }catch{return {status:'unavailable',source,upstreamStatus:null,checkedAt:now(),reason:'云端无法连接官方实时通道'};}
   finally{try{socket?.close(1000,'read complete');}catch{}}
  })();
  try{cached=await pending;return cached;}finally{pending=null;}
 }
 return async request=>{
  const url=new URL(request.url);
  if(request.method!=='GET'||url.search)return Response.json({status:'unavailable',reason:'仅接受无参数 GET'},{status:400});
  return Response.json(await check(),{headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
 };
}

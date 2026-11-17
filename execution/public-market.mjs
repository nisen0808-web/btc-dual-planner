const HOSTS=new Set(['https://api.bybit.com','https://api-testnet.bybit.com']);
const positive=value=>Number.isFinite(Number(value))&&Number(value)>0;
export function createBybitPublicMarket({baseUrl='https://api.bybit.com',fetchImpl=fetch}={}){
  if(!HOSTS.has(baseUrl))throw Error('Unsupported exchange host');
  const read=async(path,params)=>{
    const url=baseUrl+path+'?'+new URLSearchParams(params);
    const response=await fetchImpl(url,{method:'GET',redirect:'manual',credentials:'omit',signal:AbortSignal.timeout(10000),headers:{Accept:'application/json'}});
    if(!response.ok||!response.headers.get('content-type')?.includes('application/json'))throw Error('Public market data is unavailable');
    const body=await response.json();if(body?.retCode!==0||!body.result||!positive(body.time))throw Error('Public market data is invalid');return body;
  };
  return {
    async prepare(input){
      if(!/^BTC-\d{1,2}[A-Z]{3}\d{2}-\d+(?:\.\d+)?-P-USDT$/.test(input?.symbol||''))throw Error('A BTC USDT PUT symbol is required');
      const [instruments,depth]=await Promise.all([read('/v5/market/instruments-info',{category:'option',symbol:input.symbol}),read('/v5/market/orderbook',{category:'option',symbol:input.symbol,limit:'25'})]);
      const spec=instruments.result.list?.find(x=>x.symbol===input.symbol),book={bids:depth.result.b?.map(x=>({price:Number(x[0]),qty:Number(x[1])})),time:Number(depth.result.ts)};
      if(!spec||spec.status!=='Trading'||spec.optionsType!=='Put'||spec.baseCoin!=='BTC'||spec.quoteCoin!=='USDT'||spec.settleCoin!=='USDT'||!positive(spec.deliveryTime)||![spec.lotSizeFilter?.qtyStep,spec.lotSizeFilter?.minOrderQty,spec.lotSizeFilter?.maxOrderQty,spec.priceFilter?.tickSize].every(positive)||!Array.isArray(book.bids)||!positive(book.time))throw Error('Option instrument rules are incomplete');
      const quote=await read('/v5/market/tickers',{category:'option',symbol:input.symbol}),index=Number(quote.result.list?.find(x=>x.symbol===input.symbol)?.indexPrice);
      if(!positive(index))throw Error('Option index price is unavailable');
      const expiry=Number(spec.deliveryTime),delivery=new Date(expiry).getUTCDay()===5?Number(spec.deliveryFeeRate):0;
      if(!Number.isFinite(delivery)||delivery<0)throw Error('Option delivery fee is unavailable');
      const contract={symbol:spec.symbol,strike:Number(spec.symbol.split('-')[2]),expires:expiry,step:Number(spec.lotSizeFilter.qtyStep),min:Number(spec.lotSizeFilter.minOrderQty),max:Number(spec.lotSizeFilter.maxOrderQty),priceTick:Number(spec.priceFilter.tickSize),taker:.0003,cap:.125,delivery,spot:.001,spotDeductBase:true};
      return {contract,book,market:{platform:'bybit',spot:index,time:Number(depth.time)},spec:{...spec,strike:String(contract.strike),validated:true,category:'option'}};
    },
    async spot(){
      const [instruments,tickers]=await Promise.all([read('/v5/market/instruments-info',{category:'spot',symbol:'BTCUSDT'}),read('/v5/market/tickers',{category:'spot',symbol:'BTCUSDT'})]);
      const spec=instruments.result.list?.find(x=>x.symbol==='BTCUSDT'),ask=Number(tickers.result.list?.find(x=>x.symbol==='BTCUSDT')?.ask1Price);
      if(!spec||spec.status!=='Trading'||spec.baseCoin!=='BTC'||spec.quoteCoin!=='USDT'||!positive(ask)||!positive(spec.priceFilter?.tickSize)||!positive(spec.lotSizeFilter?.basePrecision))throw Error('Spot price or trading rules are unavailable');
      return {spec:{...spec,validated:true,category:'spot'},ask,time:Number(tickers.time)};
    }
  };
}

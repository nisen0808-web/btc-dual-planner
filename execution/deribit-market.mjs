const HOSTS=new Set(['https://www.deribit.com','https://test.deribit.com']);
const positive=value=>Number.isFinite(Number(value))&&Number(value)>0;
const SYMBOL=/^BTC_USDC-\d{1,2}[A-Z]{3}\d{2}-\d+(?:d\d+|\.\d+)?-P$/;
export const DERIBIT_FEE_POLICY=Object.freeze({optionFeeCap:'0.125',deliveryReserveRate:'0.00015',source:'https://support.deribit.com/hc/en-us/articles/25944746248989-Fees',checkedOn:'2026-10-23'});

/** Public metadata only. No key, session, account request, or trading method. */
export function createDeribitPublicMarket({baseUrl='https://test.deribit.com',fetchImpl=fetch,now=Date.now}={}){
  if(!HOSTS.has(baseUrl)||typeof fetchImpl!=='function'||typeof now!=='function')throw Error('Unsupported public market configuration');
  const read=async(method,params)=>{
    const url=new URL(baseUrl+'/api/v2/public/'+method);for(const [key,value]of Object.entries(params))url.searchParams.set(key,String(value));
    const response=await fetchImpl(url.href,{method:'GET',credentials:'omit',redirect:'manual',headers:{Accept:'application/json'},signal:AbortSignal.timeout(10000)});
    if(!response.ok||!response.headers.get('content-type')?.includes('application/json'))throw Error('Deribit public data unavailable');
    const body=await response.json();if(body?.jsonrpc!=='2.0'||body.error||!Object.hasOwn(body,'result'))throw Error('Invalid Deribit public response');return body.result;
  };
  async function instrument(symbol,kind){
    // Extended instrument list supplies commission caps that get_instrument can omit.
    const rows=await read('get_instruments',{currency:kind==='spot'?'any':'USDC',kind,expired:false,extended:true});
    const matches=Array.isArray(rows)?rows.filter(row=>row.instrument_name===symbol):[];
    if(matches.length!==1)throw Error('Instrument metadata is missing or ambiguous');const spec=matches[0];
    const current=await read('get_instrument',{instrument_name:symbol});
    if(current?.instrument_name!==symbol||current.state!=='open'||current.is_active!==true||current.kind!==kind||current.base_currency!=='BTC'||current.quote_currency!=='USDC'||current.instrument_type!=='linear'||!positive(current.min_trade_amount)||!positive(current.tick_size)||!positive(current.contract_size))throw Error('Instrument is not open or rules are incomplete');
    return {...spec,...current,validated:true};
  }
  async function spot(){
    const [spec,depth]=await Promise.all([instrument('BTC_USDC','spot'),read('get_order_book',{instrument_name:'BTC_USDC',depth:10})]);
    if(depth?.instrument_name!=='BTC_USDC'||depth.state!=='open'||!positive(depth.timestamp)||!Array.isArray(depth.asks)||!positive(depth.asks[0]?.[0]))throw Error('Spot ask is unavailable');
    return {spec,ask:String(depth.asks[0][0]),time:Number(depth.timestamp)};
  }
  return {environment:baseUrl.includes('test.')?'testnet':'mainnet',
    async prepare(input){
      if(!SYMBOL.test(input?.symbol||''))throw Error('A BTC USDC PUT instrument is required');
      const [spec,depth,spotData]=await Promise.all([instrument(input.symbol,'option'),read('get_order_book',{instrument_name:input.symbol,depth:100}),spot()]);
      if(spec.option_type!=='put'||spec.settlement_currency!=='USDC'||!positive(spec.strike)||!Number.isSafeInteger(spec.expiration_timestamp)||spec.expiration_timestamp<=now()||spec.contract_size!==1||depth?.instrument_name!==spec.instrument_name||depth.state!=='open'||!positive(depth.timestamp)||!positive(depth.index_price)||!Array.isArray(depth.bids))throw Error('Linear BTC PUT identity or depth is incomplete');
      const cap=Number(spec.taker_max_commission??DERIBIT_FEE_POLICY.optionFeeCap);if(!Number.isFinite(cap)||cap<=0||cap>1||!Number.isFinite(Number(spec.taker_commission))||!Number.isFinite(Number(spotData.spec.taker_commission)))throw Error('Official instrument fee metadata is incomplete');
      // Conservative delivery reserve: daily exemptions only reduce the actual debit.
      const contract={symbol:spec.instrument_name,strike:Number(spec.strike),expires:spec.expiration_timestamp,step:Number(spec.min_trade_amount),min:Number(spec.min_trade_amount),priceTick:String(spec.tick_size),taker:Number(spec.taker_commission),cap,delivery:.00015,spot:Number(spotData.spec.taker_commission),spotDeductBase:false};
      return {spec,spotSpec:spotData.spec,feePolicy:DERIBIT_FEE_POLICY,contract,book:{bids:depth.bids.map(row=>({price:Number(row[0]),qty:Number(row[1])})),time:depth.timestamp},market:{platform:'deribit',currency:'USDC',spot:Number(depth.index_price),time:depth.timestamp},environment:this.environment};
    },spot,
    async settlement({symbol,expiry,indexName='btc_usdc'}){
      if(!SYMBOL.test(symbol||'')||!Number.isSafeInteger(expiry)||expiry>now()||indexName!=='btc_usdc'||new Date(expiry).getUTCHours()!==8||expiry%86400000!==28800000)throw Error('Unsupported delivery identity');
      const result=await read('get_delivery_prices',{index_name:indexName,offset:0,count:1000});
      const date=new Date(expiry).toISOString().slice(0,10),rows=result?.data?.filter(row=>row.date===date);
      if(!Array.isArray(rows)||rows.length!==1||!positive(rows[0].delivery_price))throw Error('Official final delivery price is not yet available');
      return {symbol,expiry,indexName,price:String(rows[0].delivery_price),final:true,source:'public/get_delivery_prices',checkedAt:now()};
    }
  };
}

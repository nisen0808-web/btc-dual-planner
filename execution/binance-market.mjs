import {units,decimal,SCALE,fresh,optionSymbol} from './binance-decimal.mjs';

export const BINANCE_FEE_POLICY=Object.freeze({optionTakerRate:'0.00024',optionFeeCap:'0.1',deliveryReserveRate:'0.00015',deliveryFeeCap:'0.1',spotReferenceRate:'0.001',source:'https://www.binance.com/en/support/faq/detail/5326e5de61c34fed98abe28d2f175a23',checkedOn:'2026-10-23',accountRatesRequired:true});
const positive=v=>units(v)>0n;
function one(rows,predicate){const result=Array.isArray(rows)?rows.filter(predicate):[];if(result.length!==1)throw Error('Official metadata is missing or ambiguous');return result[0];}
export function validateBinanceOptionSpec(raw,contract){
  if(!optionSymbol(raw?.symbol)||raw.side!=='PUT'||raw.underlying!=='BTCUSDT'||raw.quoteAsset!=='USDT'||Number(raw.unit)!==1||!Number.isSafeInteger(raw.expiryDate)||!positive(raw.strikePrice)||!contract||contract.underlying!=='BTCUSDT'||contract.baseAsset!=='BTC'||contract.quoteAsset!=='USDT'||contract.settleAsset!=='USDT')throw Error('Only BTC USDT cash-settled linear PUT is supported');
  const match=raw.symbol.match(/^BTC-(\d{2})(\d{2})(\d{2})-(\d+(?:\.\d+)?)-P$/),expected=Date.UTC(2000+Number(match?.[1]),Number(match?.[2])-1,Number(match?.[3]),8);
  if(!match||expected!==raw.expiryDate||units(match[4])!==units(raw.strikePrice))throw Error('Official instrument identity mismatch');
  const price=one(raw.filters,r=>r.filterType==='PRICE_FILTER'),lotRows=raw.filters.filter(r=>r.filterType==='LOT_SIZE'),lot=lotRows.length===1?lotRows[0]:lotRows.length===0?price:null;
  if(!lot||!positive(price.tickSize)||!positive(lot.stepSize)||!positive(raw.minQty??lot.minQty)||!positive(raw.maxQty??lot.maxQty))throw Error('Official option quantity/price rules unavailable');
  // Live exchangeInfo has two schemas. Preserve which official record grants
  // permission; an explicit symbol-level false always overrides its parent.
  const permitted=raw.nakedSell===true||raw.nakedSell===undefined&&contract.nakedSell===true;
  const sellPermission={allowed:permitted,scope:raw.nakedSell===undefined?'underlying':'symbol',value:raw.nakedSell===undefined?contract.nakedSell:raw.nakedSell,source:'https://eapi.binance.com/eapi/v1/exchangeInfo',underlying:'BTCUSDT'};
  return {symbol:raw.symbol,side:'PUT',underlying:'BTCUSDT',quoteAsset:'USDT',settleAsset:'USDT',unit:1,strikePrice:decimal(units(raw.strikePrice)),expiryDate:raw.expiryDate,minQty:decimal(units(raw.minQty??lot.minQty)),maxQty:decimal(units(raw.maxQty??lot.maxQty)),stepSize:decimal(units(lot.stepSize)),tickSize:decimal(units(price.tickSize)),status:raw.status,nakedSell:raw.nakedSell,sellPermission,validated:true};
}
export function validateBinanceSpotSpec(raw){
  if(raw?.symbol!=='BTCUSDT'||raw.status!=='TRADING'||raw.baseAsset!=='BTC'||raw.quoteAsset!=='USDT'||raw.isSpotTradingAllowed!==true||!Array.isArray(raw.orderTypes)||!raw.orderTypes.includes('LIMIT'))throw Error('BTC USDT spot trading is not available');
  const price=one(raw.filters,r=>r.filterType==='PRICE_FILTER'),lot=one(raw.filters,r=>r.filterType==='LOT_SIZE'),notional=one(raw.filters,r=>['NOTIONAL','MIN_NOTIONAL'].includes(r.filterType));
  for(const value of [price.tickSize,lot.minQty,lot.maxQty,lot.stepSize,notional.minNotional])if(!positive(value))throw Error('Spot rules incomplete');
  return {symbol:'BTCUSDT',status:'TRADING',baseAsset:'BTC',quoteAsset:'USDT',minQty:decimal(units(lot.minQty)),maxQty:decimal(units(lot.maxQty)),stepSize:decimal(units(lot.stepSize)),tickSize:decimal(units(price.tickSize)),minNotional:decimal(units(notional.minNotional)),validated:true};
}
/** Unauthenticated, fixed official hosts, no exchange credentials. */
export function createBinancePublicMarket({fetchImpl=fetch,now=Date.now}={}){
  if(typeof fetchImpl!=='function'||typeof now!=='function')throw Error('Invalid Binance market configuration');
  async function read(host,path,params={}){const url=new URL(host+path);for(const [key,value]of Object.entries(params))url.searchParams.set(key,String(value));const response=await fetchImpl(url.href,{method:'GET',credentials:'omit',redirect:'manual',headers:{Accept:'application/json'},signal:AbortSignal.timeout(10000)});if(!response.ok||!response.headers.get('content-type')?.includes('application/json'))throw Error('Official Binance market unavailable');const body=await response.json();if(typeof body?.code==='number'&&body.code<0)throw Error('Official Binance market rejected');return body;}
  async function spot(){
    const started=now(),[metadata,depth,clock]=await Promise.all([read('https://api.binance.com','/api/v3/exchangeInfo',{symbol:'BTCUSDT'}),read('https://api.binance.com','/api/v3/depth',{symbol:'BTCUSDT',limit:100}),read('https://api.binance.com','/api/v3/time')]);
    if(!fresh(clock.serverTime,now(),5000)||now()-started>=5000||!Array.isArray(depth.asks)||depth.asks.length===0)throw Error('Spot ask unavailable or delayed');
    const asks=depth.asks.map(row=>({price:decimal(units(row[0])),qty:decimal(units(row[1]))}));if(asks.some(r=>!positive(r.price)||!positive(r.qty)))throw Error('Invalid spot depth');
    return {spec:validateBinanceSpotSpec(one(metadata.symbols,r=>r.symbol==='BTCUSDT')),asks,ask:asks[0].price,time:clock.serverTime,receivedAt:now()};
  }
  return {environment:'mainnet',spot,
    async prepare({symbol}={}){
      if(!optionSymbol(symbol))throw Error('Only a real BTC USDT PUT symbol is supported');
      const [metadata,depth,index,spotData]=await Promise.all([read('https://eapi.binance.com','/eapi/v1/exchangeInfo'),read('https://eapi.binance.com','/eapi/v1/depth',{symbol,limit:1000}),read('https://eapi.binance.com','/eapi/v1/index',{underlying:'BTCUSDT'}),spot()]);
      const spec=validateBinanceOptionSpec(one(metadata.optionSymbols,r=>r.symbol===symbol),one(metadata.optionContracts,r=>r.underlying==='BTCUSDT'));
      if(spec.expiryDate<=now()||!fresh(depth.T,now())||!fresh(index.time,now())||!positive(index.indexPrice)||!Array.isArray(depth.bids))throw Error('Option data is stale or incomplete');
      return {spec,spotSpec:spotData.spec,book:{bids:depth.bids.map(row=>({price:decimal(units(row[0])),qty:decimal(units(row[1]))})),time:depth.T},market:{platform:'binance',currency:'USDT',spot:decimal(units(index.indexPrice)),time:index.time},feePolicy:BINANCE_FEE_POLICY,environment:'mainnet'};
    },
    async settlement({symbol,expiry}={}){
      if(!optionSymbol(symbol)||!Number.isSafeInteger(expiry)||expiry>now())throw Error('Invalid settlement identity');
      const rows=await read('https://eapi.binance.com','/eapi/v1/exerciseHistory',{underlying:'BTCUSDT',startTime:expiry-1,endTime:expiry+1,limit:100});
      if(!Array.isArray(rows)||rows.length>=100)throw Error('Settlement history incomplete');const row=one(rows,r=>r.symbol===symbol&&r.expiryDate===expiry);
      if(!positive(row.realStrikePrice)||!['REALISTIC_VALUE_STRICKEN','EXTRINSIC_VALUE_EXPIRED'].includes(row.strikeResult))throw Error('Official final settlement unavailable');
      return {symbol,expiry,price:decimal(units(row.realStrikePrice)),strikePrice:decimal(units(row.strikePrice)),result:row.strikeResult,final:true,checkedAt:now(),source:'https://eapi.binance.com/eapi/v1/exerciseHistory'};
    }
  };
}

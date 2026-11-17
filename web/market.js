export const platforms={
 deribit:{label:'Deribit · USDC 期权',currency:'USDC',taker:.0003,cap:.125,delivery:.00015,spot:.0005,feeUrl:'https://support.deribit.com/hc/en-us/articles/25944746248989-Fees',tradeUrl:'https://www.deribit.com/options/BTC_USDC'},
 bybit:{label:'Bybit · USDT 期权',currency:'USDT',taker:.0003,cap:.07,delivery:.00015,spot:.001,feeUrl:'https://www.bybit.com/en/help-center/article/Bybit-Option-Fees-Explained',tradeUrl:'https://www.bybit.com/trade/option/usdt/BTC'}
};
const feeSources={
 deribit:{opening:platforms.deribit.feeUrl,delivery:platforms.deribit.feeUrl,spot:'https://support.deribit.com/hc/en-us/articles/31424969480093-Spot-Instruments'},
 bybit:{opening:platforms.bybit.feeUrl,delivery:platforms.bybit.feeUrl,spot:'https://www.bybit.com/en/help-center/article/Bybit-Spot-Fees-Explained'}
};
const feeMetadata=id=>({feeSourceURLs:{...feeSources[id]},feeCheckedAt:'2026-10-23',feeTier:'公开普通账户 / 当前公开接口',openingRateSource:'published_standard',spotRateSource:'published_standard'});
function publicRate(value){
 if(typeof value!=='number'&&typeof value!=='string'||typeof value==='string'&&!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))return null;
 const rate=Number(value);return Number.isFinite(rate)&&rate>=0&&rate<=1?rate:null;
}
async function json(url){const r=await fetch(url,{signal:AbortSignal.timeout(18000),credentials:'omit'});if(!r.ok)throw Error('公开接口返回 '+r.status);const d=await r.json();if(d.error||d.retCode)throw Error(d.error?.message||d.retMsg||'平台返回错误');return d;}
let specsCache={};
const spotSpecsCache={};
async function loadSpotSpec(id){
 const cached=spotSpecsCache[id];if(cached&&Date.now()-cached.at<300000)return cached.spec;
 try{
  const data=await json(id==='deribit'?'https://www.deribit.com/api/v2/public/get_instrument?instrument_name=BTC_USDC&extended=true':'https://api.bybit.com/v5/market/instruments-info?category=spot&symbol=BTCUSDT');
  const row=id==='deribit'?data.result:data.result?.list?.find(x=>x.symbol==='BTCUSDT');
  if(!row||id==='deribit'&&(row.instrument_name!=='BTC_USDC'||row.base_currency!=='BTC'||row.quote_currency!=='USDC'))return {};
  const step=Number(id==='deribit'?row.min_trade_amount:row.lotSizeFilter?.basePrecision),min=Number(id==='deribit'?row.min_trade_amount:row.lotSizeFilter?.minOrderQty),notional=Number(id==='deribit'?0:row.lotSizeFilter?.minOrderAmt);
  if(!(step>0&&step<=1&&min>0))return {};
  const fee=publicRate(row.taker_commission);
  const spec={spotStep:step,spotMin:min,spotMinNotional:Number.isFinite(notional)&&notional>=0?notional:0,...(id==='deribit'&&fee!==null?{spot:fee,spotRateSource:'public_instrument'}:{})};
  spotSpecsCache[id]={at:Date.now(),spec};return spec;
 }catch{return {};}
}
export async function loadSpot(){const d=await json('https://api.coinbase.com/v2/prices/BTC-USD/spot');const p=Number(d.data?.amount);if(!(p>0))throw Error('价格数据无效');return{price:p,source:'Coinbase BTC/USD',time:Date.now()};}
export async function loadMarket(id){
 if(!platforms[id])throw Error('不支持的平台');
 if(id==='deribit'){
  const root='https://www.deribit.com/api/v2/public/';
  const specTask=specsCache.deribit&&Date.now()-specsCache.deribit.time<300000?Promise.resolve(specsCache.deribit.data):json(root+'get_instruments?currency=USDC&kind=option&expired=false&extended=true').then(d=>{specsCache.deribit={time:Date.now(),data:d};return d;});
  const [specs,books,index,spotSpec]=await Promise.all([specTask,json(root+'get_book_summary_by_currency?currency=USDC&kind=option'),json(root+'get_index_price?index_name=btc_usdc'),loadSpotSpec(id)]);
  const map=new Map(books.result.map(x=>[x.instrument_name,x]));const now=books.usOut?books.usOut/1000:Date.now();
  const contracts=specs.result.filter(x=>x.instrument_name.startsWith('BTC_USDC-')&&x.option_type==='put'&&x.is_active&&(!x.state||x.state==='open')&&x.expiration_timestamp>now).map(x=>{const b=map.get(x.instrument_name)||{},taker=publicRate(x.taker_commission),daily=x.settlement_period==='day',classification=daily?'daily':typeof x.settlement_period==='string'&&x.settlement_period.trim()?x.settlement_period:'unknown';return{...feeMetadata(id),symbol:x.instrument_name,strike:Number(x.strike),expires:Number(x.expiration_timestamp),bid:Number(b.bid_price)||0,ask:Number(b.ask_price)||0,step:Number(x.min_trade_amount)||.01,min:Number(x.min_trade_amount)||.01,priceTick:Number(x.tick_size),taker:taker??.0003,openingRateSource:taker===null?'published_standard':'public_instrument',cap:.125,delivery:daily?0:.00015,deliveryRateSource:daily?'published_daily_exemption':'published_standard',deliveryExemptionConfirmed:daily,deliveryClassification:classification,spot:.0005,bidSize:null};});
  for(const contract of contracts)Object.assign(contract,{deliveryCap:.125,spotDeductBase:false},spotSpec);
  const price=Number(index.result?.index_price);if(!contracts.length||!(price>0))throw Error('该平台暂无可读取的 BTC USDC PUT');
  return{contracts,spot:price,source:'Deribit BTC/USDC 指数',time:now,platform:id};
 }
 const root='https://api.bybit.com/v5/market/';
 const specTask=specsCache.bybit&&Date.now()-specsCache.bybit.time<300000?Promise.resolve(specsCache.bybit.data):json(root+'instruments-info?category=option&baseCoin=BTC&limit=1000').then(d=>{specsCache.bybit={time:Date.now(),data:d};return d;});
 const [specs,books,spotSpec]=await Promise.all([specTask,json(root+'tickers?category=option&baseCoin=BTC'),loadSpotSpec(id)]);
 const map=new Map(books.result.list.map(x=>[x.symbol,x])),now=Number(books.time)||Date.now();
 const contracts=specs.result.list.filter(x=>x.optionsType==='Put'&&x.status==='Trading'&&x.settleCoin==='USDT'&&Number(x.deliveryTime)>now).map(x=>{const b=map.get(x.symbol)||{},delivery=publicRate(x.deliveryFeeRate);return{...feeMetadata(id),symbol:x.symbol,strike:Number(x.symbol.split('-')[2]),expires:Number(x.deliveryTime),bid:Number(b.bid1Price)||0,ask:Number(b.ask1Price)||0,step:Number(x.lotSizeFilter?.qtyStep)||.01,min:Number(x.lotSizeFilter?.minOrderQty)||.01,priceTick:Number(x.priceFilter?.tickSize),taker:.0003,cap:.07,delivery:delivery??.00015,deliveryRateSource:delivery===null?'published_standard':'public_instrument',deliveryExemptionConfirmed:false,deliveryClassification:'unknown',spot:.001,spotDeductBase:true,bidSize:Number(b.bid1Size)||0,index:Number(b.indexPrice)||0};});
 for(const contract of contracts)Object.assign(contract,{cap:.07,deliveryCap:.125},spotSpec);
 const price=contracts.find(c=>c.index>0)?.index;if(!contracts.length||!(price>0))throw Error('该平台暂无可读取的 BTC USDT PUT');
 return{contracts,spot:price,source:'Bybit BTC/USDT 指数',time:now,platform:id};
}

export async function loadBook(id,symbol){
 if(id==='deribit'){
  const d=await json('https://www.deribit.com/api/v2/public/get_order_book?instrument_name='+encodeURIComponent(symbol)+'&depth=20');
  return{bids:d.result.bids.map(x=>({price:Number(x[0]),qty:Number(x[1])})),time:Number(d.result.timestamp)||Date.now()};
 }
 const d=await json('https://api.bybit.com/v5/market/orderbook?category=option&symbol='+encodeURIComponent(symbol)+'&limit=25');
 return{bids:d.result.b.map(x=>({price:Number(x[0]),qty:Number(x[1])})),time:Number(d.result.ts)||Date.now()};
}

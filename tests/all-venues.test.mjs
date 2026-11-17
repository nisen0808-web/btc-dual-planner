import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeAllVenues } from '../web/all-venues.js';

const now=Date.UTC(2026,10,16,8),expires=now+86_400_000,strike=65_000,direction='CALL';
const fx={btcTime:now,btcUSDT:65_000,usdcTime:now,usdcUSDT:.98};
const selection={direction,strike,expires,fx,now};
const options={
  binance:{valid:true,symbol:'BTC-261117-65000-C',income:100,coin:'USDT',quoteTime:now},
  gate:{valid:true,symbol:'BTC_USDT-20261117-65000-C',income:100,coin:'USDT',quoteTime:now,conditional:true},
  coinbase:{valid:true,symbol:'BTC_USDC-17NOV26-65000-C',income:101,coin:'USDC',quoteTime:now},
  okx:{valid:true,symbol:'BTC-USD-261117-65000-C',income:.001,coin:'BTC',quoteTime:now},
  bitget:{valid:false,reason:'尚未核实普通期权盘口'}
};
const product={valid:true,venue:'gate',direction,strike,expires,productId:'88',income:.0012,coin:'BTC',quoteTime:now,termEstimated:true};
const duals={gate:product,bitget:{...product,venue:'bitget',income:.0013}};
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);

test('all platforms compare unchanged native incomes in one currency, retain ties and explicit coverage',()=>{
  const {options:o,duals:d}=summarizeAllVenues({...selection,options,duals});
  assert.deepEqual(o.best,['binance','gate']); assert.equal(o.available,4);assert.equal(o.comparable,4); assert.equal(o.total,5);
  assert.equal(o.rows.bitget.reason,'尚未核实普通期权盘口');assert.equal(o.rows.bitget.incomeUSDT,null);
  assert.deepEqual(d.best,['bitget']); assert.equal(d.coin,'BTC'); close(o.rows.coinbase.incomeUSDT,98.98);
  close(o.rows.coinbase.incomeBTC,98.98/65_000); close(o.rows.binance.delta.amount,100-.0013*65_000);
  assert.deepEqual(d.rows.gate.delta.against,['binance','gate']); close(d.rows.gate.delta.amount,.0012*65_000-100);
  assert.equal(d.rows.gate.delta.estimated,true);
});
test('stale or unavailable cross rates retain only comparable native figures and withhold cross-currency deltas',()=>{
  const {options:o,duals:d}=summarizeAllVenues({...selection,fx:{usdcTime:now-30_000,usdcUSDT:1.07},options,duals});
  assert.equal(o.comparable,2);assert.equal(o.rows.coinbase.best,false); assert.match(o.rows.coinbase.reason,/汇率/);
  assert.equal(o.rows.binance.delta,null);assert.equal(o.rows.coinbase.incomeUSDT,null);
  assert.deepEqual(d.best,['bitget']);close(o.rows.okx.delta.amount,-.0003);assert.equal(o.rows.okx.delta.coin,'BTC');
});
test('exact terms exclude different strikes, dates, venues, reversed sides, expired quotes, and unverified net incomes',()=>{
  const q={...options.gate},d={...product};
  for(const change of [{symbol:'BTC_USDT-20261117-66000-C'},{symbol:'BTC_USDT-20261118-65000-C'},{direction:'PUT'},{quoteTime:now-30_000},{income:null},{venue:'okx'}]) {
    const s=summarizeAllVenues({...selection,options:{gate:{...q,...change}}});assert.deepEqual(s.options.best,[]);assert.equal(s.options.available,0);
  }
  assert.equal(summarizeAllVenues({...selection,duals:{gate:{...d,venue:'bitget'}}}).duals.available,0);
  assert.equal(summarizeAllVenues({...selection,duals:{gate:{...d,expires:expires+1}}}).duals.available,0);
});
test('native comparables must also have synchronized quotes and never borrow an unavailable counterpart',()=>{
  const {options:o,duals:d}=summarizeAllVenues({...selection,options:{gate:{...options.gate,quoteTime:now-29_000},
    binance:{...options.binance,quoteTime:now+1_500}},duals:{bitget:{valid:false,reason:'读取超时'}}});
  assert.equal(o.available,2);assert.equal(o.comparable,1);assert.deepEqual(o.best,['binance']);assert.equal(o.rows.gate.delta,null);
  assert.equal(d.available,0);assert.deepEqual(d.best,[]);
});
test('two individually valid FX snapshots too far apart cannot be combined in a ranking or difference',()=>{
  const snapshot={...selection,fx:{btcUSDT:65_000,btcTime:now+1_800,usdcUSDT:.98,usdcTime:now-29_300}};
  const {options:o}=summarizeAllVenues({...snapshot,options:{coinbase:options.coinbase,okx:options.okx},duals});
  assert.deepEqual(o.best,['okx']);assert.equal(o.comparable,1);
  assert.equal(o.rows.coinbase.delta,null);assert.match(o.rows.coinbase.reason,/30 秒/);
});

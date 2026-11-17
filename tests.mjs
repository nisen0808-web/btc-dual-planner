import test from 'node:test';
import assert from 'node:assert/strict';
import { calculate } from './web/calc.js';

const now = Date.UTC(2026, 9, 22, 8);
const contract = { symbol:'BTC-29OCT26-90000-P',strike:90000,expires:now+7*86400000,bid:900,step:.01,min:.01,taker:.0003,cap:.125,delivery:.00015,spot:.0005 };
const book = { bids:[{price:900,qty:1}],time:now };
const calc = (A=10000,c=contract,b=book,S=100000,T=now,ST=100000) => calculate(A,c,b,S,T,ST);
const near = (a,b,t=1e-7) => assert.ok(Math.abs(a-b)<t,`${a} != ${b}`);

test('execution price-gap buffer reduces funded size and is never charged as an actual fee',()=>{
  const base=calculate(10000,contract,book,100000,now,70000,0);
  const buffered=calculate(10000,contract,book,100000,now,70000,.02);
  assert.equal(buffered.valid,true);assert.ok(buffered.q<base.q);
  near(buffered.buyBufferReserve,buffered.q*contract.strike*.02);
  near(buffered.reserve,buffered.capital+buffered.feeReserve+buffered.buyBufferReserve);
  assert.ok(buffered.reserve<=10000);
  const sameSize=calculate(10000,contract,{...book,bids:[{price:900,qty:buffered.q}]},100000,now,70000,0);
  // Compare per-unit realized economics: unused protection cash stays in the account.
  near(buffered.pnl/buffered.q,base.pnl/base.q);
  near(buffered.totalFee/buffered.q,base.totalFee/base.q);
  for(const rate of [-.1,.051,NaN,Infinity])assert.equal(calculate(10000,contract,book,100000,now,70000,rate).valid,false);
});

test('sizes within a single amount and does not spend the premium as collateral',()=>{
  const m=calc(); assert.equal(m.valid,true);near(m.q,.11);near(m.capital,9900);
  near(m.gross,99);near(m.openFee,3.3);near(m.feeReserve,9.735);near(m.reserve,9909.735);
  near(m.unused,100);near(m.freeCash,90.265);near(m.netIncome,95.7);
  near(m.term,.00957);near(m.annual,.00957*365/7);near(m.assets,10095.7);
});
test('uses visible bid levels and per-fill fee caps, never mark or ask',()=>{
  const b={bids:[{price:100,qty:.05},{price:50,qty:.2}],time:now};
  const m=calc(10000,contract,b);assert.equal(m.valid,true);near(m.q,.11);
  near(m.gross,8);near(m.averagePrice,8/.11);near(m.openFee,1);assert.equal(m.levelsUsed,2);
});
test('insufficient bid depth returns a readable error instead of a fabricated fill',()=>{
  const m=calc(10000,contract,{bids:[{price:900,qty:.05}],time:now});
  assert.equal(m.valid,false);assert.match(m.errors[0],/深度不足/);
});
test('settlement and subsequent spot purchase balance without double-charging fees',()=>{
  const m=calc(10000,contract,book,100000,now,70000);
  near(m.payout,2200);near(m.deliveryFee,1.155);near(m.spotFee,3.85);near(m.totalFee,8.305);
  near(m.assets,7890.695);near(m.pnl,-2109.305);near(m.btcReceived,.11);near(m.cash,190.695);
  near(m.assets,m.cash+m.btcReceived*70000);near(m.actualCost,90000+(8.305-99)/.11);
});
test('at the strike the planned purchase still happens, without intrinsic payout or delivery fee',()=>{
  const m=calc(10000,contract,book,100000,now,90000);
  assert.equal(m.willBuy,true);near(m.payout,0);near(m.deliveryFee,0);near(m.spotFee,4.95);
  near(m.btcReceived,.11);near(m.assets,m.cash+9900);
});
test('zero-price stress loses committed principal but does not invent an infinite loss',()=>{
  const m=calc(10000,contract,book,100000,now,0);
  near(m.payout,9900);near(m.deliveryFee,0);near(m.spotFee,0);near(m.assets,195.7);
  near(m.cash,195.7);near(m.pnl,-9804.3);assert.equal(m.zeroPriceStress,true);
});
test('delivery fee is capped by intrinsic value close to the strike',()=>{
  const m=calc(10000,contract,book,100000,now,89999);
  near(m.deliveryFee,.125*.11);assert.ok(m.totalFee<=m.feeReserve+1e-8);
});
test('daily-contract zero delivery rate is respected',()=>{
  const m=calc(10000,{...contract,delivery:0},book,100000,now,70000);
  near(m.deliveryFee,0);assert.ok(m.reserve<=10000);
});
test('decimal quantity steps do not over-allocate at boundaries',()=>{
  const c={...contract,strike:100,step:.01,min:.01,taker:0,delivery:0,spot:0};
  const m=calc(30,c,{bids:[{price:1,qty:10}],time:now},100,now,110);
  near(m.q,.3);near(m.reserve,30);near(m.freeCash,0);near(m.cash,30.3);
});
test('fee cap can make one extra minimum step affordable',()=>{
  const c={...contract,strike:100,step:.01,min:.01,taker:.01,delivery:0,spot:0};
  const m=calc(30,c,{bids:[{price:.01,qty:10}],time:now},100,now,110);
  near(m.q,.29);assert.ok(m.reserve<=30); // 0.30 would need 30.000375 including fees.
});
test('invalid amount, expired contract, absent bids, and budget below minimum are rejected',()=>{
  for(const A of ['',0,-1,Infinity,NaN,1e20]) assert.equal(calc(A).valid,false,`A=${A}`);
  assert.equal(calc(10000,{...contract,expires:now}).valid,false);
  assert.equal(calc(10000,contract,{bids:[{price:0,qty:100}],time:now}).valid,false);
  assert.equal(calc(100).valid,false);
  assert.equal(calc(10000,contract,book,0).valid,false);
  assert.equal(calc(10000,contract,book,100000,now,-1).valid,false);
});
test('stale bids are rejected and zero-price levels are ignored',()=>{
  assert.equal(calc(10000,contract,{...book,time:now-181000}).valid,false);
  const m=calc(10000,contract,{bids:[{price:0,qty:100},{price:900,qty:1}],time:now});
  assert.equal(m.valid,true);near(m.gross,99);
});
test('base-deducted spot fees reduce received BTC, not the remaining stablecoin a second time',()=>{
  const c={...contract,spot:.001,spotDeductBase:true};
  const m=calc(10000,c,book,100000,now,70000);
  near(m.q,.11);near(m.btcReceived,.10989);near(m.spotFee,7.7);
  near(m.assets,7886.845);near(m.cash,194.545);
  near(m.assets,m.cash+m.btcReceived*70000);
  near(m.cash,10000+m.gross-m.capital-m.openFee-m.deliveryFee);
});
test('base-deducted net costs use net BTC and exclude a duplicate spot-fee charge',()=>{
  const c={...contract,spot:.001,spotDeductBase:true};
  const m=calc(10000,c,book,100000,now,70000);
  near(m.cost,(m.capital+m.openFee+c.delivery*c.strike*m.q-m.gross)/m.btcReceived);
  near(m.actualCost,(m.capital+m.openFee+m.deliveryFee-m.gross)/m.btcReceived);
  const high=calc(10000,c,book,100000,now,100000);
  near(high.btcReceived,0);near(high.spotFee,0);near(high.cash,high.assets);
});

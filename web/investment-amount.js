import { rawAmount } from './amount-input.js';

const positive = value => Number.isFinite(value) && value > 0;
const places = {BTC:8, USDT:6};
const displayFormats = {
  BTC: new Intl.NumberFormat('en-US', {maximumFractionDigits: places.BTC}),
  USDT: new Intl.NumberFormat('en-US', {maximumFractionDigits: places.USDT})
};

function decimalFraction(value) {
  const [mantissa, exponent = '0'] = String(value).toLowerCase().split('e');
  const scale = (mantissa.split('.')[1] || '').length - Number(exponent);
  const digits = BigInt(mantissa.replace('.', ''));
  return [digits * 10n ** BigInt(Math.max(0, -scale)), 10n ** BigInt(Math.max(0, scale))];
}

// Truncate to the displayed currency precision before sending the budget to any venue.
function convertedBudget(entered, rate, toUnit) {
  const [amount, amountScale] = decimalFraction(entered);
  const [price, priceScale] = decimalFraction(rate);
  const numerator = toUnit === 'BTC' ? amount * priceScale : amount * price;
  const denominator = toUnit === 'BTC' ? amountScale * price : amountScale * priceScale;
  const digits = numerator * 10n ** BigInt(places[toUnit]) / denominator;
  return Number(digits.toString() + 'e-' + places[toUnit]);
}

export function investmentAmounts(state, nativeUnit, fx, now) {
  const raw = rawAmount(state.amount);
  const entered = Number(raw);
  const fresh = Number.isSafeInteger(fx?.btcTime) && fx.btcTime > 0 &&
    fx.btcTime <= now + 2_000 && now - fx.btcTime < 30_000 && positive(fx.btcUSDT);
  const rate = fresh ? fx.btcUSDT : null;
  const otherUnit = state.amountUnit === 'BTC' ? 'USDT' : 'BTC';
  const convertedUnit = state.enteredUnit === 'BTC' ? 'USDT' : 'BTC';
  const converted = positive(entered) && rate ? convertedBudget(raw.length <= 120 ? raw : entered,rate,convertedUnit) : NaN;
  function valueIn(unit) {
    if (!positive(entered)) return NaN;
    if (unit === state.enteredUnit) return entered;
    return positive(converted) ? converted : NaN;
  }
  const displayed = valueIn(state.amountUnit);
  const display = state.amountUnit === state.enteredUnit ? state.amount :
    positive(displayed) ? displayFormats[state.amountUnit].format(displayed) : '';
  return {
    display, rate, time: fresh ? fx.btcTime : null, otherUnit, equivalent: valueIn(otherUnit),
    native: positive(displayed) ? valueIn(nativeUnit) : NaN,
    missingRate: positive(entered) && !rate && (nativeUnit !== state.enteredUnit || state.amountUnit !== state.enteredUnit)
  };
}

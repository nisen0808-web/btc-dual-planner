const percentFormat = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 4, useGrouping: false, signDisplay: 'exceptZero'
});
const priceFormat = new Intl.NumberFormat('en-US', {maximumFractionDigits: 2});

export function withTargetDirection(text, side) {
  const value = text.normalize('NFKC').trim().replace(/%$/, '').trim().replace(/^−/, '-');
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) || Number(value) === 0) return value;
  return (side === 'PUT' ? '-' : '+') + value;
}

export function parseTargetPercent(text) {
  const value = text.normalize('NFKC').trim().replace(/%$/, '').trim().replace(/^−/, '-');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return NaN;
  const percent = Number(value);
  return Number.isFinite(percent) && percent > -100 ? percent : NaN;
}

export function targetPriceAtPercent(spot, percent) {
  if (!Number.isFinite(spot) || spot <= 0 || !Number.isFinite(percent) || percent <= -100) return '';
  const price = spot * (1 + percent / 100);
  if (!Number.isFinite(price) || price < 0.005 || price > Number.MAX_SAFE_INTEGER) return '';
  return priceFormat.format(price);
}

export function targetPercentAtPrice(spot, price) {
  if (![spot, price].every(value => Number.isFinite(value) && value > 0)) return '';
  const percent = (price - spot) / spot * 100;
  return Number.isFinite(percent) ? percentFormat.format(percent) : '';
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTargetPercent, targetPercentAtPrice, targetPriceAtPercent, withTargetDirection } from '../web/target-distance.js';

test('unsigned input follows high sell or low buy, while explicit signs are preserved', () => {
  for (const [side, input, expected] of [
    ['CALL', '5', '+5'], ['PUT', '5', '-5'], ['PUT', '5.5%', '-5.5'], ['PUT', '+2', '+2'],
    ['CALL', '−3', '-3'], ['CALL', '0', '0'], ['PUT', '0.', '0.'], ['PUT', '.5', '-.5'], ['PUT', '', '']
  ]) assert.equal(withTargetDirection(input, side), expected);
});

test('signed target distance uses the current index in either direction', () => {
  for (const [text, price, distance] of [['−5%', '62,700', '-5'], ['＋５％', '69,300', '+5'], ['0', '66,000', '0']]) {
    assert.equal(targetPriceAtPercent(66_000, parseTargetPercent(text)), price);
    assert.equal(targetPercentAtPrice(66_000, Number(price.replaceAll(',', ''))), distance);
  }
  assert.equal(targetPriceAtPercent(65_123.47, 2.5), '66,751.56');
});

test('partial, invalid or unavailable inputs never create a zero or substitute target', () => {
  for (const input of ['', '-', '+', '.', '-100%', '-101', '12%5', '1e3', 'abc']) {
    assert.ok(Number.isNaN(parseTargetPercent(input)));
  }
  for (const spot of [null, 0, -1, Infinity, NaN]) {
    assert.equal(targetPercentAtPrice(spot, 68_000), '');
    assert.equal(targetPriceAtPercent(spot, 5), '');
  }
  assert.equal(targetPriceAtPercent(66_000, -100), '');
  assert.equal(targetPercentAtPrice(66_000, 0), '');
});

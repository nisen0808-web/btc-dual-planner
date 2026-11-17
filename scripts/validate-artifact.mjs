import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [source, manifest] = await Promise.all([
  readFile(new URL('../dist/server/index.js', import.meta.url), 'utf8'),
  readFile(new URL('../dist/.openai/hosting.json', import.meta.url), 'utf8'),
]);
assert.ok(JSON.parse(manifest).project_id);
const workerUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const { default: worker } = await import(workerUrl);
assert.equal(typeof worker.fetch, 'function');

const request = (path, method = 'GET') => worker.fetch(new Request('https://example.test' + path, { method }));
const home = await request('/');
assert.equal(home.status, 200);
assert.match(home.headers.get('content-security-policy'), /form-action 'none'/);
const html = await home.text();
assert.match(html, /comparison-app\.js/);
assert.match(html, /comparison\.css/);
const spotPage = await request('/?view=spot-put');
assert.equal(spotPage.status, 200);
assert.match(spotPage.headers.get('content-security-policy'), /form-action 'none'/);
const spotHtml = await spotPage.text();
assert.match(spotHtml, /spot-put-app\.js/);
assert.doesNotMatch(spotHtml, /comparison-app\.js/);

for (const path of [
  '/api/binance-account/status', '/api/binance-account/connect', '/api/binance-account/verify',
  '/api/execution/order', '/api/binance-snapshot', '/api/binance-cloud-check',
  '/api/bitget/market', '/api/bitget/book',
  '/binance-account.js', '/execution-plan.js', '/execution-ui.js', '/binance-app.js', '/call-app.js',
]) {
  for (const method of ['GET', 'POST']) {
    assert.equal((await request(path, method)).status, 404, method + ' ' + path);
  }
}
for (const path of ['/api/binance-dual', '/api/binance-dual-high', '/api/binance-options/market', '/api/binance-options/book',
  '/api/gate/market', '/api/gate/book', '/api/gate/dual', '/api/bitget/dual',
  '/api/okx/market', '/api/okx/book', '/api/okx/dual', '/api/coinbase/market', '/api/coinbase/book', '/api/quotes/fx']) {
  assert.equal((await request(path, 'POST')).status, 405, 'POST ' + path);
}

// Verify every local browser dependency included by the public entry point can actually load.
const pending = [...(html + spotHtml).matchAll(/(?:src|href)=["']([^"'#]+\.(?:css|js))(?:\?[^"']*)?["']/g)]
  .map(match => new URL(match[1], 'https://example.test/').pathname);
const visited = new Set();
while (pending.length) {
  const path = pending.pop();
  if (visited.has(path)) continue;
  visited.add(path);
  const response = await request(path);
  assert.equal(response.status, 200, 'Referenced asset ' + path);
  if (path.endsWith('.js')) {
    const script = await response.text();
    for (const match of script.matchAll(/(?:from\s*|import\s*)["'](\.\/[^"']+\.js)["']/g)) {
      pending.push(new URL(match[1], 'https://example.test' + path).pathname);
    }
  }
}
console.log('Verified read-only public routes, retired endpoints, and ' + visited.size + ' browser assets');


import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist');
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const publicAssets = [
  'index.html',
  'spot-put.html',
  'spot-put-app.js',
  'spot-put-math.js',
  'comparison.css',
  'comparison-app.js',
  'comparison-math.js',
  'venue-math.js',
  'venue-comparison.js',
  'all-venues.js',
  'venue-insurance.js',
  'venue-details.js',
  'amount-input.js',
  'target-distance.js',
  'investment-amount.js',
  'binance-market.js',
  'binance-dual.js',
  'binance-high-dual.js',
  'binance-desk.js',
  'call-desk.js',
  'put-quote.js',
  'call-quote.js',
];
const publicServices = [
  'binance-options.js',
  'binance-options-cloud.js',
  'binance-dual-cloud.js',
  'binance-high-dual-cloud.js',
  'quote-fx.js',
  'okx-public.js',
  'coinbase-public.js',
  'gate-public.js',
  'bitget-public.js',
  'index.js',
];

const assets = await Promise.all(publicAssets.map(async file => {
  const source = await readFile(join(root, 'web', file), 'utf8');
  return ['/' + file, [mime[extname(file)], source]];
}));
const services = await Promise.all(publicServices.map(file => readFile(join(root, 'worker', file), 'utf8')));
const manifest = await readFile(join(root, '.openai', 'hosting.json'), 'utf8');
if (JSON.parse(manifest).static) throw Error('Comparison site requires worker hosting');
const worker = 'const assets = new Map(' + JSON.stringify(assets) + ');\n' + services.join('\n');

await rm(output, { recursive: true, force: true });
await mkdir(join(output, 'server'), { recursive: true });
await mkdir(join(output, '.openai'), { recursive: true });
await writeFile(join(output, 'server', 'index.js'), worker);
await writeFile(join(output, '.openai', 'hosting.json'), manifest);
console.log('Built comparison site with ' + assets.length + ' public web assets');


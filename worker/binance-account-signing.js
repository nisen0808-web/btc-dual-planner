// Server-only read-only signing; no credential values belong in this file.
                                 
                                                                                                                      
                                                                                                                       
const LIMIT = 1024 * 1024, TIMEOUT = 8000;
const ROUTES = {
  optionAccount: ['https://eapi.binance.com', '/eapi/v1/marginAccount', {}],
  optionFees: ['https://eapi.binance.com', '/eapi/v1/commission', {}],
  spotAccount: ['https://api.binance.com', '/api/v3/account', {}],
  spotFees: ['https://api.binance.com', '/api/v3/account/commission', {symbol: 'BTCUSDT'}],
  apiRestrictions: ['https://api.binance.com', '/sapi/v1/account/apiRestrictions', {}],
}         ;
                                 
const isObject = (v         )                               => v !== null && typeof v === 'object' && !Array.isArray(v);
const encoder = new TextEncoder();
function flags(raw         , fields          , required           = []) {
  if (!isObject(raw)) throw Error('schema');
  const out                          = {};
  for (const key of fields) {
    if (raw[key] === undefined && !required.includes(key)) continue;
    if (typeof raw[key] !== 'boolean') throw Error('schema');
    out[key] = raw[key];
  }
  return out;
}
function rate(value         )         {
  if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d{0,2})(?:\.\d{1,24})?$/.test(value)) throw Error('schema');
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  if (BigInt(whole) > 1n || whole === '1' && /[1-9]/.test(fraction)) throw Error('schema');
  return value;
}
function normalize(name       , raw         )                          {
  if (!isObject(raw)) throw Error('schema');
  if (name === 'optionAccount') return flags(raw, ['canTrade', 'reduceOnly'], ['canTrade', 'reduceOnly']);
  if (name === 'spotAccount') {
    const out                          = flags(raw, ['canTrade', 'canWithdraw', 'canDeposit'], ['canTrade']);
    if (raw.uid !== undefined) {
      if (typeof raw.uid !== 'string' || !/^\d{1,30}$/.test(raw.uid)) throw Error('schema');
      out.uid = raw.uid;
    }
    return out;
  }
  if (name === 'apiRestrictions') return flags(raw, ['enableReading', 'ipRestrict', 'enableVanillaOptions', 'enableSpotAndMarginTrading', 'permitsUniversalTransfer', 'enableInternalTransfer', 'enableWithdrawals', 'enableMargin', 'enableFutures', 'enablePortfolioMarginTrading', 'enableFixApiTrade', 'enableFixReadOnly'], ['enableReading', 'ipRestrict']);
  if (name === 'optionFees') {
    if (!Array.isArray(raw.commissions) || raw.commissions.length > 1000) throw Error('schema');
    const rows = raw.commissions.filter(r => isObject(r) && r.underlying === 'BTCUSDT');
    if (rows.length !== 1) throw Error('schema');
    return {underlying: 'BTCUSDT', makerFee: rate(rows[0].makerFee), takerFee: rate(rows[0].takerFee)};
  }
  if (raw.symbol !== 'BTCUSDT' || !isObject(raw.discount)) throw Error('schema');
  const out                          = {symbol: 'BTCUSDT'};
  for (const kind of ['standardCommission', 'specialCommission', 'taxCommission']) {
    const row = raw[kind];
    if (!isObject(row)) throw Error('schema');
    out[kind] = Object.fromEntries(['maker', 'taker', 'buyer', 'seller'].map(k => [k, rate(row[k])]));
  }
  const discount                          = flags(raw.discount, ['enabledForAccount', 'enabledForSymbol'], ['enabledForAccount', 'enabledForSymbol']);
  if (typeof raw.discount.discountAsset !== 'string' || !/^[A-Z0-9]{2,16}$/.test(raw.discount.discountAsset)) throw Error('schema');
  discount.discountAsset = raw.discount.discountAsset;
  discount.discount = rate(raw.discount.discount);
  out.discount = discount;
  return out;
}
function pkcs8(pem        )              {
  const match = /^-----BEGIN PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+?)\s+-----END PRIVATE KEY-----\s*$/.exec(pem);
  if (!match) throw Error('key');
  const base64 = match[1].replace(/\s/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64) || !base64) throw Error('key');
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0)).buffer;
}
async function jsonBody(response          )                   {
  if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json' || !response.body) throw Error('body');
  const size = response.headers.get('content-length');
  if (size !== null && (!/^\d+$/.test(size) || Number(size) > LIMIT)) throw Error('body');
  const reader = response.body.getReader(), chunks               = []; let length = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > LIMIT) throw Error('body');
      chunks.push(value);
    }
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  // A Spot UID can exceed JavaScript's safe integer range; keep its decimal text.
  const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes).replace(/("uid"\s*:\s*)(\d{1,30})(?=\s*[,}])/g, '$1"$2"');
  return JSON.parse(text);
}

/** Read-only authentication proof. Local signing success does not prove EAPI accepts this key type. */
export function createBinanceReadOnlyAuth(config        ) {
  if (!isObject(config) || Object.keys(config).some(k => !['apiKey', 'privateKeyPem', 'keyType', 'fetchImpl', 'now'].includes(k)) || typeof config.apiKey !== 'string' || !/^[A-Za-z0-9_-]{8,256}$/.test(config.apiKey) || typeof config.privateKeyPem !== 'string' || config.privateKeyPem.length > 16384 || !['RSA', 'Ed25519'].includes(config.keyType) || config.fetchImpl !== undefined && typeof config.fetchImpl !== 'function' || config.now !== undefined && typeof config.now !== 'function') throw Error('Invalid read-only authentication configuration');
  const {apiKey, privateKeyPem, keyType} = config, fetchImpl = config.fetchImpl ?? fetch, now = config.now ?? Date.now;
  let refused = false, keyPromise                                , queue                   = Promise.resolve();
  const fail = (code        , status         )         => ({ok: false, code, ...(status === undefined ? {} : {status}), refused});
  function key() {
    return keyPromise ??= (async () => {
      const imported = await crypto.subtle.importKey('pkcs8', pkcs8(privateKeyPem), keyType === 'RSA' ? {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'} : {name: 'Ed25519'}, false, ['sign']);
      if (keyType === 'RSA' && (imported.algorithm                   ).modulusLength < 2048) throw Error('key');
      return imported;
    })();
  }
  async function request(name       )                  {
    if (refused) return fail('permanently_refused');
    const controller = new AbortController(); let timer                               ;
    const timeout = new Promise        (resolve => { timer = setTimeout(() => { controller.abort(); resolve(fail('timeout_unknown')); }, TIMEOUT); });
    const operation = (async ()                  => {
      const timestamp = now();
      if (!Number.isSafeInteger(timestamp) || timestamp <= 0) return fail('invalid_clock');
      const [host, path, fixed] = ROUTES[name], query = new URLSearchParams(fixed);
      query.append('timestamp', String(timestamp)); query.append('recvWindow', '5000');
      const payload = query.toString(); let signature             ;
      try { signature = await crypto.subtle.sign(keyType === 'RSA' ? {name: 'RSASSA-PKCS1-v1_5'} : {name: 'Ed25519'}, await key(), encoder.encode(payload)); }
      catch { return fail('invalid_private_key'); }
      if (controller.signal.aborted || refused) return fail(refused ? 'permanently_refused' : 'timeout_unknown');
      query.append('signature', btoa(String.fromCharCode(...new Uint8Array(signature))));
      try {
        const response = await fetchImpl(host + path + '?' + query.toString(), {method: 'GET', headers: {Accept: 'application/json', 'X-MBX-APIKEY': apiKey}, credentials: 'omit', redirect: 'manual', signal: controller.signal});
        if (response.status === 403 || response.status === 451) { refused = true; void response.body?.cancel().catch(() => {}); return fail('access_refused', response.status); }
        if (response.redirected || response.status >= 300 && response.status < 400) { void response.body?.cancel().catch(() => {}); return fail('redirect_rejected', response.status); }
        let raw         ;
        try { raw = await jsonBody(response); } catch { return fail('response_invalid', response.status); }
        if (!response.ok || isObject(raw) && typeof raw.code === 'number' && raw.code < 0) {
          const code = isObject(raw) ? ({'-1022': 'signature_rejected', '-1021': 'timestamp_rejected', '-2014': 'api_key_rejected', '-2015': 'api_permission_rejected'}                          )[String(raw.code)] : undefined;
          return fail(code ?? (response.status >= 500 ? 'response_unknown' : 'exchange_rejected'), response.status);
        }
        try { return {ok: true, data: normalize(name, raw)}; } catch { return fail('schema_invalid', response.status); }
      } catch { return fail(controller.signal.aborted ? 'timeout_unknown' : 'network_unknown'); }
    })();
    try { return await Promise.race([operation, timeout]); } catch { return fail('request_unknown'); }
    finally { clearTimeout(timer ); controller.abort(); }
  }
  // Serial reads make an observed 403/451 stop queued requests as well.
  const read = (name       ) => { const result = queue.then(() => request(name)); queue = result.catch(() => {}); return result; };
  return Object.freeze({optionAccount: () => read('optionAccount'), optionFees: () => read('optionFees'), spotAccount: () => read('spotAccount'), spotFees: () => read('spotFees'), apiRestrictions: () => read('apiRestrictions')});
}

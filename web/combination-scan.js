import { calculateSimulation } from './calc.js';
import { compareDual } from './dual.js';
import { compareBinanceDual } from './binance-dual.js';
import { compareOKXDual } from './okx-dual.js';
import { compareSettlement } from './settlement-comparison.js';
import { computeSettlementLimits } from './settlement-limits.js';

const TTL = 30000;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const positive = value => finite(value) && value > 0;
const coin = value => typeof value === 'string' ? value.toUpperCase() : '';
const optionFor = currency => currency === 'USDT' ? 'bybit' : currency === 'USDC' ? 'deribit' : null;
const compareFor = platform => platform === 'bybit' ? compareDual : platform === 'binance' ? compareBinanceDual : platform === 'okx' ? compareOKXDual : null;
function runCompare(platform, amount, model, data, now) {
  try { return compareFor(platform)(amount, model, data, now); }
  catch { return { valid: false, reason: '双币报价格式异常，无法安全校验' }; }
}
const textOrder = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const receiptAge = (record, now) => positive(record?.receivedAt) && record.receivedAt <= now ? now - record.receivedAt : Infinity;
const fresh = (record, now) => receiptAge(record, now) < TTL;
const matchKey = (currency, strike, expires) => `${currency}|${String(strike)}|${String(expires)}`;
const optionKey = (platform, symbol) => `${platform}|${symbol}`;
const pairId = (platform, symbol, entry) => [platform, symbol, entry.platform, String(entry.id)].map(encodeURIComponent).join('|');
const pairOrder = (a, b) => a.contract.expires - b.contract.expires || a.contract.strike - b.contract.strike ||
  textOrder(a.optionPlatform, b.optionPlatform) || textOrder(a.dualPlatform, b.dualPlatform) || textOrder(String(a.entry.id), String(b.entry.id));

function report() {
  const errors = [], counts = new Map();
  return {
    errors,
    add(code, reason, context = {}) {
      const current = counts.get(code);
      if (current) current.count++; else counts.set(code, { code, count: 1, reason });
      errors.push({ code, reason, ...context });
    },
    reasons: () => [...counts.values()].sort((a, b) => textOrder(a.code, b.code)),
  };
}
function initialStats(markets, entries) {
  return { marketsProvided: Array.isArray(markets) ? markets.length : 0, marketsUsed: 0,
    contractsExamined: 0, activeContracts: 0, entriesProvided: Array.isArray(entries) ? entries.length : 0,
    entriesEligible: 0, exactMatches: 0, candidates: 0, candidateCount: 0, booksProvided: 0,
    evaluatedPairs: 0, rows: 0, rowCount: 0, positiveRows: 0, zeroRows: 0, negativeRows: 0, bestRows: 0,
    expirationOutsideRange: 0 };
}
function coverage(stats) {
  return { scope: 'provided_snapshots', completeMarketCoverage: false, marketsChecked: stats.marketsUsed,
    benchmarkScope: 'current_valid_quotes', maxDays: stats.maxDays,
    contractsChecked: stats.contractsExamined, quoteEntriesChecked: stats.entriesProvided, exactPairsChecked: stats.exactMatches,
    note: '仅覆盖本次传入且校验有效的目录、报价和买盘，不代表已读取全部市场或全部产品。' };
}
function inputProblem(amount, currency, markets, entries, onlyBelowSpot, now, maxDays) {
  if (!(typeof amount === 'number' || typeof amount === 'string' && amount.trim() !== '') || !Number.isFinite(Number(amount)) || Number(amount) <= 0 || Number(amount) > 1e15) return '请填写有效的当次投入资金';
  if (!optionFor(currency)) return '只支持分别以 USDT 或 USDC 计价的 BTC 组合，不能按 1:1 混算';
  if (!Array.isArray(markets) || !Array.isArray(entries)) return '期权目录或双币报价列表格式无效';
  if (!positive(now) || typeof onlyBelowSpot !== 'boolean') return '扫描时刻或接币价筛选条件无效';
  if (maxDays !== null && (!finite(maxDays) || maxDays <= 0 || maxDays > 3650)) return '到期天数上限须为大于 0 且不超过 3650 的数值，或明确选择全部';
  return null;
}
function candidateContext(candidate) {
  return { id: candidate.id, optionPlatform: candidate.optionPlatform, dualPlatform: candidate.dualPlatform,
    symbol: candidate.contract.symbol, entryId: String(candidate.entry.id) };
}

/** Match exact canonical K/T/currency and re-run each original amount/rate validator. No network. */
export function findScanCandidates({ amount, currency, markets = [], entries = [], onlyBelowSpot = true, maxDays = 7, now = Date.now() } = {}) {
  const currencyCode = coin(currency), stats = initialStats(markets, entries), problems = report();
  stats.maxDays = maxDays;
  const problem = inputProblem(amount, currencyCode, markets, entries, onlyBelowSpot, now, maxDays);
  const finish = (valid, candidates) => ({ valid, currency: currencyCode, candidates, stats, maxDays,
    errors: problems.errors, reasons: problems.reasons(), coverage: coverage(stats) });
  if (problem) { problems.add('input_invalid', problem); return finish(false, []); }
  const eligibleMarkets = new Map();
  for (const market of markets) {
    if (market?.platform !== optionFor(currencyCode)) { problems.add('market_currency_mismatch', '该期权平台的结算币种不属于本次扫描'); continue; }
    if (!positive(market.spot) || !positive(market.time) || !Array.isArray(market.contracts)) { problems.add('market_invalid', '期权目录缺少有效指数、时间或合约列表'); continue; }
    if (!fresh(market, now)) { problems.add('market_stale', '期权目录接收后已超过 30 秒或接收时间无效', { optionPlatform: market.platform }); continue; }
    const previous = eligibleMarkets.get(market.platform);
    if (!previous || previous.receivedAt < market.receivedAt || previous.receivedAt === market.receivedAt && previous.time < market.time) eligibleMarkets.set(market.platform, market);
  }
  stats.marketsUsed = eligibleMarkets.size;
  const byConditions = new Map(), entryKeys = new Set();
  const orderedEntries = entries.slice().sort((a, b) => (b?.data?.receivedAt || 0) - (a?.data?.receivedAt || 0) || (b?.data?.serverTime || 0) - (a?.data?.serverTime || 0));
  for (const entry of orderedEntries) {
    if (!compareFor(entry?.platform)) { problems.add('unsupported_dual', 'RFQ 或未接入的双币来源不参与普通双币扫描'); continue; }
    if (coin(entry.currency) !== currencyCode) { problems.add('entry_currency_mismatch', '双币报价的结算币种与本次扫描不同'); continue; }
    if (!positive(entry.strike) || !positive(entry.expires) || !Number.isInteger(entry.expires) || entry.id == null || String(entry.id).trim() === '') { problems.add('entry_invalid', '双币目录缺少精确接币价、到期时间或产品标识'); continue; }
    if (!positive(entry.data?.serverTime) || !fresh(entry.data, now)) { problems.add('quote_stale', '双币目录接收后已超过 30 秒或报价时间无效', { dualPlatform: entry.platform, entryId: String(entry.id) }); continue; }
    const key = matchKey(currencyCode, entry.strike, entry.expires), unique = `${entry.platform}|${String(entry.id)}|${key}`;
    if (entryKeys.has(unique)) { problems.add('duplicate_entry', '同一双币产品重复出现，仅保留最新收到的快照'); continue; }
    entryKeys.add(unique); stats.entriesEligible++;
    const values = byConditions.get(key) || []; values.push(entry); byConditions.set(key, values);
  }
  const candidates = [], contractsSeen = new Set();
  for (const market of eligibleMarkets.values()) {
    const clock = market.time + receiptAge(market, now);
    for (const contract of market.contracts) {
      stats.contractsExamined++;
      const context = { optionPlatform: market.platform, symbol: contract?.symbol };
      if (!contract || typeof contract.symbol !== 'string' || !contract.symbol || !positive(contract.strike) || !positive(contract.expires) || !Number.isInteger(contract.expires) || contract.expires <= clock || !positive(contract.bid) || contract.active === false || contract.is_active === false) {
        problems.add('contract_inactive', '合约已失效、缺少有效买价或不在可用目录内', context); continue;
      }
      const remainingMilliseconds = contract.expires - clock;
      if (maxDays !== null && remainingMilliseconds > maxDays * 86400000) {
        stats.expirationOutsideRange++;
        problems.add('expiration_outside_range', '合约剩余到期时间超过本次天数上限',
          { ...context, remainingDays: remainingMilliseconds / 86400000, maxDays }); continue;
      }
      if (onlyBelowSpot && contract.strike > market.spot) { problems.add('strike_above_spot', '默认仅扫描接币价不高于当前指数价的合约', context); continue; }
      const contractKey = optionKey(market.platform, contract.symbol);
      if (contractsSeen.has(contractKey)) { problems.add('duplicate_contract', '同一 PUT 合约重复出现，仅计算一次', context); continue; }
      contractsSeen.add(contractKey); stats.activeContracts++;
      const matches = byConditions.get(matchKey(currencyCode, contract.strike, contract.expires)) || [];
      if (!matches.length) { problems.add('no_exact_quote', '本次已读取报价中没有相同币种、接币价和到期时刻的双币', context); continue; }
      for (const entry of matches) {
        stats.exactMatches++;
        const candidate = { id: pairId(market.platform, contract.symbol, entry), optionPlatform: market.platform,
          dualPlatform: entry.platform, contract, entry, market, currency: currencyCode,
          remainingDays: remainingMilliseconds / 86400000 };
        const stub = { valid: true, amount: Number(amount), netIncome: 0, days: (contract.expires - clock) / 86400000,
          strike: contract.strike, expires: contract.expires, expiryPrice: contract.strike, currency: currencyCode, settleCoin: currencyCode, assets: Number(amount) };
        const precheck = runCompare(entry.platform, amount, stub, entry.data, now);
        if (!precheck.valid) { problems.add('dual_precheck_failed', precheck.reason || '双币金额、报价或申购规则校验失败', candidateContext(candidate)); continue; }
        candidates.push({ ...candidate, precheck });
      }
    }
  }
  candidates.sort(pairOrder); stats.candidates = stats.candidateCount = candidates.length;
  return finish(true, candidates);
}

/** Recalculate every pair with its actual bid depth and the same relative downside scenario. */
export function rankScanCombinations({ amount, currency, dropRate = 0, gapRate = 0, markets = [], entries = [], books = [], onlyBelowSpot = true, maxDays = 7, now = Date.now() } = {}) {
  const found = findScanCandidates({ amount, currency, markets, entries, onlyBelowSpot, maxDays, now });
  const problems = report();
  for (const error of found.errors) problems.add(error.code, error.reason, Object.fromEntries(Object.entries(error).filter(([key]) => key !== 'code' && key !== 'reason')));
  const stats = { ...found.stats, booksProvided: Array.isArray(books) ? books.length : 0 };
  const finish = (valid, rows) => ({ valid, currency: found.currency, rows, candidates: found.candidates, stats,
    errors: problems.errors, reasons: problems.reasons(), coverage: coverage(stats), dropRate, gapRate, maxDays });
  if (!found.valid) return finish(false, []);
  if (!finite(dropRate) || dropRate < 0 || dropRate > 1 || !finite(gapRate) || gapRate <= -1 || !Array.isArray(books)) {
    problems.add('scenario_invalid', '跌幅须在 0% 至 100% 之间，现货价差须为大于 -100% 的有限数值'); return finish(false, []);
  }
  const byBook = new Map();
  for (const record of books) {
    if (!record || typeof record.platform !== 'string' || typeof record.symbol !== 'string') continue;
    const key = optionKey(record.platform, record.symbol), previous = byBook.get(key);
    if (!previous || (record.receivedAt || 0) > (previous.receivedAt || 0) || record.receivedAt === previous.receivedAt && (record.book?.time || 0) > (previous.book?.time || 0)) byBook.set(key, record);
  }
  const rows = [], strongest = new Map();
  for (const candidate of found.candidates) {
    const { contract, entry, market } = candidate, context = candidateContext(candidate);
    const key = optionKey(candidate.optionPlatform, contract.symbol), bookRecord = byBook.get(key);
    if (!bookRecord) { problems.add('book_missing', '尚未取得此 PUT 的买盘深度，不使用目录买价代替成交测算', context); continue; }
    if (!fresh(bookRecord, now) || !positive(bookRecord.book?.time)) { problems.add('book_stale', '买盘接收后已超过 30 秒或时间无效', context); continue; }
    if (Math.abs(bookRecord.book.time - entry.data.serverTime) > TTL) { problems.add('quote_skew', '期权买盘与双币来源时间相差超过 30 秒，暂不比较', context); continue; }
    stats.evaluatedPairs++;
    const clock = market.time + receiptAge(market, now), scenarioPrice = contract.strike * (1 - dropRate);
    let baseModel;
    try { baseModel = calculateSimulation(amount, contract, bookRecord.book, market.spot, clock, scenarioPrice, 0, gapRate); }
    catch { baseModel = { valid: false, errors: ['买盘或合约字段异常，无法安全计算'] }; }
    if (!baseModel.valid) {
      const reason = baseModel.errors?.[0] || 'PUT 模拟失败';
      problems.add(/深度不足/.test(reason) ? 'depth_insufficient' : 'model_invalid', reason, context); continue;
    }
    const model = { ...baseModel, expires: contract.expires, currency: found.currency, settleCoin: found.currency };
    if (!model.purchaseExecuted) { problems.add('purchase_pending', '此情景尚未模拟成功买入 BTC，不参与净接币排序', context); continue; }
    const dual = runCompare(entry.platform, amount, model, entry.data, now);
    if (!dual.valid) { problems.add('dual_invalid', dual.reason || '双币报价已失效或金额不符合规则', context); continue; }
    const comparison = compareSettlement(model, dual);
    if (!comparison.valid || comparison.kind !== 'btc') { problems.add('comparison_invalid', comparison.reason || '组合尚不能比较最终净 BTC', context); continue; }
    strongest.set(key, Math.max(strongest.get(key) ?? -Infinity, dual.dualBtc));
    const limits = computeSettlementLimits(model, dual, contract);
    if (!limits.valid) { problems.add('limits_unavailable', limits.reason || '费用或买价阈值尚无法安全验证', context); continue; }
    const accountEligibilityVerified = dual.accountEligibilityVerified === true || entry.data.eligibility?.accountEligibilityVerified === true;
    rows.push({ ...candidate, market, bookRecord, model, comparison, dual, limits, scenarioPrice,
      btcDifference: comparison.btcDifference, cashDifference: comparison.cashDifference,
      assetDifference: comparison.assetDifference, bestForContract: false,
      benchmarkScope: 'current_valid_quotes',
      estimateOnly: dual.estimateOnly === true || !accountEligibilityVerified || !model.roundingKnown,
      accountEligibilityVerified, amountEligibilityVerified: dual.eligibilityVerified === true,
      scanClock: clock, dropRate, gapRate });
  }
  const grouped = new Map();
  for (const row of rows) {
    const key = optionKey(row.optionPlatform, row.contract.symbol), values = grouped.get(key) || [];
    values.push(row); grouped.set(key, values);
  }
  for (const [key, values] of grouped) {
    const eligible = values.filter(row => row.dual.dualBtc === strongest.get(key)).sort(pairOrder);
    if (eligible.length) eligible[0].bestForContract = true;
    else problems.add('best_benchmark_unavailable', '同一 PUT 下最强双币基准的阈值未通过验证，较弱基准不标作默认最佳', { optionPlatform: values[0].optionPlatform, symbol: values[0].contract.symbol });
  }
  rows.sort((a, b) => b.btcDifference - a.btcDifference || pairOrder(a, b));
  stats.rows = stats.rowCount = rows.length;
  stats.positiveRows = rows.filter(row => row.btcDifference > 0).length;
  stats.zeroRows = rows.filter(row => row.btcDifference === 0).length;
  stats.negativeRows = rows.filter(row => row.btcDifference < 0).length;
  stats.bestRows = rows.filter(row => row.bestForContract).length;
  return finish(true, rows);
}

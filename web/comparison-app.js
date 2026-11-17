import { formatAmountInput, mountAmountInput, rawAmount } from './amount-input.js';
import { investmentAmounts } from './investment-amount.js';
import { parseTargetPercent, targetPriceAtPercent, targetPercentAtPrice, withTargetDirection } from './target-distance.js';
import { loadBinanceBook, loadBinanceMarket } from './binance-market.js';
import { loadBinanceCatalogue, deriveBinanceDualIncome } from './binance-dual.js';
import { loadBinanceHighCatalogue, deriveBinanceHighDualIncome } from './binance-high-dual.js';
import { collectBinanceDesk, binanceDualIncome, binanceRowFresh, compareBinanceDesk } from './binance-desk.js';
import { collectBinanceCallDesk, binanceCallDualIncome, binanceCallRowFresh, compareBinanceCallDesk } from './call-desk.js';
import { calculateDualInsurance, calculateLaterInsurance, calculateOptionInsurance } from './comparison-math.js';
import { calculateVenueInsurance } from './venue-insurance.js';
import { exerciseFeeText, renderVenueDetails } from './venue-details.js';
import { venueNames, optionVenues, venueSourceReads, venueUniverse, rankSelections, readVenueBook, readVenueComparison, netDifference, currentFx } from './venue-comparison.js';
import { summarizeAllVenues } from './all-venues.js';

const followSpotInsuranceLink = () => {
  if (location.hash === '#spotPut') location.replace('/?view=spot-put');
};
followSpotInsuranceLink();
window.addEventListener('hashchange', followSpotInsuranceLink);

const el = id => document.getElementById(id);
const finite = Number.isFinite;
const money = (value, places = 2) => finite(value) ? value.toLocaleString('zh-CN', {maximumFractionDigits: places}) : '—';
const usd = value => finite(value) ? money(value, 4) + ' USDT' : '—';
const btc = value => finite(value) ? money(value, 8) + ' BTC' : '—';
const pct = value => finite(value) ? money(value * 100, 3) + '%' : '—';
const readInput = id => {const raw = rawAmount(el(id).value); return raw === '' ? NaN : Number(raw);};
const dateFormat = new Intl.DateTimeFormat('zh-CN', {timeZone:'Asia/Singapore',month:'2-digit',day:'2-digit',year:'numeric',weekday:'short',hour:'2-digit',minute:'2-digit',hour12:false});
const clockFormat = new Intl.DateTimeFormat('zh-CN', {timeZone:'Asia/Singapore',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
const clockText = time => finite(time) && time > 0 ? clockFormat.format(time) + ' SGT' : '—';
const readyAt = (time, now) => finite(time) && time > 0 && time <= now + 2_000 && now - time < 30_000;
const freshMarket = (market, now) => market && readyAt(market.time, now) && readyAt(market.receivedAt, now) &&
  Math.max(market.sourceAgeAtReceive || 0, market.receivedAt - market.time) + Math.max(0, now - market.receivedAt) < 30_000;
const settings = {
  CALL: {amount:'1', amountUnit:'BTC', enteredUnit:'BTC', strike:'', percent:null, expiry:'', autoStrike:true, manualExpiry:false, basis:'ask_limit'},
  PUT: {amount:'10,000', amountUnit:'USDT', enteredUnit:'USDT', strike:'', percent:null, expiry:'', autoStrike:true, manualExpiry:false, basis:'ask_limit'}
};
let side = 'CALL';
let generation = 0;
let pending = false;
let timer;
let snapshot;
let result;
let resultAmount;
let protectionLeg;
let protectionError = '';
let requestError = '';
let wasFresh = false;
let venueBooks = new Map();
const high = () => side === 'CALL';
const saved = () => settings[side];
const optionTitle = () => 'SELL ' + side;
const currency = () => high() ? 'BTC' : 'USDT';
const strikeCoins = {binance:'USDT',okx:'USD',coinbase:'USDC',gate:'USDT',all:'USDT'};
const nativeAmount = (n,coin) => finite(n) ? money(n,coin === 'BTC' ? 8 : 4) + ' ' + coin : '—';
function putText(id, text) { el(id).textContent = text; }
function investment(now) {
  return investmentAmounts(saved(), currency(), currentFx(snapshot, now), now);
}
function showInvestment(values) {
  if (el('amount').value !== values.display) el('amount').value = values.display;
  let hint = '';
  if (values.missingRate) {
    hint = '已保留 ' + saved().amount + ' ' + saved().enteredUnit + '，等候最新 BTC/USDT 行情换算。';
  } else if (values.rate && finite(values.equivalent)) {
    hint = '约 ' + nativeAmount(values.equivalent, values.otherUnit) + ' · BTC/USDT ' + money(values.rate, 4) + ' · ' + clockText(values.time);
  }
  putText('amountHint', hint);
}
function replaceList(id, values) {
  const fragment = document.createDocumentFragment();
  for (const [label, value] of values) {
    const div = document.createElement('div');
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = label;
    dd.textContent = value;
    div.append(dt, dd);
    fragment.append(div);
  }
  el(id).replaceChildren(fragment);
}
function setDirectionCopy() {
  el('highMode').setAttribute('aria-pressed', String(high()));
  el('lowMode').setAttribute('aria-pressed', String(!high()));
  putText('introNote', high() ? '用同一笔 BTC，对比高卖收取的权利金、双币利息和买保险后的收益。' : '用同一笔 USDT，对比低买收取的权利金、双币利息和买保险后的收益。');
  el('amountUnit').value = saved().amountUnit;
  putText('strikeLabel', high() ? '目标卖价' : '目标接币价');
  putText('strikePercentDirection', high() ? '高卖默认 +' : '低买默认 −');
  putText('insuranceIntro', high() ? '双币高卖搭配同卖价、同到期的买入 CALL，补偿 BTC 高于卖价的部分。' : '双币低买搭配同接币价、同到期的买入 PUT，补偿 BTC 低于接币价的部分。');
  el('strike').value = saved().strike;
  el('basis').value = saved().basis;
}
function quoteTable(rows, multiple = false) {
  el('allDeltaHead').hidden = !multiple;
  const body = document.createDocumentFragment();
  for (const row of rows) {
    const tr = document.createElement('tr');
    const heading = document.createElement('th');
    heading.scope = 'row';
    heading.textContent = row.label;
    const caption = document.createElement('small');
    caption.textContent = row.note;
    heading.append(caption);
    if (row.details) {
      const note = document.createElement('small');
      note.textContent = row.details;
      heading.append(note);
    }
    if (row.insurance) {
      const link = document.createElement('a');
      link.href = '#insurance';
      link.textContent = '看保险怎么算';
      tr.classList.add('insured-row');
      link.addEventListener('click', () => {
        if (el('insuranceType').value !== 'dual' || saved().laterExpiry) {
          el('insuranceType').value = 'dual';
          saved().laterExpiry = null;
          invalidate(false);
        }
      });
      heading.append(link);
    }
    tr.append(heading);
    const values = [row.income, row.term, row.apr];
    if (multiple) values.push(row.difference);
    for (const [index, value] of values.entries()) {
      const cell = document.createElement('td');
      cell.dataset.label = ['本期净收入', '本期收益率', '简单年化 / 平台 APR', '与对侧最高收入差'][index];
      cell.textContent = value;
      if (index === 0 && row.incomeNote) {
        const note = document.createElement('small');
        note.textContent = row.incomeNote;
        cell.append(note);
      }
      if (row.negative) cell.classList.add('negative');
      tr.append(cell);
    }
    body.append(tr);
  }
  el('returnsBody').replaceChildren(body);
}
function selectedMarket(key) {
  return key === 'binance' ? snapshot?.market : snapshot?.venues?.[key];
}
function indexVenue(key, now) {
  if (key !== 'all') return key;
  return referencePrice('binance',snapshot?.market,now) !== null ? 'binance' :
    referencePrice('gate',selectedMarket('gate'),now) !== null ? 'gate' : 'binance';
}
function referencePrice(key, market, now) {
  if (market?.platform !== key || market.status !== 'ready' || !readyAt(market.indexTime, now) ||
      !finite(market.spot) || market.spot <= 0) return null;
  return (key === 'binance' ? freshMarket(market, now) : readyAt(market.time, now)) ? market.spot : null;
}
function setIndex(key, market, spot) {
  putText('indexLabel', venueNames[key] + ' BTC 指数');
  putText('indexValue', spot !== null ? money(spot) + ' ' + strikeCoins[key] : '—');
  putText('indexTime', spot !== null ? clockText(market.indexTime) : pending ? '读取公开指数…' : '指数报价暂不可用');
}
function synchronizeTarget(spot) {
  const state = saved();
  if (state.percent === null) {
    el('strikePercent').value = targetPercentAtPrice(spot, readInput('strike'));
    return;
  }
  // Only write the calculated field. The last field edited remains authoritative on refresh.
  if (el('strikePercent').value !== state.percent) el('strikePercent').value = state.percent;
  const price = targetPriceAtPercent(spot, parseTargetPercent(state.percent));
  if (el('strike').value !== price) {
    el('strike').value = price;
    if (result) clearResults();
  }
  state.strike = price;
}
function nativeBinanceInsurance(calc) {
  if (!calc?.valid) return calc;
  return {...calc,coin:'USDT',netCoin:'USDT',cost:calc.costUSDT,premium:calc.premiumUSDT,
    openingFee:calc.openingFeeUSDT,netIncome:calc.netIncomeUSDT ?? calc.initialNetUSDT,
    maxExpiryLoss:calc.maxExpiryLossUSDT,lossCoin:'USDT'};
}
function venueOptionRow(key, quote, ask) {
  const label = venueNames[key] + ' ' + optionTitle();
  if (!quote.valid) return {label, note:quote.reason || (pending ? '正在读取盘口' : '暂无有效盘口'), income:'—', term:'—', apr:'—'};
  const gross = nativeAmount(quote.gross,quote.coin);
  const fee = nativeAmount(quote.openFee,quote.coin);
  const source = key === 'gate' ? 'Gate 合约公开费率' : key === 'coinbase' ? 'Coinbase 普通 App 费率 · Deribit 盘口' : 'OKX 普通档费率';
  return {label, note:quote.symbol + ' · ' + clockText(quote.quoteTime),
    details:source + ' · ' + (ask ? '按卖一全额成交' : '按当前买盘深度') + '。权利金 ' + gross + '，开仓费 ' + fee + '。' + (finite(quote.openFee) ? '' : '费率暂缺。'),
    income:nativeAmount(quote.income,quote.coin), incomeNote:quote.coin !== 'USDT' && finite(quote.incomeUSDT) ? '约 ' + usd(quote.incomeUSDT) + ' · 汇率 ' + clockText(quote.fxTime) : '',
    term:pct(quote.term), apr:pct(quote.annual), negative:quote.income < 0};
}
function venueDualRow(key,dual) {
  return {label:venueNames[key] + (key === 'bitget' ? ' 普通双币' : ' 双币'), note:dual.valid ? '平台 APR · ' + clockText(dual.quoteTime) : dual.reason || (pending ? '正在读取双币报价' : '暂无有效双币报价'),
    details:dual.valid ? dual.note : '', income:nativeAmount(dual.income,dual.coin),
    incomeNote:dual.coin === 'BTC' && finite(dual.incomeUSDT) ? '约 ' + usd(dual.incomeUSDT) : '',
    term:pct(dual.term), apr:pct(dual.apr)};
}
function renderAll({optionKey,dualKey,venueData,quote,contract,dual,row,chosenStrike,expiry,now}) {
  const ask = el('basis').value === 'ask_limit';
  const waiting = pending ? '正在读取报价' : '暂无严格匹配的公开报价';
  const options = {}, duals = {};
  if (optionKey === 'all' || optionKey === 'binance') {
    options.binance = quote ? {...quote,valid:true,symbol:contract?.symbol,coin:'USDT',income:quote.netIncome} :
      {valid:false,reason:requestError || row?.quote?.reason || result?.reason || snapshot?.marketError || waiting};
  }
  if (dualKey === 'all' || dualKey === 'binance') {
    duals.binance = dual ? {...dual,coin:currency()} :
      {valid:false,reason:snapshot?.catalogue?.source?.reason || waiting};
  }
  Object.assign(options,venueData.options);
  Object.assign(duals,venueData.duals);
  const summary = summarizeAllVenues({options,duals,direction:side,strike:chosenStrike,expires:expiry,fx:venueData.fx,now});
  const rows = [];
  for (const [kind,entries] of [['options',options],['duals',duals]]) {
    const isOption = kind === 'options', group = summary[kind];
    for (const [key, item] of Object.entries(entries)) {
      const info = group.rows[key], value = info.delta;
      const name = venueNames[key] + (isOption ? ' ' + optionTitle() : key === 'bitget' || key === 'binance' ? ' 普通双币' : ' 双币');
      const note = info.valid ? (isOption ? item.symbol : '平台 APR') + ' · ' + clockText(info.quoteTime) : info.reason;
      const scope = group.comparable > 1 && info.best ? '本组已报价中净收入最高。' : '';
      const basis = isOption ? (ask ? '按卖一挂价全部成交。' : '按买盘深度估算。') :
        key === 'binance' ? '计息 ' + money(item.days) + ' 天。' : item.note || '';
      rows.push({label:name,note,details:info.valid ? scope + basis + (info.reason || '') : '',
        income:nativeAmount(info.income,item.coin),term:info.valid ? pct(item.term) : '—',
        apr:info.valid ? pct(isOption ? item.annual : item.apr) : '—',
        incomeNote:info.valid && item.coin !== 'USDT' && finite(info.incomeUSDT) ? '约 ' + usd(info.incomeUSDT) : '',
        difference:value ? (value.estimated ? '约 ' : '') + (value.amount > 0 ? '+' : '') + nativeAmount(value.amount,value.coin) : '—',
        negative:info.valid && item.income < 0});
    }
  }
  quoteTable(rows,true);
  const bestNames = group => group.best.map(key=>venueNames[key]).join('、');
  const leaders = [];
  if (summary.options.comparable > 1) leaders.push('期权 ' + bestNames(summary.options));
  if (summary.duals.comparable > 1) leaders.push('双币 ' + bestNames(summary.duals));
  putText('differenceValue',leaders.length ? '已报价中收入最高：' + leaders.join(' / ') : '同价同到期收益对比');
  putText('differenceDetail','可比期权 ' + summary.options.comparable + '/' + summary.options.total +
    ' 家 · 可比双币 ' + summary.duals.comparable + '/' + summary.duals.total + ' 家');
  putText('comparisonNote','同一笔投入、同一名义目标价和到期时刻，按到期未触发比较。差额为本行净收入减去对侧可比报价的最高净收入。跨币种按实时汇率折算。选定单一期权与双币平台可看盘口、费用和保险明细。');
  putText('inputStatus',pending ? '正在更新所选平台报价…' : requestError || '各平台以自己的指数结算，行权价保留原平台计价口径。');
}
function render() {
  const now = Date.now();
  const input = investment(now);
  showInvestment(input);
  if (result && !Object.is(resultAmount, input.native)) clearResults();
  const optionKey = el('optionComparison').value;
  const dualKey = el('dualComparison').value;
  const multiple = optionKey === 'all' || dualKey === 'all';
  const indexKey = indexVenue(optionKey,now);
  const choiceMarket = selectedMarket(indexKey);
  const spot = referencePrice(indexKey, choiceMarket, now);
  setIndex(indexKey,choiceMarket,spot);
  el('detailGrid').hidden = multiple;
  el('binanceFees').hidden = multiple;
  el('insuranceLink').hidden = multiple;
  synchronizeTarget(spot);
  putText('strikeUnit', strikeCoins[optionKey]);
  const percent = saved().percent;
  const target = readInput('strike');
  const invalidPercent = percent !== null && percent.trim() !== '' && !finite(parseTargetPercent(percent));
  el('strikePercent').setAttribute('aria-invalid', String(invalidPercent));
  let hint = '';
  if (invalidPercent) hint = '请输入大于 −100% 的百分比，例如 −5 或 +5。';
  else if (spot === null) hint = choiceMarket?.reason || '等候' + venueNames[indexKey] + '的最新 BTC 指数。';
  else if (percent !== null && percent.trim() !== '' && !finite(target)) hint = '换算价格超出可输入范围。';
  else if (optionKey !== 'all' && finite(target) && target > 0 && choiceMarket.contracts?.length &&
      !choiceMarket.contracts.some(c => c.strike === target && c.expires > now && c.active !== false && c.is_active !== false &&
        (optionKey === 'binance' || c.direction === side))) hint = '所选期权平台暂未挂牌这个目标价，可在价格列表中选择。';
  putText('strikeHint', hint);
  const market = result?.market;
  const row = result?.row;
  const marketValid = freshMarket(market, now);
  const book = marketValid && readyAt(row?.book?.time, now) ? row.book : null;
  const contract = marketValid ? row?.contract : null;
  const goodQuote = row && (high() ? binanceCallRowFresh : binanceRowFresh)(row, now);
  const quote = goodQuote ? row.quote : null;
  const dual = result ? (high() ? binanceCallDualIncome : binanceDualIncome)(result, now) : null;
  const comparison = goodQuote ? (high() ? compareBinanceCallDesk : compareBinanceDesk)(row, result.entries, now)[0] : null;
  const later = Boolean(saved().laterExpiry);
  const source = el('insuranceType').value;
  const chosenStrike = readInput('strike');
  const expiry = Number(saved().expiry);
  const venueData = readVenueComparison({snapshot,books:venueBooks,direction:side,amount:input.native,strike:chosenStrike,expires:expiry,quoteMode:el('basis').value,now,optionVenue:optionKey,dualVenue:dualKey});
  if (multiple) {
    renderAll({optionKey,dualKey,venueData,quote,contract,dual,row,chosenStrike,expiry,now});
    wasFresh = Boolean(input.rate || spot || result || snapshot);
    return;
  }
  const binanceOption = optionKey === 'binance';
  const withinBinance = binanceOption && dualKey === 'binance';
  const chosenOption = binanceOption ? (quote && {valid:true,coin:'USDT',income:quote.netIncome,annual:quote.annual,
    quoteTime:quote.quoteTime,symbol:contract?.symbol,coveredBTC:quote.q * contract?.unit,conditional:quote.conditional}) : venueData.options[optionKey];
  const chosenDual = dualKey === 'binance' ? (dual && {...dual,coin:currency()}) : venueData.duals[dualKey];
  const choiceContract = binanceOption ? contract : choiceMarket?.contracts?.find(c => c.direction === side && c.strike === chosenStrike && c.expires === expiry);
  const choiceBook = binanceOption ? book : venueBooks.get(optionKey + '/' + choiceContract?.symbol);
  const common = {optionVenue:optionKey,dualVenue:dualKey,direction:side,amount:input.native,strike:chosenStrike,
    expires:expiry,market:choiceMarket,dual:chosenDual,short:chosenOption,fx:venueData.fx,now};
  const insurance = withinBinance ? nativeBinanceInsurance(calculateDualInsurance({direction:side,data:result,dual,now})) :
    calculateVenueInsurance({...common,source:'dual',contract:choiceContract,book:choiceBook});
  const insured = insurance?.valid ? insurance : null;
  let selectedResult = insurance;
  if (later || source === 'option') {
    const leg = protectionLeg;
    const legacy = {direction:side,data:result,dual,source,protectionContract:leg?.contract,protectionBook:leg?.book,now};
    selectedResult = binanceOption && (source === 'option' || withinBinance)
      ? nativeBinanceInsurance(later ? calculateLaterInsurance(legacy) : calculateOptionInsurance(legacy))
      : calculateVenueInsurance({...common,source,contract:leg?.contract,book:leg?.book,hedgeExpires:saved().laterExpiry || expiry,
          hedgeStrike:later ? chosenStrike : Number(el('insuranceStrike').value)});
  }
  const selectedInsurance = selectedResult?.valid ? selectedResult : null;
  let diff = netDifference(chosenOption,chosenDual,venueData.fx,now);
  if (withinBinance) diff = comparison?.valid ? {coin:'USDT',amount:high() ? comparison.incomeDifferenceUSDTIndicative : comparison.incomeDifference} : null;
  const differential = diff?.amount;
  const issue = requestError || (result ? result.reason || row?.quote?.reason || (!goodQuote && row?.book ? '期权报价已过期，等候更新。' : '') : '');
  const empty = pending && !result ? '读取中' : '暂无有效报价';
  const ask = el('basis').value === 'ask_limit';
  const venueLabel = venueNames[optionKey] || venueNames.binance;
  el('differenceValue').className = finite(differential) ? differential < 0 ? 'negative' : 'positive' : '';
  putText('differenceValue', finite(differential) ? (differential > 0 ? '多 ' : differential < 0 ? '少 ' : '相同 · ') + nativeAmount(Math.abs(differential),diff.coin) : pending && !result ? '正在匹配' : '暂无可比报价');
  const annualGap = withinBinance ? comparison?.spreadPoints : finite(chosenOption?.annual) && finite(chosenDual?.apr) ? (chosenOption.annual-chosenDual.apr)*100 : null;
  putText('differenceDetail', finite(differential)
    ? (finite(annualGap) ? '年化' + (annualGap >= 0 ? '高 ' : '低 ') + money(Math.abs(annualGap),3) + ' 个百分点。' : '') + (withinBinance ? (high() ? '双币利息按当前指数折算。' : '') : '同名义目标价、同到期，各平台结算基准有差异。' + (diff.fx ? '按实时汇率折算。' : '按原币比较。'))
    : chosenOption?.valid && chosenDual?.valid ? '缺少同步的净收入或汇率。' : chosenOption?.reason || chosenDual?.reason || '需要所选两方的同价、同到期报价。');
  const dualUSDT = high() ? dual?.indicativeUSDT : dual?.income;
  const dualProblem = result?.sources?.find(source => source.status !== 'ready' || source.catalogueComplete === false)?.reason || dual?.reason;
  const binanceDual = dualKey === 'binance';
  const rows = [
    binanceOption ? {label:'Binance ' + optionTitle(), note:quote ? (ask ? '按卖一挂价全部成交' : '按当前买盘逐档计价') : (issue || empty), income:quote ? usd(quote.netIncome) : '—', term:pct(quote?.term), apr:pct(quote?.annual)} : venueOptionRow(optionKey,chosenOption,ask),
    binanceDual ? {label:'Binance 普通双币', note:dual?.valid ? '平台 APR · 计息 ' + money(dual.days) + ' 天' : (dualProblem || empty), income:dual?.valid ? (high() ? btc(dual.incomeBTC) : usd(dual.income)) : '—', incomeNote:high() && dual?.valid && finite(dualUSDT) ? '约 ' + usd(dualUSDT) : '', term:pct(dual?.term), apr:pct(dual?.apr)} : venueDualRow(dualKey,chosenDual)
  ];
  rows.push({label:high() ? '双币高卖＋上涨保险' : '双币低买＋下跌保险', insurance:true,
    note:venueNames[dualKey] + ' 双币，买 ' + venueLabel + ' 同目标价、同到期 ' + side,
    details:insured ? (finite(insured.netIncome) ? '双币利息已扣保险费和开仓费' : insured.valuationReason) : (insurance?.reason || empty),
    income:nativeAmount(insured?.netIncome,insured?.netCoin), term:pct(insured?.term), apr:pct(insured?.annual), negative:insured?.netIncome < 0});
  if (source === 'option' && !later) rows.push({
      label:venueLabel + ' ' + optionTitle() + ' + 保护期权', note:selectedInsurance ? '两腿权利金与开仓费合计' : (selectedResult?.reason || protectionError || empty),
      income:nativeAmount(selectedInsurance?.netIncome,selectedInsurance?.netCoin), term:pct(selectedInsurance?.term), apr:pct(selectedInsurance?.annual), negative:selectedInsurance?.netIncome < 0
    });
  quoteTable(rows);
  putText('comparisonNote', '上表按到期未触发计算。所选期权行权价以 ' + strikeCoins[optionKey] + ' 计价。期权扣公开开仓费，按剩余时间简单年化。' + (high() ? '高卖以本次 BTC 市值计算，额外保证金未计。' : '') + '含保险的方案把买入保险的成本计入本金。');
  putText('marketTitle', venueLabel + ' 期权盘口');
  putText('contract', choiceContract?.symbol || chosenOption?.reason || '尚无匹配的有效期权合约');
  if (optionKey === 'binance') replaceList('bookFacts', [
    ['买一 / 卖一（USDT）', book ? money(book.bids?.[0]?.price,4) + ' / ' + money(book.asks?.[0]?.price,4) : '—'],
    ['卖出期权数量', btc(quote?.q)],
    [ask ? '卖一挂价（每 BTC）' : '买盘加权均价（每 BTC）', usd(quote?.averagePrice)],
    ['权利金总额', usd(quote?.gross)], ['卖出开仓费', usd(quote?.openFee)], ['盘口时间', clockText(book?.time)]
  ]);
  else {
    const v = chosenOption?.valid ? chosenOption : {};
    const terms = choiceContract;
    const liveBook = choiceBook?.status === 'ready' && choiceBook.platform === optionKey &&
      terms && choiceBook.symbol === terms.symbol && readyAt(choiceBook.time,now) ? choiceBook : null;
    const fee = terms?.[ask ? 'maker' : 'taker'];
    const cap = terms?.cap;
    replaceList('bookFacts', [
      ['买一 / 卖一', liveBook ? nativeAmount(liveBook.bids?.[0]?.price,terms.coin) + ' / ' + nativeAmount(liveBook.asks?.[0]?.price,terms.coin) : '—'],
      ['期权数量 / 名义 BTC', v.symbol ? money(v.contracts,4) + ' 张 / ' + btc(v.coveredBTC) : '—'],
      [ask ? '卖一挂价（每 BTC）' : '买盘加权均价（每 BTC）',nativeAmount(v.averagePrice,v.coin)],
      ['权利金总额', nativeAmount(v.gross,v.coin)], ['期权开仓费', nativeAmount(v.openFee,v.coin)],
      ['本期净收入',nativeAmount(v.income,v.coin)],
      ['公开开仓费率', finite(fee) && finite(cap) ? pct(fee) + '，以权利金的 ' + pct(cap) + ' 为上限' : '暂未核实'],
      ['到期交割费', exerciseFeeText(optionKey,terms)],
      ['盘口时间',clockText(liveBook?.time)]
    ]);
  }
  putText('bookNote', ask ? '卖一是卖方挂价。收取这笔权利金的条件是有买方按该价接下全部数量。' : '按当前买盘从高到低计算；买盘不足时整笔收入留空。');
  renderVenueDetails({optionKey,dualKey,direction:side,option:binanceOption ? quote : chosenOption,contract:choiceContract,
    hedge:{...(later || source === 'option' ? protectionLeg?.contract : choiceContract),openFee:selectedInsurance?.openingFee,
      coin:selectedInsurance?.coin},quoteMode:el('basis').value});
  let status = requestError || (pending ? '正在读取公开报价…' : (binanceOption && issue ? 'Binance · ' + issue : ''));
  if (!status) {
    const stamps = [];
    if (chosenOption?.valid) stamps.push('期权盘口 ' + clockText(chosenOption.quoteTime));
    if (chosenDual?.valid) stamps.push('双币 ' + clockText(chosenDual.quoteTime));
    status = stamps.join('　·　') || '当前选择暂无有效公开报价。';
    if (saved().autoStrike && saved().strike) status += '　目标价按公开产品预选，可修改。';
  }
  putText('inputStatus', status || '输入金额、目标价并选择到期时间。');
  wasFresh = Boolean(input.rate || spot || book || chosenDual?.valid || freshMarket(snapshot?.market, now) || chosenOption?.valid);
  renderInsurance({source,later,expiry,optionKey,dualKey,calc:selectedResult});
}

// Discover maturities independently, including products offered by just one source.
async function readSources(direction) {
  const optionVenue = el('optionComparison').value, dualVenue = el('dualComparison').value;
  const useBinanceDual = dualVenue === 'binance' || dualVenue === 'all';
  const catalogue = !useBinanceDual ? {entries:[]} : direction === 'CALL' ? loadBinanceHighCatalogue('BTC') : loadBinanceCatalogue('USDT', [], {independent:true});
  const market = optionVenue === 'binance' || optionVenue === 'all' || useBinanceDual ? loadBinanceMarket(direction) : null;
  const venues = venueSourceReads(direction,optionVenue,dualVenue);
  const all = await Promise.allSettled([market, catalogue,...Object.values(venues)]);
  const [marketResponse, dualResponse] = all;
  return {
    market: marketResponse.status === 'fulfilled' ? marketResponse.value : null,
    marketError: marketResponse.status === 'rejected' ? marketResponse.reason?.message || '公开期权数据不可用' : '',
    catalogue: dualResponse.status === 'fulfilled' ? dualResponse.value : {entries:[], source:{platform:'binance', status:'unavailable', reason:'双币公开报价暂不可用'}},
    direction,
    venues:Object.fromEntries(Object.keys(venues).map((key,index)=>[key, all[index+2].status === 'fulfilled' ? all[index+2].value : {status:'unavailable',reason:'该数据源暂不可用'}]))
  };
}
function eligibleProducts(amount, now) {
  if (!finite(amount) || amount <= 0) return [];
  const reader = high() ? deriveBinanceHighDualIncome : deriveBinanceDualIncome;
  return snapshot.catalogue.entries.filter(entry => reader(amount, {strike:entry.strike, expires:entry.expires, settleCoin:currency()}, entry.data, now).valid);
}
function optionsFor(list, values, selected, placeholder, format, disabledWhenEmpty = true) {
  const next = values.length ? values.map(value => new Option(format(value), String(value))) : [new Option(placeholder, '')];
  list.replaceChildren(...next);
  list.value = values.includes(selected) ? String(selected) : '';
  list.disabled = !values.length && disabledWhenEmpty;
}
function compileSelection(now) {
  const amount = investment(now).native;
  const market = freshMarket(snapshot.market, now) ? snapshot.market : null;
  const other = venueUniverse(snapshot.venues || {}, side, amount, now);
  const key = el('optionComparison').value;
  const contracts = other.contracts.filter(c => key === 'all' || c.venue === key);
  if (key === 'all' || key === 'binance') contracts.push(...(market?.contracts || []).filter(c => c.expires > now && c.active !== false && c.is_active !== false));
  const dualKey = el('dualComparison').value;
  const products = other.products.filter(p => dualKey === 'all' || p.venue === dualKey);
  if (dualKey === 'all' || dualKey === 'binance') products.push(...eligibleProducts(amount,now));
  const indexKey = indexVenue(key,now);
  const spot = referencePrice(indexKey, selectedMarket(indexKey), now);
  synchronizeTarget(spot);
  const ranked = rankSelections(contracts,products,spot,side);
  let strike = readInput('strike');
  const preferences = saved();
  // Choose an actual available price and maturity once per direction.
  if (preferences.autoStrike && preferences.strike === '') {
    if (ranked.length) {
      strike = ranked[0].strike;
      preferences.strike = formatAmountInput(String(strike));
      el('strike').value = preferences.strike;
    }
  }
  const allPrices = [...new Set([...contracts, ...products].map(item => item.strike))].sort((a,b)=>a-b);
  el('strikes').replaceChildren(...allPrices.map(value => new Option('', formatAmountInput(String(value)))));
  const atPrice = item => item.strike === strike;
  const expiries = [...new Set([...contracts, ...products].filter(atPrice).map(item => item.expires))].sort((a,b)=>a-b);
  const chosen = preferences.expiry ? Number(preferences.expiry) : null;
  const selected = preferences.manualExpiry ? chosen : expiries.includes(chosen) ? chosen : ranked.find(atPrice)?.expires ?? null;
  // Retain an explicit future choice during a source outage. No quotes are borrowed.
  if (preferences.manualExpiry && selected > now && !expiries.includes(selected)) expiries.push(selected);
  if (selected !== null && selected <= now) {
    preferences.expiry = '';
    preferences.manualExpiry = false;
    return compileSelection(now);
  }
  preferences.expiry = selected ? String(selected) : '';
  optionsFor(el('expiry'), expiries.sort((a,b)=>a-b), selected, '暂无匹配到期日', value => dateFormat.format(value));
  const laterContracts = selected ? contracts.filter(c => c.strike === strike && c.expires > selected) : [];
  const laterTimes = [...new Set(laterContracts.map(c => c.expires))].sort((a,b) => a-b);
  if (preferences.laterExpiry <= selected) preferences.laterExpiry = null;
  const chosenLater = preferences.laterExpiry;
  // Preserve the user's chosen date on an outage; never replace it with a different contract.
  if (chosenLater && !laterTimes.includes(chosenLater)) laterTimes.push(chosenLater);
  optionsFor(el('insuranceExpiry'), ['same', ...laterTimes], chosenLater || 'same', '等待主合约日期', value =>
    value === 'same' ? (selected ? dateFormat.format(selected) + ' · 同日' : '与主合约同到期') : dateFormat.format(value) + (laterContracts.some(c => c.expires === value) ? ' · 跨期' : ' · 暂缺报价'));
  el('insuranceExpiry').disabled = !selected;
  const hedgeContracts = contracts.filter(c => c.expires === selected && (high() ? c.strike > strike : c.strike < strike));
  hedgeContracts.sort((a,b)=>high() ? a.strike-b.strike : b.strike-a.strike);
  const oldHedge = preferences.hedgeStrike;
  const hedge = hedgeContracts.find(c => c.strike === oldHedge) || (!preferences.manualHedge ? hedgeContracts[0] : null);
  const hedgeValues = hedgeContracts.map(c=>c.strike);
  if (preferences.manualHedge && oldHedge && !hedgeValues.includes(oldHedge)) hedgeValues.push(oldHedge);
  optionsFor(el('insuranceStrike'), hedgeValues, hedge?.strike ?? oldHedge, '暂无同到期保护合约', value=>money(value));
  el('insuranceStrikeLabel').hidden = Boolean(chosenLater) || el('insuranceType').value !== 'option';
  return {amount,strike,selected,hedge:chosenLater ? laterContracts.find(c => c.expires === chosenLater) : hedge};
}
function renderInsurance({source,later,expiry,optionKey,dualKey,calc}) {
  const hedge = calc?.valid ? calc : null;
  const dual = source === 'dual';
  const venue = venueNames[optionKey];
  const native = value => nativeAmount(value,hedge?.coin);
  const income = nativeAmount(hedge?.netIncome,hedge?.netCoin);
  putText('insuranceTitle', venue + ' 保险怎么算');
  putText('insuranceStrikeUnit', strikeCoins[optionKey]);
  el('insuranceStrikeLabel').hidden = dual || later;
  const base = dual ? venueNames[dualKey] + (high() ? ' 双币高卖' : ' 双币低买') : venue + ' ' + optionTitle();
  const terms = later ? '同目标价、较晚到期的 ' : dual ? '同目标价、同到期的 ' : (high() ? '更高执行价、同到期的 ' : '更低执行价、同到期的 ');
  putText('insuranceIntro', base + '，搭配从 ' + venue + ' 买入的' + terms + side + '。' +
    (dual && ['okx','coinbase'].includes(optionKey) ? '双币目标价以 USDT 标示，保护执行价以 ' + strikeCoins[optionKey] + ' 标示，按相同数值匹配。' : ''));
  const facts = [
    ['保护合约', hedge?.symbol || '—'],
    ['保护盘口时间', clockText(hedge?.quoteTime)],
    [dual ? '到期本息对应 BTC' : '卖出期权名义数量', btc(hedge?.targetBTC)],
    ['实际覆盖 / 剩余敞口', hedge ? btc(hedge.coveredBTC) + ' / ' + btc(hedge.uncoveredBTC) : '—'],
    ['买入均价（每 BTC）', hedge ? native(hedge.avgAsk) + ' · ' + money(hedge.levelsUsed) + ' 档' : '—'],
    ['权利金 + 开仓费', hedge ? native(hedge.premium) + ' + ' + native(hedge.openingFee) : '—'],
    ['保险总成本', native(hedge?.cost)]
  ];
  if (later) facts.unshift(['主合约到期', expiry ? dateFormat.format(expiry) : '—'],['保护到期',dateFormat.format(saved().laterExpiry)]);
  if (!dual || later) facts.push([dual ? '双币利息估值减保险支出' : '净权利金减保险支出', income]);
  if (!dual && !later && optionKey !== 'okx') facts.push(['两腿到期最大损失（交割费前）', nativeAmount(hedge?.maxExpiryLoss,hedge?.lossCoin)]);
  replaceList('insuranceFacts', facts);
  let outcome = '';
  if (later) outcome = '主合约先结算；届时保护期权的市值尚未确定，跨期组合的最终盈亏取决于后续价格。';
  else if (dual) outcome = (high() ? '结算价高于执行价' : '结算价低于执行价') + '时，保护期权按覆盖数量赔付。双币和期权各自采用平台结算价格，未覆盖尾数仍有敞口。';
  else outcome = '风险估算仅含两腿期权。现货盈亏及可能产生的交割费另计。';
  if (optionKey === 'okx') outcome += 'OKX 反向期权以 BTC 结算，价内差额折成 BTC 时按期权结算价换算。';
  else outcome += '期权赔付以 ' + strikeCoins[optionKey] + ' 结算。';
  if (!hedge) outcome = (calc?.reason || protectionError || '等候所选平台有效的保险报价。') + ' ' + outcome;
  else if (hedge.valuationReason) outcome = hedge.valuationReason + '。' + outcome;
  if (hedge?.conditional) outcome += '卖方权利金以整笔挂单成交为前提。';
  putText('insuranceOutcome', outcome);
}
function clearResults() {
  result = null;
  venueBooks = new Map();
  protectionLeg = null;
  protectionError = '';
  requestError = '';
}
function invalidate(readNewSources, delay = 0, resetSources = false) {
  const id = ++generation;
  clearTimeout(timer);
  if (resetSources) snapshot = null;
  clearResults();
  pending = true;
  el('refresh').disabled = false;
  if (!snapshot) {
    optionsFor(el('expiry'), [], null, '读取到期日…', String);
    optionsFor(el('insuranceStrike'), [], null, '读取保护合约…', String);
    optionsFor(el('insuranceExpiry'), [], null, '读取保护到期日…', String);
    el('strikes').replaceChildren();
  }
  render();
  timer = setTimeout(() => refresh(id, readNewSources), delay);
}
async function refresh(id, forceSources) {
  if (id !== generation) return;
  const direction = side;
  const current = () => id === generation;
  pending = true;
  el('refresh').disabled = true;
  try {
    if (forceSources || !snapshot || snapshot.direction !== direction || !readyAt(snapshot.loadedAt, Date.now()) ||
        (snapshot.market && !freshMarket(snapshot.market, Date.now()))) {
      const loaded = await readSources(direction);
      if (!current()) return;
      snapshot = {...loaded,loadedAt:Date.now()};
    }
    const {amount,strike,selected,hedge} = compileSelection(Date.now());
    render();
    const validInputs = finite(amount) && amount > 0 && finite(strike) && strike > 0;
    const venue = el('optionComparison').value;
    const separateHedge = el('insuranceType').value === 'option' || Boolean(saved().laterExpiry);
    const useHedge = venue !== 'all' && el('dualComparison').value !== 'all' && validInputs && separateHedge && hedge && selected;
    const hedgeRead = useHedge ? (venue === 'binance' ? loadBinanceBook(hedge.symbol) : readVenueBook(venue,hedge.symbol))
      .then(book => ({contract:hedge,book}), e => ({error:e?.message || '保护合约卖盘暂不可用'})) : Promise.resolve(null);
    const desk = direction === 'CALL' ? collectBinanceCallDesk : collectBinanceDesk;
    const source = snapshot.catalogue.source;
    const normalized = {...snapshot.catalogue, sources:source ? [source] : []};
    const args = {amount,quantity:amount,targetPrice:finite(strike) ? strike : '',expiry:selected || '',quoteMode:el('basis').value};
    const dataRead = venue === 'binance' || venue === 'all' ? desk(args, {
      marketLoader:async() => {if (!snapshot.market) throw new Error(snapshot.marketError || '公开期权来源暂不可用'); return snapshot.market;},
      catalogueLoader:async() => normalized, isCurrent:current
    }) : {market:snapshot.market,quantity:amount,amount,targetPrice:strike,selectedExpiry:selected,entries:normalized.entries,sources:normalized.sources};
    const books = optionVenues.filter(key => venue === 'all' || key === venue).flatMap(key => {
      const market = snapshot.venues?.[key];
      const main = validInputs && selected && market?.status === 'ready' && readyAt(market.time,Date.now()) &&
        market.contracts.find(c => c.direction === direction && c.strike === strike && c.expires === selected);
      return main ? [readVenueBook(key,main.symbol).then(book => [key + '/' + main.symbol,book])] : [];
    });
    const [data, bought, entries] = await Promise.all([dataRead,hedgeRead,Promise.all(books)]);
    if (!current()) return;
    venueBooks = new Map(entries);
    result = data;
    resultAmount = amount;
    if (!validInputs) requestError = investment(Date.now()).missingRate ? '等候 BTC/USDT 行情换算投入金额。' :
      !finite(amount) || amount <= 0 ? '请输入大于零的当次投入。' : '请输入大于零的目标价格。';
    protectionLeg = bought && !bought.error ? bought : null;
    protectionError = bought?.error || (validInputs && separateHedge && !hedge ? '当前条件没找到对应的保护合约。' : '');
    render();
  } catch (error) {
    if (current()) {
      clearResults();
      requestError = error?.message || '公开报价暂不可用，请刷新。';
    }
  } finally {
    if (current()) {
      pending = false;
      el('refresh').disabled = false;
      render();
    }
  }
}
function switchDirection(direction) {
  if (direction === side) return;
  side = direction;
  setDirectionCopy();
  invalidate(true, 0, true);
}
function resetExpiry() {
  saved().expiry = '';
  saved().manualExpiry = false;
  saved().hedgeStrike = null;
  saved().manualHedge = false;
  saved().laterExpiry = null;
}
mountAmountInput(el('strike'));
mountAmountInput(el('amount'));
el('highMode').addEventListener('click', () => switchDirection('CALL'));
el('lowMode').addEventListener('click', () => switchDirection('PUT'));
el('refresh').addEventListener('click', () => invalidate(true));
el('amount').addEventListener('input', () => {
  saved().amount = el('amount').value;
  saved().enteredUnit = saved().amountUnit;
  invalidate(false, 300);
});
el('amountUnit').addEventListener('change', () => {
  saved().amountUnit = el('amountUnit').value;
  invalidate(false);
});
function editTarget(percentInput) {
  saved().autoStrike = false;
  if (percentInput) {
    const field = el('strikePercent');
    const typed = field.value;
    const signed = withTargetDirection(typed, side);
    if (signed !== typed) {
      const caret = field.selectionStart;
      field.value = signed;
      if (caret !== null) {
        const offset = Math.max(0, Math.min(signed.length, caret + signed.length - typed.length));
        field.setSelectionRange(offset, offset);
      }
    }
    saved().percent = signed;
  } else {
    saved().percent = null;
  }
  saved().strike = el('strike').value;
  resetExpiry();
  invalidate(false, 300);
}
el('strike').addEventListener('input', () => editTarget(false));
el('strikePercent').addEventListener('input', () => editTarget(true));
el('expiry').addEventListener('change', () => {
  saved().expiry = el('expiry').value;
  saved().manualExpiry = Boolean(saved().expiry);
  saved().manualHedge = false;
  saved().hedgeStrike = null;
  saved().laterExpiry = null;
  invalidate(false);
});
el('basis').addEventListener('change', () => { saved().basis = el('basis').value; invalidate(false); });
function changeComparison() {
  if (!saved().manualExpiry) saved().expiry = '';
  if (saved().autoStrike && !saved().manualExpiry) {
    saved().strike = '';
    el('strike').value = '';
  }
  invalidate(true, 0, true);
}
el('optionComparison').addEventListener('change', changeComparison);
el('dualComparison').addEventListener('change', changeComparison);
el('insuranceType').addEventListener('change', () => invalidate(false));
el('insuranceExpiry').addEventListener('change', () => {
  saved().laterExpiry = el('insuranceExpiry').value === 'same' ? null : Number(el('insuranceExpiry').value) || null;
  invalidate(false);
});
el('insuranceStrike').addEventListener('change', () => {
  saved().hedgeStrike = Number(el('insuranceStrike').value);
  saved().manualHedge = true;
  invalidate(false);
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) invalidate(true); });
setInterval(() => {
  if (!document.hidden) {
    if (wasFresh) render();
    if (!pending && snapshot && Date.now() - snapshot.loadedAt >= 18_000) {
      const id = ++generation;
      // Keep still-valid figures visible during refresh. render() expires every source independently.
      void refresh(id, true);
    }
  }
}, 1_000);
setDirectionCopy();
invalidate(true, 0, true);

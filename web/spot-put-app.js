import { loadBinanceMarket, loadBinanceBook } from './binance-market.js';
import { mountAmountInput, rawAmount } from './amount-input.js';
import { quoteSpotPut, spotPutOutcome } from './spot-put-math.js';
import { readVenueMarket, readVenueBook, readQuoteFx, venueNames } from './venue-comparison.js';
import { exerciseFeeText } from './venue-details.js';

const money = new Intl.NumberFormat('zh-CN', {minimumFractionDigits:2, maximumFractionDigits:2});
const quantity = new Intl.NumberFormat('zh-CN', {maximumFractionDigits:8});
const expiryDate = new Intl.DateTimeFormat('zh-CN', {
  timeZone:'Asia/Singapore', year:'numeric', month:'2-digit', day:'2-digit',
  weekday:'short', hour:'2-digit', minute:'2-digit', hour12:false
});
const quoteClock = new Intl.DateTimeFormat('zh-CN', {
  timeZone:'Asia/Singapore', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false
});
const usdt = value => money.format(value) + ' USDT';
const native = (value, coin) => Number.isFinite(value)
  ? (coin === 'BTC' ? quantity : money).format(value) + ' ' + coin : '待核实';
const strikeCoins = {binance:'USDT',okx:'USD',coinbase:'USDC',gate:'USDT'};
const premiumCoins = {binance:'USDT',okx:'BTC',coinbase:'USDC',gate:'USDT'};
const signed = value => (value > 0 ? '+' : '') + usdt(value);
const root = document.getElementById('spotPut');
if (root) mount(root);

function mount(section) {
  section.setAttribute('aria-labelledby','spTitle');
  section.innerHTML = `
    <div class="controls-top spot-put-head">
      <h1 id="spTitle">现货防跌保险</h1>
      <button type="button" class="refresh" id="spRefresh">刷新 PUT 报价</button>
    </div>
    <p class="spot-put-intro">买入看跌期权（PUT）保护持有的 BTC。等量保护可抵消与结算基准一致的进一步下跌；保费会降低组合收益。加大保护数量会增加保费，也可能在深跌时让整个组合盈利。</p>
    <div class="fields spot-put-fields">
      <label for="spVenue"><span>保险期权平台</span><select id="spVenue"><option value="binance">Binance</option><option value="okx">OKX</option><option value="coinbase">Coinbase App · Deribit</option><option value="gate">Gate</option></select></label>
      <label for="spQuantity"><span>现货数量</span><span class="input-wrap"><input id="spQuantity" inputmode="decimal" type="text" autocomplete="off" placeholder="输入 BTC 数量"><span>BTC</span></span></label>
      <label for="spEntry"><span>现货买入均价 <small>含买入费用</small></span><span class="input-wrap"><input id="spEntry" inputmode="decimal" type="text" autocomplete="off" placeholder="输入实际成本"><span>USDT</span></span></label>
      <label for="spExpiry"><span>PUT 到期时间 <small>新加坡</small></span><select id="spExpiry" disabled><option>读取中…</option></select></label>
      <label for="spStrike"><span>PUT 执行价 <small id="spStrikeUnit">USDT</small></span><select id="spStrike" disabled><option>读取中…</option></select></label>
      <label for="spCoverage"><span>PUT 保护数量</span><select id="spCoverage"><option value="1">全部现货 · 1 倍</option><option value="0.5">一半现货 · 0.5 倍</option><option value="2">加倍保护 · 2 倍</option><option value="custom">自定倍数</option></select></label>
      <label for="spCustom" id="spCustomLabel" hidden><span>自定保护倍数</span><span class="input-wrap"><input id="spCustom" inputmode="decimal" type="text" autocomplete="off" placeholder="输入倍数"><span>倍</span></span></label>
      <label for="spSettle"><span>想查看的到期结算价</span><span class="input-wrap"><input id="spSettle" inputmode="decimal" type="text" autocomplete="off" placeholder="输入结算价"><span>USDT</span></span></label>
    </div>
    <p id="spStatus" class="input-status spot-put-state" role="status"></p>
    <p id="spMatch" class="input-status spot-put-state" hidden></p>
    <div class="spot-put-results">
      <div><h3 id="spCostTitle">Binance PUT 保险成本</h3><dl id="spFacts"></dl></div>
      <div><h3>到期盈亏</h3><dl id="spOutcome"></dl></div>
    </div>
    <p class="footnote" id="spValuation"></p>
    <p class="footnote">保费逐档按公开卖盘估算，收益已扣普通账户的公开开仓费及适用的行权费。现货按输入的到期结算价估值。个人费率、现货卖出费和已卖出的 CALL 可另行核算。</p>`;

  const byId = id => section.querySelector('#' + id);
  const read = id => {
    const raw = rawAmount(byId(id).value);
    return raw === '' ? NaN : Number(raw);
  };
  for (const id of ['spQuantity','spEntry','spCustom','spSettle']) mountAmountInput(byId(id));
  let market, contract, book, fx, wantedExpiry, wantedStrike;
  let generation = 0, active = false, loading = false, failure = '', matchNote = '', nextRefresh = 0;

  function list(id, rows) {
    byId(id).replaceChildren(...rows.map(([name, text, value]) => {
      const group = document.createElement('div'), label = document.createElement('dt'), field = document.createElement('dd');
      label.textContent = name;
      field.textContent = text;
      if (value > 0) field.className = 'positive';
      if (value < 0) field.className = 'negative';
      group.append(label,field);
      return group;
    }));
  }
  function populate(id, values, current, format, placeholder) {
    const select = byId(id);
    const options = values.map(value => new Option(format(value),String(value)));
    if (!values.includes(current)) options.unshift(new Option(placeholder,''));
    select.replaceChildren(...options);
    select.value = values.includes(current) ? String(current) : '';
    select.disabled = !values.length;
  }
  function selectInstrument() {
    const available = market.contracts.filter(c => c.expires > Date.now() && c.active !== false && c.is_active !== false);
    const expiries = [...new Set(available.map(c => c.expires))].sort((a,b) => a-b);
    const oldExpiry = wantedExpiry, oldStrike = wantedStrike;
    if (!expiries.includes(wantedExpiry)) wantedExpiry = expiries[0];
    populate('spExpiry',expiries,wantedExpiry,n => expiryDate.format(n),'请选择有效到期日');
    const matching = available.filter(c => c.expires === wantedExpiry);
    const strikes = [...new Set(matching.map(c => c.strike))].sort((a,b) => a-b);
    if (!strikes.includes(wantedStrike) && strikes.length) {
      const target = wantedStrike ?? market.spot;
      wantedStrike = strikes.reduce((best,k) => Math.abs(best-target) <= Math.abs(k-target) ? best : k);
    }
    const changes = [];
    if (oldExpiry && oldExpiry !== wantedExpiry && wantedExpiry) changes.push(expiryDate.format(oldExpiry) + ' 到期暂缺，已选 ' + expiryDate.format(wantedExpiry));
    if (oldStrike && oldStrike !== wantedStrike && wantedStrike) changes.push(quantity.format(oldStrike) + ' 执行价暂缺，已选 ' + quantity.format(wantedStrike));
    if (changes.length) matchNote = changes.join('。') + '。';
    populate('spStrike',strikes,wantedStrike,n => quantity.format(n),'请选择有效执行价');
    return matching.find(c => c.strike === wantedStrike);
  }
  function lastValidTime() {
    const stamps = [market.time, market.indexTime, book.time];
    if (market.platform === 'binance') stamps.push(market.metadataTime,market.receivedAt,book.receivedAt);
    return stamps.every(Number.isSafeInteger) ? Math.min(...stamps) + 30_000 : 0;
  }
  function render() {
    const status = byId('spStatus');
    const venue = byId('spVenue').value, name = venueNames[venue];
    const strikeCoin = strikeCoins[venue], coin = premiumCoins[venue];
    byId('spStrikeUnit').textContent = strikeCoin;
    byId('spCostTitle').textContent = name + ' PUT 保险成本';
    byId('spMatch').textContent = matchNote;
    byId('spMatch').hidden = !matchNote;
    byId('spValuation').textContent = venue === 'okx'
      ? 'OKX 反向 PUT 的执行价以 USD 标示，保费和到期赔付用 BTC。保费按额外备付的 BTC 计。未来的 USD／USDT 比价沿用当前 BTC 两种报价推算，实际到期折算可能变化。'
      : venue === 'coinbase'
        ? 'Coinbase 普通 App 的 USDC 期权采用 Deribit 盘口。未来赔付的 USDT 估值沿用当前 USDC／USDT 汇率，实际到期折算可能变化。'
        : name + ' 线性 PUT 的执行价、保费和到期赔付均以 USDT 计价。';
    const custom = byId('spCoverage').value === 'custom';
    byId('spCustomLabel').hidden = !custom;
    byId('spRefresh').disabled = loading;
    list('spFacts',[]);
    list('spOutcome',[]);
    if (!book || !market || !contract || Date.now() >= Math.min(lastValidTime(),contract.expires)) {
      status.textContent = loading ? '正在读取 ' + name + ' 公开 PUT 盘口…' : failure || '报价已过期，请刷新。';
      return;
    }
    const asks = book.asks;
    const facts = [
      ['PUT 合约', contract.symbol],
      ['当前 BTC 指数', native(market.spot,strikeCoin)],
      ['执行价', native(contract.strike,strikeCoin)],
      ['卖一 / 可买张数', asks.length ? native(asks[0].price,coin) + ' / ' + quantity.format(asks[0].qty) + ' 张' : '暂无卖盘'],
      ['盘口时间',quoteClock.format(book.time) + ' SGT']
    ];
    list('spFacts',facts);
    const spotBTC = read('spQuantity'), entryPrice = read('spEntry');
    const coverage = custom ? read('spCustom') : Number(byId('spCoverage').value);
    if (!(spotBTC > 0) || !(entryPrice > 0) || !(coverage > 0)) {
      status.textContent = '请输入大于零的现货数量、买入均价和保护倍数。';
      return;
    }
    const quote = quoteSpotPut({venue,market,contract,book,fx,spotBTC,coverage,entryPrice});
    if (!quote.valid) {
      status.textContent = quote.reason || '保险报价暂不可用。';
      return;
    }
    facts.push(
      ['按此方案买 PUT / 对应 BTC', quantity.format(quote.contracts) + ' 张 / ' + quantity.format(quote.putBTC) + ' BTC'],
      ['加权买价 / 用到档数', native(quote.nativeAverageAsk,coin) + ' / ' + quantity.format(quote.levelsUsed) + ' 档'],
      ['权利金 / 开仓费', native(quote.nativePremium,coin) + ' / ' + native(quote.nativeOpeningFee,coin)],
      ['买入保险总支出', native(quote.nativeCost,coin) + (coin !== 'USDT' && Number.isFinite(quote.cost) ? ' · 约 ' + usdt(quote.cost) : '')],
      ['行权费规则', exerciseFeeText(venue,contract)]
    );
    if (coin !== 'USDT' && Number.isFinite(quote.fxRate) && quote.fxTime) {
      facts.push([coin + ' 折算汇率', '1 ' + coin + ' ≈ ' + quantity.format(quote.fxRate) + ' USDT · ' + quoteClock.format(quote.fxTime) + ' SGT' + (quote.fxSource ? ' · ' + quote.fxSource : '')]);
      if (Number.isFinite(quote.strike)) facts.push(['执行价折合 USDT', '约 ' + usdt(quote.strike)]);
    }
    if (quote.roundingTail > 0) facts.push(['合约步长留下的保护尾数',quantity.format(quote.roundingTail) + ' BTC']);
    list('spFacts',facts);
    if (!quote.valuationReady) {
      status.textContent = quote.valuationReason || '缺少同步汇率或已核实费率，暂不能计算组合盈亏。';
      return;
    }
    const breakEvenLabel = (price,state) => {
      if (Number.isFinite(price)) return usdt(price);
      if (state === 'already_profitable') return '当前及更低的结算价均盈利';
      if (state === 'zero_only') return '仅跌至 0 USDT 时回本';
      if (state === 'break_even_floor') return '深跌区域可持平';
      return '无深跌回本点';
    };
    const rows = [
      ['买保险前现货浮盈亏',signed(spotBTC * (quote.index - entryPrice)), spotBTC * (quote.index - entryPrice)],
      ['按历史成本，下跌至此回本',breakEvenLabel(quote.lowerBreakEven,quote.downsideStatus)],
      ['从当前市值，下跌至此回本',breakEvenLabel(quote.lowerBreakEvenFromNow,quote.downsideStatusFromNow)]
    ];
    const settle = read('spSettle');
    status.textContent = '';
    if (Number.isFinite(settle) && settle >= 0) {
      const out = spotPutOutcome(quote,settle);
      if (out.valid) rows.push(
        ['到期现货盈亏（按成本）', signed(out.spotPnl),out.spotPnl],
        ['PUT 到期赔付',native(out.nativePayoff,coin)],
        ['PUT 行权费',native(out.nativeExerciseFee,coin)],
        ['PUT 净盈亏（比单持现货多／少）',signed(out.putPnl),out.putPnl],
        ['现货＋PUT，按历史成本',signed(out.totalPnl),out.totalPnl],
        ['现货＋PUT，按当前市值起算',signed(out.totalFromNow),out.totalFromNow]
      );
      else status.textContent = out.reason || '无法计算该结算价。';
    } else status.textContent = '输入想查看的到期结算价，即可计算现货和 PUT 合计盈亏。';
    list('spOutcome',rows);
  }
  async function refresh() {
    if (!active || document.hidden) return;
    const request = ++generation;
    const venue = byId('spVenue').value, name = venueNames[venue];
    loading = true;
    failure = '';
    book = null;
    fx = null;
    render();
    try {
      const [fresh, conversion] = await Promise.all([
        venue === 'binance' ? loadBinanceMarket('PUT') : readVenueMarket(venue,'PUT'),
        venue === 'okx' || venue === 'coinbase' ? readQuoteFx().catch(() => null) : null
      ]);
      if (request !== generation) return;
      if (fresh?.status !== 'ready' || fresh.platform !== venue || !Array.isArray(fresh.contracts) ||
          !Number.isFinite(fresh.spot) || fresh.spot <= 0 ||
          ![fresh.time,fresh.indexTime].every(t => Number.isSafeInteger(t) && t > 0 && t <= Date.now()+2000 && Date.now()-t<30_000)) {
        throw Error(fresh?.reason || name + ' 公开指数、合约或时间戳无效。');
      }
      market = fresh;
      fx = conversion;
      contract = selectInstrument();
      if (!contract) throw Error('当前行情没有所选 PUT 合约，请更换到期日或执行价。');
      const depth = venue === 'binance' ? await loadBinanceBook(contract.symbol) : await readVenueBook(venue,contract.symbol);
      if (request !== generation) return;
      if (depth?.status !== 'ready' || depth.platform !== venue || depth.symbol !== contract.symbol ||
          !Array.isArray(depth.asks) || !Number.isSafeInteger(depth.time) || depth.time > Date.now() + 2000 || Date.now()-depth.time>=30_000) {
        throw Error(depth?.reason || name + ' 所选合约的盘口无效或已过期。');
      }
      book = depth;
      nextRefresh = Math.min(lastValidTime(), contract.expires);
      const fxTime = venue === 'okx' ? (market.spotUSDT > 0 && market.indexUSDTTime > Date.now()-30_000 ? market.indexUSDTTime : fx?.btcTime) :
        venue === 'coinbase' ? fx?.usdcTime : null;
      if (Number.isSafeInteger(fxTime) && fxTime > Date.now() - 30_000 && fxTime <= Date.now()+2000)
        nextRefresh = Math.min(nextRefresh,fxTime + 30_000);
    } catch (err) {
      if (request !== generation) return;
      failure = err?.message || name + ' PUT 行情暂不可用，请刷新重试。';
    } finally {
      if (request === generation) { loading = false; render(); }
    }
  }
  function visible() {
    const show = !section.hidden && !document.hidden;
    if (active === show) return;
    active = show;
    if (show) refresh();
    else {
      ++generation;
      book = null;
      loading = false;
      render();
    }
  }
  for (const id of ['spQuantity','spEntry','spCustom','spSettle']) byId(id).addEventListener('input',render);
  byId('spCoverage').addEventListener('change',render);
  byId('spRefresh').addEventListener('click',refresh);
  byId('spVenue').addEventListener('change',() => {
    market = null;
    contract = null;
    matchNote = '';
    populate('spExpiry',[],null,String,'读取所选平台到期日…');
    populate('spStrike',[],null,String,'读取所选平台执行价…');
    refresh();
  });
  byId('spExpiry').addEventListener('change',() => {
    matchNote = '';
    wantedExpiry = Number(byId('spExpiry').value) || undefined;
    refresh();
  });
  byId('spStrike').addEventListener('change',() => {
    matchNote = '';
    wantedStrike = Number(byId('spStrike').value) || undefined;
    refresh();
  });
  new MutationObserver(visible).observe(section,{attributes:true,attributeFilter:['hidden']});
  document.addEventListener('visibilitychange',visible);
  setInterval(() => { if (active && !loading && book && Date.now() >= nextRefresh) refresh(); },500);
  visible();
}

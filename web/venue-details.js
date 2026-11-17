const venues = {
  binance: {
    name: 'Binance', coin: 'USDT',
    feeLink: ['Binance 期权费率', 'https://www.binance.com/zh-CN/support/faq/detail/5326e5de61c34fed98abe28d2f175a23'],
    termsLink: ['Binance 期权结算', 'https://www.binance.com/en/support/faq/detail/acc50814eb0f4beba3799643d8b7a0d4']
  },
  okx: {
    name: 'OKX', coin: 'BTC',
    feeLink: ['OKX 期权费用计算', 'https://www.okx.com/help/trading-fee-rules-faq'],
    termsLink: ['OKX 期权结算', 'https://www.okx.com/help/whats-options-trading']
  },
  coinbase: {
    name: 'Coinbase App · Deribit', coin: 'USDC',
    feeLink: ['Coinbase 普通 App 费率', 'https://help.coinbase.com/en-sg/coinbase/derivatives/derivatives-fees'],
    termsLink: ['Coinbase 线性期权结算', 'https://help.coinbase.com/en/coinbase/derivatives/global-derivatives-linear-usdc-options']
  },
  gate: {
    name:'Gate', coin:'USDT',
    feeLink:['Gate 期权费率', 'https://www.gate.com/help/other/optionstradingrules/45829/options-fee-description'],
    termsLink:['Gate BTC/USDT 期权结算', 'https://www.gate.com/futures-introduction/contract-detail/option-usdtm-BTC_USDT']
  },
  bitget: {
    name:'Bitget',
    termsLink:['Bitget 产品与 API 目录', 'https://www.bitget.com/docs/catalog']
  }
};

const dualLinks = {
  binance: ['Binance 双币结算', 'https://www.binance.com/en/support/faq/detail/09911be9f5754c34806bd3ab4a427e0e'],
  okx: ['OKX 双币计息与结算', 'https://www.okx.com/help/dual-currency-win-faq'],
  gate: ['Gate 双币计息与结算', 'https://www.gate.com/help/lend/dual_currency_product/30851/dual-investment-operative-instructions'],
  bitget: ['Bitget 双币计息与结算', 'https://www.bitget.com/earning/dual-investment']
};

const percentage = number => (number * 100).toLocaleString('zh-CN', {maximumFractionDigits: 5}) + '%';
const amountText = (amount, coin) => amount.toLocaleString('zh-CN', {maximumFractionDigits: coin === 'BTC' ? 8 : 4}) + ' ' + coin;

// The supported BTC expiries on OKX and Deribit settle at 08:00 UTC.
export function exerciseFeeText(venue, contract) {
  if (venue === 'bitget') return 'BTC 标准期权行权费待核实';
  if (venue === 'gate') {
    if (contract?.delivery === 0) return '该合约公布的行权费率为 0%';
    if (Number.isFinite(contract?.delivery) && Number.isFinite(contract.deliveryCap))
      return '按结算时名义价值的 '+percentage(contract.delivery)+'，上限为行权价值的 '+percentage(contract.deliveryCap)+'，以 USDT 支付';
    return 'Gate 日权免行权费，其余按合约公布的交割费率及上限计算';
  }
  const expiry = contract?.expires;
  const day = Number.isSafeInteger(expiry) && expiry > 0 ? new Date(expiry).getUTCDay() : null;
  if (venue === 'okx' || venue === 'coinbase') {
    if (day !== null && day !== 5) return '日权免收行权费（非周五到期）';
    const regular = venue === 'okx'
      ? '名义 BTC × 0.02%、按账户吃单费率计费、BTC 行权价值 × 7%，取最低额'
      : 'Deribit 交割费率 0.015%，上限为期权行权价值的 12.5%，以 USDC 支付';
    return day === null ? '非周五日权免收。周五价内到期按' + (venue === 'okx' ? ' OKX 行权费规则' : ' Deribit 交割费规则') + '计费' : regular;
  }
  return '按结算时名义价值的 0.015% 估算，最高收取行权价值的 10%，以 USDT 支付';
}

function settlementText(venue, direction) {
  const high = direction === 'CALL';
  const gap = high ? '结算价超过行权价的部分' : '行权价超过结算价的部分';
  if (venue === 'bitget') return 'Bitget 普通 BTC 期权的结算条款待核实。';
  if (venue === 'gate') return 'Gate 按到期前 30 分钟 BTC/USDT 指数均价结算。价内卖方以 USDT 支付合约覆盖的 BTC 数量 × '+gap+'。';
  if (venue === 'okx') return 'OKX 卖方以 BTC 支付价内差额。金额等于合约覆盖的 BTC 数量 × ' + gap + ' ÷ 期权结算价。';
  if (venue === 'coinbase') return 'Coinbase 的 Deribit 价内期权先按行权价转为期货，随即以 USDC 结算。卖方支付合约覆盖的 BTC 数量 × ' + gap + '。';
  return 'Binance 期权以 USDT 结算。价内到期时，卖方支付合约覆盖的 BTC 数量 × ' + gap + '。';
}

export function renderVenueDetails({optionKey, dualKey, direction, option, contract, hedge, quoteMode}) {
  const platform = venues[optionKey], dualName = venues[dualKey].name;
  const panel = document.getElementById('binanceFees');
  panel.hidden = false;
  const title = optionKey === dualKey ? platform.name : platform.name + ' 期权与 ' + dualName + ' 双币';
  panel.querySelector('summary').textContent = title + ' 费用与到期结算';

  const quoteSide = quoteMode === 'ask_limit' ? 'maker' : 'taker';
  const feeRate = optionKey === 'binance' ? contract?.taker : contract?.[quoteSide];
  const postedRate = optionKey === 'bitget' ? 'BTC 标准期权公开费率待核实' : Number.isFinite(feeRate) && Number.isFinite(contract?.cap)
    ? percentage(feeRate) + '，最高为权利金的 ' + percentage(contract.cap)
    : '等待所选期权合约的费率';
  const rows = [
    [platform.name + ' 卖方开仓费', Number.isFinite(option?.openFee) ? amountText(option.openFee, platform.coin) + ' · 已计入期权净收入' : '等待有效报价'],
    ['卖方公开费率', postedRate],
    [platform.name + ' 保险买方开仓费', Number.isFinite(hedge?.openFee) && hedge.coin === platform.coin
      ? amountText(hedge.openFee, platform.coin) + ' · 已计入保险成本' : '等待有效保险报价'],
    ['主期权价内到期行权费', exerciseFeeText(optionKey, contract)]
  ];
  if (Number.isSafeInteger(hedge?.expires) && hedge.expires > 0 && hedge.expires !== contract?.expires) {
    rows.push(['保险期权价内到期行权费', exerciseFeeText(optionKey, hedge)]);
  }
  if (dualKey === 'okx' || dualKey === 'gate') rows.push([dualName + ' 双币手续费', '免费']);
  else if (dualKey === 'bitget') rows.push(['Bitget 双币费用', '以该期产品公布的申购与结算条款为准']);
  else rows.push(['Binance 双币按目标价兑换', '免交易手续费']);
  const publicSpot = optionKey === 'binance' && Number.isFinite(contract?.spot) ? 'Binance 现货普通费率 ' + percentage(contract.spot) + '。' : '';
  rows.push(['另行买卖现货', publicSpot + '按实际现货平台、成交额和账户费率另计']);

  const doc = panel.ownerDocument;
  panel.querySelector('#feeFacts').replaceChildren(...rows.map(([label, value]) => {
    const group = doc.createElement('div'), term = doc.createElement('dt'), description = doc.createElement('dd');
    term.textContent = label;
    description.textContent = value;
    group.append(term, description);
    return group;
  }));
  const dualSettlement = direction === 'CALL'
    ? '的结算价达到或高于目标卖价时，按目标价把 BTC 本息换为 USDT。低于目标价则收到 BTC 本息。'
    : '的结算价达到或低于目标接币价时，按目标价把 USDT 本息换为 BTC。高于目标价则收到 USDT 本息。';
  panel.querySelector('#settleInfo').textContent = settlementText(optionKey, direction) + dualName + ' 双币' + dualSettlement;
  const links = [platform.feeLink, platform.termsLink].filter(Boolean);
  if (optionKey === 'coinbase') links.push(['Deribit 到期交割费', 'https://support.deribit.com/hc/en-us/articles/25944746248989-Fees']);
  links.push(dualLinks[dualKey]);
  if (dualKey === 'binance') links.push(['Binance 双币兑换费', 'https://www.binance.com/en/earn-faq/dark/dual-investment/tutorials']);
  panel.querySelector('.links').replaceChildren(...links.map(([title, url]) => {
    const anchor = doc.createElement('a');
    anchor.textContent = title + ' ↗';
    anchor.href = url;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    return anchor;
  }));
}

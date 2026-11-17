const finite = value => typeof value === 'number' && Number.isFinite(value);
const nonnegative = value => finite(value) && value >= 0;
const value = raw => typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
const validRate = rate => nonnegative(rate) && rate <= 1;
const invalid = reason => ({ valid: false, quoteOnly: true, reason, feeBoundsAvailable: false,
  untriggeredNetIncome: null, deliveryFeeActual: null, spotFeeActual: null,
  deliveryFeeUpper: null, spotFeeUpper: null, futureFeeUpper: null, totalFeeUpper: null,
  triggeredFeeNetLower: null, feeReserveCoverage: null, rows: [] });

/**
 * Fee rules and price-independent bounds only. No future fixing, spot price,
 * BTC quantity or portfolio return is assumed or calculated. Delivery's
 * intrinsic-value cap supplies a valid wide bound even when its fee index I
 * differs from the option settlement price S.
 */
export function deriveStrategyCosts(quote, contract, platform) {
  if (quote?.valid !== true || !contract || !['bybit', 'deribit', 'binance'].includes(platform)) return invalid('需要有效 PUT 报价和已接入平台，才能拆分费用');
  const A = value(quote.amount), q = value(quote.q), K = value(quote.strike), capital = value(quote.capital);
  const P = value(quote.gross), O = value(quote.openFee), G = value(quote.netIncome);
  if (!finite(A) || A <= 0 || !finite(q) || q <= 0 || !finite(K) || K <= 0 ||
      ![capital, P, O].every(nonnegative) || !finite(G) || A + G < 0) return invalid('报价金额、数量或开仓费用无效，不能计算费用边界');
  const tolerance = Math.max(1e-8, Math.max(A, capital, P, O) * Number.EPSILON * 64);
  if (Math.abs(capital - q * K) > tolerance || Math.abs(G - (P - O)) > tolerance ||
      !finite(value(contract.strike)) || value(contract.strike) !== K) return invalid('报价的本金、净权利金或接币价不能对账');

  const deliveryRate = value(contract.delivery), deliveryCap = value(contract.deliveryCap);
  const spotRate = value(contract.spot), exemptionConfirmed = contract.deliveryExemptionConfirmed === true;
  // A zero inferred rate is not evidence that a daily exemption was confirmed.
  const deliveryRuleKnown = exemptionConfirmed || validRate(deliveryRate) && deliveryRate > 0 && validRate(deliveryCap);
  const spotDeductionKnown = typeof contract.spotDeductBase === 'boolean';
  const spotRuleKnown = validRate(spotRate) && spotDeductionKnown && !(contract.spotDeductBase && spotRate >= 1);
  const cashUpperBeforeFutureFees = A + G;
  const spotFeeFraction = spotRuleKnown ? contract.spotDeductBase ? spotRate : spotRate / (1 + spotRate) : null;
  const deliveryFeeUpper = deliveryRuleKnown ? exemptionConfirmed ? 0 : deliveryCap * capital : null;
  const spotFeeUpper = spotRuleKnown ? spotFeeFraction * cashUpperBeforeFutureFees : null;
  const feeBoundsAvailable = deliveryFeeUpper !== null && spotFeeUpper !== null;
  const futureFeeUpper = feeBoundsAvailable ? deliveryFeeUpper + spotFeeUpper : null;
  const totalFeeUpper = feeBoundsAvailable ? O + futureFeeUpper : null;
  const triggeredFeeNetLower = feeBoundsAvailable ? G - futureFeeUpper : null;
  const reserveKnown = nonnegative(quote.feeReserve);
  const feeReserveCoverage = feeBoundsAvailable && reserveKnown ? quote.feeReserve + tolerance >= totalFeeUpper : null;
  const feeReserveShortfall = feeBoundsAvailable && reserveKnown ? Math.max(0, totalFeeUpper - quote.feeReserve) : null;
  const requiredFundingUpper = feeBoundsAvailable ? capital + totalFeeUpper : null;
  const fundingShortfall = feeBoundsAvailable ? Math.max(0, requiredFundingUpper - A) : null;
  const fullyFundedForFeeUpper = feeBoundsAvailable ? requiredFundingUpper <= A + tolerance : null;
  const deliveryFormula = exemptionConfirmed
    ? '已明确核实该合约免交割费；按当前规则为 0'
    : '触发时 D=min(交割费率×到期指数 I，交割上限比例×max(K−S,0))×q；未触发为 0';
  const spotFormula = !spotRuleKnown ? '现货费率或扣费方式尚未核实，不计算费用上界'
    : contract.spotDeductBase ? '从买币前余额 B 买入，现货费从收到的 BTC 扣除；费用稳定币等值≤f×B'
      : '现货费从支付币另收；在总买入现金 B 内，现货费≤f/(1+f)×B';
  const unknownRules = [];
  if (!deliveryRuleKnown) unknownRules.push('交割费规则或交割上限尚未核实；不能将未确认的 0 当成免收');
  if (!spotRuleKnown) unknownRules.push('现货费率或扣费币种尚未核实');
  const rows = [
    { id: 'open_fee', label: '开仓费', status: 'quoted', amount: O, upper: O, isFee: true,
      formula: '逐档 min(taker×当前指数价，交易费上限×本档价格)×本档成交量',
      note: '依当前可见买盘与公开规则计算，报价尚未成交。' },
    { id: 'delivery_fee', label: '到期交割费', status: deliveryRuleKnown ? exemptionConfirmed ? 'confirmed_exempt' : 'future_unknown' : 'rule_unknown',
      amount: null, upper: deliveryFeeUpper, isFee: true, formula: deliveryFormula,
      note: deliveryRuleKnown ? exemptionConfirmed ? '免收条件已有明确确认，不按到期星期自行推断。' : 'S 和 I 尚未发生；仅以实值金额上限推得 D≤cap×qK，不假定 I=S。' : unknownRules[0] },
    { id: 'spot_fee', label: '触发后的现货买入费', status: spotRuleKnown ? 'future_unknown' : 'rule_unknown',
      amount: null, upper: spotFeeUpper, isFee: true, formula: spotFormula,
      note: 'B=A+毛权利金−开仓费−结算赔付−交割费，且 B≤A+净权利金；步长余款只会降低实际买入支出。' },
    { id: 'settlement_payout', label: '期权结算赔付', status: 'future_unknown', amount: null, upper: capital, isFee: false,
      formula: 'q×max(K−S,0)', note: '这是本金承担的期权损益，不是手续费，不从权利金手续费后下界重复扣除。' },
    { id: 'execution_price_difference', label: '未来现货成交价差', status: 'future_unknown', amount: null, upper: null, isFee: false,
      formula: '取决于未来真实买入价及成交情况', note: '这是成交价格影响，不是手续费；不假设未来价格，不计入手续费边界。' },
  ];
  const result = {
    valid: true, quoteOnly: true, platform, scope: 'option_entry_delivery_and_all_balance_spot_fees',
    grossPremium: P, openFee: O, netIncome: G, untriggeredNetIncome: G,
    untriggeredDeliveryFee: 0, untriggeredSpotFee: 0, untriggeredTotalFees: O,
    deliveryFeeActual: null, spotFeeActual: null, deliveryRate: validRate(deliveryRate) ? deliveryRate : null,
    deliveryCap: validRate(deliveryCap) ? deliveryCap : null, deliveryExemptionConfirmed: exemptionConfirmed,
    deliveryRuleKnown, spotRuleKnown, spotRate: spotRuleKnown ? spotRate : null,
    spotFeeFraction, cashUpperBeforeFutureFees, deliveryFormula, spotFormula,
    deliveryFeeUpper, spotFeeUpper, futureFeeUpper, totalFeeUpper, triggeredFeeNetLower,
    triggeredFeeNetUpper: G, feeBoundsAvailable, feeReserve: reserveKnown ? quote.feeReserve : null,
    feeReserveCoverage, feeReserveShortfall, requiredFundingUpper, fundingShortfall, fullyFundedForFeeUpper,
    reserveIsExpense: false, payoutIsFee: false, rows, unknownRules,
    ruleBasis: 'current_public_fee_rules',
    note: '以上为当前公开收费规则下的报价与宽上界，未来费率可能变化。权利金手续费后下界不含本金赔付、成交价差或未提供的外部转账/兑换费用，也不代表最终总资产优于双币。',
  };
  if (Object.values(result).some(v => typeof v === 'number' && !finite(v))) return invalid('费用边界超出可计算范围');
  return result;
}

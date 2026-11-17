# BTC dual-investment quote sources

Updated 2026-10-24. Unconnected visitors can read real market data without Binance login. The optional private execution bridge remains disabled until a separate broker and the visitor's account are verified; every opening order requires the user's explicit confirmation.

## Binance ordinary Dual Investment

The primary source is Binance's anonymous website product list:

`GET https://www.binance.com/bapi/earn/v5/friendly/pos/dc/project/list?investmentAsset=USDT&targetAsset=BTC&projectType=DOWN&sortType=APY_DESC&pageIndex=1&pageSize=100`

An independently reviewed open-source reader is [scripts/fetch.py at e9e9500](https://github.com/wjzzx1s/binance-dual-investment/blob/e9e9500dd2624e50fa8471ef2cd89d69b8e24eb8/scripts/fetch.py#L39). The endpoint was tested without an API key, cookie, signature or login and returned HTTP 200, code `000000`, with live products. This is a website endpoint, not a documented compatibility guarantee.

The server validates complete pagination and normalizes `investmentAsset`, `targetAsset`, `type=DOWN`, `strikePrice`, `settleTime`, `duration`, `apr`, `canPurchase` and the public deposit limits. Only required calculation fields leave the reader. Missing purchase precision and subscription deadline stay null. `canPurchase` does not verify personal account eligibility.

The optional existing read-only fallback is the [official product-list API](https://developers.binance.com/en/docs/catalog/investment-and-services-dual-investment/api/rest-api/market-data), `GET /sapi/v1/dci/product/list`. No credentials are needed for the primary website source; none are collected by the comparison page. Current official generated clients and older clients differ about signing this SAPI operation, so authenticated fallback functionality must not be claimed without a valid-key live test.

APR is the platform's live annual rate. The ordinary product's term rate is calculated from the returned interest days and truncated down to four decimal places, using decimal integer arithmetic. For the anonymous source, amount income and the premium difference are conditional estimates for the exact entered amount; unknown principal precision is not invented. Public min/max limits are still checked. A quote must match BTC/USDT, PUT direction, exact strike and exact expiry, and remain within the 30-second snapshot freshness limit.

### Hosted delivery

On 2026-10-22 the hosted Worker returned CloudFront edge HTTP 403 for both the public list and a credential-free official SAPI product-list probe. Adding an honest application User-Agent and JSON Accept did not restore access. This establishes an edge refusal, not its precise policy or geography. The same fixed public source works from the owner's Windows computer.

The public Site now reads the fixed anonymous cloud endpoint `https://harmonious-bienenstitch-ef1a0a.netlify.app/dual`. Its Netlify Free function reads the complete ordinary-dual public list without an account, key or cookie. An anonymous live request on 2026-10-24 returned HTTP 200 and 343 products; counts and APR change with the source. No paid instance or region override is configured.

The Site route has no R2, owner collector, visitor localhost or direct-Binance fallback. The complete product list is sanitized again on the Site. Original Binance HTTP Date, batch start and batch completion timestamps remain unchanged. Both cloud layers reject incomplete pagination, invalid products, bodies above 4MB and source age of 30 seconds. The browser adds its complete request duration to the Site-validated source age. An outage is displayed as unavailable; cached timestamps are never renewed.

Ordinary dual APR, platform interest days, term rate and amount income display independently of PUT. Without a real exact-USDT/strike/expiry PUT order book, PUT net premium and yield differences stay unavailable. No synthetic zero PUT model or simulated quote is used.

### Options cloud source status

The original Site direct REST/WebSocket probes returned HTTP 403, and the ordinary Netlify Node runtime returned HTTP 451 for metadata. Those refused direct paths remain unused. A different standard Free runtime, Netlify Edge Functions, was then deployed without setting a region or changing request identity. Its normal platform-selected execution returned `aws-ap-southeast-1`, HTTP 200, 308 actual BTC PUT contracts, a fresh BTCUSDT index, and an actual depth snapshot. The exact entered 78,000 strike / 2026-10-26 08:00 UTC contract was separately verified as `BTC-261026-78000-P`, with six visible bid levels, not a sample contract or a synthetic price.

The Site reads only fixed anonymous `/options/market` and `/options/book?symbol=...` paths from the same Netlify cloud service. The Edge reader verifies listing before reading a selected exact book and requests depth limit 1000, while reporting the levels actually returned. Standard opening, conditional delivery and conditional spot fee rules are disclosed separately; personal discounts and eventual settlement costs remain unverified. Real bids are swept for the entered cash amount, and only matching USDT/strike/expiry ordinary dual can supply a yield difference.

Both cloud layers preserve exchange timestamps, enforce 30-second freshness, bound bodies at 4MB, coalesce concurrent reads and use a three-second success cache. Metadata, index and book are read in order; 403/451 stops that Edge instance rather than switching hosts or regions. Netlify chooses its normal edge based on request routing; successful Singapore execution does not establish access from every region. Failures stay explicit, with no PC, R2, direct-Binance or estimated-price fallback. Public quote paths never receive account keys. Trading requires the separate private broker and the visitor's verified account; without both the page stays read-only.

The deployed Netlify source and its focused checks are retained under `cloud/netlify/` in this repository; the existing ordinary-dual Node function is preserved. No API key, account token, paid plan or manually selected region is required by that deployment.

The ordinary-dual public list can change between pages. Only a total change, duplicated-page entry or incomplete page permits one restart of the entire batch. Both attempts share the same 15-second deadline and cumulative 4MB budget. Failed partial rows are discarded, and the successful batch keeps its original four timestamps. HTTP refusal, rate limiting, schema errors and invalid clocks do not trigger this restart.

## Binance Dual Investment RFQ

The [official RFQ FAQ](https://www.binance.com/en/support/faq/detail/ee48064f555a4322814c0e46df843bc1) describes customized target prices, settlement dates and subscription amounts. Ordinary product APR is never used as an RFQ quote.

A bounded audit of official JS/Python/Go clients, CCXT, python-binance, Siebly, several dedicated dual-investment repositories and public web references found no independently verifiable anonymous RFQ implementation. This does not establish that no RFQ API exists. No login, cookies, RFQ submission or trading was performed for the audit. RFQ remains explicitly unavailable in the app until its own quote source is verified.

The published desk is Binance-only. Ordinary dual is never presented as large-investment RFQ, and other stablecoins are not silently converted.
## 2026-11-13: SELL CALL / BTC 双币高卖

新增方向与原 SELL PUT 分开取数、分开保存输入。CALL 合约只接受真实 BTC-YYMMDD-STRIKE-C，严格匹配目标价、到期时刻与 BTC 数量范围，30 秒失效。卖一是等待成交的限价，报价中的卖一挂卖量不是买方深度；即时参考从买一向下逐档累计。

普通双币高卖公开源使用 investmentAsset=BTC、targetAsset=USDT、projectType=UP；不得将 USDT 低买或大额 RFQ 替代它。公开申购精度、截止时间、个人资格仍未知，页面必须显示。

2026-11-13 重新读取官方规则：
- 期权开仓标准费：min(0.024% × BTC 指数 × 数量, 10% × 权利金)。交割标准费：min(0.015% × 官方结算价 × 数量, 10% × CALL 内在价值 × 数量)。来源：https://www.binance.com/en/support/faq/detail/5326e5de61c34fed98abe28d2f175a23 （页面更新2026-03-06，FAQ为一般说明，账户费率未验证）。
- 现货普通 Maker/Taker 0.100%，个人VIP/BNB及交易对优惠仍未核实。来源：https://www.binance.com/en/fee/trading 。
- 双币高卖本期率=floor(APR × 平台天数 / 365 × 10,000)/10,000；未触发返BTC本金和BTC利息，触发按目标价将本金及利息转USDT。来源：https://www.binance.com/en/support/faq/detail/09911be9f5754c34806bd3ab4a427e0e 。

CALL 年化以所填BTC按当前指数折算的市值为分母，仅反映权利金减开仓费，不包含持币涨跌或额外保证金资金占用。双币BTC利息与USDT权利金的差额只可按当前指数作估值比较，不能写成保证到期多拿。触发后CALL现金损失和现货卖币分别处理；结算价、现货成交价、交割费、现货费尚未知。现货BTC不是自动可用的USDT期权保证金，不能将最低开仓保证金当作最大亏损。

本版本只读；下单、划转、到期自动买卖均不启用。没有任何账户密钥进入公开行情来源。

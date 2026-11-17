# Binance SELL PUT 本机执行

网站使用 Binance BTC/USDT 真实挂牌、指数和买盘。匿名公开报价不需要交易账户；
账户费率、余额、卖方资格与执行能力须通过用户本人连接的 Binance Key 核验。
公开报价为当前盘口预估，不代表已经成交。

## 运行和连接

运行 `start-binance-local.ps1`。默认运行数据在项目外的 `work/binance-execution`，
服务仅监听 `127.0.0.1:8789`。它与旧 Deribit 8788 服务、凭据和数据库互相隔离。
没有加密配置时只提供匿名公开行情，不认证账户，也不请求交易所私有接口。

用户本人从网站“连接本机 Binance”打开本机页面，输入 API Key / Secret。
本次只接 Binance 主网，交易许可默认关闭。配置仅经本机 CSRF 接口交给本机进程，
以 Windows 当前用户的 DPAPI 加密保存为 `binance-credentials.dpapi`。
网页和网站服务器不接收交易所密钥；浏览器只保存本标签页的短期配对凭证。
保存配置或配对不会提交订单，每笔策略仍需在网站最后确认。

使用独立专用账户，预先把本次全额 USDT 放在期权钱包。自动买币还需该账户的
现货交易与期权钱包至现货钱包的内部划转权限；不提供提现或跨账户转账。
权限、UID、账户模式、余额、实际费率、卖方许可或资金归属证据不完整时不开单。

## 订单与到期

- 当次资金、精确接币价、真实合约和到期日、数量、费用、限价及到期模式冻结
  在 30 秒报价指纹中。改变条件后须重新准备。
- 卖 PUT 从买一向下逐档报价。开仓用 IOC 限价单，未成交部分不会继续挂单。
  权利金按真实成交计入；零成交不会进入自动买币流程。
- `cash`：核对官方最终结算价、实际行权损失、开仓与交割费和钱包流水后留 USDT。
  这个模式不会划转资金或买入现货。
- `buy_btc`：触发后，将本笔 A + 实收权利金 - 开仓费 - 实际结算损失 - 交割费
  中可划转的余款划至同账户现货钱包，再按真实卖盘与已确认价格保护尽量买 BTC。
  本笔完整 A 的余款包含 PUT 未成交部分对应的资金；此规则在最终确认中明示。
  交易步长和限价造成的零碎余款保留并展示，实际 BTC 数量由成交及手续费决定。
- 开仓、内部划转、现货买入均先持久化意图，再仅发送一次。
  超时、未知回包、缺少流水、外部资金变化或部分现货成交会停止后续自动操作，
  不因刷新页面或进程重启而重发原操作。

关闭页面不停止已确认的策略。电脑必须开机、联网并保持本机服务运行；
离线期间交易所仍会结算期权。超过到期后五分钟未完成自动买币时暂停，保留资产。
暂停只停止后续自动划转与买币，不会平仓或撤销交易所已接受的操作。

## 验证边界

开发检查使用合成账户、成交和结算样本验证状态机，页面展示只使用真实公开报价。
未配置真实交易凭据前，不宣称已经完成实际账户下单、内部划转或到期接币验证。

官方接口：
- https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-options/api/rest-api/market-data
- https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-options/api/rest-api/trade
- https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-options/api/rest-api/account
- https://developers.binance.com/docs/binance-spot-api-docs/faqs/commission_faq

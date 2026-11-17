# 公开只读 Binance 行情服务

普通双币由 Node Function 提供，期权由 netlify/edge-functions/options.js 提供。原 netlify.toml 和 public 页面保持不变。

普通双币仅在分页总数变化、重复条目或分页不全时，从头读取一次变动列表；两批共享15秒总时限和累计4MB上限，丢弃首批失败片段。每页自身的总数与条数必须吻合，读取到可核验的短末页。相同ID去重，前后金融字段矛盾的ID整批隔离。不对拒绝、限流、超时、格式或时间异常重试，原始报价时间不改写。

变动列表明确返回 catalogueComplete:false、reportedTotals、实际唯一条数和扫描页数，不宣称完整快照。仅已核实同币种、接币价和到期的产品可以比较；未读到某产品不代表平台没有。成功结果缓存10秒并保留原始时间；超过30秒停止显示。

- GET /options/market：无查询，串行读取完整真实挂牌及 BTCUSDT 指数。
- GET /options/book?symbol=精确BTC-PUT合约：仅接受当前真实挂牌合约，读取 limit=1000 的完整可见盘口，不自动挑选或替换合约。
- GET /edge-health：不取数，只返回服务状态和 context.server.region，不读取访客位置或 IP。
- 原始来源时间30秒TTL，成功缓存3秒、并发合并；最多8个待处理盘口及32个完成盘口缓存；单次累计4MB流式字节、总计15秒。
- 403/451停止当前实例来源，不换主机/地区/请求头，不重试；其它失败冷却10秒后允许用户正常刷新。实例回收不等于跨实例永久禁用，明确受限时不得人为循环重新探测。
- 不使用用户请求头或账户配置，不登录、不交易，不启用付费或地区设置。标准费率保留账户未知标识。
- probe源码保存在scripts，已移出Edge扫描目录，不再部署/edge-verify。

Mock测试：node --test production-options-tests.mjs。真实成功证据由root留存；本包不自行访问网络或部署。

## 2026-11-13 高卖扩展

- GET /options/market?type=CALL：只返回真实 BTC/USDT CALL 挂牌，默认 /options/market 仍为 PUT。
- GET /options/book?symbol=BTC-真实到期-真实价格-C：先核对 CALL 挂牌再读取真实买卖盘，不复制 PUT 报价。
- GET /dual-high：独立匿名读取投资 BTC、目标 USDT、方向 UP 的 Binance 普通双币高卖。保留原始 APR、金额范围与计息天数；不将其当作 RFQ。
- 高卖与低买采用独立缓存和方向校验，30 秒失效规则不变。
- 费率于 2026-11-13 复核官方公开普通费率；账户实际优惠仍未知。
- 本目录是完整免费 Netlify 部署源码，包含原低买和新高卖。部署后须验证 /dual、/dual-high、PUT/CALL 的 market 与 book 均返回真实最新时间；本机单次验证不代表云端成功。

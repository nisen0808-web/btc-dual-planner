# Netlify 只读报价服务

这是待验证的部署包，尚未部署，也不保证 Binance 允许此云端出口取数。

- 用户仍须本人登录 Netlify 并决定是否部署。本脚本不创建账号或资源。
- 使用 Node.js 22。将本目录作为 Netlify 项目根目录，配置仅 Functions 可见的服务器环境变量 QUOTE_READ_TOKEN；不要写进仓库或网页。无 Binance 账户 Key，不登录 Binance，不含 RFQ、账户或交易接口。
- Free 方案为每月 300 credits 硬上限；流量、请求与计算等共同消耗，耗尽会暂停服务。上线前核对账户的现行套餐条款和余量，不能承诺无限免费或持续可用。
- 本包不设置 region。Free 默认 Ohio；只有 Pro/Enterprise 可更改 Functions region，不能承诺 Binance 读取成功。
- GET /health 匿名仅返回 serviceReady，不表示 Binance 上游可用。GET /market、/book?symbol=真实BTC-PUT合约、/dual 均需 Authorization: Bearer <QUOTE_READ_TOKEN>。只允许固定参数；不能转发账户凭据或任意 URL。
- 上线前分别验证真实期权 exchangeInfo/index、所选合约完整深度、普通双币 APR 三类数据和原始时间戳。健康检查成功不能代替这些验证。不得用 mark price、零盘口、普通双币或模拟数据填补缺失来源/RFQ。
- 两个 worker reader 保留原始校验、时间戳与深度语义，服务不续命、不增加深度或覆盖来源；过期或读取失败应保持不可用。响应最多 4MB，最多四个并发报价。
- 403/451 会停止当前实例中对应的数据源并返回 503，另一个源不受影响。serverless 冷启动会新建实例，因此实例内闩锁不是跨实例的永久禁用；不得据此自动切主机、地区、IP或循环重试。需先解决来源授权或访问限制，再由用户决定恢复。

本地验证：在源码仓库运行 node --test netlify-feed-tests.mjs。测试仅用 mock，不访问外网。

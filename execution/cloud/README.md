# Binance 单进程云执行器（未部署，未连接真实账户）

构建上下文为 Site 源码根目录：`docker build -f execution/cloud/Dockerfile .`。仅适用于稳定固定出站 IP、一个 Node 24 进程及一个持久盘的服务器；持久盘必须是支持 SQLite 排他文件锁的本地卷，不支持 NFS 或其它网络文件系统。启动会对持久目录获取跨进程排他锁，未持锁的实例拒绝连接或执行。禁止多副本、共享数据库并发写入和自动水平扩容。主 Site 继续匿名提供真实行情，账户执行接口须通过同源后端代理。

默认真实交易关闭。以下配置全部有效才接受账户连接：

| 环境变量 | 要求 |
| --- | --- |
| `BINANCE_LIVE_ENABLED` | 默认 `false`；实际启用须运营者完成部署核验并明确改为 `true` |
| `BINANCE_SERVICE_SECRET` | 43–128 字符、仅含字母数字和 `_-` 的独立随机服务凭据，仅 Site 后端和执行器持有 |
| `BINANCE_MASTER_KEY` | 32 随机字节的标准 Base64，独立于服务凭据；只在密钥管理中配置，勿写入代码/日志 |
| `BINANCE_DATA_DIR` | 持久盘绝对路径，例如 `/data`；目录必须由服务账户独占 |
| `BINANCE_PERSISTENT_STORAGE_CONFIRMED` | 持久盘备份与重启恢复验证后设 `true` |
| `BINANCE_FIXED_EGRESS_IP` | 实际稳定出站 IP，供用户配置 Binance 白名单 |
| `BINANCE_FIXED_EGRESS_CONFIRMED` | 运营者确认出站稳定后设 `true`；仅此声明不等于账户已核验 |
| `BINANCE_SITE_ORIGIN` | 默认当前 Site 的 HTTPS origin，不含末尾斜线 |
| `PORT` | 默认 `8080`；由 HTTPS 反向代理接入 |

执行器连接时仅发送签名 GET，完整验证真实 UID、IP 白名单开关、读取/期权权限、提现等危险权限关闭、专用账户隔离和真实费用。成功 GET 与 `ipRestrict=true` 是必要证据；不能自动证明基础设施永远不会更换 IP。连接不等于允许立即下单；每次准备和确认仍走原门禁。

凭据使用 AES-256-GCM（随机 nonce、UID 作为 AAD）加密写入独立 SQLite，账户策略按 UID 分库。掌握 master key 与持久盘即可解密；必须限制两者访问，并安全备份，暂未提供在线换主密钥工具。API 凭据不写策略 journal，不放 URL 或响应。HTTP access log 禁止记录请求体/Cookie/Authorization。

代理仅转 `__Host-btc_put_session` Cookie，设置服务端 `Authorization: Bearer …`、固定 Site `Origin`、`X-Forwarded-Proto: https`。将响应 Set-Cookie 原样传回同源浏览器，不加 Domain。POST 需 `Content-Type: application/json` 及 `X-CSRF-Token`；GET status 返回 CSRF，不把服务 Bearer 交给浏览器。执行器不启用 CORS。只支持固定路径，无 query。

`GET /v1/status` 以带签名的无状态访客 Cookie 建立 Secure/HttpOnly/SameSite=Strict 会话；匿名浏览不占已连接会话容量。UID 核验成功后才将 Cookie hash 绑定账户，CSRF 只在内存使用；15 分钟闲置或 8 小时绝对过期，重启后重新连接。未认证连接限制并发与请求频率。`POST /v1/connect` 仅接受 `{apiKey,apiSecret,tradingEnabled:true}`。`POST /v1/disconnect` 仅接受 `{}`；有未结束策略时仅撤销浏览器会话，原确认的到期处理继续；无活策略删除加密凭据。`GET /v1/plans`、`POST /v1/prepare`、`/confirm`、`/pause` 均仅操作当前已验证 UID。prepare 参数为 `{amount,symbol,settlementMode:"cash"|"buy_btc",buyBufferRate?}`；confirm 为 prepare 返回的 `{id,fingerprint,account,currency,confirmed:true}`；pause 为 `{id}`。

Site 服务端另设 `BINANCE_EXECUTION_ORIGIN`（执行器的 HTTPS origin）和秘密变量 `BINANCE_EXECUTION_SERVICE_AUTH`（与执行器 `BINANCE_SERVICE_SECRET` 相同）。这些变量不进入前端；未配置时，公开页面保持行情可读、凭据表单关闭和下单禁用。仅设置 URL 或服务凭据不证明真实账户已通过核验。

启动恢复先把已有策略以内存暂停视图执行只读对账，不改变用户原暂停标记；完成后才开放后续动作。未知 PUT、划转或现货状态先查真实记录，绝不重发。每 5 秒处理已授权策略；浏览器退出不停止已授权到期动作。旧 core 保留五分钟买币窗口、限价 IOC、部分现货成交停止、专用账户和 BNB 抵扣关闭要求，不能承诺固定数量或必定全部接币。

部署前尚需验证真实主网只读权限及 schema、固定出口白名单、反向代理限流和凭据传输、持久盘/备份/主密钥管理及运营告警。当前没有部署资源、计费或真实账户/订单验证；mock 测试不代表交易通道已实盘验收。

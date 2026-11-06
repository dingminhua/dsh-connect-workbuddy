# CN 网关备选主机（issue #220）

> 本文记录 `regions.cn.cnBase` 这一设置**为什么存在、允许什么、实测到了什么**。
> 它是本仓库里唯一一个让用户改「请求发到哪台主机」的设置，所以每一条边界都要写清依据。

## 问题

企业网络按 **TLS ClientHello 的 SNI** 做黑名单时，`copilot.tencent.com`、`www.workbuddy.cn`、
`www.codebuddy.cn` 三个 CN 品牌主机都连不上——**TCP 可连通，带这些 SNI 的 ClientHello 被即时 RST**，
`ECONNRESET`，耗时 <100ms。而同一台机器上的 WorkBuddy 桌面客户端**正常**，因为它读自己配置里的
failover 列表（`~/.workbuddy/failover.json` 的 `trustedOrigins`），其中还有 `wb.tencentbuddy.com`。

改 hosts 绕不过去（拦截只看 SNI 与解析无关，且证书 SAN 不含被拦域名），所以**只能改代码**。

## 实测（2026-11-06，macOS，非受限网络）

九条 CN 路由，`wb.tencentbuddy.com` 与 `copilot.tencent.com` 的**状态码逐条相同**：

| 路由 | copilot.tencent.com | wb.tencentbuddy.com |
| --- | --- | --- |
| `GET /v3/config` | 200（252B） | 200（252B，同信封） |
| `POST /v2/chat/completions` | 401 | 401 |
| `POST /v2/chat/busy` | 400 | 400 |
| `POST /v2/plugin/auth/token/refresh` | 400 | 400 |
| `GET /v2/plugin/auth/token` | 200 | 200 |
| `POST /v2/billing/meter/get-user-resource` | 401 | 401 |
| `POST /v2/billing/meter/checkin-activity-status` | 401 | 401 |
| `POST /v2/billing/meter/daily-checkin` | 401 | 401 |
| `POST /billing/meter/compensation-status` | 401 | 401 |

`/v3/config` 的 252 字节信封在 **四个 CN 主机**上逐个相同（`wb.tencentbuddy.com`、
`copilot.tencent.com`、`www.codebuddy.cn`、`www.workbuddy.cn`）——这就是「同构主机」的直接证据，
也解释了为什么 `src/upstream.ts` 里早有一条注释说这些主机「逐字节同答」。

本机 `~/.workbuddy/failover.json` 的 `trustedOrigins` 同时列出这三个 CN 主机，与上面的测量一致。

**档位**：以上是**实测**（本机 curl，非受限网络）。**受限网络下 wb 可用**这一点来自 issue 报告者，
本仓库**未复现**——那种网络不在维护者机器上。设置本身不依赖复现：它只是让用户把主机指到别处。

## 允许什么

`src/cn-gateway.ts` 的允许清单按**可注册域**匹配：

- `copilot.tencent.com`
- `tencentbuddy.com`（含 `wb.` 与任意子域）
- `workbuddy.cn`
- `codebuddy.cn`

必须是 **https**；路径、查询、锚点、userinfo 全部丢弃（只保留主机名）。

## 为什么是允许清单，不是「任意 URL」

这个 base 会被拼到每一条带 `Authorization: Bearer <token>` 的 CN 请求前面，也包括 refresh token 交换。
**一个自由的 base 就是一枚凭据外泄原语**：能改设置的人（同步的 profile、共享的 dotfile、论坛上抄来的
「修复」）就能把活的 WorkBuddy token 重定向到自己的主机，而且**看不出坏了**——请求照样成功。

所以允许清单是安全边界，不是便利。`tests/cn-gateway.spec.ts` 里真正吃重的是几个近似域用例：
`tencentbuddy.com.evil.example` 必须被拒，而这正是手写 `endsWith('tencentbuddy.com')` 会放过的形状。

## 什么跟着变、什么不变

**跟着变**：chat、模型目录、busy 探测、生图/生视频、签到、积分、领取权益——所有 CN 出口。

**不变**：

- `Origin` / `Referer`：它们回答的是「这个请求自称来自哪个网页应用」，与连到哪台主机无关。
  从覆盖值改写会让身份自述自相矛盾，而网关正是按「CN 网页端」读它们的。
- **国际版**：全球 token 按品牌绑定（`codebuddy.ai` 的 token 被 `workbuddy.ai` 网关拒绝，反之亦然），
  没有「换一个同构主机」这回事。所以该设置**只作用于 CN**，国际版 tab 上连控件都不渲染。
- 账号与区域：这是连接层的事，不改计费对象。

## 三条入口，一套校验

| 入口 | 读什么 | 谁用 |
| --- | --- | --- |
| 卡片「能力」栏的输入框 | `regions.cn.cnBase` | 用户 |
| 每一条 CN 请求 | 同上，**每次现读** | 运行中的插件 |
| `doctor` | `WORKBUDDY_CN_BASE` 环境变量 | CLI |

为什么 `doctor` 要单独用环境变量：它跑在自己的进程里，**从不加载插件设置**——这也是
`WORKBUDDY_DEVICE_TOKEN_FILE` 早就存在的同一个原因。没有它，用户修好网络后跑 `doctor`，
拿到的报告是**对着他那张网络会重置的网关**测的；一个谎报「我探了哪台主机」的诊断工具比没有更糟。

三条入口都走 `resolveCnGateway`，所以**校验规则不可能分叉**。

## 每次现读，不是构造期采样

`regions` 是 volatile 字段，用户在卡片上保存后不重启插件。若在构造期采样一次，
改设置就只有重启才生效——而「填了没反应」恰好是本设置唯一的用途。所以 client 收的是
**读取器**（`cnBase?: () => string`），不是值。

## 失败时怎么表现

**卡片**：非法值**拒绝保存**，并按具体规则说明（「不是完整 URL」/「只接受 https」/「不是 CN 品牌主机」）。
三种规则需要三种不同的修法，一句笼统的「无效」等于没说。

**Host**：配置里若有一个通不过校验的值（手改的、旧版本写的、同步弄坏的），请求层**退回内置网关并记一条
warn**，且**同一个值只警告一次**——这条路径在每一次请求上，不能把一次误配置变成每个请求一条日志。
退回而不是抛，是因为抛会打断聊天。

**诊断栏**：报告的是**解析后生效的值**，不是保存的原始字符串。一个保存了但校验失败的值仍然走内置网关，
回显原文就会告诉用户「你的覆盖已生效」——而实际上每个请求都去了别处。

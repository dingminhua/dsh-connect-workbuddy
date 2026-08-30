# 设计方案：dsh-connect-workbuddy

> **目标**：连接 WorkBuddy 的 DSH 插件。
> **表现形式**：与 `dsh-connect-trae` 一致（插件家族统一外观）。
> **内核**：参考 `dsh-workbuddy-connect`（技术难题照搬已验证的做法）。
> **体验**：从 trae 借来，解决 workbuddy 原版的不足。

---

## 一、两个项目的分工

| 层 | 来源 | 取什么 |
|---|---|---|
| 插件外壳 / 外观 | `dsh-connect-trae` | 卡片结构、`dsm-*` CSS、LD 品牌图标、`settingsScope` 配置回写、3 条 webServer 路由、npm 发布工程、CI |
| 连接内核 | `dsh-workbuddy-connect` | 桌面端凭据读取、token 刷新、`copilot.tencent.com` 上游协议、SSE 直通、shim 加固、CLI 诊断、host heartbeat |
| 体验改善 | 新设计（见下） | 模型管理、账号切换、凭据路径多候选、错误信息可读 |

两项目已有大量同构代码（`web-status.ts` 的 `safeMessage`/`loopbackOrigin`/`json` 三个函数几乎逐字相同，`client/index.tsx` 结构一致），说明这条融合路径是低风险的。

---

## 二、内核：照搬 workbuddy 的什么

这些是技术难点，别人已经验证可用，不要重造：

1. **凭据发现与解析**（`auth.ts`）
   - 平台默认路径：`~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info`
   - 两种文档形态都支持：嵌套 `{"auth":{...},"account":{...}}` 与扁平 panel 形态
   - `expiryToMs()` 同时接受秒与毫秒
   - **双凭据择新**：桌面端文件（只读）+ `$DSH_HOME/.workbuddy-auth.json`（持有刷新结果），取 `expiresAtMs` 较大者；桌面端文件永不写入
   - 按需刷新：仅在 5 分钟余量内刷新，单飞去重；刷新失败但 token 未过期则继续用旧 token

2. **上游协议**（`upstream.ts`）
   - chat：`POST {base}/v2/chat/completions`，base 由 `domain` 决定（`workbuddy.ai` → global，否则 cn → `copilot.tencent.com`）
   - 强制 `stream: true`（上游拒绝非流式）；`tool_choice` 从 OpenAI 对象形态压成上游要的字符串
   - CLI 形态请求头：`X-User-Id` / `X-No-User-Id`、`X-Enterprise-Id` / `X-No-Enterprise-Id`、`X-Domain` / `X-No-Department-Info`、`X-Product: SaaS`
   - 刷新走独立的 `X-Refresh-Token` 头；**chat 请求绝不携带 refresh token**（原版注释标为安全红线）
   - 错误分类：`hard_credit` / `soft_rate` / `session_dead` / `not_found` / `server` / `client`，含中英文额度不足标记

3. **shim 加固**（`shim.ts`）—— 全部保留
   - 随机端口 + 进程内随机 secret（`randomBytes(32).toString('base64url')`），`timingSafeEqual` 常量时间比对
   - 四重入站校验：Host 头必须回环、Origin 必须回环、content-type 必须 JSON、bearer 必须匹配
   - 真实 WorkBuddy token 不交给 pi-ai；shim 自己从 store 解析

4. **适配器**（`adapter.ts`）：`createProvider` + `openAICompletionsApi()` + inert auth plane + `resolveApiKey: () => shim.token()`

5. **保留 CLI 诊断**：`status` / `doctor` / `logout` + host heartbeat 文件（用户明确要求保留）

---

## 三、体验：从 trae 借什么

### 3.1 模型管理（原版最大短板）

**原版问题**：`catalog.ts` 只有 45 行，11 个模型硬编码为常量；启动后拉一次上游就全量覆盖，用户**不能启用/禁用、不能手动刷新、不能选择**。

**改善方案**（照搬 trae 的 `lastCatalog` + 勾选模型）：

```
Config:
  lastCatalog?: WorkBuddyModelInfo[]   // 上次刷新的完整目录（卡片展示用）
  enabledModelIds?: string[]           // 用户勾选启用的模型 id
```

- 运行时目录 = `deriveCatalog(lastCatalog, enabledSet)`，与展示目录分离
- 卡片永远展示**最新刷新的目录**，不是陈旧快照
- 上游刷新是**草稿操作**，用户点保存才写入运行时目录
- 有 Discard / Save 两个按钮 + dirty 标记

**上游数据完全撑得起**（实测 28 个模型 / 16 个 cli 模型）：

| 上游字段 | 卡片展示 |
|---|---|
| `id` / `name` | 模型名与 id |
| `maxInputTokens` / `maxOutputTokens` | 上下文 / 最大输出 |
| `credits` (`"x0.79 credits"`) | 积分倍率，需从字符串解析出数字 |
| `supportsImages` | ~~多模态标记~~（已弃用，见下方「图片输入手动开关」） |
| `reasoning.supportedEfforts` (`["low","high","xhigh"]`) | 可选推理档位（用户可选手动档位） |
| `reasoning.effort` (`"high"` / `"medium"`) | 固定推理档位（上游只标默认强度，未给可选档位） |
| `reasoning.defaultEffort` | 默认档位 |
| `descriptionZh` / `descriptionEn` | 中英文描述 |
| `onlyReasoning` / `supportsToolCall` | 能力标记 |

> 原版把这些**全丢了**，只留 id/name/tokens。这是最可惜的一处。
>
> **图片输入手动开关**：`supportsImages` / `disabledMultimodal` 上游标记实测不可靠，图片支持改由用户勾选 `imageModelIds` 显式决定（默认不勾选），不再从上游能力标记推断。见 `src/index.ts` 的 `withImageSelection`。
>
> **推理强度两态（已知问题）**：上游 `reasoning` 有两种形态——(A) `supportedEfforts` 数组（可选手动档位，如 glm-5.3 的 low/high/xhigh）与 (B) `effort` 单值（固定档位，如 deepseek 的 high）。当前 `parseReasoning`（`src/upstream.ts`）只解析形态 A，形态 B 的 11 个 cli 模型（deepseek-v4-flash/pro、hy3、auto、glm-5.1/5.2、glm-5v-turbo、kimi-k3-1/k2.7/k2.6、minimax-m3）推理能力会被整体丢弃。详见 `docs/reasoning-investigation.md`。

### 3.2 账号切换（实测可行，原版完全没有）

**原版问题**：只认 `workbuddy-desktop.info` 单文件，账号切换只能靠在 WorkBuddy App 里重新登录。

**实测证据**（本机，只读探测）：

```
distinct accounts (by uin): 2
  uin <A>: <账号甲>  <- workbuddy-desktop.info
  uin <B>: <账号乙>  <- workbuddy-desktop.2026-08-28T...info

uin <A> (<账号甲>): catalog HTTP 200, 28 models, 16 cli, credits total=1875
uin <B> (<账号乙>): catalog HTTP 200, 28 models, 16 cli, credits total=0
```

> uin 与昵称在本文件中做脱敏处理；真实输出见 `scripts/probe-account-switch.mjs`（该脚本只在本机运行，不打印 token）。

**两个账号都拿到 28 个模型，但一个有 1875 积分、一个是 0** —— 用户必须能选。

**设计方案**：
- 扫描**整个 auth 目录**而非单个文件：`workbuddy-desktop.info` + 所有 `workbuddy-desktop.<stamp>.info` 历史文件
- 按 `uin` 去重（实测 6 个文件 → 2 个账号）
- 每个账号一项：`{ id: sha256(uin), accountName: nickname, uin, domain, source, tokenExpiresAtMs, selected }`
- 优先用最新文件（按文件名时间戳倒序）
- 默认选中**有可用积分**的账号（trae 的 `setPreferAccountIds` 思路，实测直接适用：0 积分账号选了会失败）
- `accountId` 存进配置，**token 不进配置**（与 trae 一致）

> 注意：历史文件是 WorkBuddy 的**备份产物**，不是官方多账号 API。需在 README 明确标注，并把"跟随 App 当前登录"作为默认行为，账号切换作为显式选择。

### 3.3 平台路径（原版未验证 Windows/Linux）

**原版**：macOS 单路径；Windows 有 Local/Roaming 两个候选但未验证；Linux 未验证。

**改善**：
- 凭据文件候选列表化（macOS / Windows Local+Roaming / Linux XDG），逐个探测
- auth 目录整体扫描（同时服务于多账号）
- 环境变量 `WORKBUDDY_AUTH_FILE` 仍可覆盖
- 卡片内可直接指定 `authFile` 路径，不必手改配置文件
- `doctor` 命令输出每个候选路径的命中情况

### 3.4 其他体验点

- **积分展示**：原版只显示 `total` + 每个包的进度条；实测有 20~29 个包，其中 19 个同名「运营裂变包」各 100 积分 —— 需要**按包名聚合**，否则卡片被刷屏。同时区分**月度周期套餐**（按周期刷新、看周期剩余）与**一次性礼包**（看到期时间）；月度包不显示到期时间、展示下次刷新点
- **每日签到**：`/plugins/dsh-connect-workbuddy/checkin`（POST）提供一键签到，查询状态与领取均走该路由，回环来源校验 + 领取前二次确认，不重复领取
- **卡片外观**：从 workbuddy 的 inline style 换成 trae 的 `dsm-*` CSS 类 + `--dsw-alias-*` 主题变量 + LD 图标
- **错误呈现**：上游错误分类映射到人话（额度不足 / 需重新登录 / 限流），而不是抛 HTTP 状态码

---

## 四、目标结构

```
dsh-connect-workbuddy/
├── package.json            # trae 的元数据形态 + workbuddy 的 bin 字段
├── cordis.patch.yml        # - insert: [{ id: dsh-connect-workbuddy, name: dsh-connect-workbuddy }]
├── tsdown.config.ts        # 双入口（node ESM + browser CJS） + version define
├── tsconfig.json / .client.json
├── vitest.config.ts
├── RELEASING.md            # 照搬 trae（含 Copyright (c) 2026 LaoDing 不变）
├── CHANGELOG.md
├── README.md / README.en.md
├── THIRD_PARTY_NOTICES.md  # workbuddy2api (MIT) + dsh-workbuddy-connect 参考
├── src/
│   ├── index.ts            # host 入口：Config schema + 路由 + 适配器注册
│   ├── status-paths.ts     # 3 条路由常量 + 共享类型（node-free）
│   ├── web-status.ts       # usage / models:refresh / accounts:refresh
│   ├── auth.ts             # 多账号凭据 store（改造自 workbuddy）
│   ├── upstream.ts         # 照搬 workbuddy + 解析 credits/reasoning/多模态
│   ├── catalog.ts          # lastCatalog + deriveCatalog（照搬 trae 模型）
│   ├── adapter.ts          # 照搬 workbuddy
│   ├── shim.ts             # 照搬 workbuddy（加固全部保留）
│   ├── bin.ts              # status / doctor / logout CLI（保留）
│   ├── host-heartbeat.ts   # 保留
│   └── client/
│       ├── index.tsx       # trae 形态（inject: slots, locale, settingsScope）
│       ├── WorkBuddyCard.tsx
│       ├── locales.ts      # row.* 中英
│       ├── styles.ts       # dsm-* CSS
│       └── icon.ts         # LD 图标
├── tests/
├── scripts/                # 探针与校验脚本（probe-auth / probe-accounts / probe-account-switch / probe-models / probe-credits / probe-checkin / verify-e2e）
└── docs/DESIGN.md
```

---

## 五、溯源与致谢（强制规范）

### 5.1 溯源链

```
dsh-codex-connect (Apache-2.0)  ──► dsh-workbuddy-connect (MIT, Corrine Hu) ──┐
workbuddy2api (MIT)             ──► dsh-workbuddy-connect                     ├──► 本项目 (MIT, LaoDing)
dsh-subagent-default-model (MIT) ──► dsh-connect-trae (MIT, LaoDing)         ──┘
```

### 5.2 许可证义务差异（关键点）

| 许可证 | 义务 | 本项目的履行 |
|---|---|---|
| MIT | 保留版权与许可声明 | README 致谢 + THIRD_PARTY_NOTICES + 源文件头标注 |
| **Apache-2.0** | 除上述外，还需**声明改动**、随带 **NOTICE**（若有）、保留专利/商标免责 | 单独一节说明：标注「经 dsh-workbuddy-connect 转引」、声明未修改其源码、上游若无 NOTICE 文件则如实说明 |

> `dsh-codex-connect` 是唯一非 MIT 的参考项，且是**间接**参考（经 workbuddy 转引）。即便如此也按 Apache-2.0 第 4 条完整履行，不因间接而省略。

### 5.3 源文件头标注规范

**每个从参考项目借鉴的源文件，头部注释必须写明三件事**：参考了谁、参考了什么、本项目改动了什么。格式：

```ts
/**
 * <本模块职责一句话>
 *
 * 参考：<项目名>（<许可证>）— <具体借鉴了什么>
 * 改动：<本项目相对参考实现做了什么不同的事，为什么>
 *
 * @module dsh-connect-workbuddy/xxx
 */
```

按文件分配：

| 文件 | 标注来源 |
|---|---|
| `src/upstream.ts` | `dsh-workbuddy-connect` (MIT) + `workbuddy2api` (MIT)；改动：解析 credits/reasoning/多模态字段 |
| `src/auth.ts` | `dsh-workbuddy-connect` (MIT)；改动：单文件 → 目录扫描多账号 |
| `src/shim.ts` | `dsh-workbuddy-connect` (MIT)；改动：无（加固原样保留） |
| `src/adapter.ts` | `dsh-workbuddy-connect` (MIT) → `dsh-codex-connect` (Apache-2.0) 转引 |
| `src/bin.ts` / `src/host-heartbeat.ts` | `dsh-workbuddy-connect` (MIT)；改动：扩展多账号诊断 |
| `src/catalog.ts` / `src/web-status.ts` / `src/client/*` | `dsh-connect-trae` (MIT) → `dsh-subagent-default-model` (MIT) 转引 |

### 5.4 分发层面

- `THIRD_PARTY_NOTICES.md` 列入 `package.json` 的 `files` 白名单，随 npm 包分发
- README（中英双语）致谢章节与该文件互为索引
- LICENSE 版权主体保持 **Copyright (c) 2026 LaoDing**（不改成 npm/GitHub 账号名）

## 六、风险与边界

1. **历史 auth 文件不是官方多账号 API** —— 是 WorkBuddy 的备份产物。默认仍跟随 App 当前登录，切换是显式选项；文档需如实说明。
2. **上游协议非官方** —— WorkBuddy 更新可能破坏；保留静态 fallback 目录，上游不可用时 provider 不空。
3. **`credits` 字段是字符串**（`"x0.79 credits"` / `"x0.05"` / `undefined`）—— 解析需容错，解析不出就不显示倍率，不虚构。
4. **隐私** —— 卡片只传昵称/uin 掩码/到期时间/积分；token、uid 不出现在任何 HTTP 响应里。所有探针脚本已按此原则编写（只输出长度与形状）。
5. **合规** —— 沿用 workbuddy 的免责声明；第三方声明登记 `workbuddy2api` (MIT) 与架构参考。

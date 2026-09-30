# 审计 B：客户端 ↔ Host 数据契约一致性

**审计对象**：账号池（account pool）功能中，客户端渲染所依赖的每一个字段，Host 是否真的下发。

**只读约束**：未修改 `src/` 下任何文件，也未修改 `tests/`。本次审计只新增本报告（`git status` 已确认 `src/` 的改动全部来自同伴，与本会话无关）。

**方法**：三方静态对照（类型 → Host 填充 → 客户端消费）+ **挂载真实插件实测**。用 `node --experimental-strip-types` 挂载真实 `apply()` + 真实路由，配合伪造的 `webServer`/`settings` 与桩化的 upstream `fetch`，直接 dump 线上 JSON。临时脚本写在 `/tmp/wb-audit/`，**已删除**，仓库内无遗留。

**审计基线（sha256 前 12 位；全部行号以此为准）**：

| 文件 | 基线 | 角色 |
| --- | --- | --- |
| `src/status-paths.ts` | `bfa7467eb433` | 契约类型定义 |
| `src/web-status.ts` | `034c4a327dd0` | Host 填充 `workBuddyWebPool()` + pool 路由 |
| `src/index.ts` | `9f470926f0cb` | Host pool deps（数据源） |
| `src/client/AccountPool.tsx` | `b5a8117521d1` | 客户端消费 |
| `src/account-pool.ts` | `e61029559513` | `rankPool` / `resolveTargetModel` / `pickAccount` |
| `src/account-pool-run.ts` | `ca93f2e2cfe3` | 批量行构造 |
| `src/account-pool-store.ts` | `7ada6cc37b23` | 测量结果落盘 |
| `src/client/WorkBuddyCard.tsx` | `755dcc61160d` | 轮询与父组件接线 |

**结论**：确认发现 **11** 条 —— 高 **2** / 中 **3** / 低 **6**。

**三态统计**（下列各表逐行可数，口径见注）：

| 三态 | 计数 | 明细 |
| --- | --- | --- |
| ✅ 已接线 | **31** | Pool 9 + Account 12 + Model 3 + 批量行 7 |
| ⚠️ 类型有但 Host 不填 | **0** | 本功能**不存在「类型撒谎」**：每个声明字段 Host 都会按语义产生。这是本次修复的核心成果 |
| ◻️ 客户端不消费 | **12** | 有语义价值 **3** 项（`member` + 两个 `accountId`）；有意精简 **9** 项（行内可选字段） |
| 无人 import 的信封字段 | **3** | `CheckinAnswer.action/rows`、`TestAnswer.rows` —— 两个信封类型无任何消费者，见 B-11 |
| **已声明字段合计** | **46** | 43（表中行）+ 3（信封未列表字段） |

> 计数口径：容器对象（`probe`、`result`）与其内部字段**各自单独计数**；`result.outcome` 计入「批量行 7 项」，`result` 的其余 6 个可选字段（`modelId/elapsedMs/status/message/retryAtMs/retrySource`）计入「不消费 12 项」。

---

## 一、三态总表（逐字段，验收要求的完整覆盖）

图例：**✅ 已接线** ＝ 类型有 + Host 真的赋值 + 客户端真的读；**⚠️ Host 不填** ＝ 类型声明了但 Host 永不产生该值；**◻️ 不消费** ＝ Host 真的下发但客户端从不读（下发了也用不上）。

### `WorkBuddyWebPool`（`status-paths.ts:565-594`）

| 字段 | 类型行 | Host 填充 | 客户端消费 | 结论 |
| --- | --- | --- | --- | --- |
| `enabled` | `565`+`566` | `web-status.ts:612` ← `index.ts:1016` | `AccountPool.tsx:202` | ✅ 已接线 |
| `rotateByCredits` | `567` | `web-status.ts:613` ← `index.ts:1017` | `AccountPool.tsx:203, 222` | ✅ 已接线 |
| `autoTestIntervalMinutes` | `568` | `web-status.ts:614` ← `index.ts:1018` | `AccountPool.tsx:204, 691` | ✅ 已接线 |
| `targetModelId?` | `570` | `web-status.ts:615`（有则带） | `AccountPool.tsx:205, 332, 386, 388, 397, 711` | ✅ 已接线（可选语义见 B-2） |
| `targetModelSource` | `571` | `web-status.ts:616` ← `account-pool.ts:379-388` | `AccountPool.tsx:385-389, 422-423, 496` | ✅ 已接线 |
| `memberAccountIds?` | `573` | `web-status.ts:617` ← `index.ts:1020` | `AccountPool.tsx:206, 217, 328, 413, 455, 482` | ✅ 已接线（stale 见 B-1） |
| `rotatedToAccountId?` | `582` | `web-status.ts:618` ← `index.ts:889` | `AccountPool.tsx:255-266` | ✅ 已接线（实测已确认，见下） |
| `accounts` | `583` | `web-status.ts:619` | `AccountPool.tsx:220-221, 318, 396, 456, 479` | ✅ 已接线 |
| `catalog?` | `593` | `web-status.ts:625-629` | `AccountPool.tsx:722-727` | ✅ 已接线（**catalog 从不下发 undefined**，见 B-7） |

### `WorkBuddyWebPoolAccount`（`status-paths.ts:518-554`）

| 字段 | 类型行 | Host 填充 | 客户端消费 | 结论 |
| --- | --- | --- | --- | --- |
| `accountId` | `519` | `web-status.ts:588` | `AccountPool.tsx:261, 318, 482, 519, 549` | ✅ 已接线 |
| `accountName` | `520` | `web-status.ts:589` | `AccountPool.tsx:261, 264, 350, 532, 566` | ✅ 已接线（`''` 有占位，见 B-10） |
| `credits?` | `522` | `web-status.ts:590-591` | `AccountPool.tsx:581-583` | ✅ 已接线（三态正确，见 B-3） |
| `expiringSoon?` | `524` | `web-status.ts:592` | `AccountPool.tsx:584-586` | ✅ 已接线（实测 `900`） |
| `nearestExpiryMs?` | `526` | `web-status.ts:593-595` | `AccountPool.tsx:587-590` | ✅ 已接线（实测已确认） |
| `probe?` | `528` | `web-status.ts:597-603` | `AccountPool.tsx:534, 537, 543, 576` | ✅ 已接线 |
| `probe.outcome` | `529` | `web-status.ts:599` | `AccountPool.tsx:161, 369, 545` | ✅ 已接线 |
| `probe.atMs` | `530` | `web-status.ts:600` | `AccountPool.tsx:576` | ✅ 已接线 |
| `probe.retryAtMs?` | `532` | `web-status.ts:601` | `AccountPool.tsx:537-538, 543-544` | ✅ 已接线（缺失语义正确，见 B-4） |
| `excludedBy?` | `535` | `web-status.ts:604` | `AccountPool.tsx:155-159, 168-173, 221` | ✅ 已接线（实测 `"rate-limited"`） |
| `current` | `537` | `web-status.ts:605` ← `index.ts:891-897` | `AccountPool.tsx:220, 400, 548` | ✅ 已接线 |
| `member` | `545` | `web-status.ts:606` | **无** | ◻️ **不消费**（见 B-6） |
| `checkedInToday?` | `553` | `web-status.ts:607` | `AccountPool.tsx:597-602` | ✅ 已接线（缺失语义正确，见 B-5） |

### `WorkBuddyWebPoolModel`（`status-paths.ts:614-619`）

| 字段 | 类型行 | Host 填充 | 客户端消费 | 结论 |
| --- | --- | --- | --- | --- |
| `id` | `615` | `web-status.ts:626` | `AccountPool.tsx:723, 724` | ✅ 已接线 |
| `name` | `616` | `web-status.ts:627` | `AccountPool.tsx:726, 727` | ✅ 已接线 |
| `creditMultiplier?` | `618` | `web-status.ts:628`（有则带） | `AccountPool.tsx:725-727` | ✅ 已接线（可选性被正确尊重，见 B-8） |

### 批量响应行（`status-paths.ts:597-633`）

| 字段 | 类型行 | Host 填充 | 客户端消费 | 结论 |
| --- | --- | --- | --- | --- |
| `CheckinRow.accountId` | `598` | `account-pool-run.ts:112` | **无** | ◻️ 不消费 |
| `CheckinRow.accountName` | `599` | `account-pool-run.ts:112` | `AccountPool.tsx:350, 355, 359` | ✅ 已接线 |
| `CheckinRow.status` | `600` | `account-pool-run.ts:117,120,128,130,134,139` | `AccountPool.tsx:348, 353, 357` | ✅ 已接线 |
| `CheckinRow.credit?` | `601` | `account-pool-run.ts:135` | `AccountPool.tsx:351` | ✅ 已接线（实测 `150`） |
| `CheckinRow.streakDays?` | `602` | `account-pool-run.ts:136` | **无** | ◻️ 不消费（见 B-9） |
| `CheckinRow.message?` | `603` | `account-pool-run.ts:117,120,128,139` | `AccountPool.tsx:360` | ✅ 已接线 |
| `TestRow.accountId` | `608` | `account-pool-run.ts:172` | **无** | ◻️ 不消费 |
| `TestRow.accountName` | `609` | `account-pool-run.ts:172` | `AccountPool.tsx:368` | ✅ 已接线 |
| `TestRow.result` | `610` | `account-pool-run.ts:192` | `AccountPool.tsx:369-370` | ✅ 已接线 |
| `result.modelId` | `476` | `probe.ts:384, 402, 419` | **无** | ◻️ 不消费 |
| `result.outcome` | `477` | `probe.ts:385, 403, 420` | `AccountPool.tsx:369-370` | ✅ 已接线 |
| `result.elapsedMs?` | `479` | `probe.ts:404, 421` | **无**（池内；卡片别处用） | ◻️ 不消费 |
| `result.status?` | `481` | `probe.ts:405, 422` | **无** | ◻️ 不消费 |
| `result.message?` | `483` | `probe.ts:386, 406, 423` | **无**（池内；卡片别处用） | ◻️ 不消费 |
| `result.retryAtMs?` | `494` | `probe.ts:272` ← `cooldownOf`（`probe.ts:409, 424` 展开） | **无**（池内读的是 `probe.retryAtMs`） | ◻️ 不消费 |
| `result.retrySource?` | `496` | `probe.ts:272-276` ← `cooldownOf` | **无** | ◻️ 不消费 |
| `TestAnswer.action` | `629` | `web-status.ts:826` | **无** | ◻️ 不消费 |
| `TestAnswer.modelId?` | `631` | `web-status.ts:826` | **无** | ◻️ 不消费 |

> 注：上表「不消费」共 **12 项**。其中 **9 项是有意的精简** —— 行内可选字段（`CheckinRow.streakDays`、`result.elapsedMs/status/message/retryAtMs/retrySource`、`TestAnswer.action/modelId`），池日志只渲染 `accountName + outcome`，下发了不用不是缺陷。**有语义价值的只有 3 项**：`WorkBuddyWebPoolAccount.member`（见 B-6）与两个 `accountId`（`CheckinRow.accountId`、`TestRow.accountId`）—— 后两者本可用于把批量结果**关联回具体账号行**，目前只靠 `accountName` 匹配，而 `accountName` 在空名时统一显示为占位（见 B-10），同名或空名账号无法区分。

---

## 二、确认发现

### B-1（高｜契约·stale 成员表）`memberAccountIds` 可指向已消失的登录，客户端据此渲染出一个**勾不中任何行**的「已选 1 / 共 1」并放行按钮，Host 则静默跑空批

- **位置**：Host 只按「当前登录列表」过滤成员（`src/index.ts:1033-1040`），但下发的 `memberAccountIds` 是**未过滤的原始偏好**（`src/web-status.ts:617` ← `src/index.ts:1020`）；客户端两处各读一个来源 —— 计数与按钮看偏好（`AccountPool.tsx:413, 455, 328`），勾选态看行（`AccountPool.tsx:482`）。
- **问题**：`poolMemberAccounts()` 明确写了「按 LIVE 账号列表过滤，被移除的登录不能在池里残留」（`index.ts:1037-1039`），但**这份过滤结果没有回流到 `memberAccountIds`**。于是同一个文档里 `memberAccountIds`（未过滤）与 `accounts[].member`（过滤后）互相矛盾。
- **实测证据**（挂载真实插件，保存 `memberAccountIds: ['ghost-account-id-that-no-longer-exists']`，磁盘上只有一个真实登录）：
  ```
  === memberAccountIds (saved): ["ghost-account-id-that-no-longer-exists"]
  === accounts rows: [{"member":false}]
  === client would render "N of M selected" as: 1 of 1
  === client would enable the buttons (memberAccountIds.length !== 0): true
  === client would check the visible row (memberAccountIds.includes(rowId)): false
  === checkin batch with a stale member id === 200 {"action":"checkin","rows":[]}
  === upstream requests made by that batch: 0
  ```
- **用户可见后果**：界面显示「已选 1 / 共 1」、两个按钮**可用**（`AccountPool.tsx:413, 421` 只看 `memberAccountIds.length`）、表格里那唯一一行**未勾选**；点「全部签到」后 Host 返回 `200 {"rows":[]}`，客户端打印「开始签到 1 个账号」（`:331` 用的是 `saved.memberAccountIds.length`）→「签到完成」（`:364`），**零个账号被签到、零次上游请求**，而界面宣称完成。这是「未签到」列与批量结果长期对不上的一个独立成因。
- **严重级**：高。这是**静默的成功假象**，且是本次修复的「签到列永远显示未签到」之外的另一条同类路径。
- **修复方向**（供 Lead 参考，本审计不改码）：`web-status.ts:617` 应下发**过滤后**的成员集合（与 `poolMemberAccounts` 同源），或让客户端以 `accounts[].member` 为准渲染计数与勾选态。

### B-2（高｜契约·自相矛盾）`targetModelSource` 三态与 `targetModelId` 可组合出「preferred + 目录里不存在」，客户端文案与按钮都按「已选定」放行

- **位置**：`src/account-pool.ts:379-388` —— `resolveTargetModel` 对 `preferredId` **只判空、不校验存在于目录**；`src/web-status.ts:615-616` 原样下发；客户端 `AccountPool.tsx:385-389` 渲染文案、`:422` 放行测试按钮、`:496` 不显示告警。
- **问题**：`targetModelSource === 'preferred'` 的语义是「你指定的模型」（`locales.ts:118`），但 Host 从不对照 `catalog` 校验这个 id。`resolveTargetModel` 的第三态 `'none'`（`account-pool.ts:387`）**只有在 `preferredId` 为空时**才可能产生 —— 一旦用户指定过一个后来从目录里消失的模型 id，`source` 恒为 `preferred`。
- **实测证据**：
  ```
  === mounted: preferred id NOT in catalog ===
  targetModelSource: preferred | targetModelId: ghost-model-not-in-catalog
  catalog ids: ["m1"]
  ```
  纯函数侧同样确认：
  ```
  preferred="ghost" (not in catalog): {"modelId":"ghost","source":"preferred"}
  preferred="" + no free model       : {"source":"none"}
  ```
- **用户可见后果**：池摘要显示「你指定的模型：ghost-model-not-in-catalog」（`:386`），测试按钮**可用**（`:422` 只拦 `'none'`），Host 路由也会真的拿这个 id 去跑批量（`web-status.ts:807-822` 同样只判 `modelId === undefined`）。结果是整池账号对这个不存在的模型探测失败，用户看到一排失败却找不到原因 —— 而正确文案本该是「此模型已不在目录中」。
- **严重级**：高。`source=none` 与「有 id」互斥的**另一半**没被覆盖：**`source=preferred` 可以有目录里不存在的 id**，客户端按钮禁用条件因此漏掉一整类。
- **修复方向**：`resolveTargetModel` 应校验 `preferredId ∈ catalog`，不存在时返回 `{ modelId: undefined, source: 'none' }`（或新增第四态），让既有的 `'none'` 文案与按钮禁用条件自然接管。

### B-3（中｜契约·409 二义）两种 409 客户端不区分，且「未启用」的那一条与 UI 前置条件互斥、文案与真实原因不符

- **位置**：Host 两条 409 —— 未启用 `web-status.ts:791-793`、无成员 `web-status.ts:798-800`；客户端只取 `error` 文本（`AccountPool.tsx:344`）交给 `actionError`（`:502`）。
- **实测证据**（挂载真实插件）：
  ```
  === enabled-but-empty 409: 409 {"error":"no accounts are checked into this region's pool"}
  === disabled 409:        409 {"error":"account pool is disabled for this region"}
  === test-no-free-model 409: 409 {"action":"test","rows":[],"error":"no zero-multiplier model in this region; refresh the catalog or set a target model"}
  ```
- **问题**：两种 409 只有**英文原文**可辨，客户端不做结构化区分 —— 文案是 `safeMessage`/原样字符串（`web-status.ts` 的 `error` 字段），**不经过 `t()` 本地化**，中文界面下会直接蹦出英文长句。更关键的是第二条：`AccountPool.tsx:413, 421` 已用 `active.memberAccountIds.length === 0` 把按钮禁用，所以「无成员」的 409 **在 UI 里不可能被触发** —— 唯一能真实触发它的是**草稿未保存**（勾了但没点保存，`:491` 只显示「勾选已改动 —— 保存后生效」）。此时用户点按钮 → 英文报错「no accounts are checked into this region's pool」，而界面明明勾着账号。
- **严重级**：中。不致命（Host 守住了不花钱的底线），但把用户导向「我明明勾了」的死胡同，且是唯一一条中文界面下的英文报错。

### B-4（中｜契约·测试后不刷新）`probe` / `rotatedToAccountId` 是运行时事实，但批量成功后**不重读** usage，界面直到下一次 60 秒轮询前都在撒谎

- **位置**：`onSaved` 只在**保存偏好**时调用（`AccountPool.tsx:294`），`runAction` 的成功路径（`:345-373`）**没有** `onSaved?.()`；父组件把 `onSaved` 接到 `refreshUsage`（`WorkBuddyCard.tsx:1241`），轮询间隔 60 秒（`WorkBuddyCard.tsx:87, 404`）。
- **问题**：`test` 批量的结果由 Host 落盘并重排（`index.ts:912-913`：先 `writePoolProbes` 再 `applyRotation`），**这些事实全部只经 usage 路由下发**。客户端跑完批量只往日志里写行（`:366-372`），不重读文档，于是：
  - `probe`（刚测出的 outcome/atMs）要等最多 60 秒才出现在表格里；
  - `rotatedToAccountId` 同理 —— 而「轮换记录」正是本次修复的目标之一（`:255-266` 专门监听它并写日志）。**修复后的记录逻辑本身是对的，但触发时机被推迟了一个轮询周期**，用户点完测试看不到「已切换计费账号」，会以为轮换又没写记录。
- **实测证据**（两个账号，`rotateByCredits: true`，桩化探测返回 `ok`）：
  ```
  === BEFORE test batch === {"accounts":[{"who":"Alpha","credits":5000,"current":true},{"who":"Beta","credits":10,"current":false}]}
  === test batch === 200 {"action":"test","modelId":"free-1","rows":[{"accountName":"Alpha","outcome":"ok"},{"accountName":"Beta","outcome":"ok"}]}
  === AFTER test batch === {"rotatedToAccountId":"ff4d2b66be3ba1de6211bdf7", ...}
  ```
  → `rotatedToAccountId` **确实已接线**（Host 真的下发，字段三态为 ✅），但客户端要等下一次轮询才会去读它。
- **严重级**：中。**注意这不是「字段没接线」**，而是**读取时机**问题；B-4 与「轮换不写记录」的旧缺陷外观相同，容易被误判为回归。
- **修复方向**：`runAction` 成功分支补一次 `onSaved?.()`。

### B-5（中｜契约·缺失 vs false 的**反向**混淆）`checkedInToday` 客户端三态正确，但 Host 在**每次轮询都对全池做一次签到状态请求**，把「读不到」放大成 N 次上游请求

- **位置**：`index.ts:873-883` —— `checkedInToday` 对**每个账号**调一次 `client.fetchCheckinStatus`，任一失败即 `undefined`（`:879-880`）并被 Host 丢弃（`web-status.ts:607` 只在有值时带字段）。
- **三态结论（客户端侧正确，无需改）**：`AccountPool.tsx:597-602` 明确区分 `undefined → '—'`（`poolCheckinUnknown`）、`true → 已签到`、`false → 未签到`；`locales.ts:129` 的 `'—'` 是有意为之，不是漏写。**这一条本次修复已到位**（「签到列永远显示未签到」已修）。
- **仍然存在的问题**：该 deps 被 usage 路由**每次调用**执行（`web-status.ts:567-569`），而卡片每 60 秒轮询一次 usage（`WorkBuddyCard.tsx:87, 404`），因此**每个账号每分钟一次** `checkin-activity-status`。实测上游请求序列证实了这一点：
  ```
  POST .../checkin-activity-status
  POST .../get-user-resource
  POST .../checkin-activity-status      <- 一次 usage 读取 = 每账号一次
  ```
  `index.ts:869-871` 的注释把「按账号读、失败即省略」当作设计，但没提这个**常驻成本**：一个 10 账号的池，即使全天不用，也持续产生 14,400 次/天的签到状态请求。
- **严重级**：中（资源与限流风险；`account-pool-run.ts:8-10` 的模块注释明确把「同时打整池正是把好账号打成 429 的最快方式」列为要避免的事，这里是串行但高频的同类风险）。
- **修复方向**：签到状态可只对**成员**读、或加缓存/按需读（表格进入视口/用户点击时），而非每次轮询全量读。

### B-6（低｜类型有但客户端不消费）`WorkBuddyWebPoolAccount.member` 下发但从不读；行勾选态改由 `memberAccountIds.includes()` 推断

- **位置**：类型 `status-paths.ts:545`（注释明确写了「列出未勾选账号以便用户勾选」）；Host 真的填了（`web-status.ts:606`，实测 `"member": true` / `"member": false` 均出现）；客户端**无任何读取**（`grep '\.member\b'` 在 `src/client/` 下零命中）。
- **问题**：`AccountPool.tsx:482` 用 `active.memberAccountIds.includes(account.accountId)` 推断勾选态 —— 读的是**草稿/偏好**，而非 Host 的**权威答案**。这正是 B-1 的另一面：Host 已经算好了「这一行到底是不是成员」并发了下来，客户端却选了另一个来源，两者在 stale id 场景下会分叉。
- **严重级**：低（单独看只是冗余字段；与 B-1 合并看是同一个根因的两处表现）。

### B-7（低｜契约·可选性名不副实）`catalog` 声明为可选，但 Host **永不**省略它 —— 空目录时下发 `[]`，客户端把「未读取」与「确实为空」视为同一件事

- **位置**：类型 `status-paths.ts:593`（`catalog?: readonly WorkBuddyWebPoolModel[]`）；Host `web-status.ts:625` 无任何条件判断，**恒有值**；客户端 `AccountPool.tsx:722` 用 `(pool.catalog ?? [])` 兜底。
- **实测证据**：`pool` 的键集合恒含 `catalog`（两次挂载均如此）：
  ```
  === pool block keys: accounts, autoTestIntervalMinutes, catalog, enabled, memberAccountIds, rotateByCredits, targetModelId, targetModelSource
  ```
  与 `status-paths.ts:585-592` 的注释一致（有意裁剪成三字段），但**可选标记与实际行为不符**：注释说「同一文档里模型表已带全量」，暗示它可缺席，实际从不缺席。
- **严重级**：低（纯契约卫生）。真正的风险是**语义**：`catalog: []` 在「Host 尚未刷新目录」与「这个区域确实没有模型」两种情况下都出现，而 `targetModelSource` 恰好用来区分二者（`'none'`）—— 所以客户端目前靠 `targetModelSource` 而非 `catalog` 判空是**正确**的，这条只是记录契约与实现的不一致。

### B-8（低｜契约·可选性正确，仅记录）`creditMultiplier` 的「缺失 ≠ 免费」在两侧都被正确尊重

- **位置**：类型 `status-paths.ts:618`（注释「缺失表示上游未声明倍率，NOT 同于免费」）；Host `web-status.ts:628` 用条件展开，缺失即不带键；客户端 `AccountPool.tsx:725-727` 用 `model.creditMultiplier === undefined ? model.name : name (x0.50)`。
- **实测证据**：目录里三个模型的线上形状证实可选键被正确省略：
  ```
  {"id":"free-1","name":"Free One","creditMultiplier":0}      <- 0 被保留（不是被当假值丢掉）
  {"id":"paid-1","name":"Paid One","creditMultiplier":0.5}
  {"id":"nomult","name":"No Multiplier"}                       <- 键完全缺席
  ```
  注意 `creditMultiplier: 0` **必须**被保留 —— 用 `model.creditMultiplier ? ... : ...` 的写法会把免费的 0 当缺失。两侧都用了 `=== undefined`，正确。
- **严重级**：低（**已正确接线**，列出以证明覆盖完整；与 `account-pool.ts:15-19` 的「国内版静态目录整份没有该字段」的既有约束一致）。

### B-9（低｜类型有但客户端不消费）`CheckinRow.streakDays` Host 真的下发（实测 `8`）但池日志不显示

- **位置**：类型 `status-paths.ts:602`；Host `account-pool-run.ts:136` 只在 `claimed` 时带；客户端 `AccountPool.tsx:349-352` 只渲染 `accountName + credit`。
- **实测证据**：`{"accountId":"...","accountName":"Alpha","status":"claimed","credit":150,"streakDays":8}`。
- **严重级**：低（信息冗余，非缺陷；列出以证明覆盖完整）。

### B-10（低｜契约·空名占位）`accountName` 的 `''` 在**行内**与**日志**两处都有占位，但占位文案是 `—`（「尚未测试」），语义与空名无关

- **位置**：Host 保证 `accountName` 为 `''` 而非缺失（`auth.ts:924` 注释明确「不回落 uin/uid，展示层自己给占位」）；客户端两处占位 —— 行内 `AccountPool.tsx:532` → `t('row.accountUnnamed')`，日志 `:350, 355, 359, 368` → 同一个 key。
- **问题**：占位本身正确（`''` 不会被当假值漏渲染），但 `AccountPool.tsx:598` 给「未读签到」用的 `title` 是 `t('row.poolNeverTested')`（"Not tested yet" / "尚未测试"，`locales.ts:125`），而它渲染的**内容**是 `poolCheckinUnknown`（`—`）。用「尚未测试」解释一个「—」是**串了另一列的语义**。
- **严重级**：低（纯文案；hover 提示说错了原因）。

### B-11（低｜类型有但无消费者）`WorkBuddyWebPoolCheckinAnswer` / `WorkBuddyWebPoolTestAnswer` 两个响应信封类型**无人 import**，其字段（含 `action`、`TestAnswer.modelId`）对客户端是纯声明

- **位置**：`status-paths.ts:622-625`（`CheckinAnswer`）、`status-paths.ts:628-633`（`TestAnswer`）。
- **实测证据**：全仓库检索确认这两个类型**只在 `status-paths.ts` 内出现，没有任何 import**：
  ```
  $ grep -rn "WorkBuddyWebPoolCheckinAnswer\|WorkBuddyWebPoolTestAnswer" src/ tests/ | grep -v "^src/status-paths.ts"
  (无输出)
  ```
  客户端 `runAction` 用的是**就地匿名类型**而非这两个契约类型：
  ```ts
  // AccountPool.tsx:341-343
  const body = await response.json().catch(() => undefined) as
    | { rows?: unknown, error?: string, modelId?: string }
    | undefined
  ```
  因此 `action: 'checkin' | 'test'`（`:623, 629`）在类型层面从未被校验过；`TestAnswer.modelId`（`:631`）也确实不下发给任何读取者。
- **风险**：路由真的下发了 `action`（实测 `{"action":"test","modelId":"free-1","rows":[...]}`），但没有任何类型或运行时检查消费它 —— 若将来 Host 把 `action=test` 的响应误当成 `checkin` 解析，两侧都不会报错。匿名类型还使 `rows?: unknown` 逃过了 `noUncheckedIndexedAccess`/`strict` 的保护（`tsconfig.client.json` 已开 `strict`，但 `as` 断言绕过它）。
- **严重级**：低（当前无实际故障；是**契约守卫的缺口**，不是行为缺陷）。

---

## 三、已正确接线（证明覆盖完整）

以下 31 个字段经三方逐条核对，**类型 → Host 赋值 → 客户端读取**全部成立，且可选字段的「缺失 vs false/0」语义在两侧都正确：

**Pool 级 9 项**：`enabled`、`rotateByCredits`、`autoTestIntervalMinutes`、`targetModelId`、`targetModelSource`、`memberAccountIds`、`rotatedToAccountId`、`accounts`、`catalog`。
**Account 级 12 项**：`accountId`、`accountName`、`credits`、`expiringSoon`、`nearestExpiryMs`、`probe`、`probe.outcome`、`probe.atMs`、`probe.retryAtMs`、`excludedBy`、`current`、`checkedInToday`。
**Model 级 3 项**：`id`、`name`、`creditMultiplier`。
**批量行 7 项**：`CheckinRow.accountName/status/credit/message`、`TestRow.accountName/result/result.outcome`。

其中**可选字段语义经实测确认无误**的 5 项（本次任务的重点）：

| 字段 | 缺失时的 Host 行为 | 客户端行为 | 判定 |
| --- | --- | --- | --- |
| `checkedInToday` | `web-status.ts:607` 只在读到值时带；读失败即省略 | `:597` 渲染 `—`（`poolCheckinUnknown`），不谎称「未签到」 | ✅ 三态正确 |
| `excludedBy` | `:604` 只在被排除时带 | `:155, 168, 221` 缺失即「可用」，参与候选过滤 | ✅ 三态正确 |
| `probe.retryAtMs` | `:601` 只在上游给了时间时带 | `:537` 有则显示时刻；`:543` 无则对 rate-limited/out-of-credit 明说「上游未给出何时恢复」 | ✅ 三态正确 |
| `rotatedToAccountId` | `:618` 仅在轮换指向某账号时带 | `:258` 缺失即不记日志（不伪造切换） | ✅ 三态正确（时机见 B-4） |
| `credits` / `expiringSoon` / `nearestExpiryMs` | `:590-596` credits 读失败即整组省略 | `:581` 缺失渲染 `—`；`:584` 用 `> 0` 而非真假值；`:587` 缺失不渲染 | ✅ 三态正确 |

**路由契约一致性**（`WORKBUDDY_POOL_PATH`，`status-paths.ts:45`）逐项核对通过：

| 项 | Host | 客户端 | 判定 |
| --- | --- | --- | --- |
| 方法 | 非 POST → 405（`web-status.ts:776`） | `method: 'POST'`（`AccountPool.tsx:337`） | ✅ 一致 |
| 来源 | `loopbackOrigin` 拒绝非回环（`web-status.ts:777`，`:264-273`） | `credentials: 'same-origin'`（`:339`） | ✅ 一致 |
| 区域参数 | `regionOfStatusUrl`，缺省 `cn`、未知 400（`:89-94`） | `withWorkBuddyRegionAndAction` 拼 `?region=`（`:336`，`status-paths.ts:62-68`） | ✅ 一致 |
| 动作参数 | `poolActionOf` 只认 `checkin`/`test`（`status-paths.ts:54-59`） | 同上函数生成 | ✅ 同一函数，不会漂移 |
| 成功码 | `200` + `{ action, rows }`（`:804, 826`） | `if (!response.ok) throw`（`:344`），随后读 `body.rows`（`:347, 366`） | ✅ 一致 |
| 错误字段名 | 全部用 `error`（`:782, 785, 792, 799, 819, 828`） | `body?.error ?? 'HTTP ${status}'`（`:344`） | ✅ 一致 |
| `rows` 形状 | `checkin`：`{accountId,accountName,status,credit?,streakDays?,message?}`；`test`：`{accountId,accountName,result}` | 逐字段读取，与类型一致（`:347-371`） | ✅ 一致 |
| `modelId` | `test` 成功时带（`:826`） | 不读（日志改用 `pool.targetModelId`，`:332`） | ◻️ 不消费，非不一致 |
| 409 二义 | 两条不同的 409（`:792` 未启用 / `:799` 无成员） | 只显示 `error` 原文，不区分 | ⚠️ 见 B-3 |

---

## 四、审计边界与未覆盖项

- **未做的验证**：真实上游（网络）行为、DSH 版本差异（0.1.5 vs 0.1.7 的 volatile 引用）、`WorkBuddyCard.tsx` 的其余渲染分支。本审计只覆盖「账号池字段的客户端↔Host 契约」。
- **同伴写入风险**：`web-status.ts` / `index.ts` / `WorkBuddyCard.tsx` / `status-paths.ts` 均在同一仓库被其他审计或修复会话改动。本报告的行号以第三节的基线哈希为准；若这些文件在报告之后被修改，**引用行号可能漂移，字段结论需按新哈希复核**。`AccountPool.tsx` 的基线 `b5a8117521d1` 与审计 A 一致。
- **未改任何源码**：`git status --porcelain src/` 显示的改动全部来自同伴会话，与本审计无关；本审计只新增 `docs/audit/B-contract.md`。临时脚本目录 `/tmp/wb-audit/` 已删除。
- **可复现性**：本文所有「实测证据」块均由挂载真实插件的临时脚本产生（`node --experimental-strip-types`，Node v25.9.0），方法同 `tests/pool-e2e.spec.ts:87-98` 的 `mount()`；脚本已删，如需复现请参照该 spec 的写法重建。

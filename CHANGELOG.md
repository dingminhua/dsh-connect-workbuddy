# Changelog

## 2.0.9 (2026-09-25)

### Features

- **未登录时列出「探测过哪些路径、各自为什么没成」**（对齐 trae 的未登录体验）。此前卡片只会说一句「在桌面 App 里登录一次」，用户无法判断插件到底找过哪里——凭据存在别处、或桌面 App 装在非默认位置时，这句话既不解释现状也不给出下一步。现在未登录态的卡片带一个折叠区「已检查的路径 (N)」，逐条列出**路径 + 来源 + 原因**；标签页的改动只落在**真正什么都没找到**的那条分支上。

  - **四档原因，而不是笼统的「读不到」**：`missing`（不存在）/ `unreadable`（在但读不了）/ `invalid`（读到了但没有可用 token）/ `encrypted`（读到了、字段是加密的、拿不到密钥）。探测在 `probeAuthFile()` 里一次完成，`readAuthFile()` 退化为只要凭据的薄包装，既有调用方一行未改。
  - **`encrypted` 是 workbuddy 特有的、也是本版最重要的新增档位**：Windows 新版桌面端把 token 字段加密，读它需要桌面 App 自身的原生绑定（`WORKBUDDY_APP_EXECUTABLE` 可指定）。此时用户**多半已经登录了**，卡片若沿用「重新登录一次」就是在指一条无效的路。因此这类探测结果会额外顶出一条提示，明说「需要桌面 App 在场，单纯重新登录解决不了」。把它并入 `invalid` 会让这句提示永远显示不出来——这正是变异测试专门盯住的一条。
  - **同一档内再分「值得先看 / 只是不存在」**：普通机器上多数候选路径都是 `missing`（App 只写一个文件，平台却有好几个候选目录），全部平铺会把真正解释失败的那一条淹掉。因此 `encrypted`/`invalid`/`unreadable` 直接展开，`missing` 收在第二层折叠后；而当**全都是** `missing` 时它就是答案本身，直接展开，不需要再点一次。trae 定义了 `row.searchedMore` 文案却从未接上，这里真正实现。
  - **只在「一无所获」时列出**：`selectionLost`（有本地登录、只是保存的账号 id 失配）这条分支不列路径——那些 token 是好的，正确动作是重新选账号，一列失败路径只会把话带偏。这一条有独立测试。
  - **诊断本身永不成为失败源**：`diagnose()` 会真的读盘，因此卡片侧对「没有 `diagnose()` 的旧 Host」「探测抛错」「结果为空」三种情况都退回到原来那句提示，不把整个卡片拖成错误态；空结果也不下发空数组（否则卡片会渲染出一个「已检查的路径 (0)」的空块）。
  - **消息先脱敏再下发**：探测信息来自文件系统与桌面 App 的子进程，两者都可能回显 token 片段。新增的路径列表不能变成新的泄露面，因此沿用 `safeMessage()` 过滤后再跨到浏览器。
  - **插件自己的副本不作为「已检查路径」上报**：它直到首次刷新才存在，报出来只会给每台机器稳定加两条噪声。

### Tests

测试总数 255 → 286（新增 31 例）：

- `tests/diagnose.spec.ts`（新增 10 例）：`diagnose()` 的四档原因逐一钉住——全空机器上**仍报告探测路径**、可读文件**不出现在报告里**、非法 JSON 与「有 JSON 无 token」都归 `invalid`、加密且无密钥归 `encrypted`、密钥查找抛错也归 `encrypted`、**拿到了密钥却打不开归 `invalid`**（这是「App 在、文件坏了」，建议与「装 App」不同）、**健康文件不因旁边有个坏文件而被误报**、报告里不含 token 片段、跨区域不串号。加密夹具用与桌面端相同的 AES-256-GCM 编解码器现场封制（复用 `at-rest.spec.ts` 的做法），因此 `encrypted` 是对着一个真实信封证明的，而不是一个现实中不可能出现的假标记。
- `tests/web-status.spec.ts`（新增 7 例）：路径列表下发、`encrypted` 原因原样穿过到浏览器、空结果**不下发空数组**、无 `diagnose()` 的旧 store 优雅降级、探测抛错不影响状态路由、`selectionLost` 时不列路径、消息里的 token 形状内容被脱敏而路径本身保留。
- `tests/searched-paths.spec.ts`（新增 14 例）：展示规则（`missing` 何时隐藏/何时展开、分组内保持 Host 探测顺序、四档原因各自映射到不同文案键、来源标签、总数口径），以及**两套语言里四档原因的文案互不相同**——文案合并会让 `encrypted` 在用户眼里退回成「文件不存在」，而其余测试全绿。

**变异验证（实测）**：共 14 处定向改写，全部被测试咬住（0 逃脱）——`encrypted` 并入 `invalid`、`missing` 误报为 `unreadable`、把插件副本的空缺也上报、无密钥的加密文件报成 `invalid`、空结果下发空数组、消息不脱敏、`selectionLost` 时也列路径、`missingOpen` 恒为 `false`、`encrypted` 移出「值得先看」集合、原因标签丢掉来源、`encrypted` 映射到别的文案键、总数只数可见组、加密提示丢掉 `WORKBUDDY_APP_EXECUTABLE`、以及四档文案合并成一条。

### Docs

- `README.md` / `README.en.md`：功能特性新增「未登录时列出探测过的路径与原因」一条。
- `docs/DESIGN.md` §3.4：记录未登录诊断的四档原因划分，以及「`encrypted` 必须独立成档」的理由。

## 2.0.8 (2026-09-24)

### Features

- **可以单独关掉任一版本的供应商**（对齐 trae 的 issue #11）。每个 tab 右侧新增一个勾选框（默认都勾选），**取消勾选即把该供应商从 DSH 模型选择器里彻底撤掉**，而不是只藏起 tab。

  - **关闭动作落到注册层，不是 UI 层**：`AdapterRegistrationHandle.replace([])` 抽掉该区域的路由，`DirectoryRegistrationHandle.replace([])` 摘掉它在「设置 → 模型」页的目录条目。已验证 `listProviders()` 在该区域关闭后不再含它——这正是 DSH 构造模型选择器的取数来源，所以分组是**真的消失**，不是被藏起来。注册仍是「先正常注册、再 replace([])」两步在同一同步段内完成：空数组的**首次**注册会被 DSH 拒绝（`INVALID_ADAPTER`），而 `replace([])` 明确合法。
  - **配置**：`regions.<cn|global>.enabled`，**opt-out**——只有显式 `false` 才关闭。**开关出现前的配置、以及区域拆分前的扁平旧字段一律视为开启**，老用户零感知。
  - **状态不丢**：开关只改该区域 `enabled` 一个字段，该槽位的目录 / 勾选 / 图片开关 / 上下文预算，以及另一个区域的整个槽位，全部原样带过。关掉再打开能完整恢复。
  - **保存模型不会偷偷重开**：卡片保存目录时会**回写 `enabled`**——那次写入替换整个槽位，漏掉它就会「保存一次模型列表 = 悄悄重新打开已关闭的供应商」。
  - **已关闭的区域不再做无意义的启动请求**：跳过它的启动目录刷新与 `registerModelDiscovery` 兜底，顺带消掉「无账号区域每次启动报一次错」的失败面。
  - **已知代价**：若某会话此前选中的正是被关闭供应商的模型，该会话再调用会报 `NO_ADAPTER`（`no adapter registered for provider "..."`）。这是「彻底移除」的必然结果，卡片在关闭态的 tab 上给出明确提示文案，不静默失败。
  - **与 issue #12 的「无账号自动隐藏」是两个独立维度**：`WorkBuddyCatalog` 现在同时持有 `usable`（自动：本机有无该区域账号）与 `enabled`（用户显式开关），`current()` 在**两者都成立**时才返回模型。只有用户重新勾选、且该区域确有账号时，模型才会回来。

### Tests

测试总数 236 → 255（新增 19 例）：

- `tests/region.spec.ts`（新增 11 例）：`regionEnabledOf` 的 opt-out 缺省、**同时接受「整个 settings 段」与「`regions` 子对象」两种入参**（这正是 trae 上真实发生过的 bug：卡片传错一半 → 判定恒为 `true` → 勾选「点了没反应」）、`nextRegionEnabled` 只改目标字段且不碰另一区域、以及 Host 侧 `regionEnabled` 对扁平旧配置判定为开启。
- `tests/catalog.spec.ts`（新增 4 例）：`setRegionEnabled` / `isRegionEnabled`、关闭后 `current()` 为空、重新开启恢复、以及 **`usable` 与 `enabled` 两个闸门互不干扰**（只开开关不足以让无账号区域复活）。
- `tests/settings-integration.spec.ts`（新增 4 例，走真实宿主装配）：关闭国际版后 `listProviders()` 不含 `workbuddy-global`、目录条目同步消失、**国内版的目录条目必须仍在**（守护「目录是一次性注册持有两个条目」这一约束）、另一侧不受影响、重新开启恢复、两个都关仍可恢复、旧配置两边都开。
- `tests/web-status.spec.ts`：`enabled` 在 signed-in / signed-out 两个分支都下发。

**变异验证（实测）**：把「撤掉路由」改成「照常注册」（即只隐藏 tab 的假实现），3 条集成测试立刻失败；把目录 `replace` 改回**按区域分别调用**，`registers both regional providers` 与 `both switched off can still be restored` 两条失败，失败现场收到的正是 `[{workbuddy-global}]`——国内版条目被覆盖掉了，与 trae 记录的这个 bug 完全一致。测试确实咬得住。

### Docs

- `README.md` / `README.en.md`：「功能特性」新增「可单独关闭任一版本供应商」一条，并在双供应商那条说明关闭后的效果与代价。
- `docs/DESIGN.md`：说明区域开关为何必须落在注册层（`replace([])`），以及它与 issue #12「无账号隐藏」的维度差异。

## 2.0.7 (2026-09-23)

### Features

- **凭据被上游拒绝时，给出「可执行的」建议，而不是笼统地让你重新登录**。一个 401 背后可能是两件完全不同的事，而说错那一句比不说更糟：**选中的账号**已作废、但本机另一个登录明明好用（此时该「切换账号」，重新登录毫无作用——凭据从来不是问题，作废的是那条**选择**）；或者本机所有登录都已失效（此时才该「重新登录」）。

  - **先分类，再给建议**：新增 `WorkBuddyCredentialRejectedError`（由 `CREDENTIAL_REJECTED_CODE` 标记而非 `instanceof` 识别，跨打包边界仍可靠），网关的 HTML 401/403 与 JSON 形态的 401/403 都归入此类；503 之类的**瞬时故障不会被误判**成凭据问题——那需要重试，不是重新登录。
  - **确实去探测，而不是猜**：被拒后，插件用 `credentialFor()` 取出**其他**账号的凭据（**不触碰当前选择**），向计费网关的廉价只读接口发一次真实请求，验证它是否仍然可用。有一个能用 → 卡片直说「本机账号『X』实测可用，切换即可」并给**一键切换**按钮；一个都不能用 → 如实说「还有其他账号但都没通过校验，可切换试试」；**本机再无其他账号** → 才提示重新登录。
  - **`reloginRequired` 只在「本机没有别的账号可切换」时为真**，绝不作为「探测没验证出东西」的兜底——那正是本次要消除的误导。三种情形互斥，各有独立测试。
  - **代价只在失败路径上**：健康账号一次探测都不发。判定按「区域 + 账号 id + 该凭据的 `lastRefreshAtMs`」缓存 60 秒（卡片会轮询），**重新登录会改变签发时间从而自动失效旧判定**，无需显式清理。
  - **绝不自动切换**：账单落到哪个账号是用户的选择，探测只回答「切过去是否有用」，切换动作留给用户点。`credentialFor()` 独立于当前选择，正是为了在探测期间不把计费悄悄改道。
  - **卡片的泛化提示不再与之打架**：原先「出现错误 → 重新登录 APP」在凭据被拒时会让位给上面这条具体建议；`creditsError` 仍原样保留在下方作为技术细节。

### Fixes

- **新版桌面端（Windows 先行）加密了 auth 文件的 token 字段，插件不再把「已登录」误判为「未登录」**。WorkBuddy 桌面端某个 Windows 构建起，`auth.accessToken` / `auth.refreshToken` 不再是纯字符串，而是写成 `{"$wbEncrypted":1,"envelope":"…"}` —— 一个 AES-256-GCM 信封。此前的解析器只接受字符串，遇到对象即返回「无 token」，于是**文件完全健康、账号却显示未登录**，或退回到某个早就作废的旧备份凭据上、由上游回一个 HTML 401。用户侧的「重新登录桌面端 + 重新选账号」当然修不好它：问题不在凭据，而在读不出来。

  - **加密格式**：`envelope` 是 base64 的 JSON（`suite` / `keyId` / `nonce` / `authTag` / `ciphertext`），suite 1 = AES-256-GCM，12 字节 nonce、16 字节 tag。AAD 不是空串，而是一段**长度前缀转录**（域分隔符 `WB-AAD\0` + 版本 + 格式 ID `WBEV1` + scheme `sym-v1` + suite + keyId + framing 码 + 两个可选字段的缺省标记）。转录把「这段密文是为哪种 framing 封的」也绑进认证，因此把整文件信封当字段信封打开会认证失败，而不是解出半截东西。
  - **密钥来源（本版本最关键的决定）**：字段密钥是 App 的**构建期常量**，编译在其 Electron 原生模块（`electron_browser_workbuddy_storage`）里，由 `loggerGet()` 返回载荷；App 自己对载荷里的 base64 **字符串**做 SHA-256 得到 32 字节密钥，`keyId` 是该密钥 SHA-256 的前 16 个十六进制字符。**插件因此不内置任何密钥副本**，而是在遇到加密文档时用 `ELECTRON_RUN_AS_NODE` 运行**本机已安装的那个 App**、调它自己的同一个绑定，取回同一份载荷后就地派生。也就是「向写下这个文件的那个构建本身询问」——App 升级换了密钥，插件无需跟着发版。
  - **只在真的需要时才付代价**：先按纯字符串解析，只有文档确实带加密字段时才去问 App 要密钥，所以 macOS 与旧版 Windows（以及插件自有副本）这条常用路径**一次子进程都不会启动**。密钥只在进程内存缓存，**不落盘、不进日志**；派生结果先按 `keyId` 校验，不匹配即报「不属于这把密钥」。
  - **fail-closed**：信封畸形、密钥不匹配、GCM tag 校验失败，一律当作「这份文档读不出来」（返回未登录），**绝不退化成截断的、空的、或半解密的 token**——那会让计费落到错误的地方。
  - **身份与时间字段原样保留**：加密路径只替换被加密的那些字段，`uin` / `uid` / `domain` / `expiresAt` / `lastRefreshTime` 的读取与纯文本路径完全一致，多账号去重与排序不受影响（`uin` 是明文，账号 id 保持稳定，无迁移问题）。
  - **账号名也一并解密**：这些构建**同样加密了 `account.nickname`**。只解 token 的读法会让 token 工作正常、账号名却读不出来而回退成一串 uin 数字（`330105772757`），看起来像「插件不知道这是谁」——实测确认。现在昵称走同一条解密路径，卡片与 `doctor` 显示 `老丁`、`LaoDing` 这样的名字。昵称是**可选**字段：信封打不开（密钥轮换、信封损坏）只表示「名字未知」，**不会**像 token 那样让整份凭据作废；token 依旧 fail-closed。`account.phoneNumber` 在这些构建里同样加密，**故意不读**——卡片的隐私契约只允许昵称、到期时间与积分，手机号不在其列。
  - **uin 不再显示，也不再见诸接口**：账号名是**显示值，不是标识符**。原先的名字兜底链是 `nickname ?? uin ?? uid`，昵称一旦缺席就把一串数字当名字显示；现在 store 的名字只取昵称，**没有就返回空串**，由卡片渲染本地化的「未命名账号」占位（`doctor` 对应打印 `(unnamed)`），标识符不再冒充名字。同时把 `uin` 从下发给浏览器的账号行与登录文档里**整个移除**——卡片从未渲染过它，继续传只是在无功能收益地暴露账号标识；`uin` 仍留在凭据模型内部（账号 id 由它派生，去重与排序都靠它）。
  - **门控随之放宽**：`hasEncryptedTokenFields` → `hasEncryptedCredentialFields`，除两个 token 外还检查 `nickname` / `uin` / `uid` / `enterpriseId` / `domain`。否则一个「token 明文、昵称加密」的构建会读不到密钥，账号名又静默退回数字。
  - **`doctor` 新增一行**：报告「加密凭据支持」是否可用及其解析到的 App 可执行文件路径；App 装在非常规位置时可用新增的 `WORKBUDDY_APP_EXECUTABLE` 指定。该项**不读取也不输出任何密钥材料**。

  **核查**：以本机真机取证——加密文件解出的 access token 长度 1462、`refreshToken` 1102，两者都是标准 JWT 形状；用解出的 token 调上游积分接口得 **HTTP 200**（`code: 0`，真实积分数据），模型目录接口同样 200。集成后 `store.accounts()` 正确列出 2 个账号（加密的那个被标为 selected），`store.resolve()` 返回可用凭据，`status` 子命令打印出真实余额。

### Tests

测试总数 179 → 236（新增 57 例，新文件 `tests/at-rest.spec.ts` 与 `tests/credential-recovery.spec.ts`）：

- 密钥派生：断言哈希的是载荷里的 base64 **字符串**而非解码后的字节（两者结果不同，写错即挂）、`keyId` 规则、以及畸形载荷必须抛错而不是派生出一把假密钥。
- 信封开启：本文件用与服务端**同一算法独立封出**的密文往返，覆盖同一密钥下的多个字段；另含「换一把密钥必须拒绝」「篡改密文必须失败（不得返回部分明文）」「整文件 framing 的信封必须认证失败」「畸形信封逐个字段报错」。
- 文档解析：纯字符串文档不需要密钥即可读；**看起来像 base64 的普通 token 不得被当成密文**；加密文档在没有密钥时返回 undefined（正是原缺陷的形状）；给对密钥后 token 与身份/时间字段全部正确；access 加密而 refresh 明文、以及只有 refresh 加密的混合形状；**给错密钥必须 fail-closed**；空 token 规则保持不变。
- 账号名：加密昵称必须还原成真名而不是退回 uin（并按卡片同一 fallback 链断言）；明文昵称照常原样读；**打不开的昵称只算「未知」、不得让整份凭据作废**（与 token 的 fail-closed 相反）；`phoneNumber` 即使加密且可解也**不得**被读入凭据对象（隐私契约）。
- 门控：加密昵称/uin/uid/enterpriseId/domain 各自单独出现时都要被识别为「需要密钥」，全明文的文档必须为 false。
- 可执行文件探测：环境变量优先、空/空白覆盖值被丢弃、darwin 给出 bundle 路径、linux 不给候选、路径都不存在时返回 undefined。
- 恢复建议（`tests/credential-recovery.spec.ts`）：探测命中/被拒/账号已消失三种结果；TTL 内不重复探测；**重新登录改变签发时间后旧判定自动失效**（同一账号从不可用翻回可用）；判定按区域与账号互不串味；**「本机没有其他账号」才 `reloginRequired`**、有其他账号时即使一个都没验证通过也**绝不**要求重新登录（误导守卫）、且永不把「本机一个账号都没有」误报成需要重新登录之外的结论。
- 拒绝分类（`tests/web-status.spec.ts`）：HTML 401/403 与 JSON 401 都标记 `credentialRejected` 并附建议；**503 之类的瞬时故障不得被当成凭据问题**；探测只针对**被拒账号之外**的账号；探测确认可用时给出 `usableAccount` 且不要求重新登录。
- 账号名与标识符（`tests/auth.spec.ts` / `tests/web-status.spec.ts`）：有昵称时用昵称；**昵称缺席时 `accountName` 必须是空串，绝不含 uin/uid**（并断言账号仍完全可用、id 仍正常）；空字符串昵称与缺失同义；`uin` 仍留在凭据模型里供 id 派生使用；**下发给浏览器的文档与账号行都不得出现 `uin` 字段，也不得出现 uin/uid 的数字**。

每条守卫都用「删掉对应实现即失败」验证过：把密钥派生改回哈希解码字节、或让解析器忽略 `keyId` 校验、或去掉 `hasEncryptedCredentialFields` 的门控、或让 `optionalCredentialField` 的失败向上抛、或把 `reloginRequired` 改成「没验证出来就算 true」、或把名字兜底链改回 `nickname ?? uin`，都会挂掉对应用例。

### Docs

- `README.md` / `README.en.md`：新增「加密凭据字段」说明（为什么要向本机 App 现取密钥、密钥不落盘、纯文本路径不启子进程、账号名也来自加密字段、`WORKBUDDY_APP_EXECUTABLE`），在「已知限制」补一条「加密凭据依赖桌面 App 在场」，并在「功能特性」补一条「凭据失效时给出可执行的建议」。
- `docs/DESIGN.md`：§5.3 源文件标注表新增 `src/at-rest.ts` 一行（原创，无参考实现）；§6 风险与边界新增第 5 条「字段加密随版本轮换」，说明为何不得把密钥内置进插件。

## 2.0.6 (2026-09-22)

### Fixes

- **没有账号的区域不再向模型选择器列出模型**（issue #12，报告者 `stephenyab`）。此前只有国内版账号的用户，模型选择器里会多出一整组 `WorkBuddy Global`（**恰好 20 个**，与 `FALLBACK_WORKBUDDY_MODELS_GLOBAL` 逐条一致）——这些模型一个都用不了：该区域连凭据都解析不出来，选中后 `store.resolve()` 必抛错，shim 一律回 `401 not_signed_in`。**选择器说可选、实际必失败**，对单区域用户是纯噪音。

  - **根因**：静态 fallback 的初衷是「上游离线也不让 provider 空着」，但它无条件播种（`new WorkBuddyCatalog(region)` 即装载整份 fallback），而 `deriveCatalog` 的「空勾选 = 全量」又把整份放行；启动时的真实刷新对无账号区域必然失败、只留一条 `logger.warn`，fallback 便永久留存。DSH 宿主对凭据一无所知（`buildModelCatalog` 只过滤 `models.length > 0`），于是原样渲染。
  - **修复**：`WorkBuddyCatalog` 新增「本区域是否有本机登录」状态（`setRegionUsable()` / `isRegionUsable()`），无账号时 `current()` 返回空数组 → 宿主的空分组过滤让该分组**直接消失**。**provider 本身照常注册**：它的设置卡片与账号选择器正是用户登录的入口，隐藏分组是目录层决定，不是注册层决定。
  - **与 `set()` 的非空守卫分开**，没有放宽它：两者回答不同问题——`set()` 承载**上游真实答案**，永不允许为空；「本区域没有账号」是**合法的空状态**，且必须能跨刷新存活。合并二者会要么丢掉守卫、要么丢掉隐藏分组的能力。测试专门锁定这一点：区域不可用期间上游刷新仍会在内部恢复目录，账号一出现即可立即服务。
  - **默认可用（宽松方向）**：`setRegionUsable` 由异步扫描调用，扫描尚未完成或失败时保持原状，因此**一次瞬时文件系统错误不会把正常区域清空**。
  - **两个触发点覆盖登录后的恢复**：① 设置变更时重算（`applySelection` 之后）；② 卡片侧——usage 轮询与「重新检测账号」路由本就调用 `store.accounts()`，顺手上报可用性，所以用户登录桌面端后**无需重启**，模型自动出现。`setRegionUsable()` 返回值表明状态是否真的变化，未变化时不做多余的 adapter 失效。
  - **对称覆盖两侧**：报告举的例子是「只有国内版账号 → 国际版多出 20 个」，反之亦然（只有国际版账号时国内版会多出 12 个），修复同时作用于两个区域。

  **核查**：报告的根因链**逐条属实**，本版本按报告建议的方向（其「建议修复方向」第 1、2、3 条）实现。我们额外确认了它列出的两条实现约束确实成立——`catalog.ts` 的 `set([])` 会抛错（故另开一条状态而非放宽守卫）、空目录会让宿主过滤掉整个分组（故无需注销 provider），并验证了它在第 5 条提到但未展开的点：`routableProviders` 仍包含该 provider id，这与选择器过滤是两个独立概念，本次不改动。

  **措辞说明**：`README` 此前写「两边模型同时出现在选择器里」——该表述自本版本起变为**有条件**（有账号才出现），中英文 README 与 2.0.0 的 CHANGELOG 条目均已就地更正，而不是留着一个已被推翻的说法。

### Tests

测试总数 173 → 179（新增 6 例）：

- `tests/issue12-region-hiding.spec.ts` 新增 2 例（新文件，端到端复现报告者的环境）：CN-only 机器上 `workbuddy-global` **不再列出任何模型**，而 `workbuddy` 正常服务；同时断言 **provider 与可配置 provider 仍在册**（登录入口不能消失）。第 2 例覆盖恢复路径：登录国际版账号后经设置链路重算，模型**无需重启**即可用。
- `catalog.spec.ts` 新增 4 例：默认可用（扫描未完成不误清空）、无账号后 `current()` 为空且 `isRegionUsable()` 为假、`setRegionUsable()` 的「无变化」返回值语义、以及**非空守卫与可用性标记互相独立**（区域不可用期间 `set()` 仍保有真实目录，账号出现即恢复）。

每条新增守卫都用「删掉对应实现即失败」验证过：让 `current()` 忽略可用性标记会挂 5 例；移除 `applySelection` 的重算调用会挂 3 例（含一条端到端用例）。

### Docs

- `README.md` / `README.en.md`：双供应商一节的「两边模型同时出现」改为「**有账号的区域**其模型出现」，并说明无账号区域不列出、登录后自动恢复、provider 始终注册。
- `CHANGELOG.md` 2.0.0 条目中同一处表述就地标注了 2.0.6 的收紧。

## 2.0.5 (2026-09-22)

### Fixes

- **「跟随 App 当前登录」清除后不再被旧版 `accountId` 顶掉，且清除结果在卡片上可见**（issue #11 的缺陷 1；其症状属实，但所声称的机制与严重性不准确——见下方「核查」）。

  - **空字符串哨兵现在显式终止旧值回退**。`selectAccountFor()`（由 `applySelection` 内联逻辑提升为导出纯函数）按顺序判定：`accounts.<region> === ""` → 无选择（跟随 App）；具体 id → 该区域的显式选择；键不存在 → 回退到所属区域的旧版 `accountId`。此前 `""` 走的是「值已存在」分支并被 `selectAccount('')` 归一化为 `undefined`，结果碰巧正确，但语义靠下游兜底；任何一处偏离（下游不再归一化、或增加新的读取方）都会让旧账号复活。现在哨兵在源头终止回退，并有测试锁定。
  - **启动时的旧值归属（attribution）跳过被显式清除的区域**（`legacyAttributionRegion()`）。该 pass 在启动后异步运行：跳过被清除的区域，既避免把用户刚丢弃的选择重新绑回，也保证**另一个区域仍有机会认领同一个 id**（用 `continue` 而非 `break`，否则国际版的迁移会被国内版的清除顺手打断）。
  - **卡片新增区域状态行**：显示该区域当前是「使用保存的账号」还是「跟随 App 当前登录」，清除后先显示确认文案。这是 issue #11 里真正属于产品缺陷的那一半——清除后回退到的默认账号**通常正是刚被清掉的那个账号**（用户当初就是在 App 登录状态下选它的），因此清除成功与清除无效在界面上完全同形。此前 `usage` 文档也没有任何字段能区分二者。
  - **设置写入改为「写入后回读校验」，失败时明确报错**（Windows 上尤其重要，见下）。`settingsScope.set()` 的 promise resolve **并不代表值已落盘**：设置文档 `settings.yaml` 靠「写临时文件 + rename 覆盖」替换，而 `@deepseek-ai/dsh-atomic-write` 对 `EPERM`/`EBUSY`/`EACCES` 的重试**只在 `win32` 生效**——Windows 上杀毒软件、OneDrive 等同步盘或编辑器会短暂锁住该文件。重试耗尽后，失败以「不成功的响应」回到客户端，而设置 scope 的 `mutate()` 对此**只是重新加载 Host 状态然后正常返回**，所以调用方的 `await` 会成功、文档却没变。新增 `writeAccountSlot()` 与 `writeRegionModels()`：写入后把值读回，读不回即抛 `WorkBuddySettingsWriteError`。对三处写入的影响：
    - **清除账号**：只有确认落盘才显示「已清除」，失败则显示错误并说明原选择仍生效——否则会给出一个被旧选择默默反驳的假确认，比不提示更糟；
    - **切换账号**：同样校验。静默丢弃会让下拉框显示一个账号、实际计费另一个；
    - **保存模型**：尤其要紧——保存成功会**丢弃草稿**，若写入没落盘就丢，用户唯一的副本就没了，却还被告知「已保存」。校验比对回读的 `lastCatalog` id 序列（不能只看「槽位存在」，截断/残缺的写入同样要检出）。

  **核查**：报告的根因链在 HEAD 上不成立，逐条复现如下。**注意措辞更正**：2.0.5 初稿曾断言「清除本来就生效」，该结论只在 Host 侧成立；在 Windows 上写入可能被静默丢弃，因此报告的「点了没反应」在那里是真实存在的，只是机制与报告所述不同（不是 `accountId` 顶掉，而是写入没落盘）。回读校验修复的正是后者。

  | 报告的主张 | 实测结果 |
  |---|---|
  | `clearAccount()` 只写区域槽位，旧 `accountId` 会持续顶掉清除结果 | 清除后该区域立即跟随 App 默认；三种变体（旧账号≠当前登录、旧账号＝当前登录、启动归属与清除竞争）均通过 |
  | `effectiveAccountFor()` 在哨兵值上不提前返回，因此旧值继续生效 | 该分支返回 `""`，经 `selectAccount('')` 归一化为 `undefined`，**不会**回退到 `accountId`——返回值虽然「不提前」，但结果正确 |
  | 启动迁移块会把区域重新绑回旧账号 | 迁移块只在启动时运行一次，且 `applySelection` 走同一个 `effectiveAccountFor`，同样被哨兵挡住 |
  | `""` 与「未设置」在 schema 层不可区分 | `""` 与键缺失**是可区分的**：`z.object({cn: z.string()})` 对 `{cn: ''}` 保留空串、对 `{}` 保留缺键；`Object.hasOwn` 亦为真。不可区分的只有**语义**，不是 schema |
  | （报告未提及）写入可能根本不生效 | **成立，且与平台相关**：见上一条。空串本身在 YAML 里能正确往返（写成 `cn: ""`），所以哨兵语义没问题；丢的是**整次写入** |

  因此本版本不按报告的建议去「清除旧字段」——旧字段是**两个区域共享的**迁移来源，清掉它会让另一侧失去迁移依据；正确的做法是让哨兵赢（已实现），并把无法观测的状态暴露给界面（已实现），再加上对「写入没生效」的显式检测。

### Tests

测试总数 142 → 173（新增 31 例，**全套 173 通过**）。

> 关于 `host-heartbeat.spec.ts` 的 `processStartTimeMs`：在受限沙箱下该例会失败
> （`processStartTimeMs` 需要执行 `ps`，被沙箱以 `EPERM` 拒绝 → 返回 `undefined`）。
> 放开文件策略后 `ps` 可用，**5/5 通过**。该例与本次改动无关——两次运行用同一份
> 源码，差异只来自沙箱能否执行 `ps`。

- `settings-integration.spec.ts` 新增 15 例：`selectAccountFor` 的 6 例（显式选择优先、旧值只归属本区域、哨兵终止回退、清除与未配置可区分、两区域同时清除、清除一侧不影响另一侧）；`legacyAttributionRegion` 的 6 例（归属、跳过已清除区域、跳过但继续扫描另一区域、账号已消失、无旧字段、跨区域共享 id）；另有 3 例走真实 settings 链路 —— 清除后旧字段仍在但选不中、**重启后**已清除区域不被重新归属、以及清除前后经 usage 路由可见 `selectionExplicit` 翻转（账号名不变，这正是报告里「看起来没反应」的场景）。
- `client-account-selection.spec.ts` 新增 13 例（新文件）：`configuredAccountsOf` 的容错读取；`writeAccountSlot` 的保存与「保留另一区域」、哨兵写成 `""` 而非删键、**锁文件导致的静默未落盘必须抛错**、错误携带字段名、**不把「键缺失」误判为清除成功**、正常落盘不误报、回读与卡片读取同源（scope 的 flush 默认 `sync`，落盘后同步可见，故不会误失败）；`writeRegionModels` 的保存与区域保留、**静默未落盘必须抛错**、目录被截断也要检出（不能只看「槽位存在」）、错误字段名、正常落盘不误报。
- `auth.spec.ts` 新增 1 例：`hasExplicitSelection()` 在未选择/已选择/选择失效/哨兵清除四种状态下的取值。
- `web-status.spec.ts` 新增 2 例：signed-in 与两个 signed-out 分支都携带 `selectionExplicit`。

每条新增守卫都用「删掉对应实现即失败」逐一验证过：移除哨兵判断会挂 5 例，移除归属跳过会挂 2 例，把 `selectionExplicit` 写死为 `true` 会挂 3 例，把账号回读校验换成「相信 resolve」会挂 3 例，去掉模型保存的回读校验会挂 3 例。

### Docs

- `README.md` / `README.en.md` 的「已知限制 / Known limitations」补充：旧版 `accountId` 只作用于所属区域、且该区域被显式清除后不再生效；卡片状态行用于分辨清除是否生效；**Windows 上设置文件被占用会导致账号改动无法保存**，此时卡片报错且原选择保持生效。

## 2.0.4 (2026-09-21)

### Fixes

- **修复「保存的账号在本机消失后，界面自相矛盾」**（issue #10 的缺陷 3；其症状属实，但其声称的机制与严重性不准确）。显式选择的账号若在本机不再存在（WorkBuddy 更换登录或清理备份文件——`current()` 的注释早已点名这个成因），同一个状态下四条读取路径给出两种说法：

  | 路径 | 修复前 | 修复后 |
  |---|---|---|
  | `accounts()` | 靠对象同一性比较**仍标记一个账号为 selected** | 无人生效时不标记任何行 |
  | `current()` | 返回 `undefined`（拒绝计费，刻意不回退） | 不变（账单安全语义保留） |
  | `status()` | `signed-out` | 不变 |
  | 卡片下拉框 | `value` 取 signed-in 分支才有的 `accountId` → `''` → **空白**（选项仍在） | 显示「当前没有生效的账号」占位项 |

  - **根因**：`accounts()` 与 `current()` 对「id 失配」的口径不一致。卡片渲染前者、计费走后者，于是面板同时出现「下拉框选中 Alpha」「状态栏未登录」「提示去桌面端登录一次」——而用户明明已登录，那句提示还把人指向唯一无法修复该问题的操作。commit `1279234` 移除 `current()` 的回退（`?? this.preferred()`）以避免账单落到别的账号，本修复保留该决定，只消除显示层矛盾。
  - **`accounts()` 不再报告幽灵选中**：显式选择失配时不再回退到对象同一性比较（原写法依赖 `preferred()` 返回同一数组元素，能工作但语义脆弱）；未显式选择时仍如实标出正在跟随的默认账号。
  - **新增 `selectionLost`**：usage 文档的 `signed-out` 分支新增该可选字段，区分「保存的选择已失效（凭据是好的，请重选或清除）」与「本机确实没有登录（去桌面端登录）」。仅前者为真时才显示新的说明文案，后者保留原文案。
  - **卡片下拉框改从账号列表取选中值**（原先取 signed-in 文档的 `accountId`）。这是同一类问题的第二处：当保存的账号**仍然有效**、只是 token 过期且刷新失败时，`resolve()` 同样抛错，下拉框也会变空白——用户的完整选择看起来像消失了。现在由账号列表这一个来源决定，并以此区分「没有任何账号生效」与「已登录」。
  - **新增「跟随 App 当前登录」按钮**：清除该区域的显式选择，回到文档承诺的默认行为。清除写入空字符串哨兵值，`selectAccount('')` 归一化为 `undefined`；此前空字符串会像任何失配 id 一样永久卡死（即「没有清除路径」）。
  - **`rescanAccounts()` 不再写入选中的账号**：原先只要 `accounts()` 报告的选中项与保存值不同就回写设置，导致两点危害——无显式选择时把「跟随 App 登录」的默认行为固化成一个永久绑定（此后 App 换登录不再跟随，与 `README`/`DESIGN` 承诺不符），以及保存的 id 失配时静默把区域改绑到**另一个账号**（正是严格不回退规则要防的静默改选）。「重新检测」现在只重读，选择权归下拉框与清除按钮。

### Tests

测试总数 131 → 142（新增 11 例）：

- `auth.spec.ts` 新增 7 例：失配选择不标记任何账号、未显式选择仍标出默认账号、有效选择在刷新失败时保持可见、`selectionLost` 的三种取值（无选择/有效选择/失配）、无本机登录时不报 `selectionLost`、空字符串哨兵恢复默认、以及区域隔离（一个区域失配不影响另一区域）。
- `web-status.spec.ts` 新增 3 例：orphaned 选择标记 `selectionLost` 且保留账号列表、真正的未登录不标记、signed-in 文档不含该字段。
- `settings-integration.spec.ts` 新增 1 例：空字符串哨兵经真实的 `settings.update` 链路写入后仍为 `''`，且两个 provider 继续正常服务。

### Docs

- `README.md` / `README.en.md` 的「已知限制 / Known limitations」补充账号失效后的表现与恢复方式，并说明重新登录桌面端无法修复该状态。

## 2.0.2 (2026-09-15)

### Fixes

- **修复「同一账号多个凭据文件时选中已失效的那一个」，导致积分/签到/模型全部返回 openresty HTML 401**。此前按**存储的 `expiresAt` 最大**来挑选凭据，但 `expiresAt` 描述的是「签发时有效期有多长」，**不代表上游仍然接受** —— 上游吊销 token 时不会同步改写该字段，于是一个早已失效的备份文件可以声称比真实可用的文件**更晚过期**，从而永远被选中。

  - **实测复现**：本机某账号有 8 个凭据文件，其中 `2026-07-08` 的备份声称 `2027-07-06` 过期（最远），而真正可用的当前登录文件只到 `2026-11-14`。旧逻辑因此始终选中那个 07-08 的死文件，三个端点（`get-user-resource` / `checkin-activity-status` / `models`）全部返回 `401 Authorization Required` + `openresty`。
  - **改用 `auth.lastRefreshTime` 作为新鲜度判据**：这是上游自己的签发时间，是唯一可靠的信号。新增 `WorkBuddyCredential.lastRefreshAtMs` 字段并在解析时读入；`preferred()`、多账号去重、以及插件自有副本的合并**三处**统一改用新的 `isFresher()` 比较器。
  - **排序优先级**：① live 文件 `workbuddy-desktop.info`（应用当前登录）→ ② `lastRefreshAtMs` 较新者 → ③ `expiresAtMs`（仅作为文档缺失该字段时的回退，保证比较是全序的）。
  - **实测验证**：切换判据后，本机 11 个账号选中的凭据**全部返回 200**（此前 `老丁`、`LaoDing` 等均命中死文件）。
  - 插件自有刷新副本（无 `lastRefreshTime`）不参与签发时间比较：它只在**确实更长寿**时取代桌面端备份，且**永不顶替 live 登录**。

- **上游返回 HTML 401 时给出可执行的提示**，不再原样抛出 HTML 片段。识别 openresty / APISIX 的鉴权拒绝，改为提示「凭据已被上游网关拒绝，通常说明选中的是旧登录留下的失效凭据；请重新登录 WorkBuddy 桌面端后在卡片中选择该账号，可运行 `dsh-connect-workbuddy doctor` 查看全部凭据」。非鉴权类的非 JSON 响应（如 502 网关错误）保持原有的通用提示。

### Tests

- `auth.spec.ts` 新增 4 例：**备份之间**按签发时间而非存储过期时间选择（回归锚点，旧逻辑下必失败）、文档缺失 `lastRefreshTime` 时回退到过期时间、`auth.lastRefreshTime` 的正确解析、缺失该字段时保持 `undefined`。
- `upstream.spec.ts` 新增 2 例：网关 HTML 401 被转写为可执行提示（且不泄漏 `<html>`）、非鉴权类的非 JSON 失败仍保留通用提示。
- 全套 **126 个测试通过**。

## 2.0.1 (2026-09-15)

### Fixes

- **修复 `codebuddy.ai` 国际账号被判为国内、上游返回 HTML 401（issue #4）**。国际版产品有两个品牌域名：WorkBuddy AI **桌面端**在 `workbuddy.ai` 登录，而 **CodeBuddy CLI** 把同一个国际账号登录在 `codebuddy.ai`。`regionOf()` 此前只认 `workbuddy.ai`，于是 CLI 登录的 `www.codebuddy.ai` 凭据被判为 `cn`，其 token 被发往国内网关（`copilot.tencent.com` / `www.codebuddy.cn`），在 openresty 层被直接拒绝，返回 **HTML** 401 而非业务 JSON —— 表现为积分、签到、模型列表与对话**全部失败**（报告者最初描述为「仅积分失败」，后经其本人确认实际是全挂，与该根因一致）。
  - **`regionOf()` 增补第二个国际品牌域名**：`codebuddy.ai` / `*.codebuddy.ai` → `global`。判定仍按凭据自带的 `domain` 字段，无需任何手动开关。
  - **新增 `globalBase(credential)`：国际版网关跟随凭据自身的 `domain`**，不再写死 `www.workbuddy.ai`。两个品牌域名的凭据**互不通用**（在 `codebuddy.ai` 签发的 token 会被 `workbuddy.ai` 网关拒绝，反之亦然），因此 base 必须跟随凭据。`chatBase` / `billingBase` / `originReferer` / `fetchModels` 四处全部改用 `globalBase(credential)`；未识别的国际域名回落至 `www.workbuddy.ai`。
  - **token 刷新同样受益**：刷新端点走 `chatBase(credential)`，此前 `codebuddy.ai` 账号会向国内网关刷新；现在跟随凭据域名。
  - 国内版（`codebuddy.cn` / `workbuddy.cn` / `copilot.tencent.com`）行为完全不变。

  > 实测依据（只读探测，未使用任何凭据）：`www.workbuddy.ai` 与 `www.codebuddy.ai` 对 `/v3/config` 均返回 **200 + 同一 JSON envelope**，对 `/v2/billing/meter/get-user-resource` 均返回 **401 + 同形 HTML**（未带 token），确认两者是同一套网关栈的不同品牌域名，路径形态一致。

### Docs

- `scripts/probe-global-billing-401.mjs` 同步：`regionOf` / `globalBase` 与发布版保持一致；「凭据中是否出现 codebuddy.ai」的判定改为**中性陈述**——该脚本扫的是桌面端凭据目录，而 `codebuddy.ai` 来自 CLI 登录，扫不到只能说明本机没有 CLI 登录，不构成「该域名不存在」的结论（此前正是这个措辞导致了 issue #4 中的误判）。

### Tests

- `upstream.spec.ts` 新增 3 例：`codebuddy.ai` / `*.codebuddy.ai` / 大小写与空白归一化判为 `global`，且 `www.codebuddy.cn`、`notcodebuddy.ai` 不被宽松后缀匹配误升为国际；`globalBase` 跟随凭据域名并正确回落；`fetchModels` 对 `www.codebuddy.ai` 凭据请求 **`https://www.codebuddy.ai/v3/config`**（回归锚点，验证不再误发国内网关）。

## 2.0.0 (2026-09-15)

### Breaking Changes

- **为什么是 2.0.0**：本版是架构级变更——插件由「单 provider 单活区域」变为「双 provider 并行」，运行形态与外部可见契约均有变化，按语义化版本升主版本号：
  - **运行形态**：插件现在注册两个 provider 路由（`workbuddy` + `workbuddy-global`）并打开**两个**回环端口（原先各一个）。下游脚本若假定「只存在一个 workbuddy provider」，需适配新增的 `workbuddy-global`。
  - **CLI `--json` schema v2**：`doctor` / `status` 的 JSON 输出 `schemaVersion` 1 → 2，新增 `regions.{cn,global}` 分区报告；顶层字段保持 CN 语义向后兼容，但按 `schemaVersion` 判断结构的消费方需注意。
  - **设置 schema 扩展**：新增 `accounts.{cn,global}` 每区域账号选择。旧的单 `accountId` 仍被读取并按其账号实际区域自动归位（软迁移，非硬破坏）；`regions` 分槽结构不变。

### Features

- **🆕 国内版与国际版拆分为两个并行供应商，可同时使用**——此前一个 provider 一次只能活一个区域（选哪个账号整个 `workbuddy` 就服务于哪个区域，切账号 = 翻转整个运行时目录）。现在两侧是两套完全独立的实例，**互不干扰**：

  - **双 provider 注册**：国内版保持 `workbuddy`（老 id 不变，存量会话的默认模型与已保存选择全部继续有效），国际版新增 `workbuddy-global`（displayName `WorkBuddy Global`）。两边模型同时出现在 DSH 模型选择器里——不同会话 / 子代理可以各选一边，互不干扰。（**2.0.6 起收紧**：没有账号的区域不再列出模型，理由见该版本 CHANGELOG 的 issue #12 一节。）
  - **每个区域一套完整运行时栈**：凭据 store、模型 catalog、回环 shim、adapter 各一份。store 按凭据域名过滤可见账号（`workbuddy.ai` → 国际版，其余 → 国内版），两个区域的账号可同时在线。
  - **插件卡片 tab 化**：设置卡片顶部新增「国内版 / 国际版」tab 栏（带各自登录状态圆点）。每个 tab 有独立的账号选择、积分概览、签到与模型管理；**切 tab 不丢另一侧未保存的草稿**（模型勾选 / 图片开关 / 上下文预算的草稿按区域隔离保存）。4 条卡片路由全部按 `?region=cn|global` 参数化。
  - **「减少刷新变化」**：一个 tab 里切账号、刷新模型、轮询积分，完全不触碰另一边的运行时目录——绑定另一边模型的进行中会话不受任何影响（单 provider 架构做不到这一点）。
  - **账号选择按区域独立**：配置新增 `accounts.{cn,global}`，每个 tab 各选各的账号。旧的单 `accountId` 在启动时按其实际所属区域归位（另一区域保持「跟随 App 当前登录」的默认，绝不静默继承错区域的选中账号）。
  - **凭据刷新副本按区域分文件**：`$DSH_HOME/.workbuddy-auth.cn.json` 与 `.workbuddy-auth.global.json`，双账号同时在线互不覆盖（此前单文件只存一个账号的刷新结果，后写者赢）；旧单文件 `.workbuddy-auth.json` 作为迁移来源保留读取（只被其凭据所属的区域采纳），`logout` 清除全部三个副本。
  - **CLI 按区域报告**：`doctor` / `status` 分区域列出账号、登录态与积分（JSON schema 升至 v2，新增 `regions` 字段，顶层字段保持 CN 语义向后兼容）；`logout` 清除所有插件自有副本。

### Fixes

- adapter 工厂参数化 provider id / displayName（此前 `WORKBUDDY_PROVIDER` 在 `toPiModel`、`createProvider`、profile 等 5 处硬编码）；`WorkBuddyCatalog` 构造函数接受区域参数，国际实例从第一刻起就 serve 国际 fallback 目录。
- `registerModelDiscovery` 单 handler 按 `request.provider` 分流区域；web-status 的模型刷新路由不再先 `resolve()` 凭据推导区域（区域直接来自请求参数）。

### Tests

- auth：新增区域化测试 5 例——区域过滤的账号发现、跨区域显式选中不回退、旧单副本只服务其所属区域（迁移）、区域刷新写区域文件不动旧副本、logout 清除全部副本。
- settings-integration：双 provider 注册断言（`workbuddy` + `workbuddy-global`、两条 configurable provider 目录、各自 fallback 阵容）；跨区域污染回归（CN 的图片勾选绝不泄漏进国际 provider 的同名模型；国际 tab 的保存绝不触碰 CN provider）。
- web-status：region 参数路由测试（`?region=global` 分发到对应 store、缺省回落 `cn`、未知区域 400 且不触碰 store）；`workBuddyWebStatus` 断言请求区域驱动全部四个区域化访问器。

## 1.4.0 (2026-09-11)

### Features

- **🆕 正式支持国际版 WorkBuddy AI（www.workbuddy.ai）**——国内版与国际版账号在本插件中获得完全对等的支持，**零配置、零开关，全自动**：

  - **怎么用**：在插件卡片的账号列表里选中国际版账号（凭据文件 `workbuddy-desktop-ai.info`，Gmail 等邮箱登录的那个）即等于切到国际版；选回手机号账号即回到国内版。区域判定完全跟随凭据文件自带的 `domain` 字段（国际版为 `www.workbuddy.ai`，国内版为 `www.codebuddy.cn` / `www.workbuddy.cn`），无需任何手动设置。
  - **国际账号可用的完整功能**（全部经真实国际账号端到端实测）：
    - **模型接入**：**20 个模型**进入 DSH 模型选择器，含国际版独有阵容——GPT-6-Astra、GPT-5.6-Sol / Terra / Luna、GPT-5.5 / 5.4 / 5.3-Codex、Gemini-3.5-Flash、免费的 `deepseek-v4.1-flash` / Hy3 / Hy4 preview 等；与国内版共有的 GLM-5.3 / 5.2、Kimi-K3 / K2.6 也正常列出；
    - **积分倍率**：20/20 模型全部带倍率展示（GPT-6-Astra x6.67、GPT-5.6-Sol x3.47、Auto x0.79、`deepseek-v4.1-flash` / Hy3 x0.00 免费等），与 WorkBuddy AI 官方客户端展示的是同一个 `credits` 字段（已在其 App bundle 中确认渲染数据源一致）；
    - **积分概览**：按套餐展示国际账号的剩余积分与到期时间（一次性 Bonus Pack 与月度 Free Plan Subscription 均正确区分），查询走国际网关 `https://www.workbuddy.ai`；
    - **每日签到**：签到状态与领取端点在国际网关实测可用；活动未开启时按钮自动禁用（409 守卫），开启后即可直接领取；
    - **对话路由**：chat 请求自动走国际网关，wire 协议与国内版同构（业务码 11128 等语义一致，`prepareChatBody` 的改写逻辑两侧通用）。
  - **核心修复：按渠道读取模型目录**。原先国际账号读 `/console/enterprises/personal/models`（国内路径，国际网关返回 HTTP 500）。改用两区域各自的正确来源后，国际账号首次拿到**完整 20 个模型**：
    - **国内**：`copilot.tencent.com/v2/enterprises/personal/models`（保持原样，29 个模型中取 `cli` agent 的 15 个）；
    - **国际**：`www.workbuddy.ai/v3/config` —— 关键在于**必须用桌面端 User-Agent**：配置服务按客户端渠道返回不同产品配置，`CLI/… CodeBuddy/…` 只给 35 个模型并**缺失 `deepseek-v4.1-flash`、`gpt-6-astra`**（尽管两者都能正常对话），而桌面渠道给出账号真实的 20 个 chat 模型。版本号无关（`WorkBuddy/5.5.2`、`WorkBuddy/1.0.0`、裸 `WorkBuddy` 结果一致），是 `WorkBuddy` 这个产品标识选择渠道。国内网关不需要这个切换：其桌面配置的 `cli` agent 为 0 个模型。
    - 国际账号此前**只剩 `hy3`、`hy4-preview`** 两个可用模型（`deepseek-v4.1-flash` 被静默丢弃、`gpt-6-astra` 不可见），现在 20 个全部就位，与 WorkBuddy AI 客户端的模型菜单一致。

### Fixes

- **目录与勾选按区域隔离（国内 / 国际各一套）**：此前 `lastCatalog` 与 `enabledModelIds` 是全局单槽。国内账号下勾选的模型（含 `deepseek-v4.1-flash`、`hy3-x`）在切到国际账号后，会与**国际目录**求交集——凡是国际目录里没有的 id 都被静默丢弃：国际账号实际只剩 `hy3`、`hy4-preview` 两个模型可用（`src/index.ts` 启动时 `deriveCatalog(国际目录, 国内勾选)`）。
  - 现改为 `regions.cn` / `regions.global` 两套独立槽位（目录、勾选、图片开关、上下文预算各一份），互不干扰；切换账号不再覆盖另一区域的配置。
  - 新增按区域区分的静态 fallback 目录：国际账号在首次拉取前不再被塞入国内模型清单（`FALLBACK_WORKBUDDY_MODELS_GLOBAL`，2026-09-11 从国际网关桌面渠道配置实测捕获 20 个模型及其倍率，含免费的 `deepseek-v4.1-flash`）。
  - 旧的扁平字段保留为**国内区域的迁移来源**（旧配置一律来自国内端点），国际区域绝不继承——这正是丢勾选的根源。
  - 卡片保存改为写入当前账号所属区域的槽位；usage 文档新增 `region` 字段供卡片定位。
- 三个探测脚本（`probe-models` / `probe-credits` / `probe-account-switch`）同步改用 `/v2/...` 路径：此前它们对国际账号同样会 500，导致诊断输出误导。
- 新增只读评估脚本 `scripts/probe-global-eval.mjs`：对比国际网关 `/v2/...`（500）与 `/v3/config`（200）两条取目录路径，并验证积分与签到端点——本轮的渠道发现即由它得出。

### Tests

- 新增 `fetchModels` 回归测试：stub 上游后断言 CN 凭据（`codebuddy.cn` / `workbuddy.cn`）拼出 `copilot.tencent.com/v2/enterprises/personal/models`、国际凭据（`workbuddy.ai`）拼出 `www.workbuddy.ai/v3/config`，并断言国际请求携带**桌面端 User-Agent**（`WorkBuddy/5.5.2`，CLI UA 会拿到缺模型的 35 个）、CN 请求**不得**携带桌面端 UA（国内桌面配置的 `cli` agent 为空）。把「按渠道取目录」钉死，防止日后退回会丢模型的取法。
- `regionOf` 测试补上 `www.workbuddy.cn`（国内版新 domain 形态，实测本机存在）。
- 新增区域隔离测试：`regionStateOf` 断言旧扁平字段只被读作国内状态、国际区域绝不继承、显式槽位优先；`fallbackModelsFor` 断言国内清单不得泄漏进国际（国内无 `gpt-*`/`gemini-*`，且 `default-model` 仅属国际）；web-status 断言文档携带的 `region` 与凭据域一致、且四个区域化访问器收到的都是该区域。
- **每日签到（领取）路由的守卫逻辑首次获得直接 handler 测试**（实测两区域端点行为后补齐）：
  - 活动未开启（国际账号实测形态，`active:false`）→ 409 且**绝不调用**上游领取；
  - 今日已签到 → 200 `alreadyCheckedIn` 且不调用上游领取（幂等保护）；
  - 活动开启且未签到 → 恰好领取一次、领取后重读状态并返回刷新后的连签天数；
  - 非回环 Origin → 403、非 POST → 405，两道安全守卫均在触碰上游前拒绝。
  - 实测依据（全部经插件真实代码路径、零状态变更验证）：CN 网关领取端点对已签到账号返回业务拒绝「今天已签到，请明天再来」；国际网关同路径存在，对未开启活动返回「签到活动未开启或已过期」（均为 HTTP 400 业务码而非 404，证明端点存在、鉴权与协议一致）。国际版 App bundle 中确认签到端点与插件同路径，官方 App 对签到走无前缀形态、`get-user-resource` 才需 `/v2` 前缀——插件统一 `/v2` 形态在两侧网关均实测可用。

## 1.3.0 (2026-09-10)

### Breaking Changes

- **跟进上游 DSH 内核 0.1.2-rc.1 → 0.1.5-rc.1**：本机 DSH Desktop 2.0.9 捆绑的内核已跃迁到 `0.1.5-rc.1`（npm `latest`），而插件此前按 `0.1.2-rc.1` 编译。依赖链与代码已对齐新内核线：

  - **`ResolvedPiAiProviderProfile.modelErrors` 变为必填**：`dsh-llm-pi-ai` 的 provider profile 在 0.1.5-rc.1 新增必填字段 `modelErrors`，`PiAiAdapter.modelOf` 会在每次请求时读取，并对其中列出的任何 model id 抛出 `INVALID_CONFIG`。本插件的目录来自上游实时读取，因此填**空 Map**——即「无已知失败模型」，绝不预先否定目录后续提供的模型。这是本次跃迁中本插件唯一的一处源码编译失败。
  - **`@deepseek-ai/dsh-client-runtime` 已停止发布**：该包停在 `0.1.1-rc.2`，在 0.1.5 线上既未发布也不在桌面捆绑集内（其槽位/会话服务迁至 `dsh-client-ui-renderer/client`）。此前客户端入口从它取 `ClientContext` 类型、并在 `dsh.client.inject` 中声明它。现改为：运行期注入以真实提供 `slots` 服务的 5 个包为准（移出 `dsh-client-runtime`），类型侧用具名 `WorkBuddyClientContext`（cordis `Context` + `slots`/`locale`/`settingsScope` 三个座位），使客户端入口在两条主机线上都能编译。
  - `@earendil-works/pi-ai`：`0.85.0` → `0.85.1`。

### Fixes

- **升级后 provider 注册不再静默失效**：`modelErrors` 缺失在 0.1.5-rc.1 上是**编译期**硬失败（本次已由 `pnpm run check` 捕获并修复）；回归测试进一步把「运行时该 map 必须为空」钉死，避免日后有人在其中塞入模型 id 而悄悄禁用整条路由。
- **客户端 half 不再依赖已消失的包**：`dsh-client-runtime` 在 0.1.5 主机上无法解析，客户端插件此前把它列为注入目标；现已移除，构建产物 `lib/client.js` 对它零引用。

### Dependencies

- 全部 `@deepseek-ai/dsh-*`：`0.1.2-rc.1` → `0.1.5-rc.2`（`0.1.5-rc.1` 为 npm `latest`，`rc.2` 已在 `next` 通道；本仓库按线跟进并锁在 lockfile）
- `@deepseek-ai/dsh-client-runtime`：保留 `0.1.1-rc.2`，**仅作旧主机线的类型来源**，不参与 0.1.5 运行时
- 新增 `@deepseek-ai/dsh-client-ui-renderer`：0.1.5 线上 `slots` 服务的真实提供方
- 依赖声明统一改为**范围**而非写死补丁版本（含 `pnpm-workspace.yaml` 的 `overrides`），升级时只需改一处版本串

### Docs

- 记录本轮内核跃迁的对照依据与影响判定：本插件**不受** F1（会话持久化改为句柄化接缝）与 F3（`PERSONA_SECTION` 改名）影响——全仓无会话日志直读、无 persona 段 key 注入；受影响面集中在 F4（导出面变化）与 A4（声明依赖须落在捆绑子集内）。

## 1.2.0 (2026-09-09)

### Features

- **模型选择器显示积分倍率**：DSH 模型选择器中的 WorkBuddy 模型现在按 WorkBuddy 自身选择器的拼写显示积分倍率（如 `GLM-5.3 · x0.79`；未解析到倍率则保持原名称，免费模型显示 `x0.00`）。仅改 DSH 侧显示名（`toPiModel` 与模型 discovery 的 `name`）：模型 `id`、`lastCatalog` 存档与插件卡片显示不变——DSH 的选择状态、会话事件（`model/selection` / `request/header`）、agent 默认模型设置与请求路由全部以 `provider + model id` 为连接键，倍率后缀不参与任何映射。

### Fixes

- **修复模型保存始终失败（`client api: settings/mutate rejected "ops"`）**：卡片保存 `lastCatalog` 时曾用 `nativeContextWindow: undefined, multimodal: undefined` 显式清字段——显式 `undefined` 值会穿过 `structuredClone` 并被设置写入路径的严格 JSON codec 拒绝，导致**整次保存静默失败**（错误是 unhandled rejection，UI 无任何提示；用户侧表现为「保存按钮按不下去」）。姊妹项目 dsh-connect-trae 的 payload 不含 undefined 字段，故不受影响。现在改用 `toPersistedWorkBuddyModel` 按 KEY 剥离卡片专用字段（附回归测试：持久化形状不得含 undefined 值属性、JSON 往返无损）。
- **保存失败可见化**：保存抛错此前是静默的 unhandled rejection（UI 零提示，正是它掩盖了上一条 bug）。现在保存失败时在按钮旁显示具体原因，草稿保持 dirty 可直接重试；成功路径与 dsh-connect-trae 卡片完全一致（保存中… → 自然结束 → 恢复「保存」并禁用），无额外装饰。

## 1.1.3 (2026-09-04)

### Breaking Changes

- **跟进上游 DSH 0.1.2-rc.1 / Cordis 4.0.2**：本插件依赖链全部更新至 `0.1.2-rc.1`（`@deepseek-ai/dsh-*`）与 `4.0.2`（`@deepseek-ai/cordis`）。以下 API 变更需要同步适配：

  - `installSettingsSection(ctx, ns, schema, entry, hooks)` 移除：改为 `ctx.settings.installSection(ctx, ns, schema, entry, hooks)`（实为 `SettingsProvider.installSection` 实例方法）。
  - `settingsNamespace('workbuddy')` 移除：改为 `'workbuddy' as SettingsNamespace`（dsh-settings 导出的 branded type）。
  - `registerModelDiscovery` 回调签名的 `signal` 字段从 `request.signal` 移至回调第二参数 `async (request, signal) =>`。
  - `SettingsNamespace` branded type 语义收紧：`WORKBUDDY_SETTINGS_NS` 需显式 `as SettingsNamespace` 断言。
  - Cordis 4.0.2 要求所有服务访问显式 inject：`inject` 声明从 `['llm']` 扩为 `['llm', 'settings']`。
  - `onChange` 回调在 `installSection` 注册时同步触发：涉及的前置变量（如 `invalidateCatalog`）需提前声明。

### Dependencies

- `@deepseek-ai/cordis`：`4.0.1` → `4.0.2`
- 所有 `@deepseek-ai/dsh-*` 包：`0.1.1-rc.1` → `0.1.2-rc.1`
- `@deepseek-ai/dsh-client-runtime`：`0.1.1-rc.2`（不变，0.1.2-rc.1 未发布）
- `@deepseek-ai/schemastery`：`3.18.1-rc.1` → `3.18.2`
- `@earendil-works/pi-ai`：`0.82.1` → `0.85.0`
- `@deepseek-ai/dsh-client-ui-settings`：补充显式 devDependency（已作为 0.1.2-rc.1 依赖）

### Infrastructure

- `pnpm.overrides` 从 `package.json` 迁移至 `pnpm-workspace.yaml`（pnpm 11 要求）。

## 1.1.2 (2026-08-31)

### Fixes

- **兼容当前 DSH 宿主（dsh-plugin-desktop@2.0.4，@deepseek-ai/* = 0.1.2-alpha.1）**：peerDependencies 中 8 个 `dsh-*` 包的预发布分支范围扩展为 `>=0.1.0-rc.1 <0.2.0 || >=0.1.1-rc.1 <0.2.0 || >=0.1.2-alpha.0 <0.1.3`，覆盖 0.1.0-rc / 0.1.1-rc / 0.1.2-alpha 全部已发布分支；`@earendil-works/pi-ai` 由精确 `0.82.1` 放宽为 `>=0.82.1 <0.85.0`（兼容宿主 0.84.3）。修复用户环境版本不匹配导致的 ERESOLVE / 静默排除。

## 1.1.1 (2026-08-31)

### Docs

- `RELEASING.md` 明确发布 2FA 约定：本项目使用**浏览器授权**，不用 `npm publish --otp=<码>` 命令行方式；补充验证 URL 404 时重跑生成新链接。

## 1.1.0 (2026-08-31)

### Features

- **切换账号出错提示**：切换账号后出现错误（如所选账号凭据失效返回 401）时，插件卡片账号信息区（令牌行下方）显示一行小字「出现错误，重新登录 WorkBuddy APP 即可」，提示用户通过重新登录恢复。

### Docs

- 市场收录对齐当前约定：正式提交 PR [#3812](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/3812) 仅保留 `data/plugins/dingminhua__dsh-connect-workbuddy.yml` 与生成的 README；**移除**对注册表 `data/screenshots.json` 的改动（该文件是旧约定回退，新约定为插件自己仓库根目录声明 `screenshots.json`）。
- README 与 README.en.md 市场章节补充「收录目录规范」（contributing.md 要点：单文件命名、url 一致、category、描述引号规则、`dsh.bundle` manifest、topic、CI 门槛、README 由脚本生成、每 PR ≤ 3 条）。
- 新增 `awesome-dsh-plugin-submission/README.md`：市场收录目录的操作说明与当前状态；删除已废弃的 `screenshots-entry.json` 草稿（对应旧约定往注册表加键的做法）。

## 1.0.1 (2026-08-30)

### Fixes

- 账号选择改为严格绑定用户显式选择：删除启动时按积分自动挑选账号的逻辑，未选号时跟随 App 当前登录（live 文件）；账号失效时不再静默切换到其他账号，而是报「未登录」让用户重新选择，避免账单落到用户未选择的账号上。

### Docs

- `docs/DESIGN.md` 对齐当前进度：图片输入改为手动勾选说明；补充 `reasoning.effort`（固定档位）形态与推理强度两态已知问题；积分展示补充月度周期套餐与每日签到；scripts 探针数量更新。
- README 与 README.en.md 功能特性更新：图片输入改为按模型手动勾选。
- 新增 `docs/reasoning-investigation.md`：记录推理强度调查结论（上游两态数据、DSH 链路、实测档位、待决策修复方向）。仅记录，未改代码。

## 1.0.0 (2026-08-30)

### Features

- **WorkBuddy 模型接入**：将本机登录的 WorkBuddy 模型注册为 DSH 的 `workbuddy` provider，通过安全 loopback shim 提供模型调用，DSH 本地执行工具循环。
- **模型管理**：从上游刷新完整模型目录后可逐项勾选启用；刷新为草稿操作，需显式保存。上游同时给出积分倍率、上下文/输出上限与推理档位（实测 16 个 cli 模型全部带出这些字段，原实现仅保留 id/name/token 上限）。
- **图片输入手动开关**：图片支持由用户在模型列表手动勾选「图片」复选框决定（默认不勾选），不再依赖上游 `supportsImages`/`disabledMultimodal` 自动推断；勾选保存后该模型声明 image 输入，未勾选仅 text。
- **本机账号切换**：扫描 WorkBuddy auth 目录（活跃文件 + 时间戳备份），按 uin 去重为多个可选账号，默认跟随 App 当前登录。
- **凭据路径多候选**：macOS / Windows(Local+Roaming) / Linux(XDG) 逐一探测，支持环境变量与配置覆盖。
- **只读积分概览**：按套餐聚合展示剩余积分，区分「月度周期套餐」与「一次性礼包」；查询不消耗积分。
- **每日签到**：卡片下方提供一键签到按钮，查询状态与领取均走 `/plugins/dsh-connect-workbuddy/checkin`（POST），回环来源校验 + 领取前二次确认，不会重复领取。
- **只读路由 trio**：`/plugins/dsh-connect-workbuddy/{usage,models/refresh,accounts/refresh}`，回环来源校验 + token 脱敏，积分查询失败降级为 `creditsError`。
- **CLI 诊断**：`status` / `doctor` / `logout`（`--json` 支持），doctor 列出每个发现的账号及其文件来源。

### Fixes

- **凭据选择优先活跃文件**：实测所有备份文件都声称 2027 年到期，但只有 `workbuddy-desktop.info` 的 token 被上游接受。改为活跃文件优先，到期时间仅作备份间排序。
- **无头 profile 下不再崩溃**：`ctx.effect()` 的回调同步执行，无 `webServer` 服务时（TUI）会同步抛错。现改为先 `ctx.get('webServer')` 判空再注册。
- **刷新保留用户选择**：从 WorkBuddy 刷新目录后，已启用的模型、已勾选的图片与上下文预算均按模型 id 重新映射保留，不再丢失。
- 测试不再污染真实 `$DSH_HOME`：vitest 配置隔离 DSH_HOME，避免写心跳与凭据副本到开发者真实 profile。

### Docs

- README 与 README.en.md 顶部新增插件使用界面截图，并新增 `screenshots.json` 登记截图路径。
- 确立溯源与致谢规范：`THIRD_PARTY_NOTICES.md` 完整记录参考项目及其许可证；README 与 README.en.md 的致谢章节按「连接内核的参照 / 插件外观与结构的基准」两类如实标注来源。
- `dsh-codex-connect`（Apache-2.0）作为唯一非 MIT 参考项，其第 4 条声明义务在 `THIRD_PARTY_NOTICES.md` 中单独履行。
- `docs/DESIGN.md` 第 5.3 节确立源文件头标注规范：每个借鉴自参考项目的文件必须写明「参考了谁 / 参考了什么 / 改动了什么」。
- `RELEASING.md` 将「核对溯源与致谢」列为发布前强制步骤。
- 新增 `awesome-dsh-plugin-submission/` 市场注册草稿（与 `dsh-connect-trae`、`dsh-subagent-default-model` 对齐），README 补充「市场收录与展示」章节。

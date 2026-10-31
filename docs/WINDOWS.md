# Windows 支持登记与约束（Windows Support Register）

> 本文件是 `dsh-connect-workbuddy` **平台相关约束的登记处**。README 的「平台支持」一节是面向使用者的摘要，本文件是面向维护者的完整登记。
>
> **维护约定：任何改动 Windows 行为的提交，必须同时更新本文件；README 的「平台支持」表若随之变化，两份 README（`README.md` / `README.en.md`）必须一起改，且与本文件保持一致。** 这是本项目的长期口径：**Windows 是一等目标平台，每次改动的默认考量面包含 Windows。**

## 0. 为什么需要这份文件

Windows 在本项目里不是「顺带能跑」的平台，而是**有专属分支、专属故障、且开发机无法复现**的平台。最后一点是关键：

> **macOS 开发机上跑不出来的 Windows 缺陷，不是「没复现」，而是「不可能复现」。**
>
> 依据（提交 `1b8bc7f` 的记录）：`@deepseek-ai/dsh-atomic-write` 的 rename 重试被 `process.platform !== 'win32'` 直接短路——只有 Windows 会拒绝 rename 覆盖另一个进程打开着的文件，POSIX 的 rename 无论文件是否被打开都直接替换。同一段代码在 macOS/Linux 上**根本不进重试分支**。实测对照：macOS 上把该配置文件持续持有 0/300/800/1500/3000/6000ms，写入全部在 1–2ms 内成功。
>
> 因此**「在 Mac 上试过了，没问题」不足以判定 Windows 行为**。这类结论必须来自：CI 的 windows-latest、Windows 用户回报的现场、或真机取证的向量。

## 1. 七个 Windows 专属分支

改动这七处中的任何一处，都要考虑 Windows。

| # | 位置 | Windows 行为 | 若改错会怎样 |
| --- | --- | --- | --- |
| 1 | `src/auth.ts` `defaultDesktopAuthDirs()` | `%LOCALAPPDATA%` / `%APPDATA%` **优先**，未设或为空白串时回落 `<home>\AppData`（`Local` / `Roaming` 两个候选） | 重定向配置文件（OneDrive 文件夹备份、企业策略）的机器读不到凭据 → 显示未登录 |
| 2 | `src/at-rest.ts` `workbuddyAppExecutableCandidates()` | 按 `WorkBuddy.exe` 探四个位置：`%LOCALAPPDATA%\Programs\WorkBuddy`、`%LOCALAPPDATA%\WorkBuddy`、`%ProgramFiles%\WorkBuddy`、`%ProgramFiles(x86)%\WorkBuddy` | 装在自定义目录（如同源 issue 里的 `E:\WorkBuddy\WorkBuddy.exe`）的机器取不到字段密钥 → 加密凭据读不出 |
| 3 | `src/host-heartbeat.ts` `processStartTimeMs()` → `processStartProbe()` | 走 PowerShell `Get-Process` 的 `StartTime`，以 UTC ISO 8601 输出供 `Date.parse` 解析 | PID 复用判定失准 → 心跳误判宿主存活 |
| 4 | 设置写入回读校验（`src/client/account-selection.ts`） | 写入后**回读校验**：profile 的 `cordis.patch.yml` 被占用会让 rename 覆盖失败，而 `set()` 的 promise 仍 resolve | 用户看到假确认（显示「已清除」但没落盘）→ issue #11 |
| 5 | 子进程启动选项：`src/host-heartbeat.ts` `PROCESS_PROBE_OPTIONS` 与 `src/at-rest.ts` `fetchAtRestKeyPayload()` | 一律带 `windowsHide: true`（POSIX 忽略该选项） | **宿主本身没有控制台**（Electron GUI 进程，实测 `MainWindowHandle = 0`），Windows 会给子进程**新建一个可见的控制台窗口** → 每次进程存活判定都在屏幕上闪一次黑框 |
| 6 | `src/at-rest.ts` `readAtRestKey()` → `findWorkbuddyAppExecutableWithSource()` | 字段密钥**不带参数**调用时才走注册表回退（`reg query` × 3 个卸载 hive）；这个探测曾被**只按成功结果**缓存 | 桌面端不在候选目录、凭据又是加密的机器上，`scanAll()` 会**逐文件**重跑整套探测。issue #77 实测：19.1 s 的请求里 15.3 s 花在 `spawnSync`，约 **135 个 `reg query` 子进程**（`findWorkbuddyAppExecutable()` 被调用 45 次）→ 打开页面白等 60 s。POSIX 上这一支根本不跑，**在 macOS 开发机上永远看不到** |
| 7 | `src/windows-acl.ts` `protectCredentialDirectory()`（issue #183） | 凭据库的访问权限**不能靠 `mode: 0o600`**：Windows 上 `fs.writeFile` / `fs.rename` 的 `mode` 被接受但不生效，权限完全由继承的 DACL 决定。改为在**写入之前**对 vault 根目录发一次 `icacls`（`/inheritance:r` + `*S-1-3-4`、`*S-1-5-18`、`*S-1-5-32-544`，含 `(OI)(CI)`），靠 Windows 的继承传播覆盖整棵子树 | vault 里是**明文** `accessToken` / `refreshToken`。未加固时实测该文件被 `<机器>\CodexSandboxUsers`（DSH 自己沙箱账户）以 `Modify` 读取，且本机 `~/.dsh` 还额外带着 `Everyone: FullControl` → 本机任何低权限进程都能取到可用 JWT |

**第 7 条为什么单列**：它是本项目里**第一个「静默失效的防御」**——`mode: 0o600` 看起来像已做了权限限制，代码注释、目录名（`vault`）和既有文档都暗示这一点，而 Windows 上它**什么都不做**。这类缺陷的危险不在于写错，而在于**看起来已经写对了**：没有报错、没有日志、`doctor` 也一切正常。真机取证（2026-10-27，Windows 11）用 `Get-Acl` 读到的事实与代码意图相反，这才把它暴露出来。

**加固的四条实测结论**（A 档，真机 `icacls` / `Get-Acl`）：

1. **`/T` 必须禁用**。`icacls <dir> /T /inheritance:r /grant:r "*S-1-3-4:(OI)(CI)(F)"` 会让它走过的**每个文件得到空 DACL**（实测 `ACEcount=0`）——比原来更糟，因为谁都读不了，包括插件自己。正确形态是目录用 `(OI)(CI)`、文件用裸 `(F)`；本实现的写入路径只加固目录，靠传播覆盖文件。
2. **一次 `icacls` 覆盖整棵树，不需要遍历**。实测：对一个同时含 `cn/`、`global/` 子目录与文件、且全部带 `Everyone`/`CodexSandboxUsers` 的根目录只跑一次 `icacls`，事后根、两个子目录、子目录里的文件全部变成恰好三条 ACE（`weak=0`）。因此实现里没有按目录遍历，也没有按文件逐个加固。
3. **加固必须在写入之前**。`writeFileAtomic` 是「写临时 inode → rename 覆盖」，替换出来的是**新 inode**；写在之后加固既留下 pre-rename 窗口，也会被下一次替换抹掉。
4. **要加固 vault 根目录，不只是 region 目录**。`Everyone: FullControl` 是从 `~/.dsh` 继承到 `…/workbuddy-vault` 上的；只加固 `<vault>/<region>` 时根目录仍可写，任何进程都能替换掉 region 目录本身。`writeVaultEntry()` 传的是 `dirname(dir)`。

**成本是这里的一等约束**（A 档实测）：`icacls` 是子进程，静止态 19–52 ms，**并行负载下最高 1242 ms**。因此实现遵守两条：一个目录**一次**调用；同一路径**正在进行的**加固被 join 而不重复发起。这不是提前优化——最初「每次写入后再加固一次文件」的版本把 `tests/issue12-region-hiding.spec.ts` 的 1 s 轮询预算顶穿，才定位到成本形态并改成现在这样。**改动这里的调用次数或等待策略时，请以该用例为成本哨兵。**

**没有做的事**（诚实登记）：issue #183 的建议 1（DPAPI / `safeStorage` 加密落盘）**未实现**。当前落盘的仍是明文，只是权限收紧了；管理员、SYSTEM 服务，或已经拿到该用户令牌的攻击者仍可读取。要做到那一步需要改变 vault 的**磁盘格式**并做迁移，属独立改动。README 明写「此文件含明文 token」。

**第 6 条为什么单列**：这是**第 5 条之外的第二个**「只在 Windows 才付费」形态——不是正确性错误，而是**成本随文件数 × 读取次数放大**的性能缺陷，且两个乘数都在 Windows 特有的分支里。`tests/issue77-at-rest-key-cache.spec.ts` 用 `process.platform` 影子 + `execFileSync` 打桩，在**任何宿主**上都能数出这三件事（失败结果被记住、一次探测 3 次 `reg`、5 个加密文件的一轮读取仍是 3 次）。

**第 5 条为什么单列**：它不是路径或逻辑错误，而是**只在「父进程无控制台」时才出现**的一类缺陷——而这恰是 GUI 宿主的常态、终端里的例外。在终端手工跑插件时父进程有控制台，子进程只是继承，**永远看不到这个现象**；它因此逃过了所有本地验证，直到在真机上以「父进程无控制台」的形态复现（§2 A 档）。

**通用注意**：路径一律经 `path.join` 构造，**不得写死 POSIX 分隔符**。历史上正因此挂过 CI——`2.0.11` 新增的 darwin 候选断言写死了 `/Applications/WorkBuddy.app/...`，生产代码没问题（用 `join`），错的是测试：它断言的是「跑测试的机器是 POSIX」而非「候选列表对不对」，于是 Windows 必挂、macOS 恒绿。现有回归守卫：候选路径不得**混用**分隔符。

**更隐蔽的反向形态**：处理 **Windows 专用**数据（注册表值、`%LOCALAPPDATA%` 等 Windows 环境变量）时，`path.join` / `path.basename` **不是**正确答案——它们跟随**运行平台**。在 Linux/macOS 上跑，`basename('E:\workbuddy\WorkBuddy.exe')` 返回整串（`\` 在 POSIX 下不是分隔符），`join('E:\workbuddy', 'x.exe')` 产出 `E:\workbuddy/x.exe`，两者在 Windows 上都不可能命中。正确写法是 `path.win32.join` / `path.win32.basename`：**分隔符由数据决定，而不是由宿主决定**。

- 生产代码里曾有两处踩到：`workbuddyAppExecutableCandidates()` 的四个 Windows 候选（`DIRTY` 形态的分隔符 → 非 Windows 宿主上构造出的路径永远不存在，且**它的测试用 `join()` 构造期望值，以同样的方式被改坏，于是双双通过**），以及注册表回退的 `normalizeRegistryExecutable()` / `registryInstallLocationFromQuery()`。
- 因此**测试的期望值也必须用 `win32.*` 构造**：用 `join()` 拼 Windows 期望值时，生产与测试会一起漂移，CI 在 ubuntu 上照样绿——这正是上一条「断言的是宿主而非逻辑」的同一种错，只是方向相反。
- 判断标准很简单：**这个字符串里出现 `\` 或盘符了吗？**有 → `win32.*`；是 POSIX 绝对路径或拼接本机路径 → 用 `join`。

## 2. 证据分级（写结论时必须用对档位）

| 档位 | 含义 | 实例 |
| --- | --- | --- |
| **A 真机取证** | 在真实 Windows 上取得，可作为最终判据 | ① 真实 Windows 安装（2026-09-26）里 `workbuddy-desktop.info` 的 `nickname` / `phoneNumber` / `accessToken` 信封**观察到 `keyId=9127dea1b44020a7`**；② issue #13 报告的 `E:\WorkBuddy\WorkBuddy.exe`；③ **§1-5 的控制台闪窗**（见下方专门说明）；④ §1-1 凭据目录与 §1-2 可执行文件候选在真机上命中（`doctor` 全绿，见 §7 记录） |
| **B CI 实测** | `windows-latest` 上跑过，覆盖跨平台正确性 | 套件全绿；`tests/auth.spec.ts` 的 `win32` 分支断言（注入 `platform`/`home`/`env`，**任何主机上都能跑**） |
| **C 约定推导** | 按平台约定写出 + 单元测试钉住，**未在真机逐项验证** | 四个凭据/可执行文件候选路径中**未在本机命中的那些**（见 §7 记录：本机只命中了 `%LOCALAPPDATA%\Programs\WorkBuddy` 与 `%LOCALAPPDATA%\...\auth`，其余候选仍属 C 档） |

**档位决定用途，不只是一句标注**（2026-10-24 补写，来源是 #132 的实际取舍）：

- **A / B 档**可以支撑「这是正确行为」的断言，也就可以作为默认值上线。
- **C 档**只支撑「按约定应当如此」，**不足以改动默认发出的字节**。C 档结论要上线，只能做成**默认关闭的开关**，并在文档里写明「报告者实测、本插件未复现」——因为它错的时候，代价落在每一个没选择它的用户身上。
- **D 档**只能作为待办登记，不得写进行为说明。

> **2026-10-16 更正（issue #68 逼出来的）**：上面 ① 此前写作「`tests/at-rest.spec.ts` 里**固定向量** `keyId=9127dea1b44020a7`」，并把该测试当作这条观察的守卫。**那个说法是错的**：观察本身成立（§7 的记录也独立记着它），但**推导出该 keyId 的那把 secret 从未被留存**，所以测试只能断言 16 位十六进制**形态**，无法复现该值 —— 它此前并未真正钉住这个向量，而文档把它读成了「已钉住」。
>
> 现已把测试改名为「derives a 16-hex-char id, which is the shape the real envelopes carry」并在注释里写明它不证明什么；**推导规则**（哈希 base64 串而非解码字节、取 `sha256(key)` 前 16 位十六进制）由它上面的两条测试真正钉住 —— 那两条才是否证得动的。
>
> 若要真正钉住这个向量，需要**连同推导它的一把 secret 一起取样**（或至少记录 `sha256(secret)` 的输入形式）；在那之前，① 仍是**观察记录**，不是**回归守卫**。登记在此，免得下一个人再把它当成守卫。
>
> **2026-10-16 再更正（issue #68 结案，A 档）**：这条「需要连同 secret 一起取样」的待办**已在 macOS 上一台装着两个版本的真机上完成**，三个 keyId 全部对上、且**全部由同一把 secret 推出**。结论与探针见 §2.1。**要点：`keyId` 不是「哪把 key 在加密」的证据** —— 同一个 secret 在不同哈希输入下会给出**三个都合法**的 keyId，而三者互不相等。此前把「exe 报的 keyId ≠ 凭据要求」读成「推导还没定案」，是把身份标识别当成密钥标识用了。
| **D 未验证** | 无任何上述支撑 | —— |

### 2.1 keyId 到底是什么：三值同源，已结案（issue #68，2026-10-16）

**争议**：解密路径上出现三个互不相等的 16 位十六进制值，看起来像「有三把不同的 key，不知道哪把对」：

| 值 | 出现处 |
| --- | --- |
| `9127dea1b44020a7` | 凭据信封**要求**的 `keyId`（`accessToken` / `nickname` / `refreshToken` 全部一致） |
| `c74aaf9df09104a5` | `deriveAtRestKeyId()` 对 `Electron` 进程取回的 payload 算出的值 |
| `66ef584820ad33e7` | 把 `atRestSecretKey` 先 base64 解码、再对**解码字节**做 sha256 得到的值 |

三者不等，于是被读成「protector key 的推导没定案」。**这个读法是错的**，因为三个值来自**同一把 secret**，只是哈希输入不同：

```text
secret = <payload>.atRestSecretKey        （base64 文本，32 字节明文）
key    = sha256(secret as utf8)           ← 插件采用的形式
keyId  = hex(sha256(key))[0..16]
```

- `c74aaf9df09104a5` = `hex(sha256(secret))[0..16]` —— **秘密本身**的摘要，不是 key 的 keyId。它长得像 keyId，所以极易被误认为「另一把候选 key」。
- `66ef584820ad33e7` = `hex(sha256(base64_decode(secret)))[0..16]` —— 对**解码后的字节**做哈希。这是最自然的错误猜法（文档里那句「哈希 base64 串而非解码字节」正是为它写的），但它**不打开任何信封**。
- `9127dea1b44020a7` = `hex(sha256(sha256(secret as utf8)))[0..16]` —— **只有它**能让 GCM 标签通过。

**验证（macOS 真机，`/Applications` 下同时装着两个版本）**：对 `workbuddy-desktop.info`（国内）与 `workbuddy-desktop-ai.info`（国际）的 8 个信封逐一开箱，`nickname` 与 `accessToken` 全部解出；`accounts[].nickname` / `allAccounts[].nickname`（长度 16/16/36 字节，都不是令牌）也一致。**两个区域的文件用同一把 key** —— 区域差别在文件与账户，不在密钥。

**两个此前被当成「另一条加密路径」的东西，都不是**：

- `~/.workbuddy/keyblob` 与 `~/.workbuddy-ai/keyblob` 里的 `keyId`（`1ade3d8d51807afa` / `1d071c4d12239dda`）是**另一个层级**：keyblob 自己的 `keyId` 标识它包裹的那把 data key，而 `slot[0].protectorKeyId` 仍是 `9127dea1b44020a7`（即上面的保护者）。**它们从未出现在凭据链上**，未被也不应被当作凭据 key 的候选。
- keyblob 的 `wrapped`（32 字节密文）与凭据信封的 16/36 字节 `nickname` 不是同一种载荷，混在一张表里会继续生出假候选。

**给下一个人**：判定「哪把 key 对」**不要比 keyId**，要看 GCM 标签是否通过 —— keyId 只是**身份标签**，同一份密钥材料在三种输入形式下有三种合法拼法。要正确定位，跑 `doctor` 拿到的 `atRestDecryption` 只说明**能不能拿到 payload**；`nickname` 是否解出才是**这把 key 对不对**的判据。本机实测的判据链与本节的探针脚本见提交信息（`scripts/` 不入包）。

### A 档取证：§1-5 的控制台闪窗（2026-09-26，Windows 11 22621）

**缺陷**：`src/host-heartbeat.ts` 的 `processStartTimeMs()` 以 `execFileSync('powershell', …, { encoding: 'utf8' })` 启动子进程，**未设 `windowsHide`**；同仓库的 `src/at-rest.ts` 却设了。两处不一致。

**为什么在 macOS / 终端里永远看不到**：Windows 只在**父进程没有控制台**时才给控制台程序子进程新建窗口。终端里父进程有控制台，子进程只是继承——现象不存在。而真实宿主 `DSH NEXT.exe` 是 Electron GUI 进程，实测 `MainWindowHandle = 0`、无控制台，正是会触发的形态。

**复现与判据**（两台父进程形态对照，子进程自报它实际拥有的控制台）：

| 父进程形态 | 不设 `windowsHide` | 设 `windowsHide: true` |
| --- | --- | --- |
| 终端（有控制台） | 继承，无新窗口 | 继承，无新窗口 |
| **WMI 服务创建（无控制台，等价于 GUI 宿主）** | **`NEW-console hwnd=1573500 visible=True`** | `no-console` |

WMI 服务（`Win32_Process.Create`）创建的进程与 Electron 宿主同为「无控制台」形态，因此用它复现不依赖 GUI 交互。子进程用 `kernel32!GetConsoleWindow` + `user32!IsWindowVisible` 自报：`visible=True` 即用户屏幕上真实可见的黑框。

**同时排除的一条错误判据**（避免后人重走）：不能用 `Get-Process powershell | MainWindowHandle` 观察。控制台窗口归 `conhost.exe` 所有，控制台程序自身的 `MainWindowHandle` 是 0，即使窗口正在屏幕上，**该探针也报 0**。

**修法与守卫**：抽出 `PROCESS_PROBE_OPTIONS`（含 `windowsHide: true`）与 `processStartProbe(pid, platform)`，使平台分支与启动选项可在**任意主机**上断言；守卫见 `tests/platform-standing.spec.ts`（两个 spawn 点都必须带 `windowsHide: true`）与 `tests/host-heartbeat.spec.ts`（选项值与平台分支）。**变异验证**：去掉 `windowsHide` → 对应用例变红。

**README 与 CHANGELOG 里的措辞必须与档位相称**：C 档不得写成「已验证」，A 档才可以写「真机实测」。凭据默认路径**现已部分升为 A 档**（本机命中的那两条，见 §7 记录），未命中的候选仍为 C 档——这正是 README「已知限制」里那句「未经真机验证；必要时用 `WORKBUDDY_AUTH_FILE` 指定实际位置」仍然保留的原因。

## 3. 已知的 Windows 专有故障（历史，均已修复）

| 版本 | 现象 | 根因 |
| --- | --- | --- |
| 2.0.6 | CI 在 `windows-latest` 上红 2 例 | 测试读取本机真实登录；`host-heartbeat` 测试在 Windows 上超时（PowerShell 冷启动慢） |
| 2.0.11 | CI 在 `windows-latest` 上红 2 例 | 新增的 darwin 候选断言写死 POSIX 分隔符（**生产代码无辜，错在测试**） |
| 2.0.12 | Windows 上供应商开关会静默复原 | 落盘校验漏了一处（与 #11 同源） |
| issue #11 | Windows 上账号清除「点了没反应」 | profile 配置被占用 → 写入被静默丢弃，而 `set()` 不报错 |
| issue #13 | Windows 上账号切换被判死 | profile 配置瞬时占用超出了重试预算的全部持有期 |
| issue #15 | Windows 上加密凭据读不出 | 探测路径缺 `%LOCALAPPDATA%\WorkBuddy`（用户级安装） |
| 2.1.0（本次） | 宿主内每次进程存活判定都闪一次黑色控制台窗口 | 心跳探测未设 `windowsHide`，而宿主是无控制台的 GUI 进程（§1-5、§2 A 档取证） |
| 未发布（PR #44） | 「重新检测账号」没能把删掉的账号找回来，而界面什么都不说 | 隐藏名单删除被拒时异常被吞掉（`rm` 的 `force` 不忽略 `EPERM`）——详见下节（B 档） |
| 未发布（PR #44 追加） | `tests/windows-file-lock.spec.ts` 在真机上恒红，而 CI 恒绿 | **测试自身的清场竞态**（不是产品缺陷）：`kill()` 只投递信号，内核关闭句柄在其后数毫秒，此窗口内 `rm` 必得 `EBUSY`——详见下节 |
| 4.10.1（issue #77 第二轮） | 打开设置页要等 60 s；CPU profile 里 19.1 s 的请求有 15.3 s 在 `spawnSync`（约 135 个 `reg query`） | 字段密钥的探测**只缓存成功**，且共享扫描窗口从**开始**时刻计窗——两个乘数叠在 `scanAll()` 的逐文件探测上（§1-6）。**根因跨平台**，Windows 只是把重复探测换成了同步子进程，才变成 60 秒 |
| 5.5.0（PR #116，阻断级） | `codebuddy` CLI 的自动探测在 Windows 上 **100% 失败**，只能手填 `cliBridge.binary` | CLI 候选清单把**每个**根目录都拼上 `lib/node_modules`，而 Windows 的 npm 全局前缀 `%APPDATA%\npm` 下包直接落在 `<prefix>\node_modules`、**没有 `lib` 层**，9 条候选全部落空。CI 未拦住是因为 runner spec 里当时**没有任何**针对 `cliEntryCandidates()` 的断言（绿的是测试，坏的是真机）。修法：每个根目录自带自己的布局，并补上 pnpm / yarn / fnm 的 Windows 默认仓位置（C 档：本机只实测了 npm 那条） |

### 「重新检测账号」的静默失败（PR #44，**B 档 CI 实测**）

**现象**：用户删掉一个账号（语义是「暂时隐藏」，文案承诺「点重新检测账号即可找回」），随后点「重新检测账号」——账号**没有回来**，界面**没有任何提示**，按钮看起来像成功了。

**根因**：`clearDismissals` 把「清空隐藏名单」写成 `rm(path, { force: true })` 外面套一个吞掉异常的 `catch`。`force` 只忽略 `ENOENT`（文件不存在），**不忽略拒绝**。POSIX 的 `unlink` 对另一个进程持有的打开文件照样成功，所以 macOS/Linux 看不出问题；Windows 上杀毒扫描器 / OneDrive / 编辑器持有句柄时返回 `EPERM`/`EBUSY`/`EACCES`（与 issue #11、#13 同一类占用，`isFileContentionWriteError` 就是为分类它而存在）。`catch` 又把它吞掉，于是失败在用户侧表现为「按钮没反应」。

**为什么这条必须进 §3**：它是本文件反复描述的那个形态的又一例——**静默**（不报错、只是没生效）且**只在 Windows 上出现**。

**修法**：unlink 被拒时回退为「经同一把锁原子写入空名单」（对任何读者而言两种结果等价，`readDismissed` 都得到空集合），并把结果**读回来验证**后返回布尔值；路由把 `dismissalsCleared` 转给卡片；卡片新增账户级错误行（`role="alert"`）如实显示——该状态此前只被写入、从未渲染。

**证据档位：B 档（CI 实测），不是 C 档约定推导。** 关键区别在于**占用是真的由操作系统造成的**，不是注入一个假异常：

- `tests/windows-file-lock.spec.ts` 用 PowerShell 的 `[System.IO.File]::Open($path, 'Open', 'Read', 'Read')` 真占住 `.dismissed.json`，再断言 `clearDismissals()` 返回 `false` 且账号保持隐藏；释放后同一调用转为成功。该文件只在 Windows 上运行，其余平台 skip（`FileShare` 没有 POSIX 等价物，macOS/Linux 上 unlink 对打开的文件照样成功，没有可断言的失败）。
- **变异验证（在 `windows-latest` 上真跑）**：把 `clearDismissals` 还原成「裸 `rm` + 吞异常、恒返回 `true`」，该文件 **2 例全红**，报错正是 `expected true to be false`——静默成功这个缺陷本身在真实 Windows 上复现并被咬住。还原修复后重新全绿。
- `FileShare::Read` 是被刻意选中的共享模式（不是 `FileShare::None`）：读仍能成功，所以隐藏**确实仍然生效**，`false` 是诚实答案而非保守猜测。若换成 `FileShare::None`，连读都失败，`readDismissed` 会走「无隐藏」分支、账号自己就回来了，反倒没有可报的失败——这两种模式**相反**的后果见 `tests/dismissal-clear-failure.spec.ts` 里 `both` 与 `write-blocked-read-ok` 两个模式。

未升 A 档的原因：这是 `windows-latest` 虚拟机上的 CI 取证，不是用户真机（未覆盖「某个具体杀毒软件实际持有句柄」的行为）。按 §2 的定义，CI 实测即 B 档；若你在真机上复现出与 CI 不同的形态，欢迎回报以便继续升档。

### 收尾阶段的同一种占用：`kill()` 不等于句柄已释放（PR #44 追加）

**现象**：`tests/windows-file-lock.spec.ts` 在一台 Windows 真机上**每次都红**，而同一提交在 CI 的 `windows-latest` 上**每次全绿**。报错是 `EBUSY: resource busy or locked, unlink '…\.dismissed.json'`。

**为什么它不是产品缺陷（先排除，再动手）**：报错发生在 `afterEach` 的清场里，**测试体内的断言一条都没失败**——`clearDismissals()` 仍如实返回 `false`、账号仍保持隐藏。文件被删不掉，是**测试自己还握着那个句柄**。把这个形态误当成产品 bug 去改 `clearDismissals`，会把一个正确的实现改坏。

**根因**：`kill()` 是**投递**信号，不是等待进程结束。该进程持有的 `FileShare.Read` 句柄由内核在其后数毫秒才关闭，而紧跟的 `rm` 已经走到 `unlink` 了。本机实测：`rm` 在 `kill()` 返回后 **1ms** 就到达 `unlink`，句柄直到 **~9ms** 才释放——窗口内 8/8 全红；而**盲等 50ms 后同样的裸 `rm` 8/8 全绿**，这条对照证明缺的只是时间，与删什么东西无关。

**为什么 CI 绿而真机红**：这是**竞态**，胜负取决于 `rm` 走到 `unlink` 用了多久。慢 runner（冷启动、遍历临时目录更久）常常在窗口之外才到达 `unlink`，于是恒绿；快机器反而恒红。**「CI 绿」因此不能否证本机红**，反之亦然——两个方向的推断都不成立。

**修法**：`afterEach` 改为 `await` **进程真正 `exit`** 之后再 `rm`（等的是这个清场所需的条件，不是一个够长的常数），并保留 `rm` 自身的重试预算作为第二层。同一文件第二个用例里原先的 `setTimeout(1500)` 一并换成同一个等待——**那个盲等正是同一竞态被掩盖的地方**（一个用例靠 1.5s 蒙对，另一个没蒙，于是只有后者暴露）。换掉之后该用例耗时从 7782ms 降到 1615ms：等待条件比猜时间既更准也更快。

**变异验证（本机真跑）**：把 `afterEach` 还原成「裸 `kill()` + 立即 `rm`」→ 立刻复现 `EBUSY`，与原始故障逐字一致；恢复修复后 6/6 连续通过。**这条守卫只保护测试自身**：它不会因为产品代码回退而变红（产品侧由 `tests/dismissal-clear-failure.spec.ts` 的注入式用例与上文那条变异验证负责）。

**推论（写给后人）**：凡是「起子进程占住文件 → 杀了它 → 立刻清场」的测试，都要 `await` 退出事件，而不是假定 `kill()` 已经把文件还回来了。本仓库目前只有本文件起子进程占文件；新增同类测试时照此办理。

**共同形态**：Windows 的故障几乎都是**静默**的（不报错、只是没生效），且**只在 Windows 上出现**。因此 Windows 相关的修复必须配「可被变异咬住」的测试，否则回归无人拦。

**关于 issue #13 重试预算的更正**：本文件此前写作「重试预算（200+600ms）」。实测并核对上游实现（`@deepseek-ai/dsh-atomic-write`，rc.1 与 rc.2 常量相同：initial 20ms、max 200ms、limit 8）后，真实预算是**延迟序列 20+40+80+160+200×4 ≈ 1100ms**（实测端到端 1149–1165ms，含 `rename` 调用开销）；**不存在 600ms 这一项**。真机实测的持有期-结果对照：持有 0/100/300/600/1000ms 后释放 → 全部成功；持有 60s（超出预算）→ `EPERM`，且目标文件**保持原内容不变**（不产生半写文件）。

**同一预算的第二份实现（issue #47，4.3.2）**：`src/host-peers.ts` 现在带一份后备的 `writeFileAtomic` / `withFileLock`，用于**宿主之外**（`dsh plugin … exec` 的子进程里 peer 解析不到时）。它把上文的四个常量（initial 20 / max 200 / limit 8）与 Windows 瞬时错误集合（`EACCES`/`EBUSY`/`EPERM`）**逐字转写**过来——两份实现若预算不同，同一个文件上 CLI 与宿主就会按不同节奏争锁，「谁先拿到」将取决于进程身份而不是锁本身。**平台语义与 §1-4 完全一致**：`isTransientWindowsRenameError` 同样在 `process.platform !== 'win32'` 时短路，因此 macOS/Linux 上这份后备同样**不进重试分支**。宿主在场时（宿主内、以及含 peer 的检出里）压根不会走到这份后备，改动它不影响已取证路径；改动**上游**那份时，这条要一起核对。守卫：`tests/host-peers.spec.ts` 钉住锁的互斥性与释放（含异常路径），但**不钉具体毫秒数**——预算是上游的行为契约，不是本插件的可调参数。

## 4. 改动检查清单（改任何平台相关代码前过一遍）

- [ ] 路径是否全部经 `path.join`？有无写死 `/` 或 `\`？
- [ ] 新增的环境变量是否处理「未设置」**与**「空白串」两种回落？（Windows 上企业策略可能设成空串）
- [ ] 若涉及文件写入：Windows 上可能被占用，是否需要回读校验？
- [ ] 若走外部命令：Windows 上有无等价物？（`ps -o lstart=` → PowerShell；`which` → `where`）
- [ ] **若 spawn 子进程：是否设了 `windowsHide: true`？** 宿主无控制台，漏设即闪黑框（§1-5）。注意**在终端里验证不出来**——那种形态下子进程只是继承控制台
- [ ] **若测试起子进程占住文件：清场前是否 `await` 了它的 `exit`？** `kill()` 只投递信号，句柄在其后数毫秒才关闭；此窗口内 `rm` 必得 `EBUSY`（§3 末）。窗口是竞态，**CI 绿不代表真机绿**
- [ ] **若改动 `src/host-peers.ts` 的后备实现：是否与上游 `@deepseek-ai/dsh-atomic-write` 的锁命名、Windows 瞬时错误集合与重试节奏仍一致？** 两份实现按同一预算争同一个 `.lock`，任一侧漂移都会让「谁先拿到锁」取决于进程身份（§3 末的「同一预算的第二份实现」）
- [ ] 新增测试是否**在任意主机上都能跑**（注入 `platform`/`home`/`env`），而不是断言「跑测试的机器是什么平台」？
- [ ] 结论措辞是否与§2 的证据档位相称？（C 档不要写成「已验证」）
- [ ] 本文件与两份 README 是否同步？

## 5. 相关位置索引

| 内容 | 位置 |
| --- | --- |
| CI 矩阵（含 `windows-latest`） | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) |
| 凭据目录推导与测试 | `src/auth.ts` `defaultDesktopAuthDirs()`；`tests/auth.spec.ts` |
| 可执行文件候选与测试 | `src/at-rest.ts` `workbuddyAppExecutableCandidates()`；`tests/at-rest.spec.ts` |
| 心跳时间戳与测试 | `src/host-heartbeat.ts` `processStartTimeMs()` / `processStartProbe()`；`tests/host-heartbeat.spec.ts` |
| 子进程启动选项（`windowsHide`）与测试 | `src/host-heartbeat.ts` `PROCESS_PROBE_OPTIONS`、`src/at-rest.ts` `fetchAtRestKeyPayload()`；`tests/platform-standing.spec.ts`、`tests/host-heartbeat.spec.ts` |
| 字段密钥探测的缓存与注册表子进程计数 | `src/at-rest.ts` `readAtRestKey()` / `clearAtRestKeyCache()`、`SCAN_SHARE_WINDOW_MS`（`src/auth.ts`）；`tests/issue77-at-rest-key-cache.spec.ts` |
| 真机文件占用取证与测试自身清场 | `tests/windows-file-lock.spec.ts`（`kill()` 后必须 `await` `exit` 再 `rm`，见 §3 末） |
| 写入回读校验与测试 | `src/client/account-selection.ts`；`tests/client-account-selection.spec.ts` |
| 设置隔离（供测试） | `vitest.config.ts`（`LOCALAPPDATA` / `APPDATA` / `HOME` / `USERPROFILE` / `XDG_CONFIG_HOME`） |
| 诊断脚本的跨平台写法 | `scripts/verify-dsml.mjs`：用 Node 读源码代替 `grep`（Windows 上没有 `grep`，而 `tryExec` 会吞掉失败，于是「工具缺失」会伪装成「没找到」）；仓库根用 `fileURLToPath` 而不是 `new URL(...).pathname`（后者在 Windows 上给出 `/C:/...`，任何 fs 调用都不接受） |

## 6. 尚未做的（如实登记）

- **凭据默认路径只在真机上命中了本机形态**（部分 A 档、部分 C 档）。2026-09-26 在真实 Windows 11 上复核：`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth` 命中且 `%APPDATA%` 下不存在（`doctor` 的 `desktopAuthFile.present: true`、`candidates` 两条按实际环境变量拼接）；可执行文件候选只命中了 `%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe`。**其余候选（`%LOCALAPPDATA%\WorkBuddy`、两个 `Program Files`、`%APPDATA%` 凭据目录）仍属 C 档**，只有单元测试钉住。若你的机器是别的形态（尤其 `E:\WorkBuddy\...` 这类自定义目录），欢迎回报现场。
- **issue #13 的 Windows 专用复现探针不在 `main` 上**。它作为 `scripts/probe-issue13-windows.mjs` 加在提交 `1b8bc7f`，该提交位于分支 `fix/0.1.7-forward-compat`（**非 HEAD 祖先**）。若今后需要在真机上量化重试预算是否够用，从该分支取用，或按需要重新引入。预算的真实数值已更正如 §3 末。
- **无 Windows 真机 CI 之外的手工验收**：桌面 App 的登录态复用、卡片在 Windows 上的实际渲染，目前只有用户回报，没有维护者一侧的系统性验收。下面的 §7 就是为补这一项写的。

## 7. 在 Windows 真机上验证（操作手册）

**为什么需要手工验证**：CI 的 `windows-latest` 能覆盖跨平台正确性（B 档），但覆盖不到「真实 WorkBuddy 桌面 App 在场」这件事——CI 机器上没有登录着的 App、没有加密凭据、没有杀毒软件锁文件。§1 的五处分支里，1、2、4、5 都需要真机才能验到 A 档（第 5 条尤其：CI 的无头 Windows 上父进程本来就没有控制台，但 CI 不会去断言「屏幕上没多出窗口」）。

### 7.0 本仓库已完成的真机取证记录（2026-09-26）

一次已执行的现场记录，供后人对照，不必重复：

| 项 | 结果 | 结论 |
| --- | --- | --- |
| `doctor --json` | `desktopAuthFile.present: true`；`atRestDecryption.available: true`；`hostHeartbeat.processAlive: true`；`regions.cn` 2 个账号 | §1-1 / §1-2 / §1-3 在本机形态下**真机通过** |
| 凭据加密 | `workbuddy-desktop.info` 的 `nickname` / `phoneNumber` / `accessToken` 均为 `$wbEncrypted` 信封，`keyId` = `9127dea1b44020a7` | 与固定向量**逐字一致** |
| App 可执行文件 | 命中 `%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe`；`ELECTRON_RUN_AS_NODE` 通路返回 `v22.21.1` | §1-2 的探测与取密钥通路**真机通过** |
| 心跳时间戳 | PowerShell 输出 `2026-09-26T04:03:00.9358345Z`（7 位小数），`Date.parse` → `1790395380935` 有限值 | §1-3 的输出格式与解析**咬合** |
| PID 存活探测 | `process.kill(pid, 0)`：本进程未抛错；不存在的 PID → `ESRCH` | 存活判定可用 |
| §1-5 控制台闪窗 | 无控制台父进程下：不设 `windowsHide` → `NEW-console visible=True`；设了 → `no-console` | **缺陷已复现并修复** |
| 构建与套件 | `typecheck` / 368 例测试 / `build` 全绿；`npm pack --dry-run` 18 个文件 | 本机为 Windows，故 CI 双平台中的 Windows 一侧在真机复算 |

仍未在本机验证的：§7.3 的**锁文件场景**（需要杀毒软件 / 同步盘 / 编辑器同时在场，无法在无干扰环境里制造）；以及自定义安装目录形态。

### 7.1 先跑 `doctor`（一次拿全四项证据）

```powershell
dsh plugin --profile desktop exec dsh-connect-workbuddy doctor --json
```

JSON 里有四个字段直接对应 §1 的分支，对照下表读：

| 字段 | 期望 | 若不符 → 指向 |
| --- | --- | --- |
| `desktopAuthFile.present` | `true` | §1-1 凭据目录分支。同时看 `desktopAuthFile.dir` 与 `candidates`：`dir` 是**实际选中**的目录，`candidates` 是**探测过**的全部候选。若 `present:false` 而目录里确有文件，多为文件名或目录名与预期不符 |
| `atRestDecryption.available` | `true`（凭据已加密时必须有） | §1-2 可执行文件候选。`appExecutable` 为 `(not found; set WORKBUDDY_APP_EXECUTABLE)` 说明四个候选都没命中 |
| `hostHeartbeat.processAlive` | `true`（宿主在跑时） | §1-3 心跳分支；`hostHeartbeat.registeredAt` / `pid` 用于比对 |
| `regions.cn[].source` / `regions.global[].source` | 至少一个区域有账号 | 凭据读取整体失败 |

**若 `dsh` 不在 PATH**（桌面版可能不带 CLI）：可直接执行包内的 CLI，效果等价：

```powershell
node <插件目录>\lib\bin.js doctor --json
```

**手工确认凭据目录**（用于判定「探测结果 vs 实际位置」）：

```powershell
dir "$env:LOCALAPPDATA\CodeBuddyExtension\Data\Public\auth"
dir "$env:APPDATA\CodeBuddyExtension\Data\Public\auth"
```

**手工确认 App 位置**（判定四个候选为何全空）：

```powershell
Get-Process *orkbuddy* -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path
```

自定义安装目录（如 `E:\WorkBuddy\WorkBuddy.exe`）四个候选都探不到——这是**已知的**，设 `WORKBUDDY_APP_EXECUTABLE` 指向该 exe 即可：

```powershell
[Environment]::SetEnvironmentVariable('WORKBUDDY_APP_EXECUTABLE','E:\WorkBuddy\WorkBuddy.exe','User')
# 重启 DSH，并让跑命令的终端也继承（新开的终端会自动继承用户级变量）
```

### 7.2 验 §1-1：重定向配置文件（仅当你的 `%LOCALAPPDATA%` 被重定向时需要）

企业策略或 OneDrive 文件夹备份会把 `%LOCALAPPDATA%` 指到别处。代码的意图是「env 优先，未设才回落 `<home>\AppData`」。验证：

```powershell
echo $env:LOCALAPPDATA
echo $env:APPDATA
```

两者都非空时，`doctor` 的 `desktopAuthFile.candidates` 应当**由它们的实际值拼接**，而不是 `C:\Users\<你>\AppData\Local`。若你的环境恰好是「变量为空」的形态（少见），候选才应回落到 home 推导值。

### 7.3 验 §1-4：设置写入的瞬时占用（**这是最值得实测的一项**）

**为什么最值得**：这个故障是 Windows 独有的，且在 macOS 上**不可能复现**（`atomic-write` 的 rename 重试被 `process.platform !== 'win32'` 短路）。它也是唯一会**静默丢数据**的一项。

步骤：

1. 打开 DSH 插件卡片，展开 WorkBuddy 设置区。
2. 用一个能持有文件句柄的工具锁住**当前 profile 的配置文件**（PowerShell 的 `[IO.File]::Open` 最直接）。

   **注意文件名**：0.1.7 线上配置文档是 profile 目录下的 **`cordis.patch.yml`**（`config-editor` 的 `documentPath`；易失字段也经同一条 `edit()` 落在这里）。**不是 `settings.yaml`**——那个文件在 0.1.7 上只用于一次性导入旧版本配置，导入后即改名为 `settings.yaml.imported`。锁错文件会验不出任何东西。

```powershell
# 另开一个 PowerShell 窗口，按住 profile 配置文件不放（按任意键释放）
$dsh = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
# 用你实际使用的 profile 名替换 desktop（web / dsh-tui 同理）
$p = Join-Path $dsh 'profiles\desktop\cordis.patch.yml'
if (-not (Test-Path $p)) {
  Write-Host "找不到 $p —— 先列出实际存在的 profile："
  Get-ChildItem (Join-Path $dsh 'profiles') -Directory | Select-Object -ExpandProperty FullName
  return
}
$fs = [IO.File]::Open($p,'Open','Read','None')
Write-Host "holding $p — 现在去卡片里改账号，然后按任意键释放"
$null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
$fs.Close()
```

3. 在持有期间，于卡片里**切换账号**或**清除账号**。
4. **期望**：出现明确错误提示（写入未落盘），且**原来的选择仍然生效**——绝不能显示「已清除」或新账号却实际没保存。
5. 释放句柄后重试，应当成功落盘。

**只读判定**：重新打开卡片或重跑 `doctor`，看 `regions.<区域>[].selected` 是否与你刚做的选择一致。**不一致却没有任何错误提示**，就是本项失败——请把场景回报（这正是 issue #11 的形态）。

### 7.4 验 §1-2 / §1-3 的边界

- **加密凭据**（§1-2）：若 `desktopAuthFile.present:true` 而账号数为 0，且 `atRestDecryption.available:false`，说明凭据是加密的但取不到密钥。设好 `WORKBUDDY_APP_EXECUTABLE` 后重跑 `doctor`，`available` 应变为 `true`，账号应出现。
- **心跳**（§1-3）：PowerShell 冷启动较慢（CI 上曾因此超时）。若 `hostHeartbeat.processAlive:false` 而宿主进程确实在跑，请在报告中附上 `Get-Process -Id <doctor 报的 pid> | Select-Object StartTime` 的输出——那是 PID 复用判定所依赖的值。

### 7.5 回报时请附（便于把结论升到 A 档）

```powershell
dsh plugin --profile desktop exec dsh-connect-workbuddy doctor --json
node -v
$PSVersionTable.PSVersion
```

外加：你的 Windows 版本（`winver`）、WorkBuddy 桌面 App 版本、`%LOCALAPPDATA%` 与 `%APPDATA%` 的实际值、以及 §7.3 的结果。**附上这些，§2 里那些 C 档结论就能升为 A 档**；`docs/WINDOWS.md` 与 README 的措辞也随之更新。

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

## 1. 四个 Windows 专属分支

改动这四处中的任何一处，都要考虑 Windows。

| # | 位置 | Windows 行为 | 若改错会怎样 |
| --- | --- | --- | --- |
| 1 | `src/auth.ts` `defaultDesktopAuthDirs()` | `%LOCALAPPDATA%` / `%APPDATA%` **优先**，未设或为空白串时回落 `<home>\AppData`（`Local` / `Roaming` 两个候选） | 重定向配置文件（OneDrive 文件夹备份、企业策略）的机器读不到凭据 → 显示未登录 |
| 2 | `src/at-rest.ts` `workbuddyAppExecutableCandidates()` | 按 `WorkBuddy.exe` 探四个位置：`%LOCALAPPDATA%\Programs\WorkBuddy`、`%LOCALAPPDATA%\WorkBuddy`、`%ProgramFiles%\WorkBuddy`、`%ProgramFiles(x86)%\WorkBuddy` | 装在自定义目录（如同源 issue 里的 `E:\WorkBuddy\WorkBuddy.exe`）的机器取不到字段密钥 → 加密凭据读不出 |
| 3 | `src/host-heartbeat.ts` `processStartTimeMs()` | 走 PowerShell `Get-Process` 的 `StartTime`，以 UTC ISO 8601 输出供 `Date.parse` 解析 | PID 复用判定失准 → 心跳误判宿主存活 |
| 4 | 设置写入回读校验（`src/client/account-selection.ts`） | 写入后**回读校验**：profile 的 `cordis.patch.yml` 被占用会让 rename 覆盖失败，而 `set()` 的 promise 仍 resolve | 用户看到假确认（显示「已清除」但没落盘）→ issue #11 |

**通用注意**：路径一律经 `path.join` 构造，**不得写死 POSIX 分隔符**。历史上正因此挂过 CI——`2.0.11` 新增的 darwin 候选断言写死了 `/Applications/WorkBuddy.app/...`，生产代码没问题（用 `join`），错的是测试：它断言的是「跑测试的机器是 POSIX」而非「候选列表对不对」，于是 Windows 必挂、macOS 恒绿。现有回归守卫：候选路径不得**混用**分隔符。

## 2. 证据分级（写结论时必须用对档位）

| 档位 | 含义 | 实例 |
| --- | --- | --- |
| **A 真机取证** | 在真实 Windows 上取得，可作为最终判据 | `tests/at-rest.spec.ts` 里固定向量 `keyId=9127dea1b44020a7`，**采自真实 Windows 安装**；issue #13 报告的 `E:\WorkBuddy\WorkBuddy.exe` |
| **B CI 实测** | `windows-latest` 上跑过，覆盖跨平台正确性 | 套件全绿；`tests/auth.spec.ts` 的 `win32` 分支断言（注入 `platform`/`home`/`env`，**任何主机上都能跑**） |
| **C 约定推导** | 按平台约定写出 + 单元测试钉住，**未在真机逐项验证** | 四个凭据/可执行文件候选路径本身 |
| **D 未验证** | 无任何上述支撑 | —— |

**README 与 CHANGELOG 里的措辞必须与档位相称**：C 档不得写成「已验证」，A 档才可以写「真机实测」。当前**凭据默认路径属 C 档**——这正是 README「已知限制」里那句「未经真机验证；必要时用 `WORKBUDDY_AUTH_FILE` 指定实际位置」的由来。

## 3. 已知的 Windows 专有故障（历史，均已修复）

| 版本 | 现象 | 根因 |
| --- | --- | --- |
| 2.0.6 | CI 在 `windows-latest` 上红 2 例 | 测试读取本机真实登录；`host-heartbeat` 测试在 Windows 上超时（PowerShell 冷启动慢） |
| 2.0.11 | CI 在 `windows-latest` 上红 2 例 | 新增的 darwin 候选断言写死 POSIX 分隔符（**生产代码无辜，错在测试**） |
| 2.0.12 | Windows 上供应商开关会静默复原 | 落盘校验漏了一处（与 #11 同源） |
| issue #11 | Windows 上账号清除「点了没反应」 | profile 配置被占用 → 写入被静默丢弃，而 `set()` 不报错 |
| issue #13 | Windows 上账号切换被判死 | profile 配置瞬时占用 + 重试预算（200+600ms）覆盖不到的持有期 |
| issue #15 | Windows 上加密凭据读不出 | 探测路径缺 `%LOCALAPPDATA%\WorkBuddy`（用户级安装） |

**共同形态**：Windows 的故障几乎都是**静默**的（不报错、只是没生效），且**只在 Windows 上出现**。因此 Windows 相关的修复必须配「可被变异咬住」的测试，否则回归无人拦。

## 4. 改动检查清单（改任何平台相关代码前过一遍）

- [ ] 路径是否全部经 `path.join`？有无写死 `/` 或 `\`？
- [ ] 新增的环境变量是否处理「未设置」**与**「空白串」两种回落？（Windows 上企业策略可能设成空串）
- [ ] 若涉及文件写入：Windows 上可能被占用，是否需要回读校验？
- [ ] 若走外部命令：Windows 上有无等价物？（`ps -o lstart=` → PowerShell；`which` → `where`）
- [ ] 新增测试是否**在任意主机上都能跑**（注入 `platform`/`home`/`env`），而不是断言「跑测试的机器是什么平台」？
- [ ] 结论措辞是否与§2 的证据档位相称？（C 档不要写成「已验证」）
- [ ] 本文件与两份 README 是否同步？

## 5. 相关位置索引

| 内容 | 位置 |
| --- | --- |
| CI 矩阵（含 `windows-latest`） | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) |
| 凭据目录推导与测试 | `src/auth.ts` `defaultDesktopAuthDirs()`；`tests/auth.spec.ts` |
| 可执行文件候选与测试 | `src/at-rest.ts` `workbuddyAppExecutableCandidates()`；`tests/at-rest.spec.ts` |
| 心跳时间戳与测试 | `src/host-heartbeat.ts` `processStartTimeMs()`；`tests/host-heartbeat.spec.ts` |
| 写入回读校验与测试 | `src/client/account-selection.ts`；`tests/client-account-selection.spec.ts` |
| 设置隔离（供测试） | `vitest.config.ts`（`LOCALAPPDATA` / `APPDATA` / `HOME` / `USERPROFILE` / `XDG_CONFIG_HOME`） |

## 6. 尚未做的（如实登记）

- **凭据默认路径未经真机逐项验证**（C 档）。有单元测试钉住两种回落，但未在真实 Windows 上逐项确认。若你愿意回报现场，请附 `dir "%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth"` 与 `dir "%APPDATA%\CodeBuddyExtension\Data\Public\auth"` 的输出。
- **issue #13 的 Windows 专用复现探针不在 `main` 上**。它作为 `scripts/probe-issue13-windows.mjs` 加在提交 `1b8bc7f`，该提交位于分支 `fix/0.1.7-forward-compat`（**非 HEAD 祖先**）。若今后需要在真机上量化重试预算是否够用，从该分支取用，或按需要重新引入。
- **无 Windows 真机 CI 之外的手工验收**：桌面 App 的登录态复用、卡片在 Windows 上的实际渲染，目前只有用户回报，没有维护者一侧的系统性验收。下面的 §7 就是为补这一项写的。

## 7. 在 Windows 真机上验证（操作手册）

**为什么需要手工验证**：CI 的 `windows-latest` 能覆盖跨平台正确性（B 档），但覆盖不到「真实 WorkBuddy 桌面 App 在场」这件事——CI 机器上没有登录着的 App、没有加密凭据、没有杀毒软件锁文件。§1 的四处分支里，1、2、4 都需要真机才能验到 A 档。

**准备**：一台装有 WorkBuddy 桌面 App 并**已登录**的 Windows 机器；DSH 已安装。全程只读的部分不会改动你的账号状态。

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

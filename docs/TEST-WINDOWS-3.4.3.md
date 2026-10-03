# Windows 真机验证：3.4.3

本版把两个社区 PR 的修复直接落进主干，**其中 #27 的注册表回退只在 Windows 上生效**（macOS 无法验证），因此必须有一轮 Windows 真机验证。

改动一共两件事，验证也分成两轮。**A 轮是主菜**（新功能），B 轮是顺手确认。

---

## 结果速览（2026-10-03 真机一轮）

一台 Windows 机器按本手册跑过一轮，结论如下。**A 轮的核心判据没有达成**，所以「注册表回退」至今**未经真机验证**——这份记录是为了避免日后被误读成已验证。

| 检查项 | 结果 |
| --- | --- |
| 版本号 | ✅ `WorkBuddy Connect 3.4.3` |
| `doctor` 来源字段 | ✅ 显示 `via default-layout` |
| 凭据读取 / 宿主加载 | ✅ `present` / `running (pid 27700)` |
| A 轮核心：`via registry` | ❌ **未触发**（见下） |
| `pnpm run check` | ✅ 870 全绿、typecheck 干净、build 成功 |
| CI（ubuntu + windows） | ✅ 双绿 |
| B 轮：403 策略拒绝 | ⏸️ 无法主动构造，未观测 |

### 为什么 `via default-layout` 不等于验证通过

那台机器上 App 装在标准路径，于是 `findWorkbuddyAppExecutableWithSource()` 在**候选循环里就提前 `return` 了**，`platform === 'win32'` 那段查注册表的代码**一次都没执行**：

```
via default-layout  → 证明「来源字段能显示」
via registry        → 才证明「回退能工作」
```

前者只覆盖到新加的**报告**字段，没有覆盖新加的**功能**。方向恰好相反：这次验证的环境（标准路径）与这个功能要解决的场景（非标准路径）正好互补。

### 要真正验证 A 轮，需要让默认路径全部落空

最小可逆做法：把 `%LOCALAPPDATA%\Programs\WorkBuddy` 临时改名 → 跑 `doctor`（此时必须靠注册表，期望 `via registry`）→ **立刻改回**。注意改名期间 WorkBuddy 桌面端本身不可用，第三步别忘。

### 已知未覆盖

- 注册表回退的端到端行为（三个 hive 的遍历、`DisplayIcon` / `InstallLocation` 的解析）**只由单元测试覆盖**，无真机证据。
- 非默认安装（如 `E:\`、`F:\`）从未在真机上跑过——而 issue #30 报告的正是这类环境。
- 因此 3.4.3 的注册表回退**不能宣称已真机验证**；它是「CI 双绿 + 单元测试 + 已在 macOS 上确认不会误触发」，仅此而已。

---

## 0. 准备

```powershell
# 1) 装包（在本文件所在目录，或把 tgz 拷到 Windows 后 cd 进去）
dsh plugin --profile desktop add .\dsh-connect-workbuddy-3.4.3.tgz

# 2) 重启 DSH 进程（bundle 换版后必须重启）

# 3) 确认版本与健康度
dsh-connect-workbuddy doctor
```

`doctor` 第一行应是 `WorkBuddy Connect 3.4.3 on ...`。

---

## A 轮：注册表回退（新功能）

**验证目标**：App 装在**非默认目录**时，插件不再报「未登录」。

### A0. 先确认你属于哪种情况

```powershell
# 注册表里登记的路径
reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall" /s /f WorkBuddy /t REG_SZ 2>$null | Select-String "DisplayIcon|InstallLocation"
reg query "HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall" /s /f WorkBuddy /t REG_SZ 2>$null | Select-String "DisplayIcon|InstallLocation"

# App 实际在哪
Get-Process WorkBuddy -ErrorAction SilentlyContinue | Select-Object Path
```

- 若 `DisplayIcon` 形如 `D:\xxx\WorkBuddy.exe,0` → **你就是目标场景**，重点做 A1。
- 若 App 就装在 `%LOCALAPPDATA%\WorkBuddy` 等四个默认位置 → 属于 A2 的对照组，做 A2。

### A1. 非默认目录场景（核心）

**先制造「修之前会失败」的现场**：确保**没有**设置环境变量 `WORKBUDDY_APP_EXECUTABLE`。

```powershell
echo $env:WORKBUDDY_APP_EXECUTABLE      # 必须为空
```

然后：

```powershell
dsh-connect-workbuddy doctor
```

**要看到的结果**：

```
Encrypted-credential support: available (<你的实际路径>\WorkBuddy.exe, via registry)
```

- `available` —— 能力可用
- `via registry` —— **这一条最关键**，说明路径是查注册表得到的，而不是默认布局命中

`--json` 形式：

```powershell
dsh-connect-workbuddy doctor --json | ConvertFrom-Json | Select-Object -ExpandProperty atRestDecryption
```

应得到 `appExecutable` / `appExecutableSource: registry` / `available: true`。

**再确认账号真的读出来了**（这才是用户看到的结果）：

```powershell
dsh-connect-workbuddy status
```

应列出你**当前登录**的账号，且**不是**旧账号、不是一串 uin 数字。

> 回归确认（可选但推荐）：设 `$env:WORKBUDDY_APP_EXECUTABLE="<实际路径>"` 再跑 `doctor`，应变成 `via env`；然后 `Remove-Item Env:\WORKBUDDY_APP_EXECUTABLE` 恢复。

### A2. 默认布局对照组

App 装在默认位置时，**不应**去查注册表（零开销）：

```powershell
dsh-connect-workbuddy doctor --json | ConvertFrom-Json | Select-Object -ExpandProperty atRestDecryption
```

**要看到** `appExecutableSource: "default-layout"`（**不是** `registry`）。这条证明回退确实只在前面四个候选全落空时才触发。

### A3. 容错：注册表指向不存在的文件

若你愿意做破坏性测试（**建议先在虚拟机/可恢复的机器上**）：把 App 目录改名，让注册表指向一个已不存在的路径，然后 `doctor`。

**要看到**：`available: false`，且提示里说明「Windows 上已经查过安装注册表」，**不能崩溃**。

---

## B 轮：403 策略拒绝（顺手确认）

**验证目标**：服务端内容策略拒绝时，不再被说成「登录坏了」。

这条**无法主动构造**（要真的触发服务端审核），所以只做**不回归**的确认：正常聊天必须照常工作，错误路径的形态用单元测试已覆盖。

```powershell
# 正常请求应当正常返回（这一条是「没改坏」的确认）
dsh-connect-workbuddy status        # 账号与模型正常列出
```

然后在 DSH 里**正常发一条消息**，确认能拿到回复。

如果你**恰好**遇到 403 内容策略拒绝，要看到的是：

- **不再是** 引导重新登录的 AUTH 提示
- 消息里带服务端**官方文案**（如「内容未通过安全审核，请调整后重试。」）+ `code 11140` + `requestId`
- 明确写着「重新登录不会解决」

复制那条报错原文给我即可。

另外确认账号池没有因此变红：

```powershell
dsh-connect-workbuddy status        # 账号不应被标成「不可用」
```

（修之前 `policy-rejected` 会把账号**永久**踢出池子，这是本轮顺带修掉的连带问题。）

---

## 请回报的内容

按下面这份清单贴回来，有异常就带上原始输出：

| # | 项目 | 期望 | 实际 |
| --- | --- | --- | --- |
| 1 | `doctor` 版本行 | `3.4.3` | |
| 2 | A0 `DisplayIcon` 路径 | 你的实际安装路径 | |
| 3 | A1 `via registry` | 出现 | |
| 4 | A1 `status` 账号 | 当前登录账号，非 uin | |
| 5 | A2 `appExecutableSource` | `default-layout` | |
| 6 | B 轮正常聊天 | 能拿到回复 | |
| 7 | 账号池是否变红 | 否 | |

**最需要你确认的是第 3 项 `via registry`**——它就是这次新功能的成败判据。

---

## 若 A1 没出现 `via registry`

按顺序自查，并把每步输出发我：

1. `doctor --json` 里的 `appExecutable` 到底是什么？是 `(not found; set WORKBUDDY_APP_EXECUTABLE)` 吗？
2. 上一步 A0 的注册表查询**有没有**输出？如果 `reg query` 自身没结果，说明该安装没有写卸载项，回退自然无从下手。
3. `DisplayIcon` 的值是 `…\WorkBuddy.exe,0` 还是别的（`.ico`、卸载器）？插件只接受 basename 恰为 `WorkBuddy.exe` 的路径——若你的安装写的是别的名字，这正是需要修的点。
4. 路径里有没有空格（如 `C:\Program Files\...`）？有的话请特别说明，这类路径历史上出过分隔符/引号问题。

---

## 备注：本版未在 Windows 上跑过 CI

本版的提交产自 macOS，`pnpm run check`（typecheck + 870 测试 + build）全绿，但**Windows 侧的 CI 要等推送后才跑**。你的真机验证正好覆盖这一段。

尤其值得留意的是 A 轮那条修复的**根因**：Windows 路径过去是用宿主平台的分隔符拼的，在非 Windows 上会拼成 `D:\dir/WorkBuddy.exe` 这种永不命中的形态——**这类 bug 在 macOS 上表现为「功能完全不生效」，在 Windows 上却可能表现为「一直就是好的」**。所以如果你原本在 Windows 上一切正常，A2 的对照组结果同样有价值。

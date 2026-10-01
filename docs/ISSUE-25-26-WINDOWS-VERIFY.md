# 在 Windows 机器上验证 issues #25 / #26 的修复

> 适用对象：**另一台 Windows 机器上的 AI 助手或工程师**。
> 目标：独立确认本仓库 main 分支上的修复，是否真的解决了
> [#25](https://github.com/dingminhua/dsh-connect-workbuddy/issues/25)（国际版每步 400 / 业务码 11128）
> 与 [#26](https://github.com/dingminhua/dsh-connect-workbuddy/issues/26)（所有模型无法调用工具、模型编造工具调用）。
>
> **本文件自带全部判据。请严格按顺序执行，并按文末「回报格式」输出结果；
> 与预期不符的输出请原样贴回，不要自行改判或跳过。**

---

## 0. 背景：这两个 issue 是同一个根因

pi-ai 的两代实现对「system prompt 与工具声明放在哪里」的约定不同：

| pi-ai 代次 | context 形状 | 谁读它 |
|---|---|---|
| **0.87+（modern）** | `{ messages: [ {role:'system', content, toolsAdded}, … ] }` | 0.87 的 api 只从**首条 system 消息**取 prompt 与 tools；**不读**顶层 `systemPrompt`/`tools` |
| **0.85（legacy）** | `{ systemPrompt, tools, messages }` | 0.85 的 api 只读**顶层**字段；`messages` 里的 system 条目会让它的 token 估算崩溃（issue #24） |

3.0.2 的适配层按 **context 形状**判断「需要折叠」，于是无论哪种环境都把首条 system 消息删掉 —— 恰好删掉了两个代次各自**唯一**的载体：

- 插件解析到 0.87（**干净市场安装**，本地无 pi-ai 副本，模块由 DSH 宿主提供）→ prompt 与 tools **全丢** → 国际版 400（#25）、国内版模型编造工具调用（#26）；
- 插件解析到 0.85（本机有嵌套副本）→ prompt 救回但 **tools 仍丢**（折叠只搬文本、没搬 `toolsAdded`）。

**本次修复**：按**插件自己实际解析到的那份 pi-ai** 决定分支（`import.meta.resolve` 定位 + 读所属 manifest 版本号，不 import 模块本体）：

- **modern（0.87+）**：context **字节级原样透传**；
- **legacy（0.85）**：折叠 system 文本，并**把 `toolsRemoved`/`toolsAdded` 重放后提升回顶层 `context.tools`**；
- **解析不到本地副本**（市场安装的常态）→ 视为宿主提供，走 modern 透传（会归一化 context 的宿主 0.2.0+ 都提供 0.87.1）。

---

## 1. 前置条件

```powershell
node --version     # 需 ^22.19.0 或 >=24（package.json engines）
git --version
pnpm --version     # 没有则：npm install -g pnpm@10
```

另外需要：已安装 DSH（桌面版）、已装 `dsh-connect-workbuddy` 插件、WorkBuddy 已登录（至少一个区域有账号）。

---

## 2. 步骤 A：取代码、构建、跑测试

```powershell
git clone https://github.com/dingminhua/dsh-connect-workbuddy.git C:\src\dsh-connect-workbuddy
cd C:\src\dsh-connect-workbuddy
git log --oneline -5
```

**判据 A1**：日志中应包含一条 `fix(adapter): 按解析到的 pi-ai 代次门控适配 …`（修复提交）。把实际的前 5 行贴回。

```powershell
pnpm install
pnpm run check
```

**判据 A2**：`pnpm run check` 末尾应出现

```
 Test Files  33 passed (33)
      Tests  721 passed (721)
✔ Build complete
```

（`721` 为修复后的用例数；若数字不同但全绿，也请如实记录。Windows 上若有平台相关失败，**原样贴出失败用例名与报错**——这本身就是有价值的发现。）

**判据 A3**（可选但推荐）：构建产物里 `lib/` 是唯一影响运行时行为的目录；`lib/bin.js` 的依赖链**不应**出现对 `@earendil-works/pi-ai` 的静态 import（这是为了市场安装下 `doctor` 仍可独立运行）：

```powershell
Select-String -Path C:\src\dsh-connect-workbuddy\lib\bin.js, C:\src\dsh-connect-workbuddy\lib\host-heartbeat-*.js -Pattern '^import.*@earendil-works/pi-ai'
# 期望：无输出
```

---

## 3. 步骤 B（推荐）：先复现缺陷，留下「红」的证据

在**当前未修复**的 3.0.2 上（先别做步骤 C）：

1. 打开 DSH，新建会话，选一个 **WorkBuddy（国内版）** 模型，发：

   > 请用你的 shell 工具真实执行：echo WB-2526-BASELINE，然后把工具返回的原始输出贴给我。

2. 新建会话，选一个 **WorkBuddy Global（国际版）** 模型，发同样的指令。

**判据 B1（缺陷表现）**：

- 国内版：模型在**正文里用 Markdown 代码块**假装调用工具并**编造**输出（例如 ```bash echo ... ``` + 假的结果），或承认自己没有工具；`stopReason` 表现为普通结束而不是工具调用。
- 国际版：每一步直接报错（业务码 `11128` / 提示 "blocked by security policy"）。

把两边的实际表现（截图或原文）记录下来。若缺陷**未能**复现，也请如实说明（这本身就是重要信息）。

---

## 4. 步骤 C（核心）：把修复部署到已安装的插件上

> 做法：**就地覆盖**已安装插件的 `lib/` 目录。不改动它的位置，因此 peer 依赖（`@deepseek-ai/dsh-*`）的解析链与原来完全一致 —— 这正是 issue #26 报告者的环境（本地无 pi-ai 副本，模块由宿主提供）。

### C1. 找到已安装插件的**真实路径**

```powershell
$profileRoot = "$env:USERPROFILE\.dsh\profiles"
Get-ChildItem $profileRoot -Directory | ForEach-Object {
  $p = Join-Path $_.FullName 'node_modules\dsh-connect-workbuddy'
  if (Test-Path $p) { "profile=$($_.Name)  link=$p" }
}
```

记下 profile 名（下面以 `<PROFILE>` 代替，常见为 `desktop`），然后解析真实路径（市场安装可能是 pnpm 符号链接，真实目录在 `node_modules\.pnpm\...` 下）：

```powershell
$link = "$env:USERPROFILE\.dsh\profiles\<PROFILE>\node_modules\dsh-connect-workbuddy"
$real = (node -e "console.log(require('fs').realpathSync(process.argv[1]))" $link).Trim()
"REAL = $real"
```

### C2. 备份原始目录

```powershell
robocopy $real "$env:USERPROFILE\wb-backup-302" /MIR /NFL /NDL /NJH /NJS
```

（robocopy 退出码 0–7 都算成功。）

### C3. 覆盖 `lib/`

```powershell
robocopy C:\src\dsh-connect-workbuddy\lib "$real\lib" /MIR /NFL /NDL /NJH /NJS
```

**判据 C1**：覆盖后 `$real\lib\bin.js` 的修改时间应为刚才；且 `Select-String -Path "$real\lib\*.js" -Pattern 'piAiRuntime'` 有命中（新代码已就位）。

### C4. **完全退出** DSH 再重新启动

不是关窗口 —— 要确保进程真正退出（任务管理器里确认没有 DSH / Electron 残留进程），再启动。

---

## 5. 步骤 D：`doctor` 确认走了哪条分支

```powershell
node "$real\lib\bin.js" doctor
```

**判据 D1**：输出第二行应为（**关键**）

```
pi-ai runtime: modern, host-provided (no local copy; DSH 0.2.0+ ships 0.87.1) — passes provider contexts through unchanged
```

含义：该机器**本地没有 pi-ai 副本**，运行时由 DSH 宿主提供（0.2.0+ 提供 0.87.1），因此走 **modern 透传**分支 —— 这正是 #26 报告者的环境。

若显示的是 `legacy 0.85.x (<某个路径>) — folds …`，说明该机器**确实有本地副本**，走的是**桥接分支**（同样应当修复有效）。**两种情况都请原样贴回该行**，并继续步骤 E —— 判据 E 对两条分支都成立。

机器可读版本（便于粘贴）：

```powershell
node "$real\lib\bin.js" doctor --json > "$env:TEMP\wb-doctor.json"
Get-Content "$env:TEMP\wb-doctor.json" | Select-String 'piAiRuntime'
```

---

## 6. 步骤 E（决定性）：真机行为验证

对**两个区域**各做一次，全部在**新会话**里：

### E1. 真实工具调用

发：

> 请用你的 shell 工具真实执行：echo WB-2526-FIXED，然后把工具返回的原始输出贴给我。

**判据 E1（修复成功）**：

- DSH 界面里出现**真实的工具调用**（工具调用块 / 命令确实被执行），命令输出**逐字**为 `WB-2526-FIXED`；
- 模型不是在正文里贴 Markdown 代码块假装执行；
- 追问「你刚才那次调用用的是哪个工具、参数是什么」时，答案与真实执行一致。

### E2. 工具清单不再是编造的

发：

> 列出你当前真实可用的工具名（只要名字）。

**判据 E2**：返回的是 DSH 的**真实工具名**（如 `pwsh`、`read`、`edit` 等），而**不是** `Bash`、`Shell` 这类与 DSH 无关的名字（#26 报告里模型编造的正是 `Bash`）。

### E3. 国际版不再 400

**判据 E3**：`workbuddy-global` 的每一步**不再**返回 400 / `11128`，并且同样能完成 E1。

### E4. system prompt 已生效（辅助判据）

发：

> 用一句话说明：你现在运行在哪个客户端里、你的系统提示词要求你遵守哪些规则？

**判据 E4**：模型应能描述 DSH / DeepSeek Harness 相关的真实约定（说明 system prompt 已送达）；若它完全不知道自己在什么环境里，说明 prompt 仍可能丢失 —— 请如实记录。

### 判定汇总

| 现象 | 结论 |
|---|---|
| E1 真实执行 + E2 真名工具 + E3 国际版正常 | **修复有效** |
| 正文里 Markdown 假调用 / 编造输出 / 工具名是 `Bash` | 未修复（工具与 prompt 仍丢） |
| 国际版仍 400 / 11128 | 未修复（出站首条仍非 system） |
| 模型十几毫秒内立即失败、且**没有任何上游请求** | 命中了 issue #24 的崩溃路径（0.85 api 收到 system 消息）→ 说明门控判错了代次，请把 `doctor` 输出与报错全文贴回 |

---

## 7. 步骤 F（可选）：桥接分支（legacy）验证

仅当想额外验证「本机有 0.85 副本」那条分支时执行。把插件指向**仓库本体**（其 `node_modules` 里有 pi-ai 0.85.1）：

```powershell
$link = "$env:USERPROFILE\.dsh\profiles\<PROFILE>\node_modules\dsh-connect-workbuddy"
Rename-Item $link 'dsh-connect-workbuddy.market-backup'
New-Item -ItemType Junction -Path $link -Target 'C:\src\dsh-connect-workbuddy'
```

重启 DSH，然后：

```powershell
node "$link\lib\bin.js" doctor
# 期望：pi-ai runtime: legacy 0.85.1 (…\@earendil-works\pi-ai\dist\index.js) — folds 0.87 transcripts (system text + tool state) into the 0.85 context shape
```

再做一遍 E1/E2 —— **同样应当真实调用工具**（这正是本次新增的 `toolsAdded` 提升所保证的）。

还原：

```powershell
cmd /c rmdir "$link"          # 删 junction 只删链接，不会动目标目录
Rename-Item "$link.market-backup" 'dsh-connect-workbuddy'
```

> `rmdir`（或 `cmd /c rmdir`）用于删除 junction/symlink 是安全的：它只移除链接本身。
> **不要**对链接目录使用 `Remove-Item -Recurse -Force`，部分 PowerShell 版本会顺着链接删掉目标内容。

---

## 8. 步骤 G：还原现场

覆盖式部署会被下一次市场更新覆盖；也可主动还原：

```powershell
robocopy "$env:USERPROFILE\wb-backup-302" $real /MIR /NFL /NDL /NJH /NJS
```

或在 DSH 里对该插件执行**重新安装 / 更新到 3.0.2**。

---

## 9. 注意事项

1. **版本号仍显示 `3.0.2`**：这是验证构建，不是发布版本；请用 `git log -1 --format=%H` 的提交号标识这次验证的代码。
2. **覆盖的是 pnpm 真实目录**（若为符号链接安装）：影响该 profile 下的该插件，下次市场更新即恢复；这也是还原手段之一。
3. **必须完全重启 DSH**：插件代码在宿主进程内加载，热更新不保证生效。
4. **判据以「行为」为准**：`doctor` 说明走哪条分支，E1/E2 说明用户可见的结果。两者都要记录。
5. **若插件加载失败**（DSH 启动后插件不可用 / 报错）：把**报错全文**贴回，并尝试步骤 F 的 junction 方式（peer 解析路径不同，可能绕开该问题）。
6. 若该机器**根本没有** WorkBuddy 登录或没有可用模型，请说明到哪一步为止，并贴出已完成步骤的输出。

---

## 10. 回报格式（请照此输出）

```
## 环境
- Windows 版本 / Node 版本 / pnpm 版本：
- DSH 版本（帮助→关于，或 app 目录名）：
- 插件 profile 名与真实路径（步骤 C1/C2）：
- 本次验证的提交号（git log -1 --format=%H）：

## A. 代码与测试
- git log 前 5 行：
- pnpm run check 结果（Test Files / Tests 两行原文）：
- 判据 A3（bin.js 依赖链是否出现 pi-ai 静态 import）：有 / 无

## B. 缺陷复现（若做了）
- 国内版表现：
- 国际版表现：

## C. 部署
- 备份路径：
- robocopy 覆盖是否成功：
- 是否完全重启 DSH：

## D. doctor 输出
- 人类可读的 pi-ai runtime 行（原文）：
- JSON 中的 piAiRuntime 块（原文）：

## E. 真机验证（每个区域分别记录）
| 区域 | E1 真实执行 | E2 工具真名 | E3 不再 400 | E4 prompt 生效 |
|---|---|---|---|---|
| workbuddy（国内） |  |  |  |  |
| workbuddy-global（国际） |  |  |  |  |

- E1 的原始命令输出：
- 模型列出的工具名：
- 任何异常/报错全文：

## 结论
- 修复是否有效（按第 6 节判定表）：
- 与预期不符之处：
```

---

## 附：本仓库内可对照的自动化守卫

若想理解修复在代码层是如何被钉住的（步骤 A 已跑过它们）：

| 文件 | 钉住的属性 |
|---|---|
| `tests/adapter.spec.ts` | legacy 分支折叠**并提升工具**；modern 分支**同一对象引用**透传；默认跟随实际解析代次 |
| `tests/adapter-outgoing-body.spec.ts` | **出站请求体**里确有 `tools` 与首条 system 文本（#26 建议的测法） |
| `tests/pi-ai-runtime.spec.ts` | 代次判定自洽；**解析不到本地副本时默认 modern（宿主提供）** |
| `tests/upstream.spec.ts` | wire 层兜底：user 打头时补 system 占位、已是 system 则不重复补 |
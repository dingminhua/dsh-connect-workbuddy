# 在 Windows 机器上验证 DSML 恢复（3.3.0）

> 对应代码：`99cff6d`（+ `5c7200d`、`13da588`）
> 验证对象：模型把工具调用写进正文时，插件是否在客户端看到之前把它转回真正的 `tool_calls`
> 预计耗时：15 分钟（不含可选步骤 B）

---

## 0. 要验证的一句

**上游把 `<｜DSML｜invoke name="…">` 写进正文时，DSH 收到的是真正的工具调用；而不是一堵乱码墙。**

两件**不要**误判成失败的事，先写在最前面：

1. **`<｜DSML｜ validate>` 那一类仍然会以正文显示。** 那是「工具名被写坏、拿不到工具名」的形态，
   注定过不了第二道闸（名字必须在本次请求声明的工具里）。按裁定它**原样显示**、不猜；
   只有当整轮去除标记后**没有任何正文**时才会重发一次。看到它 = 设计如此，不是回归。
2. **模型会摇摆。** 同一个模型在两种形态之间反复：本项目实测过 6/6 泄漏与 3/3 干净的两轮。
   一轮干净不能证明问题消失，一轮有标记也不能单独证明修复失效——**要看判据 D2 的分布**，
   而不是看某一句回答长什么样。

---

## 1. 已经在 CI 上验过的（不必重做）

`main` 的每次推送都会在 **ubuntu-latest 与 windows-latest** 上跑 typecheck + 全量测试 + 构建。
本次推送（`99cff6d`）两个平台都是绿的，Windows 上 **814 例**全部通过：

```powershell
gh run view 36884544307 --json jobs --jq '.jobs[] | "\(.name): \(.conclusion)"'
# test (windows-latest): success
# test (ubuntu-latest): success
```

所以下面只需要验**插件装进 DSH 之后的真机行为**——这是 CI 覆盖不到的那一层。

---

## 2. 步骤 A：取代码、构建、跑测试

```powershell
cd C:\src   # 换成你的工作目录
git clone https://github.com/dingminhua/dsh-connect-workbuddy.git   # 或 git pull
cd dsh-connect-workbuddy
git log --oneline -3      # 期望看到 99cff6d / 5c7200d / 13da588
pnpm install
pnpm run check            # typecheck + 测试 + 构建，期望全绿
```

**判据 A1**：`pnpm run check` 退出码 0，测试数与 CI 一致（814）。

---

## 3. 步骤 B（可选，会花积分）：先留下「红」的证据

想证明「这个缺陷在这台机器上真实存在过」，就先用**旧版**跑一次（不打这一步也可以跳过）：

```powershell
git stash list              # 确认没有未提交改动
git checkout a2a4e55        # 修复前的最后一个提交
pnpm install; pnpm run build
node scripts/verify-dsml.mjs --live 3
```

`--live` 是**直连上游**（绕过 shim），量的是模型本身。若这几轮里出现 `markup-in-content`，
那就是这台机器上的原始缺陷；把它原样贴回来即可。之后回到 `main` 再继续：

```powershell
git checkout main && pnpm install && pnpm run build
```

---

## 4. 步骤 C：把新代码部署到已安装的插件上

> 做法与上一轮 issue #25/#26 的验证相同：**就地覆盖**已安装插件的 `lib/`，不改它的位置，
> 因此 peer 依赖（`@deepseek-ai/dsh-*`）的解析链与原来完全一致。

### C1. 找到已安装插件的真实路径

```powershell
$profileRoot = "$env:USERPROFILE\.dsh\profiles"
Get-ChildItem $profileRoot -Directory | ForEach-Object {
  $p = Join-Path $_.FullName 'node_modules\dsh-connect-workbuddy'
  if (Test-Path $p) { "profile=$($_.Name)  link=$p" }
}
$link = "$env:USERPROFILE\.dsh\profiles\<PROFILE>\node_modules\dsh-connect-workbuddy"
$real = (node -e "console.log(require('fs').realpathSync(process.argv[1]))" $link).Trim()
"REAL = $real"
```

### C2. 备份

```powershell
robocopy $real "$env:USERPROFILE\wb-backup-dsml" /MIR /NFL /NDL /NJH /NJS
```

### C3. 覆盖 `lib/`

```powershell
robocopy C:\src\dsh-connect-workbuddy\lib "$real\lib" /MIR /NFL /NDL /NJH /NJS
```

**判据 C3**：新代码确实就位——这三样都能查到。

```powershell
Select-String -Path "$real\lib\*.js" -Pattern 'RecoveryStream'      # 有命中
Select-String -Path "$real\lib\*.js" -Pattern 'DsmlStreamBuffer'    # 有命中
Select-String -Path "$real\lib\*.js" -Pattern 'declaredTools'       # 有命中
```

（这三条正是「加载的是新构建」的机器可读证据。用户级安装若在上面 C1 里直接指向你的
`git clone` 目录，则覆盖 `lib/` 等同于重新构建，跳过 C3 也可以。）

### C4. **完全退出** DSH 再启动

不是关窗口——任务管理器里确认没有 DSH / Electron 残留进程，再启动。

---

## 5. 步骤 D（决定性）：真机行为验证

### D1. 一轮带工具的对话

在 DSH 里选 **WorkBuddy 提供商的 `deepseek-v4.1-flash`**，发一句必须用工具的指令，例如：

```
请用 shell 工具真实执行并原样贴回输出：echo WB-DSML-WINDOWS-OK
```

**判据 D1**：命令**真的被执行了**（回复里有真实输出），且回复正文里**没有** `｜DSML｜` 这类标记。
这一条同时证明了两件事：工具调用走的是结构化通道，以及响应路径没有被改写弄坏。

### D2. 量「客户端最终看到什么」（这一步才是修复的判据）

```powershell
node scripts/verify-dsml.mjs --live 3 --through-shim
```

`--through-shim` 会把真上游响应**经过 shim**再判定。判读方式：

最后一行形如 `实际分布：标记 X／原生 Y／纯文字 Z／空 W（共 N 轮）`。判读方式：

| 分布 | 含义 |
|---|---|
| 标记 0 | 正常（模型这轮没泄漏，或泄漏已被转换） |
| 标记 N，且被打印出来的片段是 `<｜DSML｜ validate>` 这类**工具名被写坏**的块 | **符合预期**：不可恢复形态按原文显示（见 §0 第 1 条） |
| 标记 N，且片段里有**完整的 `invoke name="…"` 块**（工具名合法） | **这才是问题**：转换没生效，请把整段贴回来 |

**判据 D2**：不出现上表第三行。

### D3. 静态核对（不联网，1 秒）

```powershell
node scripts/verify-dsml.mjs
```

期望在第 2 节看到「响应路径接管点：shim.ts:<行号>」与「恢复模块：src/dsml-recovery.ts 存在」两行
（行号会随改代码漂移，这里只要求**有**这两行，不要求数字）。
这两行现在是**用 Node 读源码**得到的，不再依赖 `grep`——Windows 上没有 `grep`，此前那种探针
会报「未找到」，而「工具缺失」和「确实没有」在界面上长得一模一样。

---

## 6. 判定汇总

| # | 判据 | 通过标准 |
|---|---|---|
| A1 | 本机构建 | `pnpm run check` 全绿，814 例 |
| C3 | 新代码就位 | `RecoveryStream` / `DsmlStreamBuffer` / `declaredTools` 三处都有命中 |
| D1 | 真机工具调用 | 命令真被执行，且回复正文无标记 |
| D2 | 客户端侧分布 | 不出现「标记 N 且含合法 `invoke name="…"`」 |
| D3 | 静态探针 | 能看到接管点与恢复模块两行 |

---

## 7. 回报时请附

1. `pnpm run check` 的最后几行（测试数与是否全绿）；
2. C3 那三条 `Select-String` 的输出；
3. D1 的**原文**（截图或文字），特别是命令的真实输出；
4. D2 的完整输出（分布那几行 + 任何被打印出来的标记片段）；
5. D3 第 2 节那两行。

若 D1/D2 出现「合法 invoke 块仍被当正文」，请**连原始响应一起**贴回来（`--live 3` 直连那一轮的输出），
那说明需要看的是模型本身的形态，而不是转换层。

---

## 8. 已知的、不需要报的问题

- **工具名被写坏的那一类仍会显示**（§0 第 1 条）——这是裁定过的行为。
- **模型摇摆**导致某几轮完全没有泄漏——不是修复失效，也不是修复生效的证据。
- `--live` **直连**上游时看到 `markup-in-content` 是**正常**的：它绕过 shim，量的就是模型本身。
  要比的是 `--through-shim` 的分布。

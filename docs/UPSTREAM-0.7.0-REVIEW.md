# 上游 `corrinehu/dsh-workbuddy-connect` v0.7.0 对照评估

> 评估日期：本会话
> 上游基线：`dsh-workbuddy-connect` v0.7.0（`dd01375`），v0.2.3（`d91d804`）之后的 **162 个提交**
> 本仓库基线：`dsh-connect-workbuddy` v3.0.2

## 0. 拉取状态

同级目录 `../dsh-workbuddy-connect` **此前已存在**，但停留在 v0.2.3（2026-08-28），
落后上游 162 个提交。本次已 `git fetch` + `git merge --ff-only origin/main` 快进到 **v0.7.0**。

途中唯一的阻碍是一个未跟踪的 `pnpm-workspace.yaml`——它是 pnpm 11 自动生成的占位文件
（内容是 `set this to true or false`），与上游仓库里那份真实配置同名。
已备份原文件后删除，让上游版本落地。仓库现无未跟踪改动。

## 1. 结论摘要

上游与本仓库是**同源分叉**：两者都从 v0.2.3 附近出发，之后独立演进——
上游 0.2.4 → 0.7.0，本仓库 1.0.0 → 3.0.2。因此上游的大量提交对本仓库**不适用或已覆盖**，
但确实存在 **3 个可直接落地的真实缺陷**，另有 3 处**平台发现能力**差距。

### 高价值、确认存在

| # | 缺口 | 上游来源 | 本仓库证据 | 影响 |
|---|------|---------|-----------|------|
| 1 | 未接 `resolveImageAccess` | `a3fb1ba`（issue #52） | `src/adapter.ts:105` 只有 `resolveAttachments`；`src/index.ts:1397` 只传它；全仓 `resolveImageAccess` 零命中 | 图片句柄文本不含本地归一化路径，模型 `read_image` 只能瞎猜 sha256 路径 |
| 2 | web 状态路由缺 Host 头回环校验 | `bd6a77d`（PR #11 review） | `src/web-status.ts:279` `loopbackOrigin()` 只查 Origin，且 `origin === undefined` 时返回 `true`；Host 校验只存在于 `src/shim.ts:190` | 状态文档（昵称、剩余积分、模型费率）可被 DNS-rebinding 页面读取 |
| 3 | Linux 桌面凭据只探 XDG config home | `38c1e5a`（issue #43） | `src/auth.ts:273` Linux 分支只有 `XDG_CONFIG_HOME ?? ~/.config`，无 `~/.local/share` | UOS/deepin 版把登录写成「未登录」 |

### 平台发现能力差距（同一成因：只枚举默认安装路径）

| # | 缺口 | 上游来源 | 本仓库证据 | 影响 |
|---|------|---------|-----------|------|
| 4 | macOS 无非默认安装路径兜底 | `8aa1420`（issue #48） | `src/at-rest.ts:92` 只有 `WorkBuddy.app` / `WorkBuddy AI.app`，仅探 `/Applications` 与 `~/Applications`，无 `mdfind` | 装在 `/Applications/IDE/WorkBuddy.app` 时报「未登录」，加密凭据无法解密 |
| 5 | Windows 无注册表/卸载记录扫描 | `de2c795`、`2cef8c8`、`8a26464`（#59/#60/#66） | `src/at-rest.ts:274-283` 只有 `LOCALAPPDATA` / `ProgramFiles` 硬编码候选 | 非默认安装位置（如 D: 盘）完全不被发现 |
| 6 | WSL 不探挂载的 Windows 配置目录 | `91758ea`（issue #4） | 全仓 `wsl` 零命中；WSL 下 `process.platform === 'linux'`，只走 `.config` | WSL 用户被读成「未登录」 |

## 2. 明确**不需要**跟进的（避免白做）

这部分与第 1 节同等重要：上游 v0.7.0 的门面改动对本仓库**无价值**。

- **DSH 0.2.0 兼容**。上游 v0.7.0 的头等大事（`4e09bca` 适配 `SettingsForms`、
  `0c7de3f` 补 `plugins.item` 槽位、`9a9df65` 把 peer 钉死在 `0.2.0-rc.1/rc.2`）
  本仓库**已经做过且更彻底**。`README.md:126` 记录：自 v2.1.2 起上界放宽为 `<0.3.0-0`，
  并已逐包核对 0.2.0-rc.1 tag 与本插件触碰的 12 个内核包 `src/` 树哈希**逐字节相同**，
  且在真实 0.2.0-rc.1 宿主上实测两个槽位 `active: true`、状态路由 200。
  本次复核再次确认：`SettingsForms.configure(presentation, owner)` 在
  `deepseek-harness/packages/settings/settings/src/index.ts:266` 签名不变，
  本仓库 `src/index.ts:1214` 的调用形态正确；`plugins.bundle.config` / `plugins.row.config`
  在 0.2.0-rc.1 仍在。
- **`legacy-settings.ts`**（上游 `4e09bca` 新增）。那是为了**同时**支持 0.1.5/0.1.6，
  本仓库自 2.1.0 起**只支持 0.1.7-rc.1+**，旧分区 API 分支已随该行删除
  （见 `src/index.ts:1190-1197` 的注记）。引入它等于把已删除的兼容面装回来。
- **`off` 档位在 wire 上的拼写**（上游 `5875f32`，issue #49）。上游会发字面量
  `'off'` 是因为它的映射表把 `off` 写成字符串 `'off'`
  （上游 `src/adapter.ts:248`）。本仓库的映射表**根本不含 `off` 键**
  （`src/adapter.ts:145-153` 只遍历 6 个档位，仅在不可关闭时置 `off = null`），
  而 pi-ai 只在 `typeof offValue === 'string'` 时才写该字段
  （`pi-ai/dist/api/openai-completions.js:733-735`），且选 Off 时
  `reasoningEffort` 被置为 `undefined`（同文件 `:540`）。**本仓库实际上已经等价于
  上游修复后的行为**，不需要再加区域化剥离。
  （对应代码：本仓库 `src/adapter.ts:143-153`，`off` 仅在不可关闭时被置为 `null`；
  上游 `src/adapter.ts:248` 则赋成字符串 `'off'`。）
- **`withLegacyImageBudget` 包装**（上游 `e0874e5`、`0ff1609`）。服务于 ≤0.1.5 宿主的
  image-budget 契约错位，本仓库不支持该宿主线。
- **WMI 进程启动时间解析修复**（上游 `dc10a73`、`5293637`）。本仓库走的是
  PowerShell `Get-Process -Id <pid> ... StartTime`（`src/host-heartbeat.ts:91`），
  不是 `wmic`，两个 bug 均不适用。
- **企业额度展示**（上游 `8d64f8b`、`a13b599`）。本仓库已有积分/额度体系
  （`CHANGELOG.md` 中 `积分`/`quota`/`credit` 34 处命中）。
- **最大上下文窗口偏好**（上游 `9d29de1`）。本仓库的 `contextBudgets`
  （`src/index.ts:298`、`:402`）是**逐模型**预算，粒度比上游的单一开关更细。

## 3. 可选新特性（非缺陷）

| 特性 | 上游来源 | 说明 |
|------|---------|------|
| 右下角更新提醒 | `f0da1eb`、`22cb6c6`、`36620ef`、`576d3f8`、`ad0306f`（`src/update.ts` + `update-store.ts`） | 查 npm dist-tags 与 GitHub releases，按版本数列出更新说明。本仓库无（`dist-tags` / `releases` 零命中） |
| 逐账号模型显隐开关 | `37a7098`、`03e6ea9`（issue #36） | 本仓库的 `enabledModelIds` 是**按区域**的，没有按账号粒度 |
| 未声明模型的推理档位探测 | `c540939`、`360ad75` | 本仓库 `src/probe.ts` 是**可用性/限流体积**探测（模块注释明确三个实测结论），不做档位探测 |

## 4. 若跟进第 1 节的建议顺序

1. **缺口 1（图片访问）** —— 收益最直接，API 已确认在两条宿主线上都存在：
   - `deepseek-harness/packages/llm/llm-pi-ai/src/adapter.ts:98` 定义
     `resolveImageAccess?`
   - `deepseek-harness/packages/llm/llm/src/content.ts:34` 导出
     `resolveImageAttachmentAccess(attachments, mapHostPath, ref)`
   - 本仓库已安装的 `0.1.7-rc.1` 两个包同样带这两项
     （`node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/types/adapter.d.ts:58`、
     `node_modules/@deepseek-ai/dsh-llm/lib/types/content.d.ts:27`），
     因此**不需要动 peer 范围**。
   - 参照实现：`deepseek-harness/packages/llm/llm-pi-ai/src/index.ts:217-220`
     与 `packages/llm/llm-deepseek/src/host.ts:33-35`——
     `hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath)`，按请求取值、不缓存。
   - 未接的后果可在 `packages/llm/llm/src/content.ts:91-100` 读到：句柄文本退化成
     「It may be resized or re-encoded…」而**不含路径**；被 offload 时更是
     「No local normalized image path is available」。
2. **缺口 2（Host 头校验）** —— 安全项，改动小。上游 `bd6a77d` 的做法是把回环判定抽成
   共享模块 `src/loopback.ts`，让 shim 与状态路由**用同一套**。
   注意上游那份 `hostnameOfHost` 比本仓库 `src/shim.ts:61-69` 多一条保护：
   未加括号的 IPv6 字面量含多个冒号时不得截断。
3. **缺口 3、6（Linux XDG data home / WSL）** —— 都是给 `defaultDesktopAuthDirs()`
   加候选目录并保持探测顺序，改动局部。
4. **缺口 4、5（macOS Spotlight / Windows 注册表）** —— 工作量最大。
   若要照搬上游 Windows 那条路，务必连同 `8a26464` 的教训一起拿走：
   在 Electron 宿主里 `fs.stat('resources/app.asar')` 返回的是**目录**，
   用 `isFile()` 做布局校验会**确定性地**排除掉所有候选。

## 5. 复核方式

本次结论均来自对两侧源码与已安装依赖的直接核对，非猜测：

- 上游：同级 `../dsh-workbuddy-connect`（v0.7.0），按提交逐项 `git show`。
- 宿主契约：`../deepseek-harness`（0.2.0-rc.1）与 `node_modules/@deepseek-ai/*`（0.1.7-rc.1）双向核对。
- pi-ai 行为：`node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js` 与 `dist/models.js`。
- 本仓库：逐项 grep 定位到文件与行号（见上表「本仓库证据」列）。

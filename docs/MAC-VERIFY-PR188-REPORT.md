# PR #188 侧边栏面板 · mac 实测结果

对象：`main` = `c3f9a80`（"feat: WorkBuddy 侧边栏面板（可选，默认关闭）(#188)"），测试时的版本号 5.17.0（本次发布升为 5.18.0，代码未变）。
清单：`docs/MAC-VERIFY-PR188.md`。机器：macOS 26.6.1 / Darwin 25.6.0 arm64，node v25.9.0。

截图：`docs/pr188-mac-shots/`（`01-default-no-row.png` 默认没有那一行 / `02-panel-page.png` 整页版 /
`03-off-returns-to-chat.png` 关掉后自动回对话 / `04-row-icon.png` 行图标 / `05-real-tier-disabled.png`
「真实值」档禁用 / `06-sdk-status.png` SDK 分区读数）。

## 0. 构建

| 步骤 | 命令 | 结果 |
|---|---|---|
| 装依赖 | `pnpm install` | ok（prepare 里自动构建） |
| 构建 | `pnpm run build` | ok（tsdown + `scripts/verify-entry-artifacts.mjs`） |
| 产物 | `pnpm run verify:entries` | 6 declared artifact(s) present：`lib/index.js`、`lib/index.d.ts`、`lib/bin.js`、`lib/client.js`、`cordis.patch.yml`、`package.json` |
| 类型 | `pnpm run typecheck` | exit 0（`tsconfig.json` + `tsconfig.client.json`） |
| 全量测试 | `npx vitest run` | 176 文件 / 2938 例，**2936 passed + 2 skipped**，41.22s，exit 0 |

> 一处与 commit message 的出入：消息里说 2938 例全绿，实测是 2936 passed + 2 skipped
> （`tests/windows-file-lock.spec.ts` 在非 Windows 上整组跳过）。不是回归，只是数字要修正。

## 1. 默认不出现 —— 通过

- 全新浏览器上下文打开页面，侧边栏行只有 `插件 / 自动化任务 / 更多`，**没有 WorkBuddy**。
- 浏览器控制台：`[dsh-connect-workbuddy] registered 9 slots (settings form: bound, sidebar panel: off)`。
- 宿主 `GET /plugins/dsh-connect-workbuddy/usage?region=cn` 回 `sidebarPanelEnabled: false`。
- `~/.dsh/profiles/desktop/cordis.patch.yml` 里没有 `sidebarPanel` 键 —— 默认关闭的依据成立。

## 2. 勾选后立刻出现整条链路 —— 通过

在「插件 → dsh-connect-workbuddy → 能力」勾上「在侧边栏显示 WorkBuddy」：

| 检查项 | 结果 |
|---|---|
| 侧边栏**立刻**出现那一行（不保存、不重载） | ✅ 3.5s 内行从 `["插件","自动化任务","更多"]` 变成 `["插件","WorkBuddy","自动化任务","更多"]` |
| 点它，中间栏出现整页 | ✅ |
| 左上有「返回会话」 | ✅ |
| 点返回回到对话 | ✅ |
| 图标是彩色品牌图，不是空白方块 | ✅ `img.dsm-workbuddy-panel-icon`，内联 base64 PNG |

## 3. 开着面板时把它关掉 —— 通过（这是清单里你最没把握的一步）

在**面板整页里**切到「能力」把复选框取消：

- 侧边栏那一行消失；
- 中间栏**自动回到对话**（输入框「描述你想要构建的内容」在），**没有留空白页**；
- 落盘：`cordis.patch.yml` 里 `sidebarPanel: false`。

从「插件」页取消勾选同样正常，区别只是当时不在面板页上。

## 4. 重启后仍然记得 —— 通过

杀掉 `dsh --profile pr188` 进程、重新起一个宿主，再打开页面：

- 侧边栏那一行还在；
- 「能力」栏的复选框仍然勾着（`cordis.patch.yml` 里是 `sidebarPanel: true`）。

## 5. macOS 独有的两条

### 5.1 「真实值」这一档 —— 通过（灰的，且给了原因）

`真实值` 按钮 `disabled: true`，tooltip 原文：

> 本平台用不了：桌面端 SDK 在这里取不到设备 token——macOS 上它会阻塞在 dispatch 主队列，
> 而后台进程永不排空那个队列。切过去也只会降级回虚拟值，所以这一档已禁用。当前读数见「SDK」分区。

`虚拟值` 照常可用（选中态正常）。「SDK」页的状态也与之一致：
`darwin-arm64 · electron 44.7.0` / 最近取到「从未」/ 当前档位「虚拟值——这枚 token 不发出去」。
代码侧 `src/index.ts:1243-1254` 的 `realTierAvailabilityFor('darwin') → { state: 'broken' }` 与页面一致。

### 5.2 凭据路径 / 文件权限 —— 通过（POSIX 分支，没报错）

`dsh-connect-workbuddy doctor`：

- Desktop auth file: present (`~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info`)
- CN 9 个账号、Global 3 个账号，全部读到，`expires` 正常
- Credential vault：`not-windows — POSIX mode 0600 applies`（`~/.dsh/workbuddy-vault/cn`、`/global`），实际权限 `-rw-------`
- Encrypted-credential support: available（`/Applications/WorkBuddy.app/.../Electron`）
- 卡片「账号」页能列出全部账号，没有权限相关报错

## 6. 三个 issue

| Issue | 本机结果 |
|---|---|
| #187 图生视频 https URL | 代码级 + 单测：`src/video-tool.ts` 的 `resolveVideoImageInput` 用 **GET** 下载后编码成 data URL，不再 HEAD、不再把外链透传给上游。`tests/video-tool.spec.ts:259` 断言"发的是 data URL 不是 URL"。**未做真实付费调用** |
| #187 超时 | `VIDEO_TOOL_TIMEOUT_MS = 570_000` < 宿主 600s，`VIDEO_POLL_BUDGET_MS = 540_000` 再留 30s 报错；`tests/video-tool.spec.ts:316/321` 钉住这个排序。`POLL_TIMEOUT` 带 task id。**未跑满 570s** |
| #189 子智能体套话 | **已在真实网关上验**，见下一节 |
| #190 鸿蒙 | Mac 上验不了 |

## 怎么复现这次测试

宿主跑在一次性 profile 里，没碰 desktop：

```sh
dsh plugin --profile pr188 add /Users/<you>/DshProject/dsh-connect-workbuddy
dsh --profile pr188 --port 7788 --no-open   # 打印带 token 的 URL
```

浏览器用 Playwright 驱动（`~/Library/Caches/ms-playwright` 里的 Chrome for Testing）。
profile 现在留在 `~/.dsh/profiles/pr188`，不用了 `rm -rf` 即可。

## 唯一没验到的

本机 desktop 那份 GUI（`127.0.0.1:50450`）需要 launch-token cookie，脚本进不去；
只从宿主侧确认了它的 usage 路由回 `sidebarPanelEnabled: false`（默认关闭，且已经在跑新代码）。
面板的界面行为是在上面的 pr188 窗口里验的 —— 同一份 `lib/client.js`。

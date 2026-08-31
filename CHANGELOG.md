# Changelog

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

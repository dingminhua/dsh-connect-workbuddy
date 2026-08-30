# Changelog

## Unreleased

### Features

- **模型管理**：从上游刷新完整模型目录后可逐项勾选启用；刷新为草稿操作，需显式保存。上游同时给出积分倍率、上下文/输出上限、推理档位与多模态能力（实测 16 个 cli 模型全部带出这些字段，原实现仅保留 id/name/token 上限）。
- **本机账号切换**：扫描 WorkBuddy auth 目录（活跃文件 + 时间戳备份），按 uin 去重为多个可选账号，默认跟随 App 当前登录。实测本机 2 个账号均可通过上游鉴权，积分分别为 1875 与 0。
- **凭据路径多候选**：macOS / Windows(Local+Roaming) / Linux(XDG) 逐一探测，支持环境变量与配置覆盖。
- **积分按套餐聚合**：实测单个账号下同名「运营裂变包」达 19 个，逐条渲染会淹没卡片，改为聚合并标注 count。
- **只读路由 trio**：`/plugins/dsh-connect-workbuddy/{usage,models/refresh,accounts/refresh}`，回环来源校验 + token 脱敏，积分查询失败降级为 `creditsError` 而不让整个文档失败。
- **每日签到**：卡片下方提供一键签到按钮，查询状态与领取均走 `/plugins/dsh-connect-workbuddy/checkin`（POST），回环来源校验 + 领取前二次确认「今日未签到」，不会重复领取；签到失败降级为 `checkinError` 展示。
- **月度周期积分套餐**：积分概览改为区分「月度周期套餐」（每周期刷新、永不过期，展示下次刷新时间）与「一次性礼包」（仅列出 3 天内到期且仍有余额的），替代原先按名称聚合的做法。
- **多模态标记**：已知 fallback 视觉模型 `GLM-5v-Turbo` 标记为多模态，适配器目录补充 `inputModalities`，与上游模型发现保持一致。
- **CLI 诊断**：`status` / `doctor` / `logout`（`--json` 支持），doctor 列出每个发现的账号及其文件来源。

### Fixes

- **凭据选择优先活跃文件**：实测所有备份文件都声称 2027 年到期，但只有 `workbuddy-desktop.info` 的 token 被上游接受。原先「取到期最晚者」的策略会选中已被服务端作废的 token，导致积分查询 401。现改为活跃文件优先，到期时间仅作备份间排序。
- **无头 profile 下不再崩溃**：`ctx.effect()` 的回调同步执行，无 `webServer` 服务时（TUI）会同步抛错。现改为先 `ctx.get('webServer')` 判空再注册。
- 测试不再污染真实 `$DSH_HOME`：vitest 配置隔离 DSH_HOME，避免写心跳与凭据副本到开发者真实 profile。

### Docs


- README 与 README.en.md 顶部新增插件使用界面截图 `docs/assets/dsh-connect-workbuddy-usage-card.png`（与 `dsh-connect-trae` 的展示方式一致），并新增 `screenshots.json` 登记截图路径。
- 确立溯源与致谢规范：`THIRD_PARTY_NOTICES.md` 完整记录参考项目及其许可证；README 与 README.en.md 的致谢章节按「连接内核的参照 / 插件外观与结构的基准」两类如实标注来源。
- `dsh-codex-connect`（Apache-2.0）作为唯一非 MIT 参考项，其第 4 条声明义务（保留声明、声明未修改、NOTICE 说明）在 `THIRD_PARTY_NOTICES.md` 中单独履行。
- `docs/DESIGN.md` 第 5.3 节确立源文件头标注规范：每个借鉴自参考项目的文件必须写明「参考了谁 / 参考了什么 / 改动了什么」。
- `RELEASING.md` 将「核对溯源与致谢」列为发布前强制步骤，防止后续发版遗漏。

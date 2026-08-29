# 第三方开源声明（Third-Party Notices）

> 本文件记录本项目在设计、实现与外观上参考或借鉴的开源项目，以及各自的许可证与合规要求。
>
> 通用平台与构建依赖（`@deepseek-ai/*`、`react`、`typescript`、`tsdown`、`vitest` 等）的许可证随各自 npm 包自动携带，不属于本文档范围。
>
> 若你对本文件的完整性有疑问或发现遗漏，请提交 issue 或 PR。

## 一、项目缘起

本项目是 **WorkBuddy 接入 DeepSeek Harness（DSH）** 的重新实现，目标是在保留已验证连接能力的同时，改善使用体验。它的两个来源必须被明确承认：

| 角色 | 项目 | 提供了什么 |
|---|---|---|
| 连接内核的参照 | [`dsh-workbuddy-connect`](https://github.com/corrinehu/dsh-workbuddy-connect) | 已验证可用的 WorkBuddy 接入方案：桌面端凭据发现与刷新、上游协议、SSE 直通、loopback shim 加固、pi-ai provider 装配、状态 CLI |
| 插件外观的基准 | [`dsh-connect-trae`](https://github.com/dingminhua/dsh-connect-trae) | 插件卡片的结构与 CSS、模型管理与账号选择的交互模型、host↔client 路由形态、npm 发布工程 |

> `dsh-connect-trae` 的外观本身又派生自 [`dsh-subagent-default-model`](https://github.com/dingminhua/dsh-subagent-default-model)（同一作者的插件家族基准），其 `dsm-*` 卡片样式与 `row.*` 文案键约定来自那里。

## 二、参考项目清单

### 与 WorkBuddy 接入直接相关

| 项目 | 仓库 | 参考内容 | 许可证 |
| --- | --- | --- | --- |
| `dsh-workbuddy-connect` | <https://github.com/corrinehu/dsh-workbuddy-connect> | WorkBuddy 接入的完整参照：凭据发现、上游协议、shim、适配器、CLI | **MIT**（Copyright (c) 2026 Corrine Hu） |
| `workbuddy2api` | <https://github.com/Sliverkiss/workbuddy2api> | WorkBuddy 上游协议（`copilot.tencent.com` 的 wire behavior）的参照实现 | **MIT** |

### 与 DSH 插件结构 / 外观相关

| 项目 | 仓库 | 参考内容 | 许可证 |
| --- | --- | --- | --- |
| `dsh-connect-trae` | <https://github.com/dingminhua/dsh-connect-trae> | 插件卡片外观、模型管理与账号选择交互、路由与发布工程 | **MIT**（Copyright (c) 2026 LaoDing） |
| `dsh-subagent-default-model` | <https://github.com/dingminhua/dsh-subagent-default-model> | `dsm-*` 卡片 CSS、`row.*` 文案键约定、品牌图标 | **MIT**（Copyright (c) 2026 LaoDing） |
| `dsh-codex-connect` | <https://github.com/franksong2702/dsh-codex-connect> | DSH 插件结构与 pi-ai provider 注册的参照（经 `dsh-workbuddy-connect` 转引） | **Apache-2.0** |

## 三、Apache-2.0 特别说明

`dsh-codex-connect` 采用 **Apache License 2.0**，其义务重于 MIT。本项目对它的参考是**间接的**：经由 `dsh-workbuddy-connect` 转引其 DSH 插件结构与 provider 注册思路。即便如此，本项目仍遵守 Apache-2.0 第 4 条的要求：

- **保留声明**：在该项目条目中标注其许可证为 Apache-2.0，并注明「经 `dsh-workbuddy-connect` 转引」的事实路径。
- **NOTICE 文件**：`dsh-codex-connect` 未随其仓库提供独立的 `NOTICE` 文本文件；若上游后续补充，本项目将同步将其内容纳入本文件或随包的 `NOTICE`。
- **改动声明**：本项目**未修改** `dsh-codex-connect` 的源码；相关模块（适配器装配、插件注册）为独立实现。
- **专利与商标**：本项目不主张 `dsh-codex-connect` 作者的任何专利许可或商标权利。

> 附：Apache-2.0 与本项目自身的 MIT 许可证在**再分发**层面兼容（Apache-2.0 允许以 MIT 条款再分发衍生作品，前提是满足其第 4 条的声明义务）。本项目通过本文件满足该义务。

## 四、本项目的使用方式

- **借鉴设计思路 + 独立实现**：关键模块均为本项目独立编写，并在各源文件头部注释中标注所参考的具体项目与模式。
- **不整体复制源码**：未复制、修改或再分发上述任何参考项目的源文件。
- **版权声明保留**：所有参考项目的版权归各自作者所有；本项目代码不构成对它们的再分发。
- **后续引入依赖时**：引入任何新的 WorkBuddy 相关外部依赖、或复用其他项目代码时，必须同步更新本文件，并遵守对应许可证的署名与声明要求。

## 五、随包分发

本文件已列入 `package.json` 的 `files` 白名单，随 npm 包一同分发，确保最终用户在安装包内即可看到完整的第三方声明。README（中英双语）中的「致谢」章节与本文件互为索引。

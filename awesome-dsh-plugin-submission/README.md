# 市场收录目录（Awesome DSH Plugin Submission）

本目录存放本项目提交到 [Awesome DSH Plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 注册表的**草稿**。正式提交以 PR 形式存在于该仓库，本目录是本地镜像与操作说明。

## 当前状态

- **正式提交**：PR [#3812](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/3812) —— `data/plugins/dingminhua__dsh-connect-workbuddy.yml`
- **CI**：`check` 与 `Submission gate` 均已通过 ✅
- **合并**：等待维护者 review 合并（对方仓库，需等）
- **截图**：声明在**本项目自己仓库**的 [`screenshots.json`](../screenshots.json)，未修改注册表 `data/screenshots.json`（该文件是旧约定回退，禁止再加新键）

## 收录目录规范（依据 [contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)）

- 每个插件一个 YAML：`data/plugins/<owner>__<repo>.yml`
- 字段：
  - `url`：与仓库地址**完全一致**
  - `name`：`owner/repo`
  - `category`：有效值之一（本项目为 `model`）
  - `description.en`：必填，一行，以句号结尾；含 `: ` 必须加引号
  - `description.zh`：可选，维护者会补
- 前置要求：
  - 仓库 `package.json` 声明 `dsh.bundle` manifest（本项目 `dsh.bundle.patch: ./cordis.patch.yml`）
  - 仓库打 `dsh-plugin` topic
  - 仓库满 1 天、提交数 ≥ 10（CI 自动检查）
- README（`README.md` / `README.zh.md`）由脚本生成，**不要手工编辑**；改 YAML 后执行：
  ```sh
  npm ci
  node scripts/generate-readme.mjs
  ```
- 一个 PR 最多收录 3 条；只改自己的条目。

## 更新步骤（改条目内容时）

1. 修改本目录的 `dingminhua__dsh-connect-workbuddy.yml` 草稿
2. 在 fork 分支 `add-dsh-connect-workbuddy` 上同步修改 `data/plugins/dingminhua__dsh-connect-workbuddy.yml`
3. 重新生成 README（见上）
4. 推送，PR 自动重跑 CI

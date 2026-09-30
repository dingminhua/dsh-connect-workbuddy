# 发布流程（Release Flow）

> 本文档是 `dsh-connect-workbuddy` 的**唯一权威发布流程**。发布前请通读一遍。

## 前置条件

- npm 已登录：`npm whoami` 应显示 `dmh2002`（若报 `need auth`，先 `npm login`）。
- 账号若开启 2FA（两步验证）：`npm publish` 时需**在浏览器确认一步**。
- GitHub 仓库：`https://github.com/dingminhua/dsh-connect-workbuddy`（默认分支 `main`）。
- `gh` 已登录且带 `repo` 权限：`gh auth status` 应显示 `Logged in to github.com account dingminhua`、scope 含 `repo`（第 9 步要用）。

## 每次发布的完整步骤

### 1. 确认代码、测试与版权

```bash
cd /Users/dmh2002/DshProject/dsh-connect-workbuddy
pnpm run check        # typecheck + test + build，应全部通过
grep -F "Copyright (c) 2026 LaoDing" LICENSE
```

> 本项目以 MIT 许可证发布，版权归属必须保持为 **LaoDing**；发布前不得把 LICENSE 中的版权主体改成 npm 账号、GitHub 账号或其他名称。

### 2. 核对溯源与致谢（**不得跳过**）

本项目建立在他人已公开的工作之上。每次发布前必须确认：

```bash
# 第三方声明随包分发
grep -F "THIRD_PARTY_NOTICES.md" package.json   # 应在 files 白名单内

# 双语 README 的致谢章节仍在
grep -F "corrinehu/dsh-workbuddy-connect" README.md README.en.md
grep -F "dingminhua/dsh-connect-trae" README.md README.en.md
grep -F "dsh-codex-connect" README.md README.en.md   # 唯一的 Apache-2.0 参考项
```

核对清单：

- [ ] `THIRD_PARTY_NOTICES.md` 在 `package.json` 的 `files` 白名单中，随包分发
- [ ] README 与 README.en.md 的致谢章节列出全部参考项目及许可证
- [ ] `dsh-codex-connect`（Apache-2.0）的声明义务在 `THIRD_PARTY_NOTICES.md` 中单独履行
- [ ] 本轮新增/修改的源文件，头部注释标注了参考来源（见 `docs/DESIGN.md` 第 5.3 节）
- [ ] 若引入了新的 WorkBuddy 相关依赖或复用了他人代码，`THIRD_PARTY_NOTICES.md` 已同步更新

### 2.5 平台核对（Windows 是一等目标平台，**不得跳过**）

每次发布前过一遍 [`docs/WINDOWS.md`](docs/WINDOWS.md) §4 的检查清单，并确认：

```bash
# CI 矩阵必须同时覆盖 windows-latest 与 ubuntu-latest
grep -n "windows-latest\|ubuntu-latest" .github/workflows/ci.yml

# 平台登记文件存在，且 README 的「平台支持」一节仍在
ls docs/WINDOWS.md
grep -n "## 平台支持" README.md
grep -n "## Platform support" README.en.md
```

核对清单：

- [ ] 本次改动未破坏 Windows 行为；若涉及 `docs/WINDOWS.md` §1 列出的五处分支，已在那里登记
- [ ] 新增测试在任意主机上都能跑（注入 `platform`/`home`/`env`），未断言「跑测试的机器是什么平台」
- [ ] 若新增了 spawn 子进程的代码：已设 `windowsHide: true`（宿主无控制台，漏设即闪黑框——**在终端里验证不出来**）
- [ ] 平台结论的措辞与 `docs/WINDOWS.md` §2 的证据档位相称（**C 档不得写成「已验证」**）
- [ ] 两份 README 的「平台支持」表与本文件、`docs/WINDOWS.md` 三者一致
- [ ] 若本次修复的是 Windows 专有故障：已在 `docs/WINDOWS.md` §3 的历史表补一行

### 2.6 宿主范围核对（peer 上界，**不得跳过**）

每次发布前确认声明的宿主范围与当前 DSH 线一致。**上界写错不会让任何构建或测试失败**——它只在下一个 DSH 版本落地那一刻生效，且用户侧表现为插件**静默消失**（组合包被 `loadProfileDirectory` 跳过，只打到 stderr），详见 CHANGELOG 的 2.1.2 一节。

```bash
# 所有 dsh-* peer 必须是同一条范围，且上界带 -0（DSH 至今只发预发布）
grep -c '">=0.1.7-rc.1 <0.3.0-0"' package.json

# 宿主线是否已经前进？有 0.3.x 的 tag 就说明该复核上界了
git -C ../deepseek-harness tag -l 'dsh-v0.3.*'
```

核对清单：

- [ ] `package.json` 里全部 `dsh-*` peer 范围完全一致（`tests/dsh-line.spec.ts` 会强制这一点）
- [ ] 上界仍是 `<0.3.0-0`；若 DSH 已进入 0.3.x 线，先在真机或 tag 上复核再决定是否放宽，**不要只改数字**
- [ ] 上界带 `-0` 后缀（写成 `<0.3.0` 等于不挡：DSH 至今全部 tag 都是预发布，围栏会静默失效）
- [ ] 两条 README 的「受支持的宿主范围」表与 `package.json` 三者一致
- [ ] 若本次放宽了上界，已在 `CHANGELOG.md` 说明**依据**（哪些包、如何复核），而不是只写「支持新版本」

### 3. 更新版本号

手动改 `package.json` 的 `version` 字段。

> 后续步骤以目标版本号 `X.Y.Z` 指代。

### 4. 更新 CHANGELOG.md

在 `CHANGELOG.md` 顶部新增一节 `## X.Y.Z (YYYY-MM-DD)`，按 `Features` / `Fixes` / `Docs` 分组记录本次变更。

### 5. 提交并打 git tag

```bash
git add package.json CHANGELOG.md README.md README.en.md THIRD_PARTY_NOTICES.md
git commit -m "chore: 版本升级至 X.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z: <一句话说明>"
git push origin main
git push origin vX.Y.Z
```

> ⚠️ **tag 必须指向包含本次代码的提交**。若目标 tag 已存在且指向旧提交，需先删除并强制移动，修正后用 `git rev-list -n1 vX.Y.Z` 确认指向当前 HEAD。
>
> 这里的 `-m` 用**冒号**（`vX.Y.Z: <一句话>`），第 9 步 Release 的 `--title` 用**破折号**（`vX.Y.Z — <一句话>`）——两者措辞可以不同，但都必须是同一件事的一句话说明。**打完 tag 别忘了第 9 步。**

### 6. 发布到 npm

```bash
npm publish
```

> ⚠️ **`npm publish` 成功退出（exit 0）不等于版本已上线。** 本账号/包现在会走 npm 的**暂存发布（staged publishing）**：此时 registry 返回 **`202 Accepted`**，npm 把它当成功（打印 `info ok`、退出码 0），但版本只是进了**暂存区**，**公开的 packument 里看不到**，用户也装不到。
>
> **判据**：`npm publish` 只报 `PUT 202` / `info ok`（**没有** `+ dsh-connect-workbuddy@X.Y.Z` 那一行），且第 8 步直连核验里 `latest` 仍是旧版本 —— 那就是**待批准**，不是失败。
>
> **必须再由维护者用 2FA 批准**：到 npmjs.com 的 **Staged Packages** 标签页点 **Approve**；或在 npm CLI **≥ 11.15.0** 下用 `npm stage approve <stage-id>`（本机 npm 若是 11.12.x，`npm stage` 会报 `Unknown command`——那是 CLI 太旧，不是命令不存在）。详见[常见问题](#常见问题)。

**打包内容**：`package.json` 的 `files` 字段已限定只发布 `lib/`、`docs/assets/` 产品截图、`screenshots.json`、`cordis.patch.yml`、`README.md`、`README.en.md`、`CHANGELOG.md`、`THIRD_PARTY_NOTICES.md`、`LICENSE`，`tests/` 和 `node_modules/` 不会进入发布包。

**发布前检查**（可选但推荐）：

```bash
npm pack --dry-run
```

### 7. 2FA 确认（若账号开启两步验证）

> **本项目约定：用浏览器授权，不用 `--otp` 方式。** `npm publish` 若提示 EOTP，按 npm CLI 给出的 URL 在浏览器登录确认即可，终端内的 `npm publish` 会自动继续。**不要**用 `npm publish --otp=<6位验证码>` 绕过——那是命令行验证码方式，本项目账号绑定的是浏览器授权。

> ⚠️ **这一步必须在交互式终端里做。** npm 在 stdout 不是 TTY 时（管道 `| tail`、重定向、后台任务、CI、agent 的 shell）会**印出被遮蔽的授权链接**（`…/auth/cli/***`，日志里也捞不回来）并**立刻退出**，不会等待浏览器确认——于是既拿不到链接、也没有进程接着上传。需要 2FA 的发布会话请直接在自己的终端跑 `npm publish`。详见[常见问题](#常见问题)里那条 EOTP 条目。

若浏览器打开的验证 URL 失效（404），重跑一次 `npm publish` 让 npm 生成新的授权链接，再在浏览器确认。

### 8. 验证发布成功

```bash
npm view dsh-connect-workbuddy --prefer-online version            # 应显示 X.Y.Z
npm view dsh-connect-workbuddy --prefer-online dist-tags.latest   # 应为 X.Y.Z
```

**权威验证（必须用这条，绕开本机代理缓存）**：

```bash
curl -s --noproxy '*' -H "Cache-Control: no-cache" https://registry.npmjs.org/dsh-connect-workbuddy \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('latest:',j['dist-tags'].latest);console.log('has X.Y.Z:',!!j.versions['X.Y.Z']);console.log('published:',j.time['X.Y.Z'])})"
```

应打印 `latest: X.Y.Z` 与本次发布时间。**再核对 tarball 的 shasum 与本地 `npm pack --dry-run` 输出一致**，确认上传的就是本次构建的代码。

> ⚠️ **本机 `~/.npmrc` 配了本地代理（`proxy`/`https-proxy`，端口 7897）**，`npm view` 与普通 `curl` 会走代理并可能读到**缓存的旧版本**，从而把一次**成功**的发布误判成失败（v1.4.0 发布时就这样误报了）。验证发布**只认上面那条 `--noproxy '*'` 的直连命令**，不要用裸 `npm view` 下结论。
>
> 刚发布后 registry 读缓存也可能有短暂延迟，稍等重查即可。

### 9. 创建 GitHub Release（**最容易漏，本次就差点漏掉**）

**npm 发布成功不等于发布完成。** 自 `v1.4.0` 起每个版本都在 GitHub 上有一份 Release——它是用户从 GitHub 进入时的第一屏，也是 tag 对外的说明。但本文件此前**没写这一步**，历史上已经漏过三次（`v2.0.0`、`v2.0.16`、`v2.0.17`），`v2.1.1` 的 Release 也比 npm 发布**晚了将近两天**才补上。做完第 8 步请立刻做这一步。

```bash
gh release create vX.Y.Z \
  --title "vX.Y.Z — <一句话说明>" \
  --notes-file /tmp/release-X.Y.Z.md \
  --verify-tag
```

- **`--verify-tag`（务必带上）**：tag 必须已存在（第 5 步推过）。漏了它，命令会在 tag 不存在时**悄悄新建一个指向当前 HEAD 的 tag**——那可能不是你发布的那次提交。
- **`--title` 的形态是 `vX.Y.Z — <一句话>`**（破折号 `—`，**不是** tag message 里的冒号 `:`）。这样与 `gh release list` 里历史各版的形态一致，且标题比 tag 那一行可以稍长一点。
- **`--notes-file` 指向临时文件**。不要用 `--notes-from-tag`（tag message 只有一行，正文会空得离谱），也不要用 `--generate-notes`（那是自动生成的 commit 列表，历史各版没有一个是这个形态）。
- 不加 `--draft`、不加 `--prerelease`：历史各版都是正式发布。
- **不附任何构建产物**：本插件经 npm 分发，不通过 Release 发二进制。历史所有 Release 的 `assets` 都是空的，不要在这一步突然开始塞 `.tgz`。

**正文的形态**（注意：它与 `CHANGELOG.md` 里那一节**不是同一份文本**）：

```markdown
# <一个主题 emoji> vX.Y.Z — <比 --title 再完整一档的一句>

<本版主线，一到两段；有两条主线就点名。>

---

## 一、<主题>
## 二、<主题>
```

- H1 带一个主题 emoji（如 2.1.1 用的 🪟），副标题比 `--title` 更长一档。
- 正文按 **`## 一、` `## 二、` 主题**分节，而不是照抄 CHANGELOG 的 Features / Fixes / Docs 分组：CHANGELOG 是逐条变更记录，Release 是**可独立阅读的发布公告**，可以更展开（贴真机取证、对照表、失败判据、修法）。历史各版正文在 90–100 行。
- 允许表格、引用块、行内代码、`---` 分隔线。

核对清单（**做完逐条勾掉**）：

- [ ] `gh release list` 里能看到本次版本，标题以 `vX.Y.Z — ` 开头（破折号）
- [ ] Release 指向的 tag 与第 5 步推的是同一个：`gh release view vX.Y.Z --json tagName`
- [ ] 不是 draft、不是 prerelease
- [ ] `assets` 为空（与历史一致）
- [ ] 正文不是 CHANGELOG 的复制粘贴，单独读也讲得通

```bash
# 一次确认以上五点
gh release view vX.Y.Z --json name,tagName,isDraft,isPrerelease,assets
```

> **为什么这一步必须写进文件**：它对 CI、对 npm、对测试**都没有任何影响**，所以漏掉时不会有任何东西报错——这正是它历史上漏了三次的原因。它只能靠「发布清单里写着」来保证。

## 常见问题

- **`npm publish` 报 EOTP**：账号开启了 2FA，**按第 7 步在浏览器授权**（npm CLI 给出的 URL），不要用 `--otp=<码>` 命令行方式——本项目账号绑定的是浏览器授权。链接 404 就重跑 `npm publish` 生成新链接。
- **`npm publish` 报 EOTP，但拿不到授权链接、而且它一闪就退出了**：这一步**必须在交互式终端里跑**。npm 只在 stdout 是 TTY 时才**自动打开浏览器**、并**留在原地等待**授权；一旦进了管道、重定向或后台任务（`| tail`、`> log 2>&1 &`、CI、agent 的 shell），这条路径会有两处直接断掉：
  - 授权链接被**npm 自己**印成 `https://www.npmjs.com/auth/cli/***`——`***` 是 npm 遮蔽的，不是终端或日志工具的加工；`~/.npm/_logs/*-debug-0.log` 里同样只有 `***`，事后也捞不回来；
  - 它**不等待**，打印完 `EOTP` 立刻退出，浏览器里确认完也没有进程接着上传。

  所以：**需要 2FA 的发布会话，请直接在自己的终端执行 `npm publish`**，别在管道 / 后台 / 自动化里跑；也不要为了让输出好看而加 `| tail`。判断是否真的发布成功，仍以第 8 步为准（`npm publish` 输出里的 `+ dsh-connect-workbuddy@X.Y.Z` 一行，加上 `curl --noproxy '*'` 直连复核）。v3.0.0、v3.0.1 发布时都撞到这一点。
- **`npm publish` 报 409，但两种报文的含义完全相反，别混为一谈**：
  - `Cannot publish over previously staged version "X.Y.Z"` —— 该版本在 registry 上处于**暂存（staged）未提交**状态。它**不是**「已发布」：此时 `latest` 与 packument 里**都还看不到**这个版本。常见来源是需要 2FA 而中途没走完的那次发布请求。**先别急着改版本号**——稍等重试，或在 npm 网站上批准/丢弃这次暂存，它就可能被提交掉。
  - `You cannot publish over the previously published versions: X.Y.Z` —— 这才是**已经发布成功**。此时第 8 步的直连核验会显示 `latest: X.Y.Z`，tarball 也能下载。

  有一条很实用的判据：**报错从「staged」变成「previously published」，说明中间那次其实已经成功落地**。v3.0.0 发布时就是这样——先看到 staged 的 409，再看到 published 的 409，而 registry 上的发布时间戳正好落在两次尝试之间（即另有一次发布在窗口内完成）。因此**任何时刻都以第 8 步的直连核验为准**，不要凭 `npm publish` 的退出码或某一次报文下结论；两次发布若来自不同的人/会话，只要比对 tarball 的 shasum 一致，就说明发的是同一个构建，没有版本分叉。
- **`npm publish` 明明成功了（exit 0 / `info ok`），registry 上却查不到新版本**：本账号/包会走 npm 的**暂存发布（staged publishing）**——registry 返回 **`202 Accepted`**，npm 视之为成功，但版本只进了**暂存区**，**未公开**：packument 里没有它、`latest` 不变、用户装不到。别把它当成「发布失败」去重试，更**不要**改版本号重发（那只会再多一个待批准的暂存版本）。
  - **怎么认出来**：`npm publish` 的输出里**没有** `+ dsh-connect-workbuddy@X.Y.Z` 那一行（只有 `PUT 202` / `info ok`），且第 8 步直连核验显示 `latest` 仍是旧版本。
  - **怎么批准**（**必须由维护者带 2FA 操作**）：到 **npmjs.com → Staged Packages** 标签页，核对后点 **Approve**；或在 npm CLI **≥ 11.15.0** + Node **≥ 22.14.0** 下执行 `npm stage approve <stage-id>`（`npm stage list` 可以先列出待批准的版本）。
  - **为什么本机 `npm stage` 用不了**：本机 npm 是 **11.12.x**，而暂存发布的 CLI 支持从 **11.15.0** 才有——`npm stage` 会报 `Unknown command: "stage"`，那是 **CLI 太旧，不是命令不存在**。要么升级 npm，要么直接用网页批准。
  - 参考：[Staged publishing for npm packages](https://docs.npmjs.com/staged-publishing/)。v3.0.0、v3.0.2 发布时都撞到这一点，且**两次都不是失败**——版本最终是在维护者批准后才出现在 registry 上。
- **发布后 `npm view ... version` 还是旧版本 / 甚至 `@新版本` 报 404**：**先别断定发布失败**。本机 `~/.npmrc` 的本地代理会缓存 registry 响应——用第 8 步的 `curl --noproxy '*'` 直连命令复核，或 `npm view --prefer-online`。v1.4.0 发布时就是这样被误判过一次。真正的失败特征是：`npm publish` 输出里**没有** `+ dsh-connect-workbuddy@X.Y.Z` 那一行。
- **`npm whoami` 报 E401**：说明 `~/.npmrc` 里的 `_authToken` 已失效（注意 `npm whoami` 偶尔会回显**缓存**的上一次结果，别被它迷惑）。先 `npm login --auth-type=web` 重新登录再发布。
- **本地开发与发布的关系**：本地开发用 `link:` 安装，与 npm 发布互不影响；npm 发布的包是 `lib/`、README 等静态文件，同一份源码。
- **GitHub 上没有本次 Release / `gh release list` 看不到新版本**：第 9 步漏了。npm 与 GitHub 是两条独立的发布通道，**`npm publish` 成功不会自动创建 Release**，CI 也不会——本仓库没有 release 自动化（`.github/workflows/` 只有 `ci.yml`）。补做即可：版本、tag、正文都还在仓库里，事后补建与当时创建完全等效，只是 GitHub 上的时间戳会晚。历史上 `v2.0.0`、`v2.0.16`、`v2.0.17` 就是这样漏掉的。
- **`gh release create` 报 `tag not found`**：tag 还没推。先完成第 5 步的 `git push origin vX.Y.Z`。**不要**为了让它通过就去掉 `--verify-tag`——那会让 gh 新建一个指向当前 HEAD 的 tag，可能覆盖或偏离你实际发布的提交。
- **`gh` 报 `HTTP 403` / `Resource not accessible`**：token 缺 `repo` scope。`gh auth status` 确认 scopes；需要时 `gh auth refresh -s repo`。
- **LICENSE 版权被改动**：发布前 `grep -F "Copyright (c) 2026 LaoDing" LICENSE` 必须命中；若被改成其他名称，先还原再发布。

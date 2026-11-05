# 给 DSH 0.2.2+ 插件详情页写一段 100 字以内的简介

> 可整篇转发给其他 DSH 插件作者照做。以 `dsh-connect-workbuddy` 为例，但步骤与包名无关。
> 适用宿主：DSH **0.2.2-alpha.2 及以上**（0.2.1-rc.5 及更早没有这个详情页）。
>
> ⚠️ **本插件自己不再使用这套做法。** 5.19.0 把配置界面搬去设置页后，详情页只剩
> 「这是什么」，而短简介的唯一作用就是缩短显示文本；它依赖「路径与语言链同时正确」这类
> 隐式约定，失败时静默回落到 README、界面看不出问题。所以两份 `DETAIL` 文档、两行
> `meta.detail` 与对应的守卫单测都已移除，本插件的详情页显示完整 README。
> 这篇指南保留给**需要短简介的其他插件作者**——它描述的机制仍然有效。

## 一句话结论

0.2.2 起，插件页会**把包里的 README 整篇渲染出来**。要改成一段短简介：在 `locale/*.json`
的 `meta` 里加一个 `detail`，指向一份 **100 字以内**的 Markdown 文件。宿主没有开关能关掉这个区块。

## 现象与原因

打开「插件」页 → 点开某个插件 → 名称、简介、开关下面出现一大段带反引号、issue 编号、
内部实现细节的长文。那不是插件自己写的 UI，是宿主新增的「组合包详细介绍文档」：

1. 宿主按当前界面语言，依次读 `locale/<语言>.json` 里的 `meta.detail`；
2. 找到就渲染它指向的 Markdown；
3. **一个都没找到，就回落到包根目录的 README**（`README.md` / `README.markdown` / `README`）。

我们的 README 有 700 多行，于是整篇被塞进一个 560px 高的可滚动框里。宿主把它限制了高度，
不会撑坏页面，但观感很差。相关实现：`@deepseek-ai/dsh-plugin-detail` 的 `readPackageDocument`，
以及 `@deepseek-ai/dsh-client-ui-primitives` 的 `DetailDocument`。

## 具体做法（5 步）

### 1. 新建两份短文档，放在包内任意目录

推荐 `docs/DETAIL.zh.md`（中文）与 `docs/DETAIL.md`（英文）。内容就是给普通用户看的一段话，
**不要写实现细节、issue 编号、内部路径**。

`docs/DETAIL.zh.md`（实测 92 字符，含标点）：

```markdown
把本机已登录的 WorkBuddy 接入 DSH：每次刷新按上游目录读取每个模型的积分倍率，支持逐模型图片开关与默认推理强度、多账号切换与账号池自动换号，并提供每日签到和只读积分概览。
```

`docs/DETAIL.md`（实测 96 字符）：

```markdown
WorkBuddy in DSH: live credit rates, per-model image/reasoning, account pool, check-in, credits.
```

填空模板（填完自己数一遍）：

```markdown
把 <对象> 接入 DSH：<核心能力 1>、<核心能力 2>、<核心能力 3>，并提供 <能力 4>。
```

### 2. 在**每一个** `locale/*.json` 的 `meta` 里加 `detail`

`locale/zh.json`：

```json
{
  "meta": {
    "title": "你的包名",
    "description": "卡片上的一句话简介（保持不变）",
    "detail": "docs/DETAIL.zh.md"
  }
}
```

`locale/en.json`：

```json
{
  "meta": {
    "title": "你的包名",
    "description": "One-line summary (unchanged)",
    "detail": "docs/DETAIL.md"
  }
}
```

`detail` 与 `title` / `description` 同级。注意：**`en.json` 必须写**，它是语言链的最终兜底；
只写 `zh.json` 的话，英文界面会走到「无 detail」并回落 README 全文。若还支持 ja/es 等语言，
要么各自补一份对应语言的 detail，要么接受它们显示英文版。

### 3. 把两份文档加进 `package.json` 的 `files` 白名单

有 `files` 白名单的包，没列进去的文件不会进 npm 包。加两条明确路径（不要指望
`docs/assets` 这类已有目录顺带覆盖）：

```json
"files": [
  "lib", "locale", "icons", "README.md",
  "docs/DETAIL.zh.md",
  "docs/DETAIL.md"
]
```

不需要改 `exports`：详情页是从**包目录**直接读文件的，不走模块解析。

### 4. 打包验证

```bash
# 精确数字符数（含标点与英文词，≤100）
python3 -c "import pathlib; print(len(pathlib.Path('docs/DETAIL.zh.md').read_text(encoding='utf-8').rstrip()))"

# 确认两个文件真的进了包
npm pack --dry-run 2>&1 | grep -i detail
# 或： npm pack && tar -tzf <包名>.tgz | grep -i detail
```

### 5. 界面验证（宿主 0.2.2+）

插件页 → 点开该插件，应只显示那一小段；再把界面语言切成英文，应显示英文版。
开发链接（`link:`）安装的包从本地目录读，改完刷新/重新组合即可看到；**正式发布要发新版本**，
用户侧得等新版本上架——这是包内容变更，不是配置变更。

## 100 字怎么算

按**字符总数**（汉字、标点、英文字母、数字、空格全算）≤ 100，建议控制在 80–95 留余量。
上面的中文示例 92 字符（其中汉字 72），英文示例 96 字符。别写 YAML front matter（会被剥掉）、
别用原始 HTML（宿主 `omitHtml` 忽略）、别放相对图片（短文档用不上；图片要走
`/api/plugin-manager/detail-file`，且只认 PNG/JPEG/GIF/WebP/AVIF/SVG）。
宿主默认上限 1 MiB，100 字远远够。

## 五个坑，逐条核对

1. **两个语言文件都要写 detail。** 只写一个，另一种语言回落 README 全文。
2. **路径必须是包根相对、`/` 分隔、以 `.md` 或 `.markdown` 结尾**，不能含空段、`.`、`..`、
   反斜杠或 URL scheme。
3. **指向的文件必须存在、且真的打进包。** 指向不存在的文件不会「安静地回落 README」，
   而是判 `invalid`，页面显示一条错误信息加「重试」按钮，比长文更糟。
4. **别为了「不显示」删 README。** 详情页没了，npm 页面、GitHub、第三方市场索引也一起空了。
   README 继续保留完整说明，它只是不再被插件页渲染。
5. **没有开关能关掉整个区块**（plugin-manager 的 Config 里没有 `detailEnabled` 之类）。
   想接近「不显示」只能让 detail 指向一份空文档，但仍会留下一个带上下边框的空框。
   所以正解就是写一段短文案。

## 核对清单

- [ ] `docs/DETAIL.zh.md` / `docs/DETAIL.md` 已建，各自 ≤ 100 字符
- [ ] 内容与已有 `meta.description` 不重复、不含内部路径与 issue 编号
- [ ] 每个 `locale/*.json` 的 `meta` 都有 `detail`，`en.json` 一定有
- [ ] `package.json` 的 `files` 覆盖这两份文件
- [ ] `npm pack --dry-run` 能看到两个文件
- [ ] 宿主 0.2.2+ 上中英文界面各看一遍：短文案、无报错、无「重试」
- [ ] 走一次正常发版（改包内容 = 发新版本）

## 想要更稳，加一条测试

把「每个 locale 都有 detail」「指向的文件存在」「文件在 `files` 白名单里」「字符数 ≤100」
钉成一条单测，防止下次有人删文件、改路径或把文案写长。本仓库的
`tests/locale-meta.spec.ts` 就是同类守卫的现成写法。

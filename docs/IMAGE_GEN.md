# 生图 / 改图工具：`workbuddy_draw_image`

> 日期：2026-10-21 取证；2026-10-25 跨区复测 + 改图接入 · 取证与联调时版本：4.13.2（`upstream/main` = `dfe7ab3`）
> 工具名：`workbuddy_draw_image` · 国内区与国际区都能注册（逐区打开「允许模型自主生图」）
> 真实成本：**按区不同**——国内区实测 **5.71** 积分/张（一次真实联调花掉 5.71），国际区实测 **0.03** 积分/张

## 结论

1. **WorkBuddy 的生图能力是官方 CLI 的一等能力，不是网页端私有的。** 端点
   `POST {chatBase}/v2/images/generations`，请求体只有 `model` / `prompt` / `size`
   （`n` 仅 hunyuan 系带），响应是 `{code, msg, requestId, data:{created, data:[{url}],
   usage:{credit}}}`。国内区 `chatBase` 是 `https://copilot.tencent.com`
   （`www.workbuddy.cn` 是同集群另一入口，两处都答 200）。
2. **产物是 24 小时有效的 COS 签名 URL，不是 base64。** 实测响应里
   `data.data[0].url` 指向 `ai-corpus-backup-1258344699.cos.ap-beijing.myqcloud.com`，
   带 `q-sign-time`（起止各 24h）。插件把这个 URL 原样交给模型与用户，并在返回值里
   写明「约 24 小时失效，要长期保留请及时下载」。
3. **两个区都有生图模型，但它们是两个不同的模型。** 国内区 `/v3/config` 的 61 条模型里
   `hunyuan-image-alpha`（`text-to-image`）与 `hunyuan-image-alpha-edit`（`image-to-image`）
   各带一个标签；国际区 29 条模型里 `hy-image-3.5` **同时**带 `text-to-image` 与
   `image-to-image`。所以工具**两个区都注册**，用哪个区由「哪个区既启用了供应商、又打开了
   「允许模型自主生图」」决定，两区都符合时**优先国内区**（这是唯一向后兼容的顺序：本功能
   此前只能走国内区，升级不能悄悄把老用户的支出挪到另一个网关）。两区的媒体模型目录**完全
   不重叠**，**5.71 与 0.03 是两个模型 × 两个区域共同变化的结果，不是同一张图的跨区差价**；
   两个区的积分池也各自独立，两个数字之间没有任何汇率含义。
4. **模型目录要多读一次同一份文档。** 生图工具需要 `data.models` 里的媒体标签，
   而聊天目录投影时会把它们丢掉，所以它**另外发一次只读 GET** `/v3/config`（国内区
   同样走 `/v3` → `/v2` 降级，与聊天目录一致），工具侧对结果做 5 分钟缓存。它只读、
   不花积分，但每次冷缓存确实多一次请求——如实记在这里，不要写成「零新增请求」。
5. **它是「花钱」的工具，所以按花钱的工具对待。** 缺省即**独占执行**
   （`isConcurrencySafe` 不声明），失败后 **30 秒冷却**，并且工具描述里直接写明单价，
   让模型自己知道「不要为了试错连续调用」。**冷却只看「请求是否真的发出去了」**：
   读目录失败、参数写错、未登录都没花钱，不冷却。

## 工具契约

| 项 | 值 |
| --- | --- |
| 名称 | `workbuddy_draw_image` |
| 参数 | `prompt`（必填，非空字符串）、`size`（可选，`宽x高`，默认 `1024x1024`，总像素上限约 419 万，见「尺寸与比例」）、`model`（可选）、`image`（可选，字符串或字符串数组，见「改图」）。除 `prompt` 外的可选参数一律「不填（省略/null/空串）或类型正确」：`size: 1024`、`model: [...]`、`image: 123` 这类错型直接 `INVALID_ARGS` 且不发请求，不会静默回落默认值或切换模式 |
| 输出 | `url`、`mode`、`model`、`prompt`、`hint` 必填；`credit`、`path` 可选 |
| 超时 | 180 000 ms（实测单张 12.9–38.7 秒，留足余量） |
| 执行模式 | 独占（不声明 `isConcurrencySafe`） |
| 注册条件 | 宿主有 `tools` 服务，且**至少一个区**既启用了供应商（`regionEnabled`）又打开了该区的「允许模型自主生图」；两区都符合时取国内区 |

`model` 填了但目录里没有时**直接报错**并列出可用模型，不会把不存在的模型 id 发上去
换一个上游 404——那样报错只会是「route config not found」，读者无从知道是名字写错了。

## 尺寸与比例

`size` 就是上游的 `size` 字段，**原样透传**（`buildImageBody` 不做任何换算、不缩放、
不降采样）。比例完全由宽高决定，方图只是默认值，不是唯一选项。

上限是**总像素约 419 万**（不是长边、也不是固定白名单），2026-10-25 逐档实测得出：

| 请求尺寸 | 结果 | 实际输出 | 像素 |
| --- | --- | --- | --- |
| `1024x1024` | ✅ | 1024×1024 | 1.05 MP |
| `1024x1536` | ✅ | 1024×1536 | 1.57 MP |
| `1536x1024` | ✅ | 1536×1024 | 1.57 MP |
| `2048x1152` | ✅ | 2048×1152 | 2.36 MP |
| `2048x1536` | ✅ | 2048×1536 | 3.15 MP |
| `2560x1440` | ✅ | 2560×1440 | 3.69 MP |
| `2560x1600` | ✅ | 2560×1600 | 4.10 MP |
| `2048x2048` | ✅ | 2048×2048 | 4.19 MP |
| `2560x2560` | ❌ 拒绝 | — | 6.55 MP |
| `3072x3072` | ❌ 拒绝 | — | 9.44 MP |
| `4096x4096` | ❌ 拒绝 | — | 16.8 MP |

关键结论：**输出是真实像素，不是把大图悄悄压回原生尺寸再放大**。`2560x1440` 与
`2560x1600` 下载回来核过实际宽高，与请求一致，画面里的刻度、文字纹理是独立线条而非插值
（`2560` 档 PNG 约 4.5 MB）。被拒的尺寸是**直接报参数非法**，不会退回一个较小尺寸——
所以工具描述里必须写清上限，否则模型会往 4K 上撞。

按用途选（都在 419 万像素以内）：

| 用途 | `size` | 实测状态 |
| --- | --- | --- |
| 方图（默认）/ 头像 / 方块素材 | `1024x1024`，大图用 `2048x2048` | 两者都实测通过 |
| 横图 / 封面 / 宽幅 | `1536x1024`，大图用 `2048x1536` | 两者都实测通过 |
| 桌面壁纸 16:9 | `2560x1440` | 实测通过 |
| 打印 / 详情图 4:3 | `2048x1536` | 实测通过 |
| 手机竖屏壁纸 / 竖版海报（小） | `1024x1536` | 实测通过 |
| 手机竖屏壁纸（大） | `1440x2560` | **未单独实测**：与已通过的 `2560x1440` 像素数相同、只转 90°，按像素阈值推断可用；若被拒就先退回 `1024x1536` |

> 竖版大图那一格是**推断不是实测**——为了不把「没跑过的尺寸」写成结论，工具描述里给的是
> 通过实测的宽高（`2048x2048` / `2560x1440` / `2560x1600`），`1440x2560` 只作为
> 「手机竖屏」的推荐出现在本节，并明确标注了它的证据强度。

写进工具描述时**必须把这几种比例都点出来**：此前这里只给了一个 `1024x1024` 的例子，
模型据此把「形如 1024x1024」读成「只能出方图」，用户要竖版也只能得到方图——这不是上游
的限制，是提示词给人造成的错误先验。三档基础尺寸（`1024x1024` / `1024x1536` / `1536x1024`）
照抄官方 CLI `ImageGen` 的 `.describe()`（原文 `Image size in pixels, e.g. "1024x1024",
"1024x1536", "1536x1024"`），大图档位则是上述实测补上的——官方 schema 里没有这些例子。

官方 schema 还有 `quality` / `style` / `background` / `footnote` / `revise` 几个字段，
本插件没有暴露：只用目录与实测能确认的东西。

> **仍然没测过的部分**：阈值到底卡在像素数还是某份服务端白名单（`2560x1600` = 4.10 MP 通过、
> `2560x2560` = 6.55 MP 被拒，像是像素阈值，但没有 `2560x1638` 这种临界点样本）；
> 非 8 倍数、极小尺寸（`512x512`）是否接受也没测。描述里因此只说「约 419 万像素」这一个
> 实测边界，**不写「支持任意宽高」**。超出范围时上游直接拒绝，错误按 `UPSTREAM` 原样透传。

## 改图（image-to-image）

同一个工具、同一条命令，**给不给 `image` 决定模式**——不新增 `mode` 参数，否则就会
出现「`mode=edit` 但没图」这种自相矛盾的请求：

| 传了 `image`？ | 模式 | 走的端点 | 选模型用的标签 |
| --- | --- | --- | --- |
| 否 | 文生图 | `POST /v2/images/generations` | `text-to-image` |
| 是（单个字符串或数组） | 改图 | `POST /v2/images/edits` | `image-to-image` |

`model` 的校验也按当次模式的标签组做：拿文生图模型去改图会直接报
「目录里没有图生图模型「xxx」。可用：…」，不会把不匹配的 id 发上去换一个上游 404。

### `image` 收哪几种形态

官方 CLI 的 `processImageInput` 收下面四种，这里全部支持；**一律先归一成
`data:<mime>;base64,<b64>`** 再发上去（那是上游唯一接受的形态）。
`image` 除了单个字符串，**也收字符串数组**（多张参考图，按顺序当参考，如
`[模板图, 服装图]`）——数组会逐张归一后按序传给上游 `/v2/images/edits` 的
`image` 字段（那本来就是 data URL 数组）。数组里混了非字符串或空串、或传了
数字 / 对象等畸形值，一律报 `INVALID_ARGS`，绝不悄悄退回文生图；

| 形态 | 例子 | 说明 |
| --- | --- | --- |
| 本地绝对路径 | `C:\\Users\\me\\pic.png` | 直接读盘 |
| `file://` URL | `file:///C:/Users/me/pic.png` | 先 `fileURLToPath` 再读盘 |
| `http(s)` URL | `https://example.com/pic.jpg` | 宿主侧下载，30 秒超时 |
| data URL | `data:image/png;base64,iVBOR…` | 校验 `data:image/*;base64,` 前缀后原样使用 |
| 裸 base64 | `iVBORw0KGgo…` | 长度 ≥ 100、无路径分隔符、字符集合法才认，否则当成路径 |
| 字符串数组 | `[path1, path2]` | 多张参考图，逐张按上表规则归一，按序上传 |

**上限 8 MB**（`MAX_INPUT_IMAGE_BYTES`），超了报 `INVALID_ARGS` 并在消息里给出实际大小。
体积按**解码后的字节数**算，不按 base64 字符串长度——base64 比原始字节长约 4/3，
拿字符串长度比会把合法的 6 MB 图误判成超限。四条输入路径（`http(s)` / 裸 base64 /
本地路径 / data URL）都过同一个 `assertInputImageBytes()` 闸门，所以「空文件」与
「超限」的文案只有一份、不可能各自漂移。
**不做缩放、裁剪、格式转换**：用户给什么就传什么，免得悄悄改了输入图。mime 的判定顺序
是「HTTP `Content-Type` 的 `image/*`」→「按扩展名」→「按魔数嗅探」（PNG / JPEG /
GIF / WEBP / BMP，兜底 `image/png`）。

### 输入图的失败不进冷却

读不到文件、下载失败、格式不对、体积超限——这些**请求一次都没发出去**，一分钱没花，
所以统一走 `INVALID_ARGS`，不触发 30 秒冷却（冷却只看「请求是否真的发出去了」）。
紧接着再调一次仍然能立刻执行。

> 这条闸门曾经漏掉 data URL 一条路径：`resolveImageInput` 的 `data:` 分支校验完格式就
> `return`，超限的 data URL 会被原样发到上游，再按「已计费失败」吃一次冷却。四条的
> 检查合并到同一个 `assertInputImageBytes()` 之后不再可能各自漂移，回归用例见
> `tests/image-gen.spec.ts` 的「超限的 data URL → INVALID_ARGS」。

### 每组只有一个模型，所以卡片只做只读清单

两个区今天每个标签组都只有 1 个模型（国内区 `hunyuan-image-alpha` /
`hunyuan-image-alpha-edit`，国际区 `hy-image-3.5` 同时带两个标签）。给长度 1 的列表
配下拉框是假选择，所以卡片只显示「这区有哪些媒体模型、各带什么标签」的只读清单
（视频那两个标签组各有 2 个模型，那边是可钉的——见 [VIDEO_GEN.md](./VIDEO_GEN.md) 的「卡片上按模式
钉住模型」）
（`POST /plugins/dsh-connect-workbuddy/media-models`，只读免费，宿主侧缓存 5 分钟，
卡片上的「重新读取」带 `refresh=1` 跳过缓存）。切换能力的方式就是工具的 `model` 参数。

为什么这条端点和 `models/refresh` 分开：聊天目录投影时会把媒体条目丢掉（`selectCliModels`
不认它们），所以刷新聊天目录永远看不到图像模型；这条端点返回的是未经投影的媒体条目。
## 上游协议

请求头（`imageHeaders()`，`src/upstream.ts:1026`）：

```
Authorization: Bearer <accessToken>
Accept: application/json, text/plain, */*
Content-Type: application/json
User-Agent: WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0
X-Product: SaaS
X-Requested-With: XMLHttpRequest
X-User-Id / X-No-User-Id: 1
X-Enterprise-Id / X-No-Enterprise-Id: 1
X-Domain / X-No-Department-Info: 1
X-Conversation-Id / X-Conversation-Request-Id / X-Conversation-Message-Id: <每请求新 UUID>
```

**刻意不带 `Origin` / `Referer`**：取证探针就是这套头拿到 200 的，多带两个头只是多一个
可能被网关拒掉的变量，没有收益。

请求体按官方 CLI 的 `buildBaseRequestBody` 分支（`buildImageBody()`）：

- `hunyuan-*`：`{model, prompt, size, n: 1}` —— **只**加 `n`，不加 `response_format`；
- `gemini-*`：`{model, prompt, size}` —— 什么都不加；
- 其它：`{model, prompt, size, response_format: 'b64_json'}`。

响应解析（`parseImageResponse()`）：先看信封 `code`（HTTP 200 也可能 `code !== 0`），
再取 `data.data[0]` 的 `url` 或 `b64_json`，最后从 `data.usage.credit` 读实际扣费。
上游给了 base64 时，插件落盘到系统临时目录下的 `workbuddy-image-gen/`
（`os.tmpdir()` 派生，macOS 是 `$TMPDIR`、Linux 是 `/tmp`、Windows 是 `%TEMP%`）
里的 `<model>-<时间戳>.png`，返回 `file://` URL 与本地绝对路径——不让 2 MB 的
base64 直接灌进对话。

## 失败分类与冷却

| HTTP | code | 说法 |
| --- | --- | --- |
| 401 / 403 | `AUTH` | 提示重新登录 |
| 404 | `NO_ROUTE` | 提示该区没有生图路由 |
| 429 | `RATE_LIMIT` | 提示限流 |
| 其它 | `UPSTREAM` | 抽信封里的 `msg` |

冷却只对**真的发过请求**的失败生效（`AUTH` / `RATE_LIMIT` / `NO_ROUTE` / `UPSTREAM` /
`EMPTY_RESULT`，以及非本模块的异常）。参数写错、未登录、目录里没有模型这三类**不进冷却**
——它们一分钱没花，冷却只会让人以为工具坏了。

## 安全

- **凭据不出宿主进程**：工具在宿主侧执行，token 只用于这一次 `fetch`，不进对话上下文、
  不进页面。与积分读数那条链路的边界一致。
- **桌面 App 的认证文件始终只读**：`WORKBUDDY_AUTH_FILE` 只在测试里用来指向它，
  生产路径读的是插件自己的凭据库。

## 取证与联调记录

- **模型发现**：国内区 `/v3/config` → `selectMediaModels(data.models, 'text-to-image')`
  → `[{"id":"hunyuan-image-alpha","name":"Hunyuan Image Alpha","tags":["text-to-image"]}]`。
- **真实出图（国内区）**：同一凭据 `POST /v2/images/generations` → HTTP 200、12.9 秒、
  `credit: 5.71`、COS 签名 URL；下载产物 2 065 707 字节、PNG magic
  `89-50-4E-47-0D-0A-1A-0A`、1024×1024，画面与提示词一致（水彩橘猫、窗台、暖光），
  右下角带「AI生成 WorkBuddy」水印。
- **真实出图（国际区，2026-10-25）**：凭据来自 `www.workbuddy.ai`，
  `POST /v2/images/generations` + `hy-image-3.5` → HTTP 200、`credit: 0.03`，
  产物同样是 COS 签名 URL（`ap-singapore` 桶）。`buildImageBody` 的「其它」分支
  （带 `response_format: 'b64_json'`）被原样接受，**协议层不用改**。同一轮探针还确认
  国际区 `/v2/api-keys` 回 503、`/agenttool/v1/tempkey` 回 500，而国内区后者回 200 ——
  即「3D 那条临时密钥链路」在国际区整个不存在（图片走的是产品内置的 ImageGen，不经它）。
- **尺寸边界（2026-10-25 逐档实测，国内区 hunyuan-image-alpha）**：从 `1024x1024` 起逐档加码，
  `2048x2048`（4.19 MP）、`2048x1536`、`2048x1152`、`2560x1440`、`2560x1600`（4.10 MP）
  全部成功且输出宽高与请求一致；`2560x2560`（6.55 MP）、`3072x3072`、`4096x4096` 均被
  直接拒绝。据此把上限登记为「总像素约 419 万」，并据此改写工具描述——此前描述只有
  1024 系例子，模型会低估能力（也曾在别的对话里断言「原生上限约 1536 长边」，
  被这批实测推翻）。
- **测试**：`tests/image-gen.spec.ts` 62 条，覆盖模型筛选与去重（含多标签 `MEDIA_TAGS`）、
  `pickMediaModel` 按标签组校验（含国际区
  `hy-image-3.5` 两组都能选、拿文生图模型去改图的报错文案）、`buildEditBody`、
  输入图归一（mime / 魔数嗅探 / data URL 解析 / 裸 base64 判定）、改图走
  `editImage` 且 `mode: 'edit'`、输入图读不到报 `INVALID_ARGS` 且不进冷却、
  三分支请求体、响应解析（url / b64 / `code !== 0` / 空结果）、失败分类、工具的
  schema 形状与「返回值键严格落在 `output.schema` 里」、冷却只对计费失败生效、
  目录 TTL 只读一次、base64 落盘、`render` 的 markdown、小数积分原样印出（0.03 不会被
  抹成 0），以及 `size` 描述的三条断言——方 / 竖 / 横三种比例的例子、大图档位
  （`2048x2048` / `2560x1440`）与「约 419 万像素」上限（只给方图例子会让模型把比例
  锁死成 1:1；不写上限会让它往 4K 撞）。`tests/image-tool-optin.spec.ts` 12 条，覆盖
  逐区 opt-in、`imageToolRegionOf` 的两区优先级与「区关着时勾选不算授权」。

## 没做的事（如实登记）

- **视频（`/v2/videos/generations`）现已独立成工具 `workbuddy_draw_video`**，
  详见 [VIDEO_GEN.md](./VIDEO_GEN.md)。它的要点是：**视频是异步任务**，不是同步生图——
  `submitVideo()` 只拿到 `taskId`，还要 `pollVideoTask()` 轮询到 `completed`、
  再 `downloadVideo()` 把视频拉到本地才算完成。旧版本文档里写的「加视频只是接一次
  `submitVideo()`」少了轮询 + 下载两段，已在 VIDEO_GEN.md 的「与『只接一次 submitVideo()』
  的旧说法对账」一节纠正。参数层与选模型层（`MEDIA_TAGS`、`VIDEO_TAG_*`、卡片清单、`fetchMediaModels`）
  确实可复用，但执行层是全新异步代码；卡片的视频行也与图像行不同，可按模式钉模型。
- **国际区已支持**（2026-10-25 起）：国际区目录里的 `hy-image-3.5` 带 `text-to-image`，实测可用；
  此前「国际区一条都没有」的观测已过期，不要再据此禁用它。
- **不做批量**：一次调用一张图、一份积分。没有「一次画四张」的参数——那是一次不可控支出。

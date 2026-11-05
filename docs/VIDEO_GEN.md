# 视频生成工具：`workbuddy_draw_video`

> 日期：2026-10-25 取证 + 联调设计 · 取证版本：4.13.2（`upstream/main` = `dfe7ab3`）
> 工具名：`workbuddy_draw_video` · 国内区与国际区都能注册（逐区打开「允许模型自主生视频」）
> 真实成本：花积分的**异步任务**——提交一次只扣「任务受理」，真正扣积分发生在任务
> `completed` 时（见「上游协议 / 计费」）；时长越长、分辨率越高，实扣越多。

## 结论

1. **WorkBuddy 的视频能力是官方 CLI 的一等能力，端点是异步任务，不是同步请求。**
   `POST {chatBase}/v2/videos/generations` 只返回一个任务 id（`data.id`）；真正的视频
   要再 `POST {chatBase}/v2/videos/tasks` 带着 `{task_id}` 轮询，直到
   `status === 'completed'`（或 `failed`），再从 `data.videos[].url` 把每条视频
   `GET` 下来。**它和生图（一次同步请求拿 `url`）是两套完全不同的执行模型**，本插件
   的生图代码**不能直接复用**，必须另写一段「提交 → 轮询 → 下载」的异步流程。
2. **视频是花钱的异步任务，所以按「异步花钱任务」对待。** 缺省即**独占执行**
   （不声明 `isConcurrencySafe`），失败后 **60 秒冷却**，工具描述里写明这是异步任务、
   可能要等几十秒到几分钟。**冷却只看「请求是否真的发出去了」**：读目录失败、参数写错、
   未登录、图片读不到都没花钱，不冷却；而 `submitVideo` 失败（已受理任务、已花钱）、
   `pollVideoTask` 失败、`downloadVideo` 失败都视为已花钱，进冷却。
3. **两个区都有视频模型，但同样是两个不同的模型目录。** 国内区 `/v3/config` 里
   `kling-video-v3` 与 `minimax-video-h3` 各带 `text-to-video` 与 `image-to-video`；
   国际区 `kling-video-v3` **同时**带这两个标签。工具**两个区都注册**，用哪个区由
   「哪个区既启用了供应商、又打开了「允许模型自主生视频」」决定，两区都符合时**优先国内区**
   （向后兼容：本功能此前只走国内区）。两区的媒体模型目录**完全不重叠**，积分池也各自独立。
4. **模型目录要多读一次同一份文档，和生图走同一条只读链路。** 视频工具需要
   `data.models` 里的媒体标签，而聊天目录投影时会把它们丢掉，所以它另外发一次只读
   `GET /v3/config`，工具侧做 5 分钟缓存（`VIDEO_MODEL_TTL_MS = 5 * 60_000`）。
   它只读、不花积分，但每次冷缓存多一次请求——如实记在这里。
5. **视频模型带 `videoGeneration` 模型级配置**（`resolutions[]` / `defaultResolution` /
   `defaultSeconds` / `minSeconds` / `maxSeconds`），与图片模型不同。拿到这份配置时，
   时长必须落在该模型的 `[minSeconds, maxSeconds]` 内，分辨率必须在 `resolutions[]` 内
   （否则回落默认并告警；匹配大小写不敏感）。这份配置随条目下发时必须**原样保留到校验层**
   （早期版本在 `selectMediaModels` 里把它丢了，等于时长校验是死代码）。**拿不到这份配置时
   不做盲拒**
   ——原样透传用户给的时长/分辨率，让上游去判，因为目录里不一定每条都带 `videoGeneration`。
6. **模式由「有没有给 `image`」唯一决定，不新增 `mode` 参数**（与生图一致）。给图是
   图生视频（`image-to-video`，带 `image_url` / `last_image_url`，比例由输入图决定、
   不传 `aspect_ratio`）；不给图是文生视频（`text-to-video`，可传 `aspect_ratio`）。

## 工具契约

| 项 | 值 |
| --- | --- |
| 名称 | `workbuddy_draw_video` |
| 参数 | `prompt`（必填，非空字符串、≤2500 字）、`image`（可选，见「图生视频」）、`model`（可选）、`seconds`（可选，默认 5、须在模型 `[min,max]` 内）、`resolution`（可选，须在模型 `resolutions` 内）、`aspect_ratio`（可选，仅文生视频，`16:9`/`9:16`/`1:1`）、`negative_prompt`（可选，≤2500 字）、`enable_audio`（可选，默认 true）。除 `prompt` 外的可选参数一律「不填（省略/null/空串）或类型正确」：填错类型（`seconds: "10"`、`model: [...]`、`enable_audio: "true"`、`image: 123`）直接 `INVALID_ARGS` 且**一条请求都不发**，不会静默丢参、回落默认或切换模式——`image` 的单元素字符串数组与字符串等价是唯一例外。**schema 里没有的字段同样 `INVALID_ARGS`**（`size` / `ratio` / `n` / `return_base64` / `quality` 这类从生图工具、agnes 串过来的写法）：`additionalProperties: false` 只是写给模型看的，宿主把 `parameters` 原样投影、不代校验，执行层必须自己挡（`rejectUnknownArgs`） |
| 输出 | `videos`（本地 `file://` 路径数组）、`mode`、`model`、`prompt`、`seconds`、`resolution`、`hint` 必填；`credit` 可选 |
| 超时 | 570 000 ms（`VIDEO_TOOL_TIMEOUT_MS`）。**必须小于宿主的 600 000 ms 工具上限**，见下面「超时的层级」 |
| 执行模式 | 独占（不声明 `isConcurrencySafe`） |
| 注册条件 | 宿主有 `tools` 服务，且**至少一个区**既启用了供应商（`regionEnabled`）又打开了该区的「允许模型自主生视频」；两区都符合时取国内区 |

`model` 的取值顺序是 **显式参数 → 用户在卡片上给这个模式钉住的偏好 → 该区目录里这个
标签组的第一个**。显式参数填了但目录里没有（或不在当次模式的标签组里）时**直接报错**并列出
可用模型，不会把不存在的 / 不匹配的模型 id 发上去换一个上游 404——那样报错只会是
「route config not found」，读者无从知道是名字写错了。卡片上的偏好则是**软约束**：钉住的模型
已从目录里消失时静默回落到组内第一个，不让一条过期的偏好卡住一次生成（见「卡片上按模式
钉住模型」）。

## 约束与默认值

| 约束 | 值 / 处理 |
| --- | --- |
| `prompt` 长度 | ≤ 2500 字符，超出报 `INVALID_ARGS` |
| `negative_prompt` 长度 | ≤ 2500 字符，超出报 `INVALID_ARGS` |
| `aspect_ratio`（仅文生视频） | 只接受 `16:9` / `9:16` / `1:1`，非法报 `INVALID_ARGS`；图生视频不校验、且不传该字段 |
| `seconds` | 默认 `DEFAULT_VIDEO_SECONDS = 5`；拿到模型 `minSeconds`/`maxSeconds`（目录给的，或上游上一次拒绝时自报并被记下的）时越界报 `INVALID_ARGS`，否则原样透传 |
| `resolution` | 拿到模型 `resolutions[]` 时：在列内（**大小写不敏感**，命中后发目录的拼写）原样采纳，不在列内回落 `defaultResolution` 并给 `warnings`；**没拿到这份清单时原样透传**，交给上游判（与 `seconds` 同一条判据） |
| `enable_audio` | 默认 `DEFAULT_VIDEO_ENABLE_AUDIO = true` |
| `watermark` | 提交时**固定 `true`**（照抄官方 CLI `submitTask`） |

## 图生视频（image-to-video）

和生图一样，同一个工具、同一条命令，**给不给 `image` 决定模式**：

| 传了 `image`？ | 模式 | 选模型用的标签 | 额外字段 |
| --- | --- | --- | --- |
| 否 | 文生视频 | `text-to-video` | `aspect_ratio`（可选） |
| 是（单个字符串，或只含一个字符串的数组；**两张及以上 → `INVALID_ARGS`**，上游只收一张 `image_url`，不会静默改走文生视频） | 图生视频 | `image-to-video` | `image_url` / `last_image_url`（首尾帧）；比例由输入图决定，**不传 `aspect_ratio`** |

`model` 的校验按当次模式的标签组做：拿文生视频模型去图生视频会直接报
「目录里没有图生视频模型「xxx」。可用：…」，不会把不匹配的 id 发上去换一个上游 404。

### `image` 收哪几种形态

与生图输入图**完全一致**：本地绝对路径 / `file://` URL / `http(s)` URL
（宿主侧下载，`VIDEO_INPUT_TIMEOUT_MS = 30_000`）/ data URL / 裸 base64。

**五种形态全部归一成 data URL**，然后放进 `image_url`。不做缩放、裁剪、格式转换：
用户给什么就用什么，只改承载形式。

> ### 这一段曾经写反了（issue #187）
>
> 旧文档（和旧实现）说「**不读成 base64**——视频上游接受的是 `image_url`，不是
> base64」，于是 `http(s)` 这一支只发一个 `HEAD` 做可达性校验，再把 URL **原样**
> 交给上游。两个后果：
>
> 1. **`HEAD` 被 COS 拒绝。** 插件自己出图返回的是腾讯 COS 签名 URL，签名只覆盖
>    `GET`，对它发 `HEAD` 拿到 **403**。而"用上一张成功的图做首帧"是最自然的
>    路径，于是用户在最不该卡的地方卡死，报错还说的是"你的图不可达"——用 `curl`
>    明明取得到。
> 2. **上游不吃外链。** 即使 HEAD 通过，图生视频与图生图是同一条规则（PR #145
>    记录过："image 必须是 data URI，传 COS 原始 URL → invoke model error"）。原样
>    传 URL 只是把失败推迟到上游，而那时 task 已建、积分已扣。
>
> 现在与 `image-tool.ts` 的 `resolveImageInput` 严格对齐：`GET` 下载、编码成
> data URL。顺带让签名过期在上游建任务**之前**就报出可读的 `INVALID_ARGS`。

### 输入图的失败不进冷却

读不到文件、下载失败、格式不对——这些**请求一次都没发出去**，一分钱没花，统一走
`INVALID_ARGS`，不触发冷却。紧接着再调一次仍然能立刻执行。

## 卡片上按模式钉住模型

两个区今天每个视频标签组有 1–2 个模型（国内区 `kling-video-v3` / `minimax-video-h3`，
国际区只有 `kling-video-v3`）。卡片仍显示「这区有哪些媒体模型、各带什么标签」的只读清单
（`media-models` 端点，只读免费，宿主侧缓存 5 分钟）；**图像那几行只读，视频那几行可钉**。

钉住解决的是一个具体问题：国内区每个视频标签组都有 2 个模型，调用方多半省掉 `model`，
于是永远拿到目录里的第一个。口头说一次不持久，所以在卡片上按模式钉住：

- **按区、按标签存**：`regions.<区>.preferredVideoModels` 是 `{ [tag]: modelId }`。
  两种模式可能由不同模型提供，且**模型 id 不跨区**（国内区的 `minimax-video-h3` 在国际区
  不存在），所以不能只存一个 id。
- **软约束，与显式参数分工明确**：显式 `model` 是调用方为**这一次**写的，写错就报错；偏好是
  用户**以前**写的，失效就静默回落。两条规则方向相反，各自都在 `tests/video-tool.spec.ts`
  里钉住。
- **清空 = 删 key**，不是写空串：读取侧 `''` 与缺省是同一件事，写入侧也只留一种表示。
- **读值先问 Host**：与视频开关一样，`statusByRegion` 的答案优先，浏览器里的配置快照只作
  回落（0.1.7 上该 namespace 的镜像是 stale 的）。
- 钉住的 id 若已不在目录里，选择框显示「默认（组内第一个）」那一行——因为工具正是这么回落的。
- 选择框只在「该区启用 + 该区视频工具已勾上 + 目录已读到」时出现；写入走与开关同一条
  「写后回读校验」的路径（`writeRegionPreferredVideoModels`），不是裸 `scope.set`。

## 上游协议

请求头与生图同一条 `imageHeaders()`（`src/upstream.ts`）：`Authorization: Bearer`、
`Accept`、`Content-Type: application/json`、`User-Agent`、`X-Product: SaaS` 等；
**刻意不带 `Origin` / `Referer`**（与生图取证结论一致）。

### 提交（`submitVideo` → `POST /v2/videos/generations`）

请求体**完全照抄官方 CLI 的 `submitTask`**（`buildVideoBody()`）：

- 公共：`{prompt, model, seconds, negative_prompt, watermark: true}`
- 图生视频：额外 `image_url`（或 `last_image_url`）——**不传 `aspect_ratio`**
- `extra_parameters`：`{resolution, enable_audio}`；**仅文生视频**附带 `aspect_ratio`

响应解析（`parseVideoSubmission()`）：先看信封 `code`（HTTP 200 也可能 `code !== 0`），
再取 `data.id` 作 `taskId`。无 `id` 或 `code !== 0` 报 `EMPTY_RESULT` / `UPSTREAM`。

### 轮询（`pollVideoTask` → `POST /v2/videos/tasks`，体 `{task_id}`）

循环 POST 直到 `status` 终态，间隔 `VIDEO_POLL_INTERVAL_MS = 5_000`、整体上限
`VIDEO_POLL_TIMEOUT_MS = 540_000`（超时抛 `POLL_TIMEOUT`，**带 task id**）。状态机（`parseVideoTask()`）：

- `status === 'completed'`：取 `data.videos[].url` 与 `data.credit`（实扣积分）；
  若空 `videos` 当作未完成、继续轮询；上层在循环结束仍无视频时报 `EMPTY_RESULT`。
- `status === 'failed'`：返回 failed，上层抛 `TASK_FAILED`。
- 其它（含 `pending` / `running` / 未知值）：当成未完成，继续轮询。

### 超时的层级（issue #187）

一次视频调用里有三个 deadline 同时存在，**谁先到期决定了用户看到什么**：

| 层 | 常量 | 值 | 到期表现 |
| --- | --- | --- | --- |
| 宿主工具调用上限 | （宿主内置） | 600 000 ms | 裸的 `tool call timed out after 600000ms`，**丢掉 task id** |
| 插件工具层 | `VIDEO_TOOL_TIMEOUT_MS` | 570 000 ms | `POLL_TIMEOUT`，带 task id |
| 轮询循环 | `VIDEO_POLL_TIMEOUT_MS` | 540 000 ms | `POLL_TIMEOUT`，带 task id |

这三个值曾经都写作 600 000。等于同时到期，而宿主的计时器先落地，于是插件内部的
`POLL_TIMEOUT` 分支**永远没有机会执行**：用户拿到的是一个没有任何上下文的超时，
日志里也分不出是提交卡住还是轮询卡住。而 task id 恰恰是这个故障里唯一能拿去问上游
的东西，丢掉它等于把可排障的失败变成不可排障的。

现在内部两层都严格更早，并且留了 30s 给「抛错 + 下载」。`tests/video-tool.spec.ts`
里的 `video tool timeout ordering` 钉的是这个**顺序**而不是具体数字——数值以后可以
调，顺序不能反。

### 下载（`downloadVideo` → `GET <video url>`）

逐条 `GET` 视频 URL，落到系统临时目录下的 `workbuddy-video-gen/`
（`os.tmpdir()` 派生；Windows 是 `%TEMP%`），文件名 `<model>-<时间戳>.mp4`，
返回 `file://` URL 与本地绝对路径——不让视频二进制直接灌进对话。下载超时
`VIDEO_DOWNLOAD_TIMEOUT_MS = 120_000`。

### 计费

积分**不是提交时扣**，而是任务 `completed` 后由 `data.credit` 给出实扣值（在
`pollVideoTask` 阶段才拿到）。所以「计费失败」的边界是：`submitVideo` 收到受理
即视为已花钱（受理失败按 `AUTH`/`RATE_LIMIT`/`NO_ROUTE`/`UPSTREAM` 进冷却）、
`pollVideoTask` 失败 / 超时、`downloadVideo` 失败都视为已花钱（进冷却）。

### 实测单价与产物规格（2026-10-25，国内区）

积分**按次扣**，单价随区域与模型不同；同一次调用的真实扣费以返回的 `credit` 为准。
以下是国内区实测四次（全部 `enable_audio: true` 的成功任务）：

| 模式 | 模型 | 请求时长 | 实扣积分 | 折合每秒 |
| --- | --- | --- | --- | --- |
| 图生视频 | `minimax-video-h3` | 4s | 57.14 | 14.29 |
| 图生视频 | `kling-video-v3` | 4s | 68.57 | 17.14 |
| 文生视频 | `minimax-video-h3` | 5s | 71.43 | 14.29 |
| 文生视频 | `kling-video-v3` | 5s | 128.57 | 25.71 |

- `minimax-video-h3` 在两个模式下都是每秒 14.29（≈100/7），**文生 / 图生同价**；
- `kling-video-v3` 图生视频每秒 17.14（≈120/7）、文生视频每秒 25.71（≈180/7）——
  **图生比文生便宜**，不是同一条费率；
- 所以「一条 5 秒视频多少积分」不能只按模型查，要连模式一起看；两区的积分池彼此独立，
  **国内区的数字不能换算到国际区**。

四个产物的实际规格（直接解析 mp4 的 `moov` 盒得到，不靠上游自报）：

| 产物（本地时间） | 请求 → 实际时长 | 帧数 | 分辨率 | 视频码率 | 音轨 | 体积 |
| --- | --- | --- | --- | --- | --- | --- |
| `11-12-24` | 5s → 5.086s | 121 | 1280×720 | 11.47 Mbps | AAC 0.13 Mbps | 7.0 MB |
| `11-50-20` | 4s → 4.459s | 107 | 1344×768 | 3.66 Mbps | AAC 0.13 Mbps | 2.0 MB |
| `11-59-51` | 4s → 4.042s | 97 | 1280×720 | 7.93 Mbps | **无** | 3.8 MB |
| `12-03-59` | 5s → 5.167s | 124 | 1344×768 | 5.45 Mbps | AAC 0.13 Mbps | 3.4 MB |

关键结论：

1. **实际时长不等于请求的秒数**，而是模型按 24fps 出的整数帧：121 帧 = 5.042s、
   107 帧 = 4.458s、97 帧 = 4.042s、124 帧 = 5.167s，容器时长再补上音轨那几十毫秒。
   所以请求 5 秒拿回 5.09–5.17 秒、请求 4 秒拿回 4.04–4.46 秒都正常，**不要按
   「请求几秒就正好几秒」做下游裁剪假设**。
2. **容器是 H.264（`avc1`）+ AAC，24fps**，没有 HEVC / AV1 选项；`enable_audio: true`
   时不保证有音轨（上表第三条就没有），所以播放入口别假设一定有声音。
3. **分辨率不是 1080p**：实测只出现 `1280x720` 与 `1344x768` 两种，后者是 16:9 之外的
   画布尺寸（1.75:1），来自模型自己的默认值。这正是 `resolution` 只在模型 `resolutions[]`
   内原样采纳的原因——`resolution: "1080p"` 对 `minimax-video-h3` 不成立，插件回落默认值
   并给出告警原文「resolution 1080p 不被模型 minimax-video-h3 支持；改用 上游默认」。
   > **上面那条告警曾经是个假象（2026-10-25 修）**：拿不到 `videoGeneration` 的账号上，
   > `resolutions[]` 为空，旧实现把「不在清单里」与「根本没有清单」当成一回事，于是**任何**
   > 显式 `resolution` 都被静默丢掉、再回落默认，同时打印上面那句「不被支持」——看起来像
   > 上游拒绝，其实是本插件自己没把值发出去（`buildVideoBody` 收到的 `resolution` 已是
   > `undefined`，请求体里连字段都没有）。现在与 `seconds` 用同一条判据：**只有真的拿到
   > `resolutions[]` 才回落**，拿不到就原样透传交给上游判；另外清单匹配改为大小写不敏感
   > （官方 CLI 的兜底档位写的是 `["720P","1080P"]`，而调用方常写 `1080p`），命中后发
   > **目录的拼写**。
   > 因此「实测只有 720p 出图」这个结论要重新读：`resolution` 只有在**该账号的目录确实
   > 下发了 `resolutions[]`** 时才被本地校验过，其余情况从未真正到达上游。
4. **码率不是分辨率的函数**：同为 1280×720，一条 7.93 Mbps、一条 11.47 Mbps；1344×768
   的两条是 3.66 / 5.45 Mbps。它随模型与画面运动量变化，所以「同秒数同价格」也不代表
   「同质量」——文件体积从 2.0 MB 到 7.0 MB 差了 3.5 倍。

> 上表的「产物 → 模型」对应关系没有从响应里固化下来（文件名只带时间戳），所以这里按
> 生成时间列，不按模型归组；单价表则来自每次工具返回值里的 `credit`，是逐次确认过的。

## 失败分类与冷却

| 阶段 | HTTP | code | 说法 |
| --- | --- | --- | --- |
| 提交 | 401 / 403 | `AUTH` | 提示重新登录 |
| 提交 | 404 | `NO_ROUTE` | 提示该区没有视频路由 |
| 提交 | 429 | `RATE_LIMIT` | 提示限流 |
| 提交 | 其它 4xx | `REJECTED` | 上游在**建任务之前**退回了请求，明说「没有创建任务、没有扣积分」，把上游原文（含 `supported range: 4-15 seconds`）带出来 |
| 提交 | 5xx / 其它 | `UPSTREAM` | 抽信封里的 `msg` |
| 轮询 | — | `POLL_TIMEOUT` | 超出 `VIDEO_POLL_TIMEOUT_MS` 仍非终态 |
| 轮询 | — | `TASK_FAILED` | 上游任务本身 failed |
| 提交/轮询 | — | `EMPTY_RESULT` | 无 taskId / 终态却无视频 |

冷却只对**真的花过积分**的失败生效（`AUTH` / `RATE_LIMIT` / `NO_ROUTE` /
`UPSTREAM` / `EMPTY_RESULT` / `TASK_FAILED` / `POLL_TIMEOUT`，以及非本模块的异常）。
参数写错（`INVALID_ARGS`）、未登录（`NOT_LOGGED_IN`）、目录里没模型（`NO_VIDEO_MODEL`）、
图片读不到、以及**提交阶段被上游 4xx 退回（`REJECTED`）**这五类**不进冷却**——
它们一分钱没花。

`REJECTED` 单列出来是踩过的坑：`seconds: 1` 被上游以
`unsupported video duration: 1 seconds, supported range: 4-15 seconds` 退回（HTTP 400，
`code 14407`），任务根本没创建，按 `UPSTREAM` 处理却给了一次「白等 60 秒」——
用户的原话是「上游返回这种错误，也要等半天」。现在这次失败**改完参数可以立刻重试**。

### 从上游的拒绝里学区间

目录里没有 `videoGeneration` 的账号（实测部分国内区账号的 `/v3/config` 条目只有
`{id,name,tags}`）本地无从校验，只能让上游先拒一次。它拒的时候会把真相写在文案里，
`parseSupportedSecondsRange` 把 `supported range: 4-15` 读出来，按
**区域 + 模型 id**（模型 id 不跨区）记进本次进程的 `learnedSeconds`。同一个进程里
第二次给同样的越界值，就在 `resolveVideoParams` 被本地拦下：**零请求、零冷却**，
报错里直接写「时长必须在 4 到 15 秒之间」。读不出区间（比如拒绝理由是宽高比）就
不记任何东西——不猜。

## 安全

- **凭据不出宿主进程**：工具在宿主侧执行，token 只用于这一次 `fetch`，不进对话上下文、
  不进页面。与生图、积分读数链路边界一致。
- **桌面 App 的认证文件始终只读**：`WORKBUDDY_AUTH_FILE` 只在测试里用，生产读插件自己的凭据库。
- **产物落本地临时目录**：视频是二进制，不进对话体，只回 `file://` 路径 + 渲染成链接。

## 与「只接一次 submitVideo()」的旧说法对账

旧 `IMAGE_GEN.md` 的「没做的事」一节写过：「工具已把四类媒体标签都读进目录，
**加视频只是接一次 `submitVideo()`**」。这句**少说了轮询 + 下载两段**，在此纠正：
视频是异步任务，`submitVideo()` 只拿到一个 `taskId`，必须再 `pollVideoTask()`
轮询到 `completed`、再 `downloadVideo()` 把视频拉到本地，才算完成一次调用。参数层与
选模型层（`MEDIA_TAGS`、`VIDEO_TAG_*`、卡片只读清单、`fetchMediaModels`）确实可复用，
但**执行层是全新异步代码，不是同步生图的改写**。

## 测试

- `tests/video-gen.spec.ts` 48 条：模型筛选与双 video 标签、`pickVideoModel` 按标签组
  校验（含「拿文生视频模型去图生视频」的报错文案）、`buildVideoBody` 文/图两分支
  （`watermark` / `extra_parameters` / 仅文生视频带 `aspect_ratio`）、
  `resolveVideoParams` 的 2500 上限 / `aspect_ratio` 非法 / 时长透传与越界 /
  分辨率回落与告警 / 图生视频 `aspectRatio = undefined`、`parseVideoSubmission` /
  `parseVideoTask`（含未知 status 当未完成）、`describeVideoFailure` 401/403/404/429/
  JSON / 非 JSON / **提交阶段 400 → `REJECTED` 且轮询阶段仍是 `UPSTREAM`**、
  `parseSupportedSecondsRange`（`4-15` / `to` / `~` / en dash / 颠倒 / 0 都各一条）、
  `videoGeneration` 透传（`selectMediaModels` 不丢字段、没给就不造、`readVideoGeneration`
  只搬已知字段、与 `image-gen` 的同名函数读出同一答案、透传后真的能拦下越界时长）。
- `tests/video-tool.spec.ts` 12 条：偏好的解析顺序与它的边界——都没钉、都没传时取组内
  第一个；只钉了偏好时用它（并断言问的标签是 `text-to-video`，不是写死一个）；偏好已不在
  目录里时回落第一个（不报错）；显式参数压过偏好；显式参数在手时**根本不读**偏好；显式参数
  不在组里时仍抛 `NO_VIDEO_MODEL`；`seconds` 的描述说的是「越界报错」而不是「夹回默认值」
  （`resolveVideoParams` 确实是抛 `INVALID_ARGS`）；另有 5 条钉住时长与冷却：
  目录 `videoGeneration` 拦下 1 秒（`submitVideo` 一次都没被调用）、区间内的时长放行、
  提交阶段 400 之后**下一次调用仍然会真的发请求**（不进冷却）、上游自报区间被记住后第二次
  在本地就被拦下（`submitVideo` 调用次数不增）、`UPSTREAM` 这种可能真扣过钱的失败照旧冷却。
- `tests/video-tool-optin.spec.ts` 19 条：`regionVideoToolEnabledOf` 仅显式 true、
  `nextRegionVideoToolEnabled` 仅改单 flag、配置默认 OFF、`videoToolRegionOf` 两区优先级、
  「区关着时勾选不算授权」、卡片含 `dsm-workbuddy-video-tool-check` 视频开关与按模式
  picker、`regionPreferredVideoModelsOf`（畸形值收敛为 `{}`、只留非空字符串、按区隔离）、
  `nextRegionPreferredVideoModels`（钉一个不动另一个、`undefined` 与 `''` 都删 key、
  round-trip）。

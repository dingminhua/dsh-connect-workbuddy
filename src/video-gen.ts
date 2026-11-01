/**
 * WorkBuddy 生视频的纯逻辑层：媒体模型筛选、请求体构造、任务轮询解析、失败描述。
 *
 * 这一层刻意不做任何网络 I/O、不引用宿主的任何包（同 `src/image-gen.ts` 的约定，
 * 见其模块注释里的可达图说明）。`src/upstream.ts` 会静态引用本模块，所以这里
 * 必须保持零外部依赖。
 *
 * 上游契约照抄官方 CLI `codebuddy-lite-wb.mjs` 的 `VideoService`（实测 2026-10-25，
 * 二进制位于 `WorkBuddy/resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs`）：
 *
 *   submitTask:  POST {endpoint}/v2/videos/generations
 *               body = { prompt, model, seconds, negative_prompt, watermark:true,
 *                        image_url/last_image_url(图生视频时),
 *                        extra_parameters:{ resolution, enable_audio,
 *                                          aspect_ratio(仅文生视频) } }
 *               resp = { code, msg, request_id, data:{ id } }   ← 只是 task id
 *   pollTask:    POST {endpoint}/v2/videos/tasks  { task_id }
 *               轮询直到 data.status === 'completed' | 'failed'
 *               resp = { code, msg, data:{ status, usage?:{credit}, ... } }
 *   download:   GET 每条 data[].url → 写本地 .mp4
 *
 * 与 `ImageService` 的根本区别：视频是**异步任务**，不是一次同步请求。生图
 * `ImageService` 调一次 `generations` 直接拿 URL；视频 `VideoService` 要先
 * `generations` 拿 task id，再 `tasks` 轮询，最后下载。所以本模块把"提交 / 轮询 /
 * 下载"三段拆开，工具层负责把它们串成一条异步流程（`src/video-tool.ts`）。
 *
 * 模型配置来自产品配置里每条媒体模型的 `videoGeneration` 字段：
 *   { resolutions:[...], defaultResolution, defaultSeconds,
 *     minSeconds, maxSeconds }。时长/分辨率要在该模型允许的集合内，否则上游
 *   会拒。这里把"该模型支持哪些值"的读取与校验收进来，工具层只把用户给的值
 *   递进来、拿校验结果。
 *
 * 两个区的视频目录（2026-10-25 实测，`src/upstream.ts` 的 `fetchMediaModels`
 * 注释）：
 *   - 国内区（61 条模型）：`kling-video-v3` 与 `minimax-video-h3` 各带
 *     `text-to-video` + `image-to-video`。
 *   - 国际区（29 条）：`kling-video-v3` 带两种 video tag。
 * 两边目录完全不重叠，所以"以哪个区为准"由工具的 `videoToolRegionOf` 决定
 * （默认国内区优先，与 image 工具一致）。
 *
 * @module dsh-connect-workbuddy/video-gen
 */

/** 产品配置里「文生视频」模型的标签。 */
export const VIDEO_TAG_TEXT_TO_VIDEO = 'text-to-video'
/** 产品配置里「图生视频」模型的标签。 */
export const VIDEO_TAG_IMAGE_TO_VIDEO = 'image-to-video'

/** 生视频路由（提交任务，拿 task id）。 */
export const VIDEO_GENERATIONS_PATH = '/v2/videos/generations'
/** 任务轮询路由。 */
export const VIDEO_TASKS_PATH = '/v2/videos/tasks'

/** 官方 CLI 的默认时长（秒）。模型没声明 `defaultSeconds` 时落这个值。 */
export const DEFAULT_VIDEO_SECONDS = 5
/** 官方 CLI 的默认宽高比（仅文生视频时使用）。 */
export const DEFAULT_VIDEO_ASPECT_RATIO = '16:9'
/** 支持的非图像决定宽高比集合。 */
export const VIDEO_ASPECT_RATIOS: readonly string[] = ['16:9', '9:16', '1:1']
/** 默认开启音频。 */
export const DEFAULT_VIDEO_ENABLE_AUDIO = true

/**
 * 本插件认作「媒体模型」的全部标签（与 `src/image-gen.ts` 的 `MEDIA_TAGS` 同源，
 * 这里重新声明一份，避免视频层反向依赖 image 层导致循环引用问题；两者必须保持
 * 一致——`fetchMediaModels` 只读一次就返回全部媒体条目）。
 */
export const MEDIA_TAGS: readonly string[] = [
  'text-to-image',
  'image-to-image',
  VIDEO_TAG_TEXT_TO_VIDEO,
  VIDEO_TAG_IMAGE_TO_VIDEO,
]

/** 一条模型的 `videoGeneration` 配置（上游 `models[].videoGeneration`）。 */
export interface WorkBuddyVideoModelConfig {
  readonly resolutions?: readonly string[]
  readonly defaultResolution?: string
  readonly defaultSeconds?: number
  readonly minSeconds?: number
  readonly maxSeconds?: number
}

/**
 * 产品配置 `data.models` 里的一个媒体模型条目。
 *
 * 实测上游媒体条目只有 `{"id","name","tags"}` 三个字段（见 `image-gen.ts` 的
 * 模块注释）；`videoGeneration` 是**模型级**配置，随条目下发时才有。这里只做
 * 透传：下游校验拿它当**唯一**的时长/分辨率依据，没有就交给上游，绝不臆造默认区间。
 *
 * `image-gen.ts` 的同名接口带同一个可选字段——两边读的是同一份目录，
 * `fetchMediaModels` 只会返回一种形状（见该文件的 `WorkBuddyMediaVideoGeneration`）。
 */
export interface WorkBuddyMediaModel {
  readonly id: string
  readonly name: string
  readonly tags: readonly string[]
  readonly videoGeneration?: WorkBuddyVideoModelConfig
}

/** 一次生视频请求的可变部分。 */
export interface WorkBuddyVideoRequest {
  readonly model: string
  readonly prompt: string
  readonly image?: string | undefined
  readonly lastImage?: string | undefined
  readonly negativePrompt?: string | undefined
  readonly resolution?: string | undefined
  readonly aspectRatio?: string | undefined
  readonly seconds?: number | undefined
  readonly enableAudio?: boolean | undefined
}

/** 提交任务后上游返回的任务元数据（task id）。 */
export interface WorkBuddyVideoSubmission {
  readonly taskId: string
  readonly warnings: readonly string[]
}

/** 轮询完成后解析出的任务结果。 */
export interface WorkBuddyVideoOutcome {
  /** 每个成品视频的下载 URL（`.mp4`）。 */
  readonly videos: readonly string[]
  /** 本次实际消耗的积分；上游没给就是 undefined。 */
  readonly credit?: number | undefined
  /** 提交阶段就攒下的非致命告警。 */
  readonly warnings?: readonly string[] | undefined
}

/** 生视频链路的错误码。调用方据此决定是提示登录、提示换模型还是原样透传。 */
export type WorkBuddyVideoErrorCode =
  | 'INVALID_ARGS'
  | 'NOT_LOGGED_IN'
  | 'NO_VIDEO_MODEL'
  | 'NO_ROUTE'
  | 'POLL_TIMEOUT'
  | 'TASK_FAILED'
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'UPSTREAM'
  | 'EMPTY_RESULT'
  /** 提交阶段被上游 4xx 退回：没建任务、没扣积分，改完参数可以立刻重试。 */
  | 'REJECTED'
  | 'COOLDOWN'

/** 生视频链路的错误。带一个稳定的 `code`，避免调用方去匹配文案。 */
export class WorkBuddyVideoError extends Error {
  readonly code: WorkBuddyVideoErrorCode

  constructor(message: string, code: WorkBuddyVideoErrorCode) {
    super(message)
    this.name = 'WorkBuddyVideoError'
    this.code = code
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    const text = asString(item)
    if (text !== undefined) out.push(text)
  }
  return out
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 把目录条目上的 `videoGeneration` 读成已知字段的配置对象。
 *
 * 只搬我们真的会用的字段（分辨率清单、默认值、时长上下限），缺哪个就是 undefined
 * ——尤其是 `minSeconds`/`maxSeconds`：**没有就不校验**，把判断交给上游，而不是
 * 猜一个区间去拦用户。
 */
export function readVideoGeneration(raw: unknown): WorkBuddyVideoModelConfig | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const resolutions = stringList(record['resolutions'])
  const defaultResolution = asString(record['defaultResolution'])
  const defaultSeconds = asFiniteNumber(record['defaultSeconds'])
  const minSeconds = asFiniteNumber(record['minSeconds'])
  const maxSeconds = asFiniteNumber(record['maxSeconds'])
  const config: WorkBuddyVideoModelConfig = {
    ...(resolutions.length === 0 ? {} : { resolutions }),
    ...(defaultResolution === undefined ? {} : { defaultResolution }),
    ...(defaultSeconds === undefined ? {} : { defaultSeconds }),
    ...(minSeconds === undefined ? {} : { minSeconds }),
    ...(maxSeconds === undefined ? {} : { maxSeconds }),
  }
  return Object.keys(config).length === 0 ? undefined : config
}

/**
 * 从上游的拒绝文案里读出它自己报的时长区间。
 *
 * 目录没有 `videoGeneration` 时，本地无从校验，只能让上游先拒一次；它会以
 * `unsupported video duration: 1 seconds, supported range: 4-15 seconds` 这种
 * 文案把真相说出来。把这段读出来记到本次进程里，第二次同样的参数就能在本地被拦下，
 * 不再多打一次注定失败的请求。读不出来就返回 undefined（绝不猜）。
 */
export function parseSupportedSecondsRange(
  text: string,
): { minSeconds: number; maxSeconds: number } | undefined {
  const match = /supported range:\s*(\d+(?:\.\d+)?)\s*(?:-|–|—|~|to)\s*(\d+(?:\.\d+)?)/i.exec(text)
  if (match === null) return undefined
  const minSeconds = Number(match[1])
  const maxSeconds = Number(match[2])
  if (!Number.isFinite(minSeconds) || !Number.isFinite(maxSeconds)) return undefined
  if (minSeconds <= 0 || maxSeconds < minSeconds) return undefined
  return { minSeconds, maxSeconds }
}

/**
 * 从产品配置的 `data.models` 里挑出带指定 tag 的媒体模型。
 *
 * 与 `image-gen.ts` 的 `selectMediaModels` 同形：tag 可以是一组，命中任一即算；
 * 去重按 `id`。视频模型也走这条（传 `VIDEO_TAG_TEXT_TO_VIDEO` 等）。
 */
export function selectMediaModels(
  rawModels: unknown,
  tag: string | readonly string[] = VIDEO_TAG_TEXT_TO_VIDEO,
): WorkBuddyMediaModel[] {
  const wanted = typeof tag === 'string' ? [tag] : tag
  if (!Array.isArray(rawModels)) return []
  const out: WorkBuddyMediaModel[] = []
  const seen = new Set<string>()
  for (const entry of rawModels) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const id = asString(record['id'])
    if (id === undefined || seen.has(id)) continue
    const tags = stringList(record['tags'])
    if (!wanted.some(one => tags.includes(one))) continue
    seen.add(id)
    const videoGeneration = readVideoGeneration(record['videoGeneration'])
    out.push({
      id,
      name: asString(record['name']) ?? id,
      tags,
      ...(videoGeneration === undefined ? {} : { videoGeneration }),
    })
  }
  return out
}

/** tag 的人话名字，只用在错误信息里。 */
function tagLabel(tag: string): string {
  if (tag === VIDEO_TAG_IMAGE_TO_VIDEO) return '图生视频'
  if (tag === VIDEO_TAG_TEXT_TO_VIDEO) return '文生视频'
  return tag
}

/**
 * 按能力标签选一个视频模型：先在该标签组内找调用方点名的那个，否则取组内第一个。
 *
 * 与 `image-gen.ts` 的 `pickMediaModel` 完全一致的设计——点名的模型必须在**这一组**
 * 里，写错名字或拿文生视频模型去图生视频都直接报错，而不是把它发上去换一个上游 404。
 */
export function pickVideoModel(
  models: readonly WorkBuddyMediaModel[],
  requested: string | undefined,
  tag: string = VIDEO_TAG_TEXT_TO_VIDEO,
): WorkBuddyMediaModel {
  const group = models.filter(model => model.tags.includes(tag))
  if (requested !== undefined && requested !== '') {
    const found = group.find(model => model.id === requested)
    if (found === undefined) {
      const known = group.map(model => model.id).join(', ')
      throw new WorkBuddyVideoError(
        `workbuddy video: 目录里没有${tagLabel(tag)}模型「${requested}」。可用：${known === '' ? '（空）' : known}`,
        'NO_VIDEO_MODEL',
      )
    }
    return found
  }
  const first = group[0]
  if (first === undefined) {
    throw new WorkBuddyVideoError(
      `workbuddy video: 该区账号的产品配置里没有任何带 ${tag} 标签的模型（${tagLabel(tag)}）。`
      + '国内区文生视频/图生视频是 kling-video-v3、minimax-video-h3；'
      + '国际区 kling-video-v3 同时带这两个标签；一个都没有说明该区目录暂时没有这类模型。',
      'NO_VIDEO_MODEL',
    )
  }
  return first
}

/**
 * 把一次生视频请求组装成上游 `POST /v2/videos/generations` 的请求体。
 *
 * 完全照抄官方 CLI 的 `submitTask`：`prompt` / `model` / `seconds` /
 * `negative_prompt` / `watermark:true`，图生视频时带 `image_url` 或
 * `last_image_url`，`extra_parameters` 里放 `resolution` / `enable_audio` /
 * 以及仅文生视频的 `aspect_ratio`。
 *
 * `config` 来自该模型的 `videoGeneration` 字段，用于回落默认值与约束校验
 * （见 {@link resolveVideoParams}）。`isImageToVideo` 由调用方（工具层）按
 * "有没有给 image" 唯一决定，与 image 工具"不给 image 就是文生图"的约定一致。
 */
export function buildVideoBody(
  request: WorkBuddyVideoRequest,
  isImageToVideo: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    prompt: request.prompt,
    model: request.model,
    seconds: request.seconds,
    negative_prompt: request.negativePrompt ?? '',
    watermark: true,
  }
  if (request.image !== undefined) body['image_url'] = request.image
  if (request.lastImage !== undefined) body['last_image_url'] = request.lastImage

  // 分辨率已经由 resolveVideoParams 校验/回落过，这里直接信任；不再二次推导，
  // 否则在拿不到 videoGeneration 配置时会把自定义分辨率静默丢掉。
  const extra: Record<string, unknown> = {
    resolution: request.resolution,
    enable_audio: request.enableAudio ?? DEFAULT_VIDEO_ENABLE_AUDIO,
  }
  // 图生视频时输入图已经决定了宽高比，上游不接受 aspect_ratio；只有文生视频才带。
  if (!isImageToVideo) {
    const aspectRatio = request.aspectRatio ?? DEFAULT_VIDEO_ASPECT_RATIO
    extra['aspect_ratio'] = aspectRatio
  }
  body['extra_parameters'] = extra
  return body
}

/**
 * 校验并回落一次生视频请求的可选参数（时长 / 分辨率 / 宽高比）。
 *
 * 集中处理"该模型支持哪些值"的判断，让工具层只需把用户给的值递进来。
 * 返回：最终要用的 `seconds` / `resolution` / `aspectRatio`（图生视频时
 * `aspectRatio` 为 undefined，因为由输入图决定），以及一条非致命告警列表
 * （例如用户给的分辨率模型不支持、被回落成默认值）。
 *
 * 抛 `WorkBuddyVideoError`('INVALID_ARGS') 的情况：prompt 超长、宽高比非法、
 * 模型不支持自定义时长却给了时长、时长越界。
 */
export function resolveVideoParams(
  request: WorkBuddyVideoRequest,
  config?: WorkBuddyVideoModelConfig | undefined,
): {
  seconds: number
  resolution: string | undefined
  aspectRatio: string | undefined
  warnings: string[]
} {
  const warnings: string[] = []
  const prompt = request.prompt ?? ''
  if (prompt.length > 2500) {
    throw new WorkBuddyVideoError(
      'workbuddy video: prompt 不能超过 2500 字符。',
      'INVALID_ARGS',
    )
  }
  if ((request.negativePrompt?.length ?? 0) > 2500) {
    throw new WorkBuddyVideoError(
      'workbuddy video: negative_prompt 不能超过 2500 字符。',
      'INVALID_ARGS',
    )
  }
  const isImageToVideo = request.image !== undefined || request.lastImage !== undefined

  // 时长
  const minSeconds = config?.minSeconds
  const maxSeconds = config?.maxSeconds
  let seconds = request.seconds ?? config?.defaultSeconds ?? DEFAULT_VIDEO_SECONDS
  if (request.seconds !== undefined) {
    // 只有拿到该模型的 videoGeneration 配置才做"不支持自定义时长"的断言——
    // 否则我们根本不知道它支不支持，盲拒会让所有自定义时长都失败。拿不到配置时
    // 直接透传，交给上游校验。
    if (minSeconds !== undefined && maxSeconds !== undefined
      && (seconds < minSeconds || seconds > maxSeconds)) {
      throw new WorkBuddyVideoError(
        `workbuddy video: 时长必须在 ${minSeconds} 到 ${maxSeconds} 秒之间（给定 ${seconds}）。`,
        'INVALID_ARGS',
      )
    }
  }

  // 分辨率。与上面的时长同一条判据：**只有真的知道该模型支持哪些值时才回落**。
  const resolutions = config?.resolutions ?? []
  const defaultResolution = config?.defaultResolution
  let resolution: string | undefined = defaultResolution
  if (request.resolution !== undefined) {
    const requested = request.resolution
    if (resolutions.length === 0) {
      // 目录没给 resolutions（或这条条目压根没有 videoGeneration）：我们并不知道
      // 上游认不认这个值，盲回落会把调用方显式给的分辨率**静默丢掉**——于是
      // 「resolution: 1080P」从来没到达过上游，日志里却只留一条「改用 上游默认」的
      // 告警。这里原样透传，认不认交给上游判，与秒数的「拿不到区间就不拦」一致。
      resolution = requested
    } else {
      // 目录里的拼写可能与调用方给的只差大小写（官方 CLI 的兜底档位是
      // `["720P","1080P"]`，而工具描述举的例子是 `720p`/`1080p`）。命中的话采纳
      // **目录的拼写**——上游认的是它自己那一份，不是调用方写的那份。
      const matched = resolutions.includes(requested)
        ? requested
        : resolutions.find(one => one.toLowerCase() === requested.toLowerCase())
      if (matched === undefined) {
        warnings.push(
          `resolution ${requested} 不被模型 ${request.model} 支持；改用 ${defaultResolution ?? '上游默认'}`,
        )
        resolution = defaultResolution
      } else {
        resolution = matched
      }
    }
  }

  // 宽高比（仅文生视频）
  let aspectRatio: string | undefined
  if (!isImageToVideo) {
    const ar = request.aspectRatio ?? DEFAULT_VIDEO_ASPECT_RATIO
    if (!VIDEO_ASPECT_RATIOS.includes(ar)) {
      throw new WorkBuddyVideoError(
        `workbuddy video: aspect_ratio 只能是 ${VIDEO_ASPECT_RATIOS.join('、')} 之一（给定 ${ar}）。`,
        'INVALID_ARGS',
      )
    }
    aspectRatio = ar
  }

  return { seconds, resolution, aspectRatio, warnings }
}

/**
 * 解析 `POST /v2/videos/generations` 的响应，取出 task id。
 *
 * 信封是 `{code, msg, request_id, data}`，`code !== 0` 是业务失败（与 HTTP
 * 状态无关）。成功时 `data.id` 是 task id。没有 id 就说不通（上游一定返回 id）。
 */
export function parseVideoSubmission(payload: unknown): WorkBuddyVideoSubmission {
  if (typeof payload !== 'object' || payload === null) {
    throw new WorkBuddyVideoError('workbuddy video: 上游返回的不是 JSON 对象', 'UPSTREAM')
  }
  const envelope = payload as Record<string, unknown>
  const code = typeof envelope['code'] === 'number' ? envelope['code'] : undefined
  if (code !== undefined && code !== 0) {
    const message = asString(envelope['msg']) ?? 'unknown error'
    const requestId = asString(envelope['request_id'])
    throw new WorkBuddyVideoError(
      `workbuddy video: 提交失败（code ${code}）: ${message}`
      + (requestId === undefined ? '' : `（request_id ${requestId}）`),
      'UPSTREAM',
    )
  }
  const data = typeof envelope['data'] === 'object' && envelope['data'] !== null
    ? envelope['data'] as Record<string, unknown>
    : {}
  const taskId = asString(data['id'])
  if (taskId === undefined) {
    throw new WorkBuddyVideoError(
      'workbuddy video: 上游没返回 task id，无法进入轮询。',
      'EMPTY_RESULT',
    )
  }
  return { taskId, warnings: [] }
}

/**
 * 解析 `POST /v2/videos/tasks` 的轮询响应。
 *
 * 返回当前 `status`，以及（完成态时）成品视频 URL 列表与实扣积分。
 * `status` 不在 `pending/processing/completed/failed` 内的未知字符串，一律
 * 当成"还没好"继续轮询，避免把新状态误判成失败而浪费一次已花钱的任务。
 */
export function parseVideoTask(payload: unknown): {
  status: string
  videos: readonly string[]
  credit?: number | undefined
  /**
   * 失败（或任何非完成态）时，`data` 里那些**我们认不出、但上游确实发了**的字段。
   *
   * ## 为什么是"原样带出来"而不是解析某个名字
   *
   * issue #187 的文生视频现象是：task 建成功、扣了积分、轮询返回 `status: "failed"`，
   * 而插件只报「生视频任务失败（task …）」——没有任何原因。用户因此无法判断是
   * 提示词、模型不支持、还是上游自己的问题。
   *
   * 但当前**没有任何一份上游响应样例**能证明那个原因字段叫什么
   * （`docs/VIDEO_GEN.md` 只记了 `status` / `data[]` / `credit`）。猜一个
   * `fail_reason` 去读，猜错就是永久静默；而人工写死一份"猜测清单"下次上游换个
   * 名字又失配。
   *
   * 所以这里把 `data` 中除已知键以外的内容**原样**附上（深层对象做 JSON 截断）。
   * 代价是报错文案多几十个字符；收益是下一次报错时，issue 里能直接看到上游到底
   * 发了什么，从而一次取证就把字段名钉死——那时再把它提成结构化字段才是有依据的。
   */
  detail?: string | undefined
} {
  if (typeof payload !== 'object' || payload === null) {
    throw new WorkBuddyVideoError('workbuddy video: 轮询响应不是 JSON 对象', 'UPSTREAM')
  }
  const envelope = payload as Record<string, unknown>
  const code = typeof envelope['code'] === 'number' ? envelope['code'] : undefined
  if (code !== undefined && code !== 0) {
    const message = asString(envelope['msg']) ?? 'unknown error'
    const requestId = asString(envelope['request_id'])
    throw new WorkBuddyVideoError(
      `workbuddy video: 轮询失败（code ${code}）: ${message}`
      + (requestId === undefined ? '' : `（request_id ${requestId}）`),
      'UPSTREAM',
    )
  }
  const data = typeof envelope['data'] === 'object' && envelope['data'] !== null
    ? envelope['data'] as Record<string, unknown>
    : {}
  const status = asString(data['status']) ?? 'unknown'
  if (status === 'completed') {
    const items = Array.isArray(data['data']) ? data['data'] : []
    const videos: string[] = []
    for (const item of items) {
      if (typeof item !== 'object' || item === null) continue
      const url = asString((item as Record<string, unknown>)['url'])
      if (url !== undefined) videos.push(url)
    }
    const usage = typeof data['usage'] === 'object' && data['usage'] !== null
      ? data['usage'] as Record<string, unknown>
      : {}
    const credit = typeof usage['credit'] === 'number' && Number.isFinite(usage['credit'])
      ? usage['credit'] as number
      : undefined
    return { status, videos, credit }
  }
  return { status, videos: [], detail: describeUnknownTaskFields(data) }
}

/**
 * `data` 里除已知键以外的内容，序列化成一行短文本。
 *
 * 已知键：`status`（状态机自己用）、`data`（成品 URL 列表）、`usage`（扣费）。
 * 其余全部带上——那正是"上游说了原因但我们没读"的地方（issue #187）。
 *
 * 深层结构做 JSON 序列化并截断到 400 字符：一轮报错不该因为上游回了一棵大树而
 * 变成几 KB。空对象返回 `undefined`，好让调用方不拼一个空的「（上游未给出原因）」。
 */
function describeUnknownTaskFields(data: Record<string, unknown>): string | undefined {
  const known = new Set(['status', 'data', 'usage'])
  const extra: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (known.has(key)) continue
    if (value === undefined || value === null || value === '') continue
    extra[key] = value
  }
  if (Object.keys(extra).length === 0) return undefined
  let text: string
  try {
    text = JSON.stringify(extra)
  } catch {
    // 循环引用之类：退回一句"有额外字段"，至少不让诊断本身变成新的故障。
    return '（上游返回了无法序列化的额外字段）'
  }
  return text.length > 400 ? `${text.slice(0, 400)}…` : text
}

/** 把一次非 2xx 的提交/轮询响应翻成带 `code` 的错误，好让上层决定怎么提示。 */
export function describeVideoFailure(
  status: number,
  bodyText: string,
  phase: 'submit' | 'poll' = 'submit',
): WorkBuddyVideoError {
  const text = bodyText.trim()
  let detail = text.slice(0, 240)
  if (text.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>
        const message = asString(record['msg'])
        const code = typeof record['code'] === 'number' ? record['code'] : undefined
        if (message !== undefined) detail = code === undefined ? message : `code ${code}: ${message}`
      }
    } catch {
      // 保留截断后的原文
    }
  }
  const where = phase === 'submit' ? '提交生视频任务' : '轮询生视频任务'
  if (status === 401 || status === 403) {
    return new WorkBuddyVideoError(
      `workbuddy video: 凭据被上游拒绝（HTTP ${status}），请在插件设置里重新登录 WorkBuddy。${detail === '' ? '' : ` ${detail}`}`,
      'AUTH',
    )
  }
  if (status === 429) {
    return new WorkBuddyVideoError(
      `workbuddy video: 触发上游限流（HTTP 429），稍后再试。${detail === '' ? '' : ` ${detail}`}`,
      'RATE_LIMIT',
    )
  }
  if (status === 404) {
    return new WorkBuddyVideoError(
      `workbuddy video: 上游没有这条生视频路由（HTTP 404）——该区网关没有开放视频接口。${detail === '' ? '' : ` ${detail}`}`,
      'NO_ROUTE',
    )
  }
  // 提交阶段的其他 4xx：上游在**创建任务之前**就把请求退回了（典型是参数不合它的
  // 规则，例如 `unsupported video duration: 1 seconds`）。没有 task、没有扣积分，
  // 所以归成 REJECTED 而不是 UPSTREAM——「UPSTREAM 一律进冷却」会让一次参数写错
  // 白等一分钟，正是「上游返回这种错误，也要等半天」的来源。
  if (phase === 'submit' && status >= 400 && status < 500) {
    const range = parseSupportedSecondsRange(detail)
    return new WorkBuddyVideoError(
      `workbuddy video: 上游拒绝了这次生视频请求（HTTP ${status}），没有创建任务、没有扣积分`
      + `${range === undefined ? '' : `；该模型支持的时长是 ${range.minSeconds}-${range.maxSeconds} 秒`}`
      + `。按下面的提示改参数后可以立刻重试。${detail === '' ? '' : ` ${detail}`}`,
      'REJECTED',
    )
  }
  return new WorkBuddyVideoError(
    `workbuddy video: ${where}失败（HTTP ${status}）${detail === '' ? '' : `: ${detail}`}`,
    'UPSTREAM',
  )
}

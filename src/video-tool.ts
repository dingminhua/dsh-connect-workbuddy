/**
 * `workbuddy_draw_video`：把 WorkBuddy 的视频生成能力（国内区与国际区各自的
 * `text-to-video` / `image-to-video` 模型）暴露成一个 DSH agent 工具。
 *
 * 与生图工具（一次同步请求就拿回图片）不同，视频是**异步任务**：
 * 先 `submitVideo` 拿到 task id，再 `pollVideoTask` 轮询到 completed，
 * 最后 `downloadVideo` 把每条视频 URL 落成本地 `.mp4`。这一整段都照搬
 * 官方 CLI 的 `VideoService`（submitTask / pollTask / downloadVideos），
 * 详见 docs/VIDEO_GEN.md。
 *
 * 参数 / 选模型层与生图工具几乎完全一致（共用 MEDIA_TAGS、video 标签常量、
 * 媒体目录缓存），所以「接受参数」这部分本插件已经就绪；真正多写的是
 * 上面那段异步执行流程。
 *
 * 为什么手写 ToolDefinition（不 import `@deepseek-ai/dsh-tools` 的 `defineTool`）：
 * 同 image-tool.ts 的注释——宿主 `Tools.register` 只校验 `output.render` 是函数、
 * `output.schema` 是受支持的 JSON Schema，`schemaOf()` 把 `parameters` 原样投影，
 * 手写换来零新 peer 依赖、不会触发 tests/host-peers.spec.ts 对可达图的断言。
 *
 * @module dsh-connect-workbuddy/video-tool
 */

import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { WorkBuddyCredential } from './auth.ts'
import {
  MAX_INPUT_IMAGE_BYTES,
  imageDataUrl,
  imageMimeForPath,
  isBareBase64Image,
  parseImageDataUrl,
  sniffImageMime,
} from './image-gen.ts'
import {
  DEFAULT_VIDEO_ASPECT_RATIO,
  DEFAULT_VIDEO_ENABLE_AUDIO,
  DEFAULT_VIDEO_SECONDS,
  VIDEO_TAG_IMAGE_TO_VIDEO,
  VIDEO_TAG_TEXT_TO_VIDEO,
  WorkBuddyVideoError,
  parseSupportedSecondsRange,
  pickVideoModel,
  resolveVideoParams,
  type WorkBuddyMediaModel,
  type WorkBuddyVideoOutcome,
  type WorkBuddyVideoSubmission,
} from './video-gen.ts'

/** 工具名。宿主禁止 `run_code`，这个名字与其它 connect 插件的命名习惯一致。 */
export const WORKBUDDY_VIDEO_TOOL_NAME = 'workbuddy_draw_video'

/**
 * 工具单次执行的上限：提交 + 轮询 + 下载。
 *
 * ## 为什么必须比宿主的 600 秒**明显小**（issue #187 的第三种现象）
 *
 * 这个值原本正好是 `600_000`，与宿主自己给工具调用的上限**完全相等**。两者同时到
 * 期，而宿主的计时器先落地：调用被宿主直接掐断，用户看到的是裸的
 * `tool call timed out after 600000ms`——没有 `taskId`、没有 `POLL_TIMEOUT`、没有
 * 任何结构化错误，日志里也找不到是提交卡住还是轮询卡住。
 *
 * 内部超时短于宿主上限，插件就能**先**抛 `POLL_TIMEOUT`，把 task id 带出去。那个
 * id 是这个故障里唯一能拿去问上游的东西，丢掉它等于把可排障的失败变成不可排障的。
 *
 * 570s 而不是更短：正常任务实测几十秒到几分钟，砍太狠会把慢但成功的任务判死。
 */
export const VIDEO_TOOL_TIMEOUT_MS = 570_000
/**
 * 轮询自身上限，同样要短于工具上限。
 *
 * 留 30s 给"抛错 + 下载"，这样即使轮询吃满，工具层也还有时间把 `POLL_TIMEOUT`
 * 连同 task id 返回，而不是让两个 deadline 撞在一起。
 *
 * 导出只为让测试钉住"它确实更短"——这是 issue #187 第三种现象的修复本身，
 * 不是实现细节。
 */
export const VIDEO_POLL_BUDGET_MS = 540_000
/** 媒体模型目录的缓存时长：目录变化很慢，不必每次都重新读一遍。 */
export const VIDEO_MODEL_TTL_MS = 5 * 60_000
/** 下载远程输入图（图生视频时）的上限，不含生视频本身。 */
const VIDEO_INPUT_TIMEOUT_MS = 30_000
/** 失败后的冷却：视频按次扣积分且一次要几十秒，连续重试会烧掉大量积分。 */
const FAILURE_COOLDOWN_MS = 60_000

/** 宿主 ContentBlock 的最小结构（只需要文本块）。 */
export interface VideoToolContentBlock {
  readonly type: 'text'
  readonly text: string
}

/**
 * 宿主 `ToolDefinition` 的结构子集。不 import 宿主类型，避免把插件绑死在
 * 某个宿主版本的类型上。
 */
export interface VideoToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: Record<string, unknown>
    render(args: unknown, value: unknown): VideoToolContentBlock[]
  }
  readonly timeoutMs: number
  execute(args: unknown, exec: VideoToolExec): Promise<Record<string, unknown>>
}

/** 宿主传给 execute 的执行上下文里本工具用得到的部分。 */
export interface VideoToolExec {
  readonly signal?: AbortSignal
}

/** 工具运行所需的外部能力，全部由 `src/index.ts` 注入，便于单测替换。 */
export interface VideoToolDeps {
  /** 解析生视频所用区的凭据；该区未登录/未授权则返回 undefined（不要抛异常）。 */
  readonly resolveCredential: () => Promise<WorkBuddyCredential | undefined>
  /** 读该凭据所属区的产品配置，返回该区**全部**媒体模型（调用方按 tag 分组）。 */
  readonly listMediaModels: (
    credential: WorkBuddyCredential,
    signal?: AbortSignal,
  ) => Promise<readonly WorkBuddyMediaModel[]>
  /** 提交一次生视频任务，拿回 task id。 */
  readonly submitVideo: (
    credential: WorkBuddyCredential,
    request: {
      readonly model: string
      readonly prompt: string
      readonly seconds: number
      readonly negativePrompt?: string | undefined
      readonly image?: string | undefined
      readonly lastImage?: string | undefined
      readonly resolution?: string | undefined
      readonly aspectRatio?: string | undefined
      readonly enableAudio?: boolean | undefined
    },
    signal?: AbortSignal,
  ) => Promise<WorkBuddyVideoSubmission>
  /** 轮询任务直到完成/失败，返回视频 URL 列表与扣费。 */
  readonly pollVideoTask: (
    credential: WorkBuddyCredential,
    taskId: string,
    signal?: AbortSignal,
  ) => Promise<WorkBuddyVideoOutcome>
  /**
   * 该区在卡片上钉住的模型 id（按 video tag 分开），没钉就返回 undefined。
   *
   * 只在调用方没显式传 `model` 时生效。它与显式参数的区别是「谁写的」：
   * 显式参数是这次调用者写下的名字，写错就该报错；钉住的是用户上一次在卡片上
   * 点的，可能随目录变化（换套餐、换区）已经不存在，所以它失效时静默回落到
   * 组内第一个，而不是让一次生成因为一个过期偏好彻底失败。
   */
  readonly preferredVideoModel?: (
    credential: WorkBuddyCredential,
    tag: string,
  ) => string | undefined
  /** 下载一条视频 URL 到本地，返回绝对路径。 */
  readonly downloadVideo: (
    credential: WorkBuddyCredential,
    url: string,
    signal?: AbortSignal,
  ) => Promise<string>
  readonly logger: { warn(message: string): void }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function describeArgType(value: unknown): string {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  return typeof value
}

/**
 * 可选参数的严格读取族：undefined/null/空串 → 未提供（走默认值）；
 * 类型不对 → INVALID_ARGS，绝不静默丢掉。
 *
 * 旧行为（`asNumber`/`asBoolean` 式的"类型不对就当没给"）与生图工具
 * `image: [...] 被丢掉切回文生图` 是同一族错误：`seconds: "10"` 安静地
 * 出 5 秒的片、`model: ["kling-video-v3"]` 安静地换了模型扣积分。调用方
 * 写了参数就要么被尊重、要么被明说——类型写错就报错，不要替它猜默认值。
 * 这些校验都发生在「发请求」之前：不花积分、不进冷却。
 */
function strictString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new WorkBuddyVideoError(
      `workbuddy video: 参数 ${name} 必须是字符串（或不填），实际是${describeArgType(value)}。`,
      'INVALID_ARGS',
    )
  }
  return value.trim() === '' ? undefined : value.trim()
}

function strictNumber(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new WorkBuddyVideoError(
      `workbuddy video: 参数 ${name} 必须是有限数字（或不填），实际是${describeArgType(value)}。`,
      'INVALID_ARGS',
    )
  }
  return value
}

function strictBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') {
    throw new WorkBuddyVideoError(
      `workbuddy video: 参数 ${name} 必须是布尔值（或不填），实际是${describeArgType(value)}。`,
      'INVALID_ARGS',
    )
  }
  return value
}

/**
 * 输入图参数：字符串 → 照旧；单元素字符串数组 → 解包（与字符串等价，宽容
 * 模型侧常见的数组写法）；undefined/null/空串 → 未提供（文生视频）。
 * 其余 → INVALID_ARGS。
 *
 * 为什么不收多图数组：图生视频上游只吃**单张** `image_url`，不像图生图的
 * `/v2/images/edits` 收数组。调用方传多张时它以为自己在做多图参考——
 * 静默取第一张或静默全丢都是撒谎，必须明说；生图工具那种「数组被丢掉、
 * 模式悄悄切成文生」的 bug 在这里被钉死不再发生。
 */
function asVideoImageInput(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') {
    return value.trim() === '' ? undefined : value.trim()
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return undefined
    if (value.length > 1) {
      throw new WorkBuddyVideoError(
        `workbuddy video: 图生视频只支持一张输入图，收到 ${value.length} 张。`
        + '需要多图参考时，先用生图工具把参考合成一张成品图，再把那张图传到这里。',
        'INVALID_ARGS',
      )
    }
    const item = value[0]
    if (typeof item !== 'string' || item.trim() === '') {
      throw new WorkBuddyVideoError(
        'workbuddy video: image 数组的唯一元素必须是非空字符串'
        + '（本地路径 / file:// / http(s) / data URL / 裸 base64）。',
        'INVALID_ARGS',
      )
    }
    return item.trim()
  }
  throw new WorkBuddyVideoError(
    'workbuddy video: image 必须是字符串或单元素字符串数组'
    + '（本地路径 / file:// / http(s) / data URL / 裸 base64）。',
    'INVALID_ARGS',
  )
}

/**
 * 这些失败说明请求真的打到了上游、可能已经扣了积分，才值得进冷却。
 * 参数写错 / 未登录 / 目录里没有模型都还没花钱，轮询也已先花过提交那次的钱。
 *
 * 注意 `REJECTED` **不在**这里：提交阶段被上游 4xx 退回时任务根本没创建、
 * 积分没花，冷却只会让一次「参数写错了」变成白等一分钟。
 */
const BILLABLE_FAILURE_CODES: ReadonlySet<string> = new Set([
  'AUTH',
  'RATE_LIMIT',
  'NO_ROUTE',
  'UPSTREAM',
  'EMPTY_RESULT',
  'TASK_FAILED',
  'POLL_TIMEOUT',
])

/**
 * 是否该进冷却——由「这一次到底有没有把生视频请求发出去」决定。
 * 读目录 / 选模型 / 参数校验全在「发请求」之前，失败了不花积分、不冷却。
 * 一旦 `submitVideo` 被调用，提交那次就花钱了，后续轮询 / 下载失败一律进冷却。
 */
function isBillableFailure(error: unknown, sent: boolean): boolean {
  if (!sent) return false
  if (error instanceof WorkBuddyVideoError) return BILLABLE_FAILURE_CODES.has(error.code)
  // 请求已发出之后的意外异常（读轮询响应时连接断了等）同样算一次真实尝试。
  return true
}

/**
 * 把任意形态的输入图规整成 data URL。
 *
 * ## 为什么 http(s) 也要下载下来（issue #187）
 *
 * 这里以前只发一个 `HEAD` 做可达性校验，然后把 URL **原样**交给上游。两个问题：
 *
 * 1. **`HEAD` 会被 COS 拒绝。** 插件自己出图返回的是腾讯 COS 签名 URL
 *    （`ai-corpus-backup-*.cos.ap-beijing.myqcloud.com`），签名只覆盖 `GET`。
 *    对它发 `HEAD` 拿到 **403**，于是用户在"用上一张成功的图做首帧"这条最自然的
 *    路径上卡死——而那个 URL 用 `curl` 明明取得到。报错因此指向了错误的对象：
 *    用户以为是自己的图有问题。
 * 2. **上游不接受外链。** 即使 HEAD 通过，图生视频的 `image_url` 与图生图的
 *    `image` 是同一条规则（PR #145 记录过："image 必须是 data URI，传 COS 原始
 *    URL → invoke model error"）。原样传 URL 只是把失败推迟到上游，并且那时已经
 *    建了 task、扣了积分。
 *
 * 所以这里与 `image-tool.ts` 的 `resolveImageInput` 完全对齐：**下载并编码成
 * data URL**。这也顺带让签名过期、上游改域名的场景在本地就报出可读的错，而不是
 * 变成一个花了钱才发现的 `TASK_FAILED`。
 *
 * 仍然不做缩放或格式转换——用户给什么就传什么，只改承载形式。
 */
async function resolveVideoImageInput(value: string, signal?: AbortSignal): Promise<string> {
  const text = value.trim()

  // 1. data URL：校验格式与体积后直传
  if (text.startsWith('data:')) {
    const parsed = parseImageDataUrl(text)
    if (parsed === undefined) {
      throw new WorkBuddyVideoError(
        'workbuddy video: image 看起来是 data URL，但格式不对（需要 data:image/*;base64,...）。',
        'INVALID_ARGS',
      )
    }
    const bytes = Buffer.from(parsed.base64, 'base64')
    assertVideoInputImageBytes(bytes.byteLength, '（内联 data URL）')
    return text
  }

  // 2. http(s) URL：真的下载下来，编码成 data URL 再发（见上面的函数注释）
  if (/^https?:\/\//i.test(text)) {
    let response: Response
    try {
      response = await fetch(text, {
        // `GET` 而不是 `HEAD`：COS 签名只覆盖 GET，对签名 URL 发 HEAD 会拿到
        // 403（issue #187 的第二种现象）。既然无论如何都要下载，就不再单独
        // 打一次 HEAD——那是两次往返换一个"存在"的布尔，还换来了假 403。
        signal: signal ?? AbortSignal.timeout(VIDEO_INPUT_TIMEOUT_MS),
      })
    } catch (error: unknown) {
      throw new WorkBuddyVideoError(
        `workbuddy video: 下载输入图失败（${text}）：`
        + (error instanceof Error ? error.message : String(error)),
        'INVALID_ARGS',
      )
    }
    if (!response.ok) {
      throw new WorkBuddyVideoError(
        `workbuddy video: 下载输入图失败（HTTP ${response.status}）：${text}`,
        'INVALID_ARGS',
      )
    }
    // 内容类型来自响应头；`encodeVideoInputImage` 在缺失时会去嗅探魔数。
    return encodeVideoInputImage(
      new Uint8Array(await response.arrayBuffer()),
      response.headers.get('content-type') ?? text,
    )
  }

  // 3. 裸 base64：编码成 data URL
  if (isBareBase64Image(text)) {
    const bytes = Buffer.from(text, 'base64')
    return encodeVideoInputImage(bytes, '（内联 base64）')
  }

  // 4. 本地路径 / file:// URL：读文件，编码成 data URL
  const path = text.startsWith('file:') ? fileURLToPath(text) : text
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch (error: unknown) {
    throw new WorkBuddyVideoError(
      `workbuddy video: 读不到输入图「${path}」：`
      + (error instanceof Error ? error.message : String(error)),
      'INVALID_ARGS',
    )
  }
  return encodeVideoInputImage(bytes, path)
}

/**
 * 体积与空文件闸门——所有输入图都从这里过，所以「空文件」和「超过 8 MB」
 * 的文案只有一份。与 `image-tool.ts` 的 `assertInputImageBytes` 同逻辑。
 *
 * `byteLength` 必须是解码后的字节数：base64 比原始字节长约 4/3。
 */
function assertVideoInputImageBytes(byteLength: number, source: string): void {
  if (byteLength === 0) {
    throw new WorkBuddyVideoError(`workbuddy video: 输入图是空文件：${source}`, 'INVALID_ARGS')
  }
  if (byteLength > MAX_INPUT_IMAGE_BYTES) {
    const limit = MAX_INPUT_IMAGE_BYTES / 1024 / 1024
    const actual = (byteLength / 1024 / 1024).toFixed(1)
    throw new WorkBuddyVideoError(
      `workbuddy video: 输入图 ${actual} MB，超过 ${limit} MB 上限：${source}`,
      'INVALID_ARGS',
    )
  }
}

/** 校验体积、定出 MIME，再把字节编成 data URL。 */
function encodeVideoInputImage(bytes: Uint8Array, source: string): string {
  assertVideoInputImageBytes(bytes.byteLength, source)
  const mime = imageMimeForPath(source) ?? sniffImageMime(bytes)
  return imageDataUrl(mime, Buffer.from(bytes).toString('base64'))
}

/**
 * 造出工具定义。每次 `apply()` 只造一个实例，冷却状态与目录缓存都挂在闭包里，
 * 生命周期跟着插件走。
 */
export function createVideoTool(deps: VideoToolDeps): VideoToolDefinition {
  let mediaCache: { readonly at: number; readonly models: readonly WorkBuddyMediaModel[] } | undefined
  let cooldownUntil = 0
  /**
   * 上游在拒绝一次提交时顺带告诉我们的「这个模型支持几秒」。
   *
   * 目录里没有 `videoGeneration` 的账号（实测国内区部分账号的 `/v3/config`
   * 条目只有 `{id,name,tags}`）本地无从校验，只能让上游先拒一次。它拒的时候
   * 会把区间写在文案里，这里记下来：同一个进程里第二次给同样的越界值，就在本地
   * 被 `resolveVideoParams` 拦下——零请求、零冷却。键带上区域名，因为模型 id
   * 不跨区（同名 id 在两个区可能是不同模型）。
   */
  const learnedSeconds = new Map<string, { readonly minSeconds: number; readonly maxSeconds: number }>()
  const secondsKey = (domain: string, modelId: string): string => `${domain}|${modelId}`

  const listModels = async (
    credential: WorkBuddyCredential,
    signal?: AbortSignal,
  ): Promise<readonly WorkBuddyMediaModel[]> => {
    const now = Date.now()
    if (mediaCache !== undefined && now - mediaCache.at < VIDEO_MODEL_TTL_MS) return mediaCache.models
    const models = await deps.listMediaModels(credential, signal)
    mediaCache = { at: now, models }
    return models
  }

  return {
    name: WORKBUDDY_VIDEO_TOOL_NAME,
    description:
      '用当前账号的 WorkBuddy 视频生成能力生成一段短视频。'
      + '不填 image 是文生视频（用该区带 text-to-video 标签的模型）；'
      + '填了 image 是图生视频（用带 image-to-video 标签的模型，只收一张输入图）。'
      + '可选参数要么不填、要么类型正确；填错类型直接 INVALID_ARGS 且不发请求，'
      + '不会静默丢参数或切换模式。'
      + '国内区与国际区都可用，模型取自该区产品配置'
      + '（国内区 kling-video-v3、minimax-video-h3；国际区 kling-video-v3，'
      + '两种 video tag 都有；以该区目录为准）。'
      + '视频是异步任务：先提交、再轮询到完成、最后把视频下载到本地，单次可能要几十秒到几分钟。'
      + '每次生成会真实消耗 WorkBuddy 积分，单价随区域与模型不同，以返回结果里的 credit 为准；'
      + '不要在没必要时调用，也不要为了试错连续调用。'
      + '返回的是本地 .mp4 文件路径（file:// URL），由宿主/客户端打开或下载。',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: '画面描述（中文或英文都可以），≤2500 字符。写清楚主体、动作、风格、镜头。',
        },
        image: {
          type: ['string', 'array'],
          items: { type: 'string' },
          description:
            '输入图，可选。填了就是图生视频（image-to-video）；不填就是文生视频。'
            + '接受本地绝对路径、file:// URL、http(s) URL、data URL 或裸 base64。'
            + '上限 8 MB，不做缩放或格式转换。'
            + '单元素字符串数组与字符串等价；图生视频只支持一张输入图，'
            + '传多张会直接报错（不会静默改走文生视频）。'
            + '需要多图参考（如按模板换装）时，先用生图工具 workbuddy_draw_image 把参考'
            + '合成一张成品图，再把这张图传进来。',
        },
        model: {
          type: 'string',
          description:
            '模型 id，可选。不填就用用户在设置卡片上按模式钉住的模型；'
            + '卡片上没钉就用该区目录里第一个带当前模式标签的模型'
            + '（文生视频看 text-to-video，图生视频看 image-to-video）。'
            + '填了但该 tag 组里没有会直接报错，不会盲发。',
        },
        seconds: {
          type: 'number',
          description:
            '视频时长（秒），可选。不填用模型默认（通常 5s）。'
            + '该模型在目录里给了 videoGeneration.minSeconds..maxSeconds 时，越界直接报错、不会静默夹取；'
            + '目录没给区间时交给上游判断，被拒的错误里会带上游支持的范围，改完可立刻重试（不计失败冷却）。',
        },
        resolution: {
          type: 'string',
          description:
            '分辨率，可选，如 720P / 1080P（大小写不敏感，按模型目录里的拼写发）。不填用模型默认。'
            + '该模型在目录里给了 videoGeneration.resolutions 时，不在列内会回落到默认分辨率并给出告警；'
            + '目录没给这份清单时原样透传，交给上游判断（与 seconds 同一条判据）。',
        },
        aspect_ratio: {
          type: 'string',
          description:
            '画面比例，仅文生视频有效，可选：16:9 / 9:16 / 1:1。'
            + '不填默认 16:9。图生视频由输入图决定比例，传了会被忽略。',
        },
        negative_prompt: {
          type: 'string',
          description: '不希望出现的元素，可选，≤2500 字符。',
        },
        enable_audio: {
          type: 'boolean',
          description: '是否生成带声音的视频，可选，默认 true。',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          videos: {
            type: 'array',
            items: { type: 'string' },
            description: '生成的视频本地路径列表（file:// URL，.mp4）。',
          },
          mode: { type: 'string', description: "'text-to-video' 或 'image-to-video'。" },
          model: { type: 'string', description: '实际使用的模型 id。' },
          prompt: { type: 'string', description: '实际提交的画面描述。' },
          seconds: { type: 'number', description: '实际使用的时长（秒）。' },
          resolution: { type: 'string', description: '实际使用的分辨率。' },
          hint: { type: 'string', description: '给模型的后续提示（如何打开、扣费）。' },
          credit: { type: 'number', description: '本次实际消耗的 WorkBuddy 积分。' },
        },
        required: ['videos', 'mode', 'model', 'prompt', 'seconds', 'resolution', 'hint'],
        additionalProperties: false,
      },
      render(_args: unknown, value: unknown): VideoToolContentBlock[] {
        const record = asRecord(value)
        const videos = Array.isArray(record['videos'])
          ? (record['videos'] as unknown[]).filter((v): v is string => typeof v === 'string')
          : []
        const model = asNonEmptyString(record['model']) ?? 'unknown'
        const modeLabel = record['mode'] === 'image-to-video' ? '图生视频' : '文生视频'
        const seconds = typeof record['seconds'] === 'number' ? (record['seconds'] as number) : undefined
        const resolution = asNonEmptyString(record['resolution'])
        const credit = typeof record['credit'] === 'number' ? record['credit'] as number : undefined
        const hint = asNonEmptyString(record['hint']) ?? ''
        const lines = [
          `${modeLabel} · 模型：${model}`
          + (seconds === undefined ? '' : ` · ${seconds}s`)
          + (resolution === undefined ? '' : ` · ${resolution}`)
          + (credit === undefined ? '' : ` · 消耗 ${credit} 积分`),
          '',
        ]
        if (videos.length === 0) {
          lines.push('（没有返回任何视频文件）')
        } else {
          videos.forEach((v, i) => {
            lines.push(`视频 ${i + 1}: [${v}](${v})`)
          })
        }
        if (hint !== '') lines.push('', hint)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: VIDEO_TOOL_TIMEOUT_MS,
    async execute(args: unknown, exec: VideoToolExec): Promise<Record<string, unknown>> {
      const record = asRecord(args)
      const prompt = asNonEmptyString(record['prompt'])
      if (prompt === undefined) {
        throw new WorkBuddyVideoError(
          `${WORKBUDDY_VIDEO_TOOL_NAME}: 参数 prompt 必填，且必须是非空字符串。`,
          'INVALID_ARGS',
        )
      }
      const requestedModel = strictString(record['model'], 'model')
      const requestedSeconds = strictNumber(record['seconds'], 'seconds')
      const requestedResolution = strictString(record['resolution'], 'resolution')
      const requestedAspectRatio = strictString(record['aspect_ratio'], 'aspect_ratio')
      const requestedNegativePrompt = strictString(record['negative_prompt'], 'negative_prompt')
      const requestedEnableAudio = strictBoolean(record['enable_audio'], 'enable_audio')
      // 模式由「有没有给输入图」唯一决定（同生图工具的思路：不增加 mode 参数）。
      // 类型不对的 image 必须报错而不是当成「没给图」——见 asVideoImageInput。
      const image = asVideoImageInput(record['image'])

      const now = Date.now()
      if (now < cooldownUntil) {
        const seconds = Math.ceil((cooldownUntil - now) / 1000)
        throw new WorkBuddyVideoError(
          `workbuddy video: 上一次生视频刚失败过，请 ${seconds} 秒后再试`
          + '（失败冷却是为了避免连续重试白白烧积分）。',
          'COOLDOWN',
        )
      }

      const credential = await deps.resolveCredential()
      if (credential === undefined) {
        throw new WorkBuddyVideoError(
          'workbuddy video: 没有可用的 WorkBuddy 账号——要么两个区都没登录，'
          + '要么已登录的那个区没有打开「允许模型自主生图」。'
          + '请先在插件设置里登录该区账号，并打开那个开关。',
          'NOT_LOGGED_IN',
        )
      }

      const signal = exec.signal === undefined
        ? AbortSignal.timeout(VIDEO_TOOL_TIMEOUT_MS)
        : AbortSignal.any([exec.signal, AbortSignal.timeout(VIDEO_TOOL_TIMEOUT_MS)])

      // 这一次到底有没有把生视频请求发出去——冷却的唯一判据。
      let sent = false
      // 选中的模型要活到 catch 里：上游拒绝时得知道是哪条模型的区间，好记下来。
      let chosen: WorkBuddyMediaModel | undefined
      try {
        const models = await listModels(credential, signal)
        // 先把输入图归一成 URL / 本地路径：发生在「发请求」之前，失败不花积分。
        const imageInput = image === undefined ? undefined : await resolveVideoImageInput(image, signal)
        const tag = imageInput === undefined ? VIDEO_TAG_TEXT_TO_VIDEO : VIDEO_TAG_IMAGE_TO_VIDEO
        // 谁写的名字决定写错了谁负责：显式 `model` 是这次调用者写的，不在组里
        // 就报错；钉住的偏好是用户上次在卡片上点的，目录变了就可能失效，那种
        // 情况按「没填」处理、回落组内第一个，不拿一个过期偏好卡住整次生成。
        const pinned = requestedModel === undefined ? deps.preferredVideoModel?.(credential, tag) : undefined
        let model: WorkBuddyMediaModel
        try {
          model = pickVideoModel(models, requestedModel ?? pinned, tag)
        } catch (error: unknown) {
          if (requestedModel !== undefined || pinned === undefined) throw error
          model = pickVideoModel(models, undefined, tag)
        }
        chosen = model

        // 校验用的时长区间：以目录给的 `videoGeneration` 为底；上游上一次拒绝时
        // 自报的区间（learned）存在就覆盖它——那是比目录更晚的事实。
        const learned = learnedSeconds.get(secondsKey(credential.domain, model.id))
        const modelConfig = learned === undefined
          ? model.videoGeneration
          : { ...model.videoGeneration, ...learned }

        const resolved = resolveVideoParams({
          model: model.id,
          prompt,
          seconds: requestedSeconds,
          negativePrompt: requestedNegativePrompt,
          image: imageInput,
          resolution: requestedResolution,
          aspectRatio: requestedAspectRatio,
          enableAudio: requestedEnableAudio,
        }, modelConfig)

        const request = {
          model: model.id,
          prompt,
          seconds: resolved.seconds,
          negativePrompt: requestedNegativePrompt,
          image: imageInput,
          resolution: resolved.resolution,
          aspectRatio: resolved.aspectRatio,
          enableAudio: requestedEnableAudio,
        }
        // 真正的请求从这里开始——置位 sent，此后任何失败都算花钱、进冷却。
        sent = true
        const submission = await deps.submitVideo(credential, request, signal)
        const outcome = await deps.pollVideoTask(credential, submission.taskId, signal)
        const paths: string[] = []
        for (const url of outcome.videos) {
          const local = await deps.downloadVideo(credential, url, signal)
          paths.push(pathToFileURL(local).href)
        }
        const mode = imageInput === undefined ? 'text-to-video' : 'image-to-video'
        const value: Record<string, unknown> = {
          videos: paths,
          mode,
          model: model.id,
          prompt,
          seconds: resolved.seconds,
          resolution: resolved.resolution ?? '',
          hint:
            `这段视频来自 WorkBuddy（模型 ${model.id}，${mode === 'image-to-video' ? '图生视频' : '文生视频'}）。`
            + '按次扣积分，单价随区域与模型不同'
            + (outcome.credit === undefined
              ? '（本次响应没带扣费字段，以额度面板为准）。'
              : `；本次实际扣费 ${outcome.credit} 积分。`)
            + (resolved.warnings.length > 0 ? ` 提示：${resolved.warnings.join('；')}。` : '')
            + '视频已下载到本地，请用 file:// 链接打开或下载保存。',
        }
        if (outcome.credit !== undefined) value['credit'] = outcome.credit
        return value
      } catch (error: unknown) {
        // 上游把参数退回来时**什么都没创建**：把它自报的支持区间记进本次进程，
        // 下一次同样的越界值在本地就被拦下，不再多打一次注定失败的请求。
        if (error instanceof WorkBuddyVideoError && error.code === 'REJECTED' && chosen !== undefined) {
          const range = parseSupportedSecondsRange(error.message)
          if (range !== undefined) learnedSeconds.set(secondsKey(credential.domain, chosen.id), range)
        }
        if (isBillableFailure(error, sent)) cooldownUntil = Date.now() + FAILURE_COOLDOWN_MS
        throw error
      }
    },
  }
}

/** 宿主 tools 服务里本工具用到的那一个方法。 */
export interface ToolsServiceLike {
  register(definition: unknown): () => void
}

/**
 * 把工具注册进宿主。返回 disposer；调用方负责在插件卸载时调用它。
 * 注册本身是同步的；`tools` 服务由宿主提供，拿不到就直接返回 undefined 并记警告。
 */
export function registerWorkBuddyVideoTool(
  tools: ToolsServiceLike,
  deps: VideoToolDeps,
): (() => void) | undefined {
  try {
    return tools.register(createVideoTool(deps))
  } catch (error: unknown) {
    deps.logger.warn(
      `dsh-connect-workbuddy: 注册 ${WORKBUDDY_VIDEO_TOOL_NAME} 失败: `
      + (error instanceof Error ? error.message : String(error)),
    )
    return undefined
  }
}

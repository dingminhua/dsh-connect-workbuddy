/**
 * WorkBuddy 生图的纯逻辑层：媒体模型筛选、请求体构造、响应解析、失败描述。
 *
 * 这一层刻意不做任何网络 I/O、不引用宿主的任何包。`src/upstream.ts` 会被
 * `src/bin.ts` 静态可达（见 tests/host-peers.spec.ts 对 lib/bin.js 可达图的断言：
 * 除 `node:` 外不得出现任何裸说明符），所以任何被它引用的模块都必须保持零外部依赖。
 *
 * 上游契约照抄官方 CLI `codebuddy-lite-wb.mjs` 的 ImageService（实测 2026-10-21，
 * 国内区 `copilot.tencent.com` 与 `www.workbuddy.cn` 两个入口逐字段同答）：
 *
 *   POST {endpoint}/v2/images/generations
 *   body = { model, prompt, size, ...按 model 前缀分支的字段 }
 *   resp = { code, msg, request_id?, data: { created, data: [{ url } | { b64_json }],
 *            usage: { credit } } }
 *
 * 前缀分支（`buildBaseRequestBody` 原文行为）：
 *   - `hunyuan-*`：额外只带 `n`（默认 1）/ `footnote` / `revise`
 *   - `gemini-*`  ：什么都不加
 *   - 其它        ：`response_format: 'b64_json'` + 可选 `n` / `quality` / `style` / `background`
 *
 * 两个区的目录各有一条媒体模型，互不重叠（2026-10-25 实测）：
 *   - 国内区（61 条模型）：`text-to-image` 只有 `hunyuan-image-alpha`，
 *     `image-to-image` 只有 `hunyuan-image-alpha-edit`。走 hunyuan 分支，
 *     响应是 COS 签名 URL（24h 有效），单张约 5.71 credits。
 *   - 国际区（29 条模型）：`hy-image-3.5` 同时带 `text-to-image` 与
 *     `image-to-image`。走「其它」分支（带 `response_format: 'b64_json'`），
 *     实测单张约 0.03 credits，返回的同样是 ap-singapore 的 COS 签名 URL。
 *
 * 两个数不是一个价目表的两个档位：目录条目只有 id/name/tags，**没有价格**，
 * 价格只在上游结算时以 `data.usage.credit` 返回，所以工具只能回报实扣、
 * 不能预先报价。
 *
 * @module dsh-connect-workbuddy/image-gen
 */

/** 产品配置里「文生图」模型的标签。 */
export const IMAGE_TAG_TEXT_TO_IMAGE = 'text-to-image'
/** 产品配置里「图生图 / 改图」模型的标签。 */
export const IMAGE_TAG_IMAGE_TO_IMAGE = 'image-to-image'
/** 官方 CLI 的默认尺寸。 */
export const DEFAULT_IMAGE_SIZE = '1024x1024'

/**
 * 一个文生图模型**自己**登记的尺寸能力。
 *
 * 为什么要按模型分开：两个可用模型的尺寸范围**不是同一个**，而且差得不少。
 * 2026-11-12 逐档实测（国内区，接受/拒绝都记下来）：
 *
 *   | 模型 | 边长 | 总像素上限 | 实测边界 |
 *   | --- | --- | --- | --- |
 *   | `hunyuan-image-alpha` | 512–2560 | 4,194,304 | 2560x1440 / 2560x1600 通过，2560x2560 拒 |
 *   | `hunyuan-image-v3.0`   | 512–2048 | 1,048,576 | 1024x1024 / 1365x768 通过，1024x1025、1280x832 拒 |
 *
 * 把 v3.0 塞进 alpha 的范围会得到一串 `14402 The requested output image size is
 * not supported` —— 上游 400、本地却以为合法，正是「工具算得出、上游不认」的
 * 那类最难解释的失败。所以范围必须跟着**这一次真正选中的模型**走。
 *
 * 表里没有的模型（目录明天增了新 id）沿用 alpha 的宽范围：宁可让它发上去被
 * 上游拒，也不要在本地凭空收紧一个没测过的模型。
 */
export interface WorkBuddyImageSizeLimits {
  /** 两条边各自的下限。 */
  readonly minEdge: number
  /** 两条边各自的上限。 */
  readonly maxEdge: number
  /** 宽乘高的上限。 */
  readonly maxPixels: number
}

/** 实测通过的宽档（目录里的 `hunyuan-image-alpha` 等默认档）。 */
export const IMAGE_SIZE_LIMITS_WIDE: WorkBuddyImageSizeLimits = {
  minEdge: 512,
  maxEdge: 2560,
  maxPixels: 4_194_304,
}

/**
 * `hunyuan-image-v3.0` 的窄档：边长 2048、总像素 1024² 顶格。
 *
 * 实测边界见 {@link WorkBuddyImageSizeLimits} 的表：`1024x1024`（1,048,576）
 * 通过、`1024x1025` 被拒，所以上限就是这个数，不多一位。
 */
export const IMAGE_SIZE_LIMITS_V3: WorkBuddyImageSizeLimits = {
  minEdge: 512,
  maxEdge: 2048,
  maxPixels: 1_048_576,
}

/**
 * 按模型 id 给出它的尺寸范围。
 *
 * 判据只看 id 前缀：`hunyuan-image-v3.0` 与它的改图位（若有）同族同限。这不是
 * 「猜模型能力」——两条是实测过的边界，其余一律回落到实测过的宽档。
 */
export function imageSizeLimitsOf(modelId: string): WorkBuddyImageSizeLimits {
  return modelId.startsWith('hunyuan-image-v3') ? IMAGE_SIZE_LIMITS_V3 : IMAGE_SIZE_LIMITS_WIDE
}

/**
 * 无水印模型：`hunyuan-image-v3.0`（issue #241）。
 *
 * 2026-11-12 实测：同一个提示词、同一个账号，`hunyuan-image-alpha` 的产物右下角
 * 固定带「AI生成 WORKBUDD>」水印，而 `hunyuan-image-v3.0` **完全没有**——它不是
 * 参数开关，是产物落盘路径的差别：带水印的产物落在 COS 的 `aigc-processed/`
 * 前缀下，v3.0 的不落。所以「关水印」这件事在上游只有一个等价做法：换模型。
 *
 * 代价如实体现在两处：单价 6 → 11.1 积分/张，尺寸上限降到
 * {@link IMAGE_SIZE_LIMITS_V3}。因此它是**用户选的**，不是默认——
 * 见 `preferredImageModels`。
 */
export const IMAGE_MODEL_NO_WATERMARK = 'hunyuan-image-v3.0'

/** 这个模型 id 是不是那条「不带水印」的模型。 */
export function isWatermarkFreeImageModel(modelId: string): boolean {
  return modelId === IMAGE_MODEL_NO_WATERMARK
}

/**
 * 「不带水印」这条可选项的目录条目。
 *
 * 它**不在** `/v3/config` 的媒体目录里——目录只发 `hunyuan-image-alpha` /
 * `hunyuan-image-alpha-edit` 两条。但它是官方 CLI 自己写死的文生图兜底模型
 * （`resolveModel` 里 `s ? "hunyuan-image-v3.0" : "hunyuan-image-v2.0-general-edit"`），
 * 实测也真的能出图，所以把它补成一条与目录条目同形的候选，让「选模型」这一层
 * 不必为它开第二条分支。
 *
 * `tags` 只给 `text-to-image`：它在 `/v2/images/edits` 上是**静默忽略输入图**的
 * （2026-11-12 实测：蓝底黑十字的输入图 + 「只加一颗星」，出来是灰底一颗星、
 * 输入图完全没进画布，照样扣 11.31 积分）。所以它绝不能出现在改图那一组里。
 */
export const IMAGE_MODEL_NO_WATERMARK_ENTRY: WorkBuddyMediaModel = {
  id: IMAGE_MODEL_NO_WATERMARK,
  name: 'Hunyuan Image v3.0（无水印）',
  tags: [IMAGE_TAG_TEXT_TO_IMAGE],
}

/**
 * 某个 tag 组里**可选的全部**模型：目录给的，加上本插件自己补的。
 *
 * 只往 `text-to-image` 组里补 `hunyuan-image-v3.0`，其他组原样返回。目录要是哪天
 * 自己下发了这个 id，就以目录的那条为准（不重复、不覆盖上游的名字）。
 */
export function imageModelChoices(
  models: readonly WorkBuddyMediaModel[],
  tag: string,
): WorkBuddyMediaModel[] {
  const group = models.filter(model => model.tags.includes(tag))
  // 空组不补。目录里一条 `text-to-image` 都没有，说明这个账号的产品配置就没开通
  // 生图——那不是「目录列漏了」，补一条上去只会让一次注定不该发生的调用发出去。
  // 「要不要补」只在「能画、但有第二条更贵的路」时才成立。
  if (group.length === 0) return group
  if (tag !== IMAGE_TAG_TEXT_TO_IMAGE) return group
  if (group.some(model => model.id === IMAGE_MODEL_NO_WATERMARK)) return group
  return [...group, IMAGE_MODEL_NO_WATERMARK_ENTRY]
}
/** 生图路由。 */
export const IMAGE_GENERATIONS_PATH = '/v2/images/generations'
/** 改图路由：官方 CLI 的 `ImageService.editImage` 打的就是这条（2026-10-25 国际区实测 200）。 */
export const IMAGE_EDITS_PATH = '/v2/images/edits'
/** 产品配置里「文生视频」模型的标签。 */
export const VIDEO_TAG_TEXT_TO_VIDEO = 'text-to-video'
/** 产品配置里「图生视频」模型的标签。 */
export const VIDEO_TAG_IMAGE_TO_VIDEO = 'image-to-video'

/**
 * 本插件认作「媒体模型」的全部标签。
 *
 * 目录只读一次就返回全部媒体条目，由调用方按 tag 分组：生图工具只认两个 image
 * 标签，卡片清单则把视频条目一并列出来。这样 `fetchMediaModels` 不必为每种能力
 * 各读一遍 `/v3/config`。
 */
export const MEDIA_TAGS: readonly string[] = [
  IMAGE_TAG_TEXT_TO_IMAGE,
  IMAGE_TAG_IMAGE_TO_IMAGE,
  VIDEO_TAG_TEXT_TO_VIDEO,
  VIDEO_TAG_IMAGE_TO_VIDEO,
]

/**
 * 产品配置 `data.models` 里的一个媒体模型条目。
 *
 * 实测上游只给三个字段（`{"id":"hunyuan-image-alpha","name":"Hunyuan Image Alpha",
 * "tags":["text-to-image"]}`），没有 credits、没有上下文长度。不要在这里补
 * 上游没有的字段——那正是「不猜」红线的反面。
 */
export interface WorkBuddyMediaModel {
  readonly id: string
  readonly name: string
  readonly tags: readonly string[]
  /**
   * 模型级视频生成配置（上游 `models[].videoGeneration`），只对视频模型出现，
   * 图像链路从不读它。透传它是因为**同一份目录**同时喂生图与生视频两条链路：
   * 视频工具要靠这里的 `minSeconds`/`maxSeconds` 在本地拦下越界时长，
   * 而不是发上去等一个「unsupported video duration」的 400。
   *
   * 形状与 `video-gen.ts` 的 `WorkBuddyVideoModelConfig` 一致（那边是视频层的
   * 同一份定义，两处必须同步——tests/video-gen.spec.ts 有一条对拍测试）。
   */
  readonly videoGeneration?: WorkBuddyMediaVideoGeneration
}

/** `WorkBuddyMediaModel.videoGeneration` 的结构。字段缺席就是上游没给，不补默认值。 */
export interface WorkBuddyMediaVideoGeneration {
  readonly resolutions?: readonly string[]
  readonly defaultResolution?: string
  readonly defaultSeconds?: number
  readonly minSeconds?: number
  readonly maxSeconds?: number
}

/** 一次生图请求的可变部分。 */
export interface WorkBuddyImageRequest {
  readonly model: string
  readonly prompt: string
  readonly size?: string
  readonly n?: number
}

/** 上游成功响应的归一化结果。`url` 与 `b64` 至少有一个。 */
export interface WorkBuddyImageOutcome {
  readonly url?: string
  readonly b64?: string
  readonly created?: number
  readonly credit?: number
}

/** 生图链路的错误码。调用方据此决定是提示登录、提示换模型还是原样透传。 */
export type WorkBuddyImageErrorCode =
  | 'INVALID_ARGS'
  | 'NOT_LOGGED_IN'
  | 'NO_IMAGE_MODEL'
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'NO_ROUTE'
  | 'UPSTREAM'
  | 'EMPTY_RESULT'
  | 'COOLDOWN'

/** 生图链路的错误。带一个稳定的 `code`，避免调用方去匹配文案。 */
export class WorkBuddyImageError extends Error {
  readonly code: WorkBuddyImageErrorCode

  constructor(message: string, code: WorkBuddyImageErrorCode) {
    super(message)
    this.name = 'WorkBuddyImageError'
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
 * 把目录条目上的 `videoGeneration` 读成已知字段的配置对象（图像链路只是搬运，
 * 不解释它）。与 `video-gen.ts` 的 `readVideoGeneration` 必须同形——同一份上游
 * 数据，两个入口不能读出两个答案。缺字段即 undefined，不补默认值。
 */
export function readVideoGeneration(raw: unknown): WorkBuddyMediaVideoGeneration | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const resolutions = stringList(record['resolutions'])
  const defaultResolution = asString(record['defaultResolution'])
  const defaultSeconds = asFiniteNumber(record['defaultSeconds'])
  const minSeconds = asFiniteNumber(record['minSeconds'])
  const maxSeconds = asFiniteNumber(record['maxSeconds'])
  const config: WorkBuddyMediaVideoGeneration = {
    ...(resolutions.length === 0 ? {} : { resolutions }),
    ...(defaultResolution === undefined ? {} : { defaultResolution }),
    ...(defaultSeconds === undefined ? {} : { defaultSeconds }),
    ...(minSeconds === undefined ? {} : { minSeconds }),
    ...(maxSeconds === undefined ? {} : { maxSeconds }),
  }
  return Object.keys(config).length === 0 ? undefined : config
}

/**
 * 从产品配置的 `data.models` 里挑出带指定 tag 的媒体模型。
 *
 * `tag` 可以是一组标签，命中任一即算——目录只读一次就返回全部媒体条目（{@link MEDIA_TAGS}），
 * 调用方再按能力分组过滤，比每种能力各读一遍 `/v3/config` 少一次往返。
 *
 * 去重按 `id`：上游目录里同一个 id 只应出现一次，但目录是外部数据，
 * 重复条目不该让卡片或工具参数里出现两个同名选项。
 */
export function selectMediaModels(
  rawModels: unknown,
  tag: string | readonly string[] = IMAGE_TAG_TEXT_TO_IMAGE,
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
  if (tag === IMAGE_TAG_IMAGE_TO_IMAGE) return '图生图'
  if (tag === IMAGE_TAG_TEXT_TO_IMAGE) return '文生图'
  return tag
}

/**
 * 按能力标签选一个图像模型：先在该标签组内找调用方点名的那个，否则取组内第一个。
 *
 * 点名的模型必须在**这一组**里——写错名字或拿改图模型来文生图都直接报错，
 * 而不是把它发上去让上游回一个「route config not found」。这样报错信息能指出
 * 真正的问题（模型名写错，或该区这一组没有模型），那句话里还会列出本组可用项。
 */
export function pickMediaModel(
  models: readonly WorkBuddyMediaModel[],
  requested: string | undefined,
  tag: string = IMAGE_TAG_TEXT_TO_IMAGE,
): WorkBuddyMediaModel {
  const group = models.filter(model => model.tags.includes(tag))
  if (requested !== undefined && requested !== '') {
    const found = group.find(model => model.id === requested)
    if (found === undefined) {
      const known = group.map(model => model.id).join(', ')
      throw new WorkBuddyImageError(
        `workbuddy image: 目录里没有${tagLabel(tag)}模型「${requested}」。可用：${known === '' ? '（空）' : known}`,
        'NO_IMAGE_MODEL',
      )
    }
    return found
  }
  const first = group[0]
  if (first === undefined) {
    throw new WorkBuddyImageError(
      `workbuddy image: 该区账号的产品配置里没有任何带 ${tag} 标签的模型（${tagLabel(tag)}）。`
      + '国内区文生图应是 hunyuan-image-alpha、改图是 hunyuan-image-alpha-edit；'
      + '国际区 hy-image-3.5 同时带这两个标签；一个都没有说明该区目录暂时没有这类模型。',
      'NO_IMAGE_MODEL',
    )
  }
  return first
}

/**
 * 文生图模型的选择：{@link pickMediaModel} 的 `text-to-image` 快捷方式。
 *
 * 保留这个旧名字，是因为它读起来就把用途说完了；改图路径显式传标签，
 * 免得两种能力在调用点长得一样、看不出用的是哪一组。
 */
export function pickImageModel(
  models: readonly WorkBuddyMediaModel[],
  requested: string | undefined,
): WorkBuddyMediaModel {
  return pickMediaModel(models, requested, IMAGE_TAG_TEXT_TO_IMAGE)
}

/** 按官方 CLI 的 `buildBaseRequestBody` 分支规则拼请求体。 */
export function buildImageBody(request: WorkBuddyImageRequest): Record<string, unknown> {
  const model = request.model
  const body: Record<string, unknown> = {
    model,
    prompt: request.prompt,
    size: request.size ?? DEFAULT_IMAGE_SIZE,
  }
  if (model.startsWith('hunyuan-')) {
    body['n'] = request.n ?? 1
    return body
  }
  if (model.startsWith('gemini-')) return body
  body['response_format'] = 'b64_json'
  if (request.n !== undefined) body['n'] = request.n
  return body
}

/**
 * 改图请求体：生图那一套字段 + `image`（data URL 数组）+ 可选 `input_fidelity`。
 *
 * 顺序照抄官方 CLI 的 `editImage`：先 `buildBaseRequestBody`，再补 `image`，
 * 再可选补 `input_fidelity`。`image` 上游只认字符串数组，单个字符串会被拒。
 */
export function buildEditBody(
  request: WorkBuddyImageRequest & {
    readonly image: readonly string[]
    readonly inputFidelity?: string
  },
): Record<string, unknown> {
  const body = buildImageBody(request)
  body['image'] = [...request.image]
  if (request.inputFidelity !== undefined && request.inputFidelity !== '') {
    body['input_fidelity'] = request.inputFidelity
  }
  return body
}

/** 输入图的大小上限。上游没说，但一张改图输入不该比产物大一个量级，8 MB 足够。 */
export const MAX_INPUT_IMAGE_BYTES = 8 * 1024 * 1024

/** 按扩展名猜输入图的 MIME；不认识就返回 undefined（交给嗅探）。 */
const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
}

export function imageMimeForPath(path: string): string | undefined {
  const lower = path.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot < 0) return undefined
  return IMAGE_MIME_BY_EXTENSION[lower.slice(dot)]
}

/**
 * 按魔数嗅探图片 MIME，照抄官方 CLI 的 `detectMimeTypeFromBase64`。
 *
 * 认不出来时兜底 `image/png`（CLI 也是这么兜的）：宁可让上游按 png 试一次，
 * 也不要因为一个我们没见过的头就拒掉用户给的图。
 */
export function sniffImageMime(bytes: Uint8Array): string {
  const at = (index: number): number => bytes[index] ?? -1
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image/png'
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg'
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return 'image/gif'
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46
    && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return 'image/webp'
  if (at(0) === 0x42 && at(1) === 0x4d) return 'image/bmp'
  return 'image/png'
}

/** 拼出上游唯一接受的输入形态：`data:<mime>;base64,<base64>`。 */
export function imageDataUrl(mime: string, base64: string): string {
  return `data:${mime};base64,${base64}`
}

/** 解析一个 data URL 形式的输入图；不是 `data:image/*;base64,` 就返回 undefined。 */
export function parseImageDataUrl(value: string): { readonly mime: string; readonly base64: string } | undefined {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(value.trim())
  if (match === null) return undefined
  const mime = match[1] ?? ''
  const base64 = match[2] ?? ''
  if (!mime.startsWith('image/') || base64 === '') return undefined
  return { mime, base64 }
}

const BARE_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * 看起来像「裸 base64」而不是路径吗？
 *
 * 判据照抄 CLI 的 `processImageInput`：不含路径分隔符、足够长、字符集是 base64。
 * 长度门槛是必要的——`a.png` 这种文件名同样不含分隔符，短到不足以是图片数据。
 */
export function isBareBase64Image(value: string): boolean {
  const text = value.trim()
  if (text.length < 100) return false
  if (text.includes('/') || text.includes('\\')) return false
  return BARE_BASE64.test(text)
}

/**
 * 解析生图响应。
 *
 * 信封是 `{code, msg, request_id, data}`；`code !== 0` 是业务失败（与 HTTP 状态
 * 无关，上游可能 HTTP 200 但 code 非 0）。`data.data` 是数组，元素要么带 `url`
 * 要么带 `b64_json`；`data.usage.credit` 是本次实际扣的积分。
 */
export function parseImageResponse(payload: unknown): WorkBuddyImageOutcome {
  if (typeof payload !== 'object' || payload === null) {
    throw new WorkBuddyImageError('workbuddy image: 上游返回的不是 JSON 对象', 'UPSTREAM')
  }
  const envelope = payload as Record<string, unknown>
  const code = typeof envelope['code'] === 'number' ? envelope['code'] : undefined
  if (code !== undefined && code !== 0) {
    const message = asString(envelope['msg']) ?? 'unknown error'
    const requestId = asString(envelope['request_id'])
    throw new WorkBuddyImageError(
      `workbuddy image: 上游拒绝（code ${code}）: ${message}`
      + (requestId === undefined ? '' : `（request_id ${requestId}）`),
      'UPSTREAM',
    )
  }
  const data = envelope['data']
  if (typeof data !== 'object' || data === null) {
    throw new WorkBuddyImageError('workbuddy image: 响应缺少 data 字段', 'UPSTREAM')
  }
  const record = data as Record<string, unknown>
  const items = Array.isArray(record['data']) ? record['data'] : []
  const first = items.length > 0 ? items[0] : undefined
  let url: string | undefined
  let b64: string | undefined
  if (typeof first === 'object' && first !== null) {
    const item = first as Record<string, unknown>
    url = asString(item['url'])
    b64 = asString(item['b64_json'])
  }
  if (url === undefined && b64 === undefined) {
    throw new WorkBuddyImageError(
      'workbuddy image: 上游返回成功但 data.data 里既没有 url 也没有 b64_json',
      'EMPTY_RESULT',
    )
  }
  const usage = typeof record['usage'] === 'object' && record['usage'] !== null
    ? record['usage'] as Record<string, unknown>
    : {}
  const credit = typeof usage['credit'] === 'number' && Number.isFinite(usage['credit'])
    ? usage['credit'] as number
    : undefined
  const created = typeof record['created'] === 'number' ? record['created'] as number : undefined
  return {
    ...url === undefined ? {} : { url },
    ...b64 === undefined ? {} : { b64 },
    ...created === undefined ? {} : { created },
    ...credit === undefined ? {} : { credit },
  }
}

/** 把一次非 2xx 的响应翻成带 `code` 的错误，好让上层决定怎么提示。 */
export function describeImageFailure(status: number, bodyText: string): WorkBuddyImageError {
  const text = bodyText.trim()
  let detail = text.slice(0, 240)
  // 上游错误体通常是 JSON 信封；能把 msg 抽出来就用 msg，抽不出就原样截断。
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
  if (status === 401 || status === 403) {
    return new WorkBuddyImageError(
      `workbuddy image: 凭据被上游拒绝（HTTP ${status}），请在插件设置里重新登录 WorkBuddy。${detail === '' ? '' : ` ${detail}`}`,
      'AUTH',
    )
  }
  if (status === 429) {
    return new WorkBuddyImageError(
      `workbuddy image: 触发上游限流（HTTP 429），稍后再试。${detail === '' ? '' : ` ${detail}`}`,
      'RATE_LIMIT',
    )
  }
  if (status === 404) {
    return new WorkBuddyImageError(
      `workbuddy image: 上游没有这条生图路由（HTTP 404）——该区网关没有开放生图接口。${detail === '' ? '' : ` ${detail}`}`,
      'NO_ROUTE',
    )
  }
  return new WorkBuddyImageError(
    `workbuddy image: 上游失败（HTTP ${status}）${detail === '' ? '' : `: ${detail}`}`,
    'UPSTREAM',
  )
}

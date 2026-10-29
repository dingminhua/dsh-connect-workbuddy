/**
 * `workbuddy_draw_image`：把 WorkBuddy 的文生图能力（国内区与国际区各自的
 * `text-to-image` 模型）暴露成一个 DSH agent 工具。
 *
 * 为什么手写 ToolDefinition 而不 import `@deepseek-ai/dsh-tools` 的 `defineTool`：
 * 宿主 `Tools.register` 只校验两件事——`output.render` 是函数、`output.schema` 是
 * 受支持的 JSON Schema；`schemaOf()` 把 `parameters` **原样**投影给模型。也就是说
 * raw JSON Schema 完全够用，而 `defineTool` 额外提供的只有「按 spec 编译 schema +
 * 代校验参数」这一层包装。手写换来的是：零新 peer 依赖、不需要动态 import 兜底、
 * 不会碰到 tests/host-peers.spec.ts 对 `lib/bin.js` 可达图的断言（那里禁止除
 * `node:` 外的任何裸说明符）。
 *
 * 代价是参数校验要自己做——见 {@link createImageTool} 的 execute。
 *
 * @module dsh-connect-workbuddy/image-tool
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { WorkBuddyCredential } from './auth.ts'
import { pruneTempDir, TEMP_MEDIA_KEEP } from './temp-files.ts'
import {
  DEFAULT_IMAGE_SIZE,
  IMAGE_TAG_IMAGE_TO_IMAGE,
  IMAGE_TAG_TEXT_TO_IMAGE,
  MAX_INPUT_IMAGE_BYTES,
  WorkBuddyImageError,
  imageDataUrl,
  imageMimeForPath,
  isBareBase64Image,
  parseImageDataUrl,
  pickMediaModel,
  sniffImageMime,
  type WorkBuddyImageOutcome,
  type WorkBuddyMediaModel,
} from './image-gen.ts'

/** 工具名。宿主禁止 `run_code`，这个名字与其它 connect 插件的命名习惯一致。 */
export const WORKBUDDY_IMAGE_TOOL_NAME = 'workbuddy_draw_image'

/** 工具单次执行的上限。实测一张图 17–39 秒，留足余量。 */
const IMAGE_TOOL_TIMEOUT_MS = 180_000
/** 媒体模型目录的缓存时长：目录变化很慢，不必每张图都重新读一遍。 */
export const MEDIA_MODEL_TTL_MS = 5 * 60_000
/** 下载远程输入图的上限（只覆盖 http(s) 那一次 GET，不含生图本身）。 */
const IMAGE_INPUT_TIMEOUT_MS = 30_000
/** 失败后的冷却：生图按张扣积分，连续重试会在几秒内烧掉几十积分。 */
const FAILURE_COOLDOWN_MS = 30_000

/** 宿主 ContentBlock 的最小结构（只需要文本块）。 */
export interface ImageToolContentBlock {
  readonly type: 'text'
  readonly text: string
}

/**
 * 宿主 `ToolDefinition` 的结构子集。
 *
 * 刻意不 import 宿主的类型：`@deepseek-ai/dsh-tools` 在运行期由宿主提供，
 * 这里只描述「宿主会读哪些字段」，避免把插件绑死在某个宿主版本的类型上。
 */
export interface ImageToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: Record<string, unknown>
    render(args: unknown, value: unknown): ImageToolContentBlock[]
  }
  readonly timeoutMs: number
  execute(args: unknown, exec: ImageToolExec): Promise<Record<string, unknown>>
}

/** 宿主传给 execute 的执行上下文里本工具用得到的部分。 */
export interface ImageToolExec {
  readonly signal?: AbortSignal
}

/** 工具运行所需的外部能力，全部由 `src/index.ts` 注入，便于单测替换。 */
export interface ImageToolDeps {
  /** 解析生图所用区的凭据；该区未登录/未授权则返回 undefined（不要抛异常）。 */
  readonly resolveCredential: () => Promise<WorkBuddyCredential | undefined>
  /** 读该凭据所属区的产品配置，返回该区**全部**媒体模型（调用方按 tag 分组）。 */
  readonly listMediaModels: (
    credential: WorkBuddyCredential,
    signal?: AbortSignal,
  ) => Promise<readonly WorkBuddyMediaModel[]>
  /** 真正发一次文生图请求。 */
  readonly generateImage: (
    credential: WorkBuddyCredential,
    request: { readonly model: string; readonly prompt: string; readonly size: string },
    signal?: AbortSignal,
  ) => Promise<WorkBuddyImageOutcome>
  /** 真正发一次改图请求（输入图已是 data URL）。 */
  readonly editImage: (
    credential: WorkBuddyCredential,
    request: {
      readonly model: string
      readonly prompt: string
      readonly size: string
      readonly image: readonly string[]
    },
    signal?: AbortSignal,
  ) => Promise<WorkBuddyImageOutcome>
  readonly logger: { warn(message: string): void }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * 这些失败说明请求真的打到了上游、可能已经扣了积分，才值得进冷却。
 * 参数写错 / 未登录 / 目录里没有模型都还没花钱。
 */
/**
 * 这些失败码都发生在「请求已经发出去」之后——上游可能已经扣了积分或排了队，
 * 连续重试只会把它们再花一遍，所以进冷却。
 */
const BILLABLE_FAILURE_CODES: ReadonlySet<string> = new Set([
  'AUTH',
  'RATE_LIMIT',
  'NO_ROUTE',
  'UPSTREAM',
  'EMPTY_RESULT',
])

/**
 * 是否该进冷却——由「这一次到底有没有把生图请求发出去」决定，而不是由异常
 * 的类型反推。
 *
 * 早先的写法是「不是 WorkBuddyImageError 就算花过钱」，方向正好错了两头：
 * 读目录（`fetchMediaModels` 的那次只读 GET）失败抛的是 upstream.ts 的
 * `envelopeError`/网络错误，一分钱没花却把工具冷却 30 秒；而参数写错这类真正
 * 免费的失败又因为带着 `INVALID_ARGS` 才被放行——判据和事实不在一根轴上。
 *
 * 现在由调用点显式置位：请求发出去了才置 `sent`，冷却只看它。
 */
function isBillableFailure(error: unknown, sent: boolean): boolean {
  if (!sent) return false
  if (error instanceof WorkBuddyImageError) return BILLABLE_FAILURE_CODES.has(error.code)
  // 请求已发出之后的意外异常（读响应体时连接断了等）同样算一次真实尝试。
  return true
}

/** 生成图片的临时目录（issue #174）——清理由 {@link pruneTempDir} 负责。 */
const TEMP_IMAGE_DIR = join(tmpdir(), 'workbuddy-image-gen')

/** 把 b64 图片落成一个临时文件，返回绝对路径。 */
async function writeTempImage(b64: string, model: string): Promise<string> {
  await mkdir(TEMP_IMAGE_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const safeModel = model.replace(/[^A-Za-z0-9._-]+/g, '_')
  const path = join(TEMP_IMAGE_DIR, `${safeModel}-${stamp}.png`)
  await writeFile(path, Buffer.from(b64, 'base64'))
  // 机会式清理（issue #174）：在写入之后跑，不 await——回给模型的是路径，不是清理
  // 报告，而清理失败不该让一次成功的生成变成失败。`void` 而不是裸调用，是为了让
  // 「这是故意不等」一眼能看出来。
  void pruneTempDir(TEMP_IMAGE_DIR, TEMP_MEDIA_KEEP, ['.png'])
  return path
}

/**
 * 输入图的一切毛病都发生在「请求还没发出去」之前，所以统一用 INVALID_ARGS：
 * 不进冷却、不花积分，错误信息直接说清是哪个环节。
 */
function inputImageError(message: string): WorkBuddyImageError {
  return new WorkBuddyImageError(message, 'INVALID_ARGS')
}

const INLINE_BASE64_LABEL = '（内联 base64）'
const INLINE_DATA_URL_LABEL = '（内联 data URL）'

/**
 * 体积与空文件闸门——四种输入形态都从这里过，所以「空文件」和「超过 8 MB」的
 * 文案只有一份。
 *
 * `byteLength` 必须是**解码后**的字节数：base64 比原始字节长约 4/3，拿字符串长度
 * 比上限度会把一个 6 MB 的图误判成超限（并在错误信息里报出一个虚高的 MB 数）。
 */
function assertInputImageBytes(byteLength: number, source: string): void {
  if (byteLength === 0) throw inputImageError(`workbuddy image: 输入图是空文件：${source}`)
  if (byteLength > MAX_INPUT_IMAGE_BYTES) {
    const limit = MAX_INPUT_IMAGE_BYTES / 1024 / 1024
    const actual = (byteLength / 1024 / 1024).toFixed(1)
    throw inputImageError(`workbuddy image: 输入图 ${actual} MB，超过 ${limit} MB 上限：${source}`)
  }
}

/**
 * 把任意形态的输入图规整成上游唯一接受的形态：`data:<mime>;base64,<b64>`。
 *
 * 官方 CLI 的 `processImageInput` 收 data URL、http(s)、裸 base64、本地路径四
 * 种；这里只是把前三种归一，**不做**缩放、裁剪、格式转换——用户给什么就传什么，
 * 免得悄悄改了输入图。
 */
async function resolveImageInput(value: string, signal?: AbortSignal): Promise<string> {
  const text = value.trim()
  if (text.startsWith('data:')) {
    const parsed = parseImageDataUrl(text)
    if (parsed === undefined) {
      throw inputImageError(
        'workbuddy image: image 看起来是 data URL，但格式不对（需要 data:image/*;base64,...）。',
      )
    }
    // 这一支以前直接 return，于是绕过了 encodeInputImage 里的空文件与 8 MB 闸门：
    // 一个超限的 data URL 会原样发给上游，失败后还会按「请求已发出」进 30 秒冷却
    // ——正是「输入图的毛病都该在请求发出前报 INVALID_ARGS」要避免的那种情形。
    // 体积要按**解码后**的字节数算（base64 比原始字节长约 4/3），不能拿字符串长度比。
    assertInputImageBytes(Buffer.from(parsed.base64, 'base64').byteLength, INLINE_DATA_URL_LABEL)
    return text
  }
  if (/^https?:\/\//i.test(text)) {
    let response: Response
    try {
      response = await fetch(text, { signal: signal ?? AbortSignal.timeout(IMAGE_INPUT_TIMEOUT_MS) })
    } catch (error: unknown) {
      throw inputImageError(
        `workbuddy image: 下载输入图失败（${text}）：`
        + (error instanceof Error ? error.message : String(error)),
      )
    }
    if (!response.ok) {
      throw inputImageError(`workbuddy image: 下载输入图失败（HTTP ${response.status}）：${text}`)
    }
    return encodeInputImage(
      new Uint8Array(await response.arrayBuffer()),
      response.headers.get('content-type') ?? undefined,
      text,
    )
  }
  if (isBareBase64Image(text)) {
    return encodeInputImage(
      new Uint8Array(Buffer.from(text, 'base64')),
      undefined,
      INLINE_BASE64_LABEL,
    )
  }
  const path = text.startsWith('file:') ? fileURLToPath(text) : text
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch (error: unknown) {
    throw inputImageError(
      `workbuddy image: 读不到输入图「${path}」：`
      + (error instanceof Error ? error.message : String(error)),
    )
  }
  return encodeInputImage(new Uint8Array(bytes), undefined, path)
}

/** 校验体积、定出 mime，再把字节编成 data URL。 */
function encodeInputImage(bytes: Uint8Array, contentType: string | undefined, source: string): string {
  assertInputImageBytes(bytes.byteLength, source)
  const declared = contentType?.split(';')[0]?.trim().toLowerCase()
  const mime = declared !== undefined && declared.startsWith('image/')
    ? declared
    : imageMimeForPath(source) ?? sniffImageMime(bytes)
  return imageDataUrl(mime, Buffer.from(bytes).toString('base64'))
}
/**
 * 造出工具定义。
 *
 * 每次 `apply()` 只造一个实例，所以冷却状态与目录缓存都挂在闭包里，
 * 生命周期跟着插件走。
 */
export function createImageTool(deps: ImageToolDeps): ImageToolDefinition {
  let mediaCache: { readonly at: number; readonly models: readonly WorkBuddyMediaModel[] } | undefined
  let cooldownUntil = 0

  const listModels = async (
    credential: WorkBuddyCredential,
    signal?: AbortSignal,
  ): Promise<readonly WorkBuddyMediaModel[]> => {
    const now = Date.now()
    if (mediaCache !== undefined && now - mediaCache.at < MEDIA_MODEL_TTL_MS) return mediaCache.models
    const models = await deps.listMediaModels(credential, signal)
    mediaCache = { at: now, models }
    return models
  }

  return {
    name: WORKBUDDY_IMAGE_TOOL_NAME,
    description:
      '用当前账号的 WorkBuddy 生图能力画一张图。'
      + '不填 image 是文生图（用该区带 text-to-image 标签的模型）；'
      + '填了 image 是改图（用带 image-to-image 标签的模型）。'
      + '国内区与国际区都可用，模型取自该区产品配置'
      + '（国内区文生图 hunyuan-image-alpha、改图 hunyuan-image-alpha-edit；'
      + '国际区 hy-image-3.5 同时带这两个标签，以该区目录为准）。'
      + '每张图会真实消耗 WorkBuddy 积分，单价随区域与模型不同，以返回结果里的 credit 为准；'
      + '不要在没必要时调用，也不要为了试错连续调用。返回的是 COS 签名 URL，'
      + '约 24 小时后失效；需要展示给用户时，用 markdown 图片语法引用该 URL。',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: '画面描述（中文或英文都可以）。写清楚主体、风格、构图、光线。',
        },
        size: {
          type: 'string',
          description:
            '图片尺寸，写成「宽x高」（像素）。比例由宽高决定，不限于方图。'
            + '常用三档：方图 1024x1024、竖图 1024x1536、横图 1536x1024。'
            + '要大图就按「总像素 419 万以内」放，出的是真实像素不是插值放大：'
            + '2048x2048（4.19MP，方形上限）、2048x1536、2560x1440（16:9 桌面壁纸）、'
            + '2560x1600。竖版同理，把长边放到 2048–2560 那一档。'
            + '超过这个量级会被上游直接拒绝、不会悄悄降级（2560x2560、3072x3072、4096x4096 都失败），'
            + '所以不要填 4K 尺寸，也不要指望传大数字能拿到更多细节。'
            + `不填默认 ${DEFAULT_IMAGE_SIZE}（方图）。`
            + '用户要竖版 / 横版 / 手机壁纸 / 封面 / 高清大图时，改这里的宽高，不要只在 prompt 里说。',
        },
        image: {
          type: 'string',
          description:
            '输入图，可选。填了就是改图（image-to-image）；不填就是文生图。'
            + '接受本地绝对路径、file:// URL、http(s) URL、data URL 或裸 base64。'
            + '上限 8 MB，不做缩放或格式转换。',
        },
        model: {
          type: 'string',
          description:
            '模型 id，可选。不填就用该区目录里第一个带当前模式标签的模型'
            + '（文生图看 text-to-image，改图看 image-to-image）。'
            + '填了但该 tag 组里没有会直接报错，不会盲发。',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '图片地址（COS 签名 URL，或本地 file:// 地址）。' },
          mode: { type: 'string', description: "'generate'（文生图）或 'edit'（改图）。" },
          model: { type: 'string', description: '实际使用的模型 id。' },
          prompt: { type: 'string', description: '实际提交的画面描述。' },
          hint: { type: 'string', description: '给模型的后续提示（如何展示、链接时效）。' },
          credit: { type: 'number', description: '本次实际消耗的 WorkBuddy 积分。' },
          path: { type: 'string', description: '上游返回 base64 时，落盘的本地绝对路径。' },
        },
        required: ['url', 'mode', 'model', 'prompt', 'hint'],
        additionalProperties: false,
      },
      render(_args: unknown, value: unknown): ImageToolContentBlock[] {
        const record = asRecord(value)
        const url = asNonEmptyString(record['url']) ?? ''
        const model = asNonEmptyString(record['model']) ?? 'unknown'
        const mode = record['mode'] === 'edit' ? '改图' : '文生图'
        const credit = typeof record['credit'] === 'number' ? record['credit'] as number : undefined
        const path = asNonEmptyString(record['path'])
        const hint = asNonEmptyString(record['hint']) ?? ''
        const lines = [
          `![WorkBuddy ${mode}](${url})`,
          '',
          `${mode} · 模型：\`${model}\`${credit === undefined ? '' : ` · 消耗 ${credit} 积分`}`,
        ]
        if (path !== undefined) lines.push(`本地文件：${path}`)
        if (hint !== '') lines.push('', hint)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: IMAGE_TOOL_TIMEOUT_MS,
    async execute(args: unknown, exec: ImageToolExec): Promise<Record<string, unknown>> {
      const record = asRecord(args)
      const prompt = asNonEmptyString(record['prompt'])
      if (prompt === undefined) {
        throw new WorkBuddyImageError(
          `${WORKBUDDY_IMAGE_TOOL_NAME}: 参数 prompt 必填，且必须是非空字符串。`,
          'INVALID_ARGS',
        )
      }
      const size = asNonEmptyString(record['size']) ?? DEFAULT_IMAGE_SIZE
      const requestedModel = asNonEmptyString(record['model'])
      // 模式由「有没有给输入图」唯一决定：不新增 mode 参数，免得出现
      // 「mode=edit 但没图」这种自相矛盾的请求。
      const image = asNonEmptyString(record['image'])

      const now = Date.now()
      if (now < cooldownUntil) {
        const seconds = Math.ceil((cooldownUntil - now) / 1000)
        throw new WorkBuddyImageError(
          `workbuddy image: 上一次生图刚失败过，请 ${seconds} 秒后再试`
          + '（失败冷却是为了避免连续重试白白烧积分）。',
          'COOLDOWN',
        )
      }

      const credential = await deps.resolveCredential()
      if (credential === undefined) {
        throw new WorkBuddyImageError(
          'workbuddy image: 没有可用的 WorkBuddy 账号——要么两个区都没登录，'
          + '要么已登录的那个区没有打开「允许模型自主生图」。'
          + '请先在插件设置里登录该区账号，并打开那个开关。',
          'NOT_LOGGED_IN',
        )
      }

      const signal = exec.signal === undefined
        ? AbortSignal.timeout(IMAGE_TOOL_TIMEOUT_MS)
        : AbortSignal.any([exec.signal, AbortSignal.timeout(IMAGE_TOOL_TIMEOUT_MS)])

      // 这一次到底有没有把生图请求发出去。冷却的唯一判据——见
      // `isBillableFailure` 的注释：读目录的失败一分钱没花，不该冷却。
      let sent = false
      try {
        const models = await listModels(credential, signal)
        // 先把输入图归一成 data URL：读文件 / 下载都在「发请求」之前，
        // 失败了不花积分、也不该触发冷却。
        const input = image === undefined ? undefined : await resolveImageInput(image, signal)
        const tag = input === undefined ? IMAGE_TAG_TEXT_TO_IMAGE : IMAGE_TAG_IMAGE_TO_IMAGE
        const model = pickMediaModel(models, requestedModel, tag)
        sent = true
        const outcome = input === undefined
          ? await deps.generateImage(credential, { model: model.id, prompt, size }, signal)
          : await deps.editImage(
            credential,
            { model: model.id, prompt, size, image: [input] },
            signal,
          )
        const mode = input === undefined ? 'generate' : 'edit'
        const value: Record<string, unknown> = {
          mode,
          model: model.id,
          prompt,
          hint:
            `这张图来自 WorkBuddy（模型 ${model.id}，${mode === 'edit' ? '改图' : '文生图'}）。`
            + '按张扣积分，单价随区域与模型不同'
            + (outcome.credit === undefined
              ? '（本次响应没带扣费字段，以额度面板为准）。'
              : `；本次实际扣费 ${outcome.credit} 积分。`)
            + 'COS 签名 URL 约 24 小时失效；要长期保留请及时下载。',
        }
        if (outcome.url !== undefined) {
          value['url'] = outcome.url
        } else if (outcome.b64 !== undefined) {
          const path = await writeTempImage(outcome.b64, model.id)
          value['url'] = pathToFileURL(path).href
          value['path'] = path
          value['hint'] = `${value['hint'] as string} 上游返回的是内联 base64，已落盘到本地。`
        } else {
          throw new WorkBuddyImageError(
            'workbuddy image: 上游既没有返回 url 也没有返回 b64_json。',
            'EMPTY_RESULT',
          )
        }
        if (outcome.credit !== undefined) value['credit'] = outcome.credit
        return value
      } catch (error: unknown) {
        // 只有「真的发过请求」的失败才进冷却。参数写错、没登录、目录里没有模型、
        // 读目录时网络抖了一下——这些都还没花钱，冷却它们只会让用户以为工具坏了。
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
 *
 * 注册本身是同步的；`tools` 服务由宿主提供，拿不到就直接返回 undefined
 * 并记一条警告——生图工具缺失不该让整个插件起不来。
 */
export function registerWorkBuddyImageTool(
  tools: ToolsServiceLike,
  deps: ImageToolDeps,
): (() => void) | undefined {
  try {
    return tools.register(createImageTool(deps))
  } catch (error: unknown) {
    deps.logger.warn(
      `dsh-connect-workbuddy: 注册 ${WORKBUDDY_IMAGE_TOOL_NAME} 失败: `
      + (error instanceof Error ? error.message : String(error)),
    )
    return undefined
  }
}

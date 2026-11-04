/**
 * WorkBuddy 生图：纯逻辑层 + 工具定义层。
 *
 * 这份测试守的是三件事：
 *  1. **模型筛选**只认产品配置里真实的 `tags`，不猜、不补字段。夹具是 2026-10-21
 *     国内区 `/v3/config` 的 `data.models` 真实片段（62 条里只有一条
 *     `hunyuan-image-alpha` 带 `text-to-image`）。
 *  2. **请求体分支**照抄官方 CLI 的 `buildBaseRequestBody`：hunyuan 分支只加
 *     `n`，其它分支加 `response_format: 'b64_json'`。这是与上游协议对齐的关键，
 *     写错不会报错、只会静默拿到不同形状的响应。
 *  3. **工具定义**能被宿主 `Tools.register` 接受（output.render 是函数、
 *     output.schema 是 object），且 execute 的返回值严格落在 output.schema 里
 *     —— 宿主会用 `validateJsonSchemaValue(output.schema, value)` 校验，
 *     多一个字段就抛 ToolOutputError。
 */
import { describe, expect, it, vi } from 'vitest'
import { existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { WorkBuddyCredential } from '../src/auth.ts'
import {
  DEFAULT_IMAGE_SIZE,
  IMAGE_TAG_IMAGE_TO_IMAGE,
  IMAGE_TAG_TEXT_TO_IMAGE,
  MAX_INPUT_IMAGE_BYTES,
  MEDIA_TAGS,
  VIDEO_TAG_IMAGE_TO_VIDEO,
  VIDEO_TAG_TEXT_TO_VIDEO,
  WorkBuddyImageError,
  buildEditBody,
  buildImageBody,
  describeImageFailure,
  imageDataUrl,
  imageMimeForPath,
  isBareBase64Image,
  parseImageDataUrl,
  parseImageResponse,
  pickImageModel,
  pickMediaModel,
  selectMediaModels,
  sniffImageMime,
  type WorkBuddyMediaModel,
} from '../src/image-gen.ts'
import {
  WORKBUDDY_IMAGE_TOOL_NAME,
  createImageTool,
  registerWorkBuddyImageTool,
  type ImageToolDeps,
} from '../src/image-tool.ts'

/** 国内区 `/v3/config` 的真实片段：媒体条目只有 id/name/tags。 */
const cnModels = [
  { id: 'auto', name: 'Auto', tags: ['craft'] },
  { id: 'hunyuan-image-alpha', name: 'Hunyuan Image Alpha', tags: ['text-to-image'] },
  { id: 'hunyuan-image-alpha-edit', name: 'Hunyuan Image Alpha Edit', tags: ['image-to-image'] },
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', tags: ['craft'] },
]

/**
 * 国际区 `/v3/config` 的真实形状（2026-10-25 实测，29 条里媒体条目只有一条）：
 * `hy-image-3.5` **同时**带 `text-to-image` 与 `image-to-image`。
 */
const globalModels = [
  { id: 'hy3', name: 'Hy3', tags: ['craft'] },
  { id: 'hy-image-3.5', name: 'Hunyuan Image 3.5', tags: ['text-to-image', 'image-to-image'] },
  { id: 'kling-video-v3', name: 'Kling Video v3', tags: ['text-to-video'] },
]

function credential(overrides: Partial<WorkBuddyCredential> = {}): WorkBuddyCredential {
  return {
    accessToken: 'token',
    refreshToken: 'refresh',
    expiresAtMs: Date.now() + 60_000,
    domain: 'www.codebuddy.cn',
    uid: 'u-1',
    enterpriseId: 'e-1',
    source: 'desktop',
    filePath: 'C:/tmp/workbuddy.info',
    ...overrides,
  }
}

function mediaModel(id = 'hunyuan-image-alpha'): WorkBuddyMediaModel {
  return { id, name: id, tags: [IMAGE_TAG_TEXT_TO_IMAGE] }
}

describe('selectMediaModels', () => {
  it('只挑带指定 tag 的条目，其余一律忽略', () => {
    const text = selectMediaModels(cnModels, IMAGE_TAG_TEXT_TO_IMAGE)
    expect(text.map(model => model.id)).toEqual(['hunyuan-image-alpha'])

    const edit = selectMediaModels(cnModels, IMAGE_TAG_IMAGE_TO_IMAGE)
    expect(edit.map(model => model.id)).toEqual(['hunyuan-image-alpha-edit'])
  })

  it('国际区的 hy-image-3.5 同时带两个标签（旧观测「一条都没有」已过期）', () => {
    expect(selectMediaModels(globalModels, IMAGE_TAG_TEXT_TO_IMAGE).map(model => model.id))
      .toEqual(['hy-image-3.5'])
    expect(selectMediaModels(globalModels, IMAGE_TAG_IMAGE_TO_IMAGE).map(model => model.id))
      .toEqual(['hy-image-3.5'])
  })

  it('按 id 去重，且 name 缺失时回退成 id', () => {
    const models = selectMediaModels([
      { id: 'a', tags: ['text-to-image'] },
      { id: 'a', name: 'dup', tags: ['text-to-image'] },
    ], IMAGE_TAG_TEXT_TO_IMAGE)
    expect(models).toHaveLength(1)
    expect(models[0]?.name).toBe('a')
  })

  it('非数组 / 非对象 / 缺 id 的条目不会让它崩', () => {
    expect(selectMediaModels(undefined, IMAGE_TAG_TEXT_TO_IMAGE)).toEqual([])
    expect(selectMediaModels([null, 42, 'x', { tags: ['text-to-image'] }], IMAGE_TAG_TEXT_TO_IMAGE)).toEqual([])
  })
})

describe('pickImageModel', () => {
  it('点名一个存在的模型就用它', () => {
    const models = [mediaModel('a'), mediaModel('b')]
    expect(pickImageModel(models, 'b').id).toBe('b')
  })

  it('不点名就用目录里的第一个', () => {
    expect(pickImageModel([mediaModel('first'), mediaModel('second')], undefined).id).toBe('first')
  })

  it('国际区目录同样能选出默认模型', () => {
    const models = selectMediaModels(globalModels, IMAGE_TAG_TEXT_TO_IMAGE)
    expect(pickImageModel(models, undefined).id).toBe('hy-image-3.5')
    expect(pickImageModel(models, 'hy-image-3.5').id).toBe('hy-image-3.5')
  })

  it('点名一个不存在的模型直接报错，并列出可用的', () => {
    try {
      pickImageModel([mediaModel('a'), mediaModel('b')], 'nope')
      expect.unreachable('应当抛错')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(WorkBuddyImageError)
      expect((error as WorkBuddyImageError).code).toBe('NO_IMAGE_MODEL')
      expect((error as Error).message).toContain('nope')
      expect((error as Error).message).toContain('a, b')
    }
  })

  it('目录为空时报「该区没有生图模型」', () => {
    try {
      pickImageModel([], undefined)
      expect.unreachable('应当抛错')
    } catch (error: unknown) {
      expect((error as WorkBuddyImageError).code).toBe('NO_IMAGE_MODEL')
    }
  })
})

describe('pickMediaModel（按能力分组选模型）', () => {
  it('点名改图模型时只在 image-to-image 那一组里找', () => {
    const models = selectMediaModels(cnModels, MEDIA_TAGS)
    expect(pickMediaModel(models, 'hunyuan-image-alpha-edit', IMAGE_TAG_IMAGE_TO_IMAGE).id)
      .toBe('hunyuan-image-alpha-edit')
  })

  it('拿文生图模型去改图会被拒，并列出本组可用项', () => {
    // 这条守的是「写错组」这种真实错误：hunyuan-image-alpha 确实在目录里，
    // 但它不带 image-to-image，发上去只会换回一个 route config not found。
    const models = selectMediaModels(cnModels, MEDIA_TAGS)
    try {
      pickMediaModel(models, 'hunyuan-image-alpha', IMAGE_TAG_IMAGE_TO_IMAGE)
      expect.unreachable('应当抛错')
    } catch (error: unknown) {
      expect((error as WorkBuddyImageError).code).toBe('NO_IMAGE_MODEL')
      expect((error as Error).message).toContain('图生图')
      expect((error as Error).message).toContain('hunyuan-image-alpha-edit')
    }
  })

  it('该组为空时说明是哪一类模型缺失，而不是只说「没有生图模型」', () => {
    // 一个只有文生图的目录：改图那一组是空的。报错必须点出「图生图」，
    // 否则用户会以为整个生图能力不可用。
    const models = selectMediaModels(
      [{ id: 'hunyuan-image-alpha', name: 'Alpha', tags: [IMAGE_TAG_TEXT_TO_IMAGE] }],
      MEDIA_TAGS,
    )
    try {
      pickMediaModel(models, undefined, IMAGE_TAG_IMAGE_TO_IMAGE)
      expect.unreachable('应当抛错')
    } catch (error: unknown) {
      expect((error as WorkBuddyImageError).code).toBe('NO_IMAGE_MODEL')
      expect((error as Error).message).toContain('图生图')
      expect((error as Error).message).toContain(IMAGE_TAG_IMAGE_TO_IMAGE)
    }
  })

  it('国际区的 hy-image-3.5 两个组都能选到（旧观测「全球区一条都没有」已过期）', () => {
    const models = selectMediaModels(globalModels, MEDIA_TAGS)
    expect(pickMediaModel(models, undefined, IMAGE_TAG_TEXT_TO_IMAGE).id).toBe('hy-image-3.5')
    expect(pickMediaModel(models, undefined, IMAGE_TAG_IMAGE_TO_IMAGE).id).toBe('hy-image-3.5')
  })
})

describe('selectMediaModels 的多标签形态（给卡片读全量清单用）', () => {
  it('传一组标签时命中任一即可，且只剩媒体条目', () => {
    const models = selectMediaModels(globalModels, MEDIA_TAGS)
    expect(models.map(model => model.id)).toEqual(['hy-image-3.5', 'kling-video-v3'])
    expect(MEDIA_TAGS).toContain(VIDEO_TAG_TEXT_TO_VIDEO)
    expect(MEDIA_TAGS).toContain(VIDEO_TAG_IMAGE_TO_VIDEO)
  })
})

describe('buildEditBody', () => {
  it('在生图请求体上补 image 数组，顺序与官方 CLI 一致', () => {
    const body = buildEditBody({
      model: 'hunyuan-image-alpha-edit',
      prompt: '换成夜景',
      image: ['data:image/png;base64,AAAA'],
    })
    expect(body).toEqual({
      model: 'hunyuan-image-alpha-edit',
      prompt: '换成夜景',
      size: DEFAULT_IMAGE_SIZE,
      n: 1,
      image: ['data:image/png;base64,AAAA'],
    })
    expect(body).not.toHaveProperty('input_fidelity')
  })

  it('input_fidelity 为空串时不写进请求体', () => {
    const body = buildEditBody({
      model: 'hy-image-3.5',
      prompt: 'p',
      image: ['data:image/png;base64,AAAA'],
      inputFidelity: '',
    })
    expect(body).not.toHaveProperty('input_fidelity')
  })

  it('image 是拷贝，不是调用方数组的引用', () => {
    const image = ['data:image/png;base64,AAAA']
    const body = buildEditBody({ model: 'hy-image-3.5', prompt: 'p', image })
    expect(body['image']).toEqual(image)
    expect(body['image']).not.toBe(image)
  })
})

describe('输入图归一（mime / sniff / data URL）', () => {
  it('按扩展名认 mime，大小写与查询串都无影响', () => {
    expect(imageMimeForPath('C:/tmp/A.PNG')).toBe('image/png')
    expect(imageMimeForPath('/tmp/a.jpeg')).toBe('image/jpeg')
    expect(imageMimeForPath('/tmp/a.webp')).toBe('image/webp')
    expect(imageMimeForPath('/tmp/a.unknown')).toBeUndefined()
    // 没有扩展名：交给嗅探，而不是猜成 png。
    expect(imageMimeForPath('/tmp/noext')).toBeUndefined()
  })

  it('按魔数嗅探五种格式，认不出来兜底 png', () => {
    expect(sniffImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe('image/png')
    expect(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff]))).toBe('image/jpeg')
    expect(sniffImageMime(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBe('image/gif')
    expect(sniffImageMime(new Uint8Array([0x42, 0x4d]))).toBe('image/bmp')
    const webp = new Uint8Array(12)
    webp.set([0x52, 0x49, 0x46, 0x46], 0)
    webp.set([0x57, 0x45, 0x42, 0x50], 8)
    expect(sniffImageMime(webp)).toBe('image/webp')
    expect(sniffImageMime(new Uint8Array([1, 2, 3]))).toBe('image/png')
  })

  it('data URL 只认 data:image/*;base64,', () => {
    expect(parseImageDataUrl(imageDataUrl('image/png', 'AAAA'))).toEqual({ mime: 'image/png', base64: 'AAAA' })
    expect(parseImageDataUrl('data:image/jpeg;base64,BBBB')).toEqual({ mime: 'image/jpeg', base64: 'BBBB' })
    // 非图片、非 base64、空载荷都不是输入图。
    expect(parseImageDataUrl('data:text/plain;base64,AAAA')).toBeUndefined()
    expect(parseImageDataUrl('data:image/png,AAAA')).toBeUndefined()
    expect(parseImageDataUrl('data:image/png;base64,')).toBeUndefined()
    expect(parseImageDataUrl('https://example.com/a.png')).toBeUndefined()
  })

  it('裸 base64 的判定要求够长、无路径分隔符、字符集正确', () => {
    expect(isBareBase64Image('A'.repeat(120))).toBe(true)
    // 短到不可能是图片数据：`a.png` 这种文件名同样不含分隔符。
    expect(isBareBase64Image('a.png')).toBe(false)
    expect(isBareBase64Image('C:/tmp/a.png')).toBe(false)
    expect(isBareBase64Image(`${'A'.repeat(120)}!`)).toBe(false)
  })

  it('上限就是 8 MB', () => {
    expect(MAX_INPUT_IMAGE_BYTES).toBe(8 * 1024 * 1024)
  })
})

describe('buildImageBody', () => {
  it('hunyuan 分支只加 n，默认 1', () => {
    expect(buildImageBody({ model: 'hunyuan-image-alpha', prompt: '猫' })).toEqual({
      model: 'hunyuan-image-alpha',
      prompt: '猫',
      size: DEFAULT_IMAGE_SIZE,
      n: 1,
    })
  })

  it('hunyuan 分支透传 n，且不带 response_format', () => {
    const body = buildImageBody({ model: 'hunyuan-image-alpha', prompt: '猫', size: '512x512', n: 3 })
    expect(body).toEqual({ model: 'hunyuan-image-alpha', prompt: '猫', size: '512x512', n: 3 })
    expect(body).not.toHaveProperty('response_format')
  })

  it('gemini 分支什么都不加', () => {
    expect(buildImageBody({ model: 'gemini-3-pro-image', prompt: '猫' })).toEqual({
      model: 'gemini-3-pro-image',
      prompt: '猫',
      size: DEFAULT_IMAGE_SIZE,
    })
  })

  it('其它分支加 response_format: b64_json', () => {
    const body = buildImageBody({ model: 'openai-image-1', prompt: '猫' })
    expect(body['response_format']).toBe('b64_json')
    expect(body).not.toHaveProperty('n')
    expect(buildImageBody({ model: 'openai-image-1', prompt: '猫', n: 2 })['n']).toBe(2)
  })
})

describe('parseImageResponse', () => {
  it('取出 url / credit / created', () => {
    const outcome = parseImageResponse({
      code: 0,
      msg: 'OK',
      request_id: 'r-1',
      data: {
        created: 1750000000,
        data: [{ url: 'https://cos.example/a.png' }],
        usage: { credit: 5.71 },
      },
    })
    expect(outcome).toEqual({ url: 'https://cos.example/a.png', created: 1750000000, credit: 5.71 })
  })

  it('支持 b64_json 形态', () => {
    const outcome = parseImageResponse({
      code: 0,
      data: { data: [{ b64_json: 'AAAA' }] },
    })
    expect(outcome.b64).toBe('AAAA')
    expect(outcome.url).toBeUndefined()
  })

  it('code 非 0 是业务失败，带 msg 与 request_id', () => {
    try {
      parseImageResponse({ code: 14018, msg: 'Credits exhausted.', request_id: 'r-9' })
      expect.unreachable('应当抛错')
    } catch (error: unknown) {
      expect((error as WorkBuddyImageError).code).toBe('UPSTREAM')
      expect((error as Error).message).toContain('14018')
      expect((error as Error).message).toContain('Credits exhausted.')
      expect((error as Error).message).toContain('r-9')
    }
  })

  it('缺 data / data.data 为空 / 元素没有 url 与 b64 都算空结果', () => {
    expect(() => parseImageResponse({ code: 0 })).toThrow(WorkBuddyImageError)
    expect(() => parseImageResponse({ code: 0, data: { data: [] } })).toThrow(WorkBuddyImageError)
    expect(() => parseImageResponse({ code: 0, data: { data: [{}] } })).toThrow(WorkBuddyImageError)
  })
})

describe('describeImageFailure', () => {
  it('401/403 归为 AUTH 并提示重新登录', () => {
    for (const status of [401, 403]) {
      const error = describeImageFailure(status, '')
      expect(error.code).toBe('AUTH')
      expect(error.message).toContain('重新登录')
    }
  })

  it('404 归为 NO_ROUTE，且不再把国际区说成没有生图模型', () => {
    // 2026-10-25 实测国际区有 `hy-image-3.5`；404 现在只说明「该区网关没开这条
    // 接口」，再点名「全球区没有生图模型」就是一句过期的事实断言。
    const error = describeImageFailure(404, '')
    expect(error.code).toBe('NO_ROUTE')
    expect(error.message).toContain('404')
    expect(error.message).not.toContain('全球区')
    expect(error.message).not.toContain('请用国内区账号')
  })

  it('429 归为 RATE_LIMIT', () => {
    expect(describeImageFailure(429, '').code).toBe('RATE_LIMIT')
  })

  it('从 JSON 信封里抽出 code 与 msg', () => {
    const error = describeImageFailure(500, JSON.stringify({ code: 50001, msg: 'boom' }))
    expect(error.code).toBe('UPSTREAM')
    expect(error.message).toContain('50001')
    expect(error.message).toContain('boom')
  })

  it('非 JSON 的响应体截断后原样带上', () => {
    const error = describeImageFailure(502, '<html>bad gateway</html>')
    expect(error.message).toContain('bad gateway')
  })
})

describe('createImageTool', () => {
  function deps(overrides: Partial<ImageToolDeps> = {}): ImageToolDeps {
    return {
      resolveCredential: async () => credential(),
      listMediaModels: async () => [mediaModel()],
      generateImage: async () => ({ url: 'https://cos.example/a.png', credit: 5.71 }),
      // 默认实现必须存在：缺了它任何没走改图分支的用例都会在「deps 形状」上
      // 报错，而不是在用例真正想验的那条断言上。
      editImage: async () => ({ url: 'https://cos.example/edited.png', credit: 5.71 }),
      logger: { warn: () => {} },
      ...overrides,
    }
  }

  it('工具描述同时交代两个区，并说明以实扣为准', () => {
    const tool = createImageTool(deps())
    // 单价按区不同（国内 5.71、国际 0.03），写死一个数字等于对另一个区撒谎。
    expect(tool.description).toContain('国内区')
    expect(tool.description).toContain('国际区')
    expect(tool.description).toContain('hy-image-3.5')
    expect(tool.description).toContain('credit')
  })

  it('size 的描述给出多种比例的例子，模型才不会以为只能出方图', () => {
    const tool = createImageTool(deps())
    const size = (tool.parameters['properties'] as Record<string, Record<string, unknown>>)['size']!
    const description = size['description'] as string
    // 只给一个方图例子时，模型读到「形如 1024x1024」就会把比例固定成 1:1；
    // 官方 CLI 的 ImageGen 同样用三个例子覆盖方 / 竖 / 横三种比例。
    expect(description).toContain('1024x1024')
    expect(description).toContain('1024x1536')
    expect(description).toContain('1536x1024')
    expect(description).toContain(DEFAULT_IMAGE_SIZE)
    expect(description).toContain('比例')
  })

  it('size 的描述写出实测的大图档位与 419 万像素上限', () => {
    const tool = createImageTool(deps())
    const size = (tool.parameters['properties'] as Record<string, Record<string, unknown>>)['size']!
    const description = size['description'] as string
    // 2026-10-25 逐档实测：2048/2560 档都能出真实像素，2560x2560 起被直接拒绝。
    // 不写这两件事会各错一半——低估能力（只敢出 1024）或高估（往 4K 撞）。
    expect(description).toContain('2048x2048')
    expect(description).toContain('2560x1440')
    expect(description).toContain('419')
    expect(description).toContain('4096x4096')
  })

  it('形状满足宿主 Tools.register 的硬性要求', () => {
    const tool = createImageTool(deps())
    expect(tool.name).toBe(WORKBUDDY_IMAGE_TOOL_NAME)
    expect(tool.description).toContain('积分')
    expect(typeof tool.output.render).toBe('function')
    expect(tool.output.schema['type']).toBe('object')
    expect(tool.parameters['type']).toBe('object')
    expect(tool.parameters['required']).toEqual(['prompt'])
    expect(Number.isFinite(tool.timeoutMs)).toBe(true)
    expect(tool.timeoutMs).toBeGreaterThan(0)
  })

  it('execute 返回的键严格落在 output.schema 里（宿主会校验）', async () => {
    const tool = createImageTool(deps())
    const value = await tool.execute({ prompt: '一只猫' }, {})
    const schema = tool.output.schema as {
      properties: Record<string, unknown>
      required: string[]
      additionalProperties: boolean
    }
    expect(schema.additionalProperties).toBe(false)
    for (const key of Object.keys(value)) expect(schema.properties).toHaveProperty(key)
    for (const key of schema.required) expect(value).toHaveProperty(key)
    expect(value['url']).toBe('https://cos.example/a.png')
    expect(value['model']).toBe('hunyuan-image-alpha')
    expect(value['prompt']).toBe('一只猫')
    expect(value['credit']).toBe(5.71)
  })

  it('prompt 缺失或为空白 → INVALID_ARGS，且不进冷却', async () => {
    const tool = createImageTool(deps())
    await expect(tool.execute({}, {})).rejects.toMatchObject({ code: 'INVALID_ARGS' })
    await expect(tool.execute({ prompt: '   ' }, {})).rejects.toMatchObject({ code: 'INVALID_ARGS' })
    // 未登录/参数错误不该冷却：紧接着一次正常调用应当成功
    const value = await tool.execute({ prompt: '猫' }, {})
    expect(value['url']).toBe('https://cos.example/a.png')
  })

  it('未登录 → NOT_LOGGED_IN，且不把两个区的事说成国内区的事', async () => {
    const tool = createImageTool(deps({ resolveCredential: async () => undefined }))
    const error = await tool.execute({ prompt: '猫' }, {}).catch((thrown: unknown) => thrown as Error)
    expect((error as { code?: string }).code).toBe('NOT_LOGGED_IN')
    expect((error as Error).message).not.toContain('国内区未登录')
    // 两种可能都要说到：没登录，或者登录了但没给那个区开「自主生图」。
    expect((error as Error).message).toContain('两个区都没登录')
  })

  it('目录里没有生图模型 → NO_IMAGE_MODEL', async () => {
    const tool = createImageTool(deps({ listMediaModels: async () => [] }))
    await expect(tool.execute({ prompt: '猫' }, {})).rejects.toMatchObject({ code: 'NO_IMAGE_MODEL' })
  })

  it('点名不存在的模型 → NO_IMAGE_MODEL，且不会发请求', async () => {
    const generateImage = vi.fn()
    const tool = createImageTool(deps({ generateImage }))
    await expect(tool.execute({ prompt: '猫', model: 'nope' }, {}))
      .rejects.toMatchObject({ code: 'NO_IMAGE_MODEL' })
    expect(generateImage).not.toHaveBeenCalled()
  })

  describe('改图（带 image）', () => {
    /** A real data URL, so the input normalizer accepts it untouched. */
    const INPUT = imageDataUrl('image/png', Buffer.from('hello').toString('base64'))

    it('给了 image 就走 editImage，并用 image-to-image 组的模型', async () => {
      const generateImage = vi.fn()
      const editImage = vi.fn(async (
        _credential: unknown,
        _request: {
          readonly model: string
          readonly prompt: string
          readonly size: string
          readonly image: readonly string[]
        },
      ) => ({ url: 'https://cos.example/edited.png', credit: 5.71 }))
      const tool = createImageTool(deps({
        // 目录里两组各有一个，改图必须落在 edit 那一个上。
        listMediaModels: async () => [
          { id: 'hunyuan-image-alpha', name: 'A', tags: [IMAGE_TAG_TEXT_TO_IMAGE] },
          { id: 'hunyuan-image-alpha-edit', name: 'B', tags: [IMAGE_TAG_IMAGE_TO_IMAGE] },
        ],
        generateImage,
        editImage,
      }))
      const value = await tool.execute({ prompt: '换成夜景', image: INPUT }, {})
      expect(value['mode']).toBe('edit')
      expect(value['model']).toBe('hunyuan-image-alpha-edit')
      expect(generateImage).not.toHaveBeenCalled()
      expect(editImage).toHaveBeenCalledTimes(1)
      expect(editImage.mock.calls[0]?.[1]).toMatchObject({
        model: 'hunyuan-image-alpha-edit',
        prompt: '换成夜景',
        image: [INPUT],
      })
    })

    it('不给 image 时仍是文生图，且不会碰 editImage', async () => {
      const editImage = vi.fn()
      const tool = createImageTool(deps({ editImage }))
      const value = await tool.execute({ prompt: '猫' }, {})
      expect(value['mode']).toBe('generate')
      expect(editImage).not.toHaveBeenCalled()
    })

    it('读不到输入图 → INVALID_ARGS，且不进冷却（一分钱没花）', async () => {
      const editImage = vi.fn()
      const tool = createImageTool(deps({ editImage }))
      const missing = fileURLToPath(new URL('./no-such-input-image.png', import.meta.url))
      await expect(tool.execute({ prompt: '改', image: missing }, {}))
        .rejects.toMatchObject({ code: 'INVALID_ARGS' })
      expect(editImage).not.toHaveBeenCalled()
      // 紧接着一次没有输入图的调用必须照常成功：读文件失败是免费的。
      const value = await tool.execute({ prompt: '猫' }, {})
      expect(value['url']).toBe('https://cos.example/a.png')
    })

    it('格式不对的 data URL 也被拒，而不是原样发上去', async () => {
      const editImage = vi.fn()
      const tool = createImageTool(deps({ editImage }))
      await expect(tool.execute({ prompt: '改', image: 'data:text/plain;base64,AAAA' }, {}))
        .rejects.toMatchObject({ code: 'INVALID_ARGS' })
      expect(editImage).not.toHaveBeenCalled()
    })

    it('把文生图模型点名给改图 → NO_IMAGE_MODEL，且不发请求', async () => {
      const editImage = vi.fn()
      const tool = createImageTool(deps({
        listMediaModels: async () => [
          { id: 'hunyuan-image-alpha', name: 'A', tags: [IMAGE_TAG_TEXT_TO_IMAGE] },
          { id: 'hunyuan-image-alpha-edit', name: 'B', tags: [IMAGE_TAG_IMAGE_TO_IMAGE] },
        ],
        editImage,
      }))
      await expect(tool.execute({ prompt: '改', image: INPUT, model: 'hunyuan-image-alpha' }, {}))
        .rejects.toMatchObject({ code: 'NO_IMAGE_MODEL' })
      expect(editImage).not.toHaveBeenCalled()
    })

    it('超限的 data URL → INVALID_ARGS，且不发请求、不进冷却', async () => {
      // The `data:` branch used to return before the size gate, so an oversized
      // data URL went upstream verbatim — and then cooled the tool for 30s as a
      // BILLED failure. Every other input form was already checked, which is
      // exactly why the gap survived review.
      const editImage = vi.fn()
      const tool = createImageTool(deps({ editImage }))
      // 12 MB of base64 chars decodes to 9 MB, over MAX_INPUT_IMAGE_BYTES (8 MB).
      const oversized = `data:image/png;base64,${'A'.repeat(12 * 1024 * 1024)}`
      await expect(tool.execute({ prompt: '改', image: oversized }, {}))
        .rejects.toMatchObject({ code: 'INVALID_ARGS' })
      expect(editImage).not.toHaveBeenCalled()
      // Second call must run (not COOLDOWN): nothing was ever sent, so there is
      // nothing to cool down for.
      const value = await tool.execute({ prompt: '猫' }, {})
      expect(value['url']).toBe('https://cos.example/a.png')
    })

    it('data URL 的上限按解码后的字节数算，不按 base64 字符串长度', async () => {
      // base64 is ~4/3 the size of the original bytes. Comparing the STRING
      // length against the byte cap would reject a legitimate 6 MB image (8 MB
      // of base64 chars) and report a fictional MB figure in the message.
      const editImage = vi.fn(async () => ({ url: 'https://cos.example/edited.png', credit: 0.03 }))
      const tool = createImageTool(deps({
        listMediaModels: async () => [
          { id: 'hunyuan-image-alpha', name: 'A', tags: [IMAGE_TAG_TEXT_TO_IMAGE] },
          { id: 'hunyuan-image-alpha-edit', name: 'B', tags: [IMAGE_TAG_IMAGE_TO_IMAGE] },
        ],
        editImage,
      }))
      const sixMb = `data:image/png;base64,${'A'.repeat(8 * 1024 * 1024)}`
      await expect(tool.execute({ prompt: '改', image: sixMb }, {}))
        .resolves.toMatchObject({ mode: 'edit' })
      expect(editImage).toHaveBeenCalledTimes(1)
    })

    it('解出来是空内容的 data URL → INVALID_ARGS，且不发请求', async () => {
      // `====` matches the data-URL shape but decodes to zero bytes: the empty
      // file check has to run on the DATA branch too, not only on readFile.
      const editImage = vi.fn()
      const tool = createImageTool(deps({ editImage }))
      await expect(tool.execute({ prompt: '改', image: 'data:image/png;base64,====' }, {}))
        .rejects.toMatchObject({ code: 'INVALID_ARGS' })
      expect(editImage).not.toHaveBeenCalled()
    })

    it('render 里把改图标出来，不只画一张图', () => {
      const tool = createImageTool(deps())
      const blocks = tool.output.render({}, {
        url: 'https://cos.example/e.png',
        mode: 'edit',
        model: 'hunyuan-image-alpha-edit',
        prompt: '换夜景',
        hint: '提示',
      })
      expect(blocks[0]?.text).toContain('改图')
      expect(blocks[0]?.text).toContain('hunyuan-image-alpha-edit')
    })

    it('给 image 数组就走 editImage，多张参考图按顺序全部上传', async () => {
      const editImage = vi.fn(async (
        _credential: unknown,
        request: {
          readonly model: string
          readonly prompt: string
          readonly size: string
          readonly image: readonly string[]
        },
      ) => ({ url: 'https://cos.example/edited.png', credit: 5.71 }))
      const tool = createImageTool(deps({
        listMediaModels: async () => [
          { id: 'hunyuan-image-alpha', name: 'A', tags: [IMAGE_TAG_TEXT_TO_IMAGE] },
          { id: 'hunyuan-image-alpha-edit', name: 'B', tags: [IMAGE_TAG_IMAGE_TO_IMAGE] },
        ],
        editImage,
      }))
      const template = imageDataUrl('image/png', Buffer.from('template').toString('base64'))
      const outfit = imageDataUrl('image/png', Buffer.from('outfit').toString('base64'))
      const value = await tool.execute(
        { prompt: '按模板换装', image: [template, outfit] },
        {},
      )
      expect(value['mode']).toBe('edit')
      expect(value['model']).toBe('hunyuan-image-alpha-edit')
      expect(editImage).toHaveBeenCalledTimes(1)
      expect(editImage.mock.calls[0]?.[1]).toMatchObject({
        model: 'hunyuan-image-alpha-edit',
        prompt: '按模板换装',
        image: [template, outfit],
      })
    })

    it('数组里混了非字符串 → INVALID_ARGS，且不发请求', async () => {
      const editImage = vi.fn()
      const tool = createImageTool(deps({ editImage }))
      await expect(tool.execute(
        { prompt: '改', image: ['data:image/png;base64,AAAA', 42] },
        {},
      )).rejects.toMatchObject({ code: 'INVALID_ARGS' })
      expect(editImage).not.toHaveBeenCalled()
    })

    it('image 是数字 / 对象 → INVALID_ARGS，而不是悄悄退回文生图', async () => {
      // This pins the regression the multi-image fix addresses: a non-string,
      // non-array image used to be read as undefined and silently flip the tool
      // into generate mode, generating an unrelated image and burning credits.
      const generateImage = vi.fn()
      const tool = createImageTool(deps({ generateImage }))
      await expect(tool.execute({ prompt: '改', image: 123 }, {}))
        .rejects.toMatchObject({ code: 'INVALID_ARGS' })
      expect(generateImage).not.toHaveBeenCalled()
    })
  })

  it('上游失败后进入冷却，第二次调用直接 COOLDOWN', async () => {
    const tool = createImageTool(deps({
      generateImage: async () => {
        throw describeImageFailure(500, 'boom')
      },
    }))
    await expect(tool.execute({ prompt: '猫' }, {})).rejects.toMatchObject({ code: 'UPSTREAM' })
    await expect(tool.execute({ prompt: '猫' }, {})).rejects.toMatchObject({ code: 'COOLDOWN' })
  })

  it('读目录时网络抖了一下 → 一分钱没花，不进冷却', async () => {
    // The cooldown must follow "did a generation request actually leave", not
    // "what type was the exception". Reading the catalog is a read-only GET that
    // spends nothing and throws a plain error (not a WorkBuddyImageError) — the
    // old rule cooled the tool for 30s on a free failure.
    let fail = true
    const tool = createImageTool(deps({
      listMediaModels: async () => {
        if (fail) throw new Error('socket hang up')
        return [mediaModel()]
      },
    }))
    await expect(tool.execute({ prompt: '猫' }, {})).rejects.toThrow(/socket hang up/)
    // Immediately retry: a free failure must not be cooling anything.
    fail = false
    const value = await tool.execute({ prompt: '猫' }, {})
    expect(value['url']).toBe('https://cos.example/a.png')
  })

  it('目录读取失败不缓存，下一次仍然真的去读', async () => {
    const listMediaModels = vi.fn(async () => {
      throw new Error('boom')
    })
    const tool = createImageTool(deps({ listMediaModels }))
    await expect(tool.execute({ prompt: '猫' }, {})).rejects.toThrow(/boom/)
    await expect(tool.execute({ prompt: '猫' }, {})).rejects.toThrow(/boom/)
    // A failed read is not cached, so both attempts really reached the reader.
    expect(listMediaModels).toHaveBeenCalledTimes(2)
  })

  it('媒体目录在 TTL 内只读一次', async () => {
    const listMediaModels = vi.fn(async () => [mediaModel()])
    const tool = createImageTool(deps({ listMediaModels }))
    await tool.execute({ prompt: '一' }, {})
    await tool.execute({ prompt: '二' }, {})
    expect(listMediaModels).toHaveBeenCalledTimes(1)
  })

  it('上游只给 b64 时落盘并返回 file:// 地址', async () => {
    const tool = createImageTool(deps({
      generateImage: async () => ({ b64: Buffer.from('hello').toString('base64') }),
    }))
    const value = await tool.execute({ prompt: '猫' }, {})
    const path = value['path'] as string
    expect(path).toBeTruthy()
    expect(existsSync(path)).toBe(true)
    expect(String(value['url'])).toContain('file://')
    expect(fileURLToPath(String(value['url']))).toBe(path)
    rmSync(path, { force: true })
  })

  it('render 输出 markdown 图片与积分说明', () => {
    const tool = createImageTool(deps())
    const blocks = tool.output.render({}, {
      url: 'https://cos.example/a.png',
      model: 'hunyuan-image-alpha',
      prompt: '猫',
      hint: '提示',
      credit: 5.71,
    })
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.type).toBe('text')
    // 现在是「文生图」，因为同一个 render 也画改图的结果，两者要能分开。
    expect(blocks[0]?.text).toContain('![WorkBuddy 文生图](https://cos.example/a.png)')
    expect(blocks[0]?.text).toContain('5.71 积分')
  })

  it('render 原样印出小数积分（国际区 0.03 不能被抹成 0）', () => {
    const tool = createImageTool(deps())
    const blocks = tool.output.render({}, {
      url: 'https://cos.example/a.png',
      model: 'hy-image-3.5',
      prompt: '猫',
      hint: '提示',
      credit: 0.03,
    })
    expect(blocks[0]?.text).toContain('0.03 积分')
  })
})

describe('registerWorkBuddyImageTool', () => {
  it('把工具交给宿主，并返回 disposer', () => {
    const register = vi.fn((_definition: unknown) => () => {})
    const dispose = registerWorkBuddyImageTool({ register }, {
      resolveCredential: async () => credential(),
      listMediaModels: async () => [mediaModel()],
      generateImage: async () => ({ url: 'u' }),
      editImage: async () => ({ url: 'u' }),
      logger: { warn: () => {} },
    })
    expect(register).toHaveBeenCalledTimes(1)
    expect(register.mock.calls[0]?.[0]).toMatchObject({ name: WORKBUDDY_IMAGE_TOOL_NAME })
    expect(typeof dispose).toBe('function')
  })

  it('宿主拒绝注册时记一条警告，不抛异常', () => {
    const warn = vi.fn()
    const dispose = registerWorkBuddyImageTool({
      register: () => {
        throw new Error('reserved name')
      },
    }, {
      resolveCredential: async () => credential(),
      listMediaModels: async () => [mediaModel()],
      generateImage: async () => ({ url: 'u' }),
      editImage: async () => ({ url: 'u' }),
      logger: { warn },
    })
    expect(dispose).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('reserved name')
  })
})

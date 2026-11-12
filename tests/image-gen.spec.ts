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
  IMAGE_MODEL_NO_WATERMARK,
  imageMimeForPath,
  imageModelChoices,
  imageSizeLimitsOf,
  isBareBase64Image,
  isWatermarkFreeImageModel,
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

describe('无水印模型与尺寸范围（issue #241）', () => {
  it('目录之外补一条 v3.0，只补到文生图组，且不覆盖目录自己的条目', () => {
    // v3.0 不在 `/v3/config` 里（它是官方 CLI 写死的兜底模型），所以要补；
    // 但补的范围必须严格是 `text-to-image`：它在 `/v2/images/edits` 上会静默
    // 忽略输入图（实测），列进改图组就是一个「花了钱却没用上参考图」的按钮。
    const textChoices = imageModelChoices(cnModels, IMAGE_TAG_TEXT_TO_IMAGE)
    expect(textChoices.map(model => model.id)).toEqual([
      'hunyuan-image-alpha',
      IMAGE_MODEL_NO_WATERMARK,
    ])
    expect(isWatermarkFreeImageModel(textChoices[1]?.id ?? '')).toBe(true)
    expect(imageModelChoices(cnModels, IMAGE_TAG_IMAGE_TO_IMAGE).map(model => model.id))
      .toEqual(['hunyuan-image-alpha-edit'])
  })

  it('目录里已经有 v3.0 时用目录那条，不重复也不改名', () => {
    const withV3 = [
      ...cnModels,
      { id: IMAGE_MODEL_NO_WATERMARK, name: '目录自己的名字', tags: ['text-to-image'] },
    ]
    const choices = imageModelChoices(withV3, IMAGE_TAG_TEXT_TO_IMAGE)
    expect(choices.filter(model => model.id === IMAGE_MODEL_NO_WATERMARK)).toHaveLength(1)
    expect(choices.find(model => model.id === IMAGE_MODEL_NO_WATERMARK)?.name).toBe('目录自己的名字')
  })

  it('目录里一条文生图模型都没有时不凭空补一个', () => {
    // 空组意味着这个账号的产品配置没开通生图，不是「目录列漏了」。
    // 补一条上去会让一次注定失败的调用真的发出去（还扣积分）。
    expect(imageModelChoices([], IMAGE_TAG_TEXT_TO_IMAGE)).toEqual([])
    expect(imageModelChoices([{ id: 'x', name: 'X', tags: ['craft'] }], IMAGE_TAG_TEXT_TO_IMAGE))
      .toEqual([])
  })

  it('v3.0 的尺寸范围比 alpha 小，且两个边界都是实测值', () => {
    const v3 = imageSizeLimitsOf(IMAGE_MODEL_NO_WATERMARK)
    const wide = imageSizeLimitsOf('hunyuan-image-alpha')
    // 实测：1024x1024 通过、1024x1025 被拒（14402），所以上限就是 1024²。
    expect(v3.maxPixels).toBe(1_048_576)
    expect(v3.maxEdge).toBe(2048)
    expect(v3.minEdge).toBe(512)
    // 未知 id 回落到宽的实测档，而不是凭空收紧一个没测过的模型。
    expect(imageSizeLimitsOf('some-future-model')).toEqual(wide)
    expect(wide.maxPixels).toBe(4_194_304)
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
  /** size 现在是必填参数；除了专门测「没填 / 填错」的用例，一律带上它。 */
  const SIZE = '1024x1024'

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

  it('工具描述先讲用户关心的事：哪个区、花多少积分、尺寸怎么填', () => {
    // 描述写给模型、模型再讲给用户听。写一堆「不许传 ratio / return_base64」的
    // 纪律，模型读完只知道不能做什么；用户问「这是国内版还是国际版」「一张多少
    // 积分」「我要竖版壁纸」时，它一条都答不上来。这三件事按顺序排在前面。
    const tool = createImageTool(deps())
    expect(tool.description).toContain('国内版')
    expect(tool.description).toContain('国际版')
    expect(tool.description).toContain('5.71')
    expect(tool.description).toContain('0.03')
    expect(tool.description).toContain('积分')
    // 具体模型 id 仍不写死：两区目录不同，点错区就是一次 NO_IMAGE_MODEL。
    expect(tool.description).not.toContain('hy-image-3.5')
    expect(tool.description).not.toContain('hunyuan-image-alpha')
    expect(tool.description).toContain('model 一般留空')
  })

  it('工具描述把「比例靠 size 而不是 prompt」写成行为指令', () => {
    // 这条指令原先只埋在 size.description 里：模型读工具描述就决定怎么填参数，
    // 看不到 size 的描述时只会在 prompt 里写「竖版」，出图仍是方图。
    const tool = createImageTool(deps())
    expect(tool.description).toContain('(a) 画什么：prompt 写主体')
    expect(tool.description).toContain('(d) size 怎么填（必填）')
    expect(tool.description).toContain('宽x高')
    expect(tool.description).toContain('2560x1440')
    expect(tool.description).toContain('1440x2560')
    // 第十一轮删掉了「只在 prompt 里写「竖版」不改变比例」这句话：前一句已经说了
    // 「比例只由 size 决定」，这句既不增加信息、模型也没有任何可执行动作，
    // 只让整段读起来像在防它。留下的是同一件事的正面表述。
    // 第十八轮：这句是纯复述（'prompt 里写竖版' 不改变比例这件事，schema 的 prompt 说明已经交代），
    // 两个评审都判它「不产生任何可执行动作」，删掉。
    expect(tool.description).not.toContain('比例只由 size 决定')
    expect(tool.description).not.toContain('不改变比例')
    expect(tool.description).toContain('要几张就调几次')
  })

  it('工具描述替模型回答「用户没说尺寸时填什么」', () => {
    // 让 size 必填只解决了一半问题：用户说「画只猫」时，模型仍要自己决定填多少。
    // 子代理冷读实测里，三个「用户没给尺寸」的请求全部卡在这里——它只能瞎猜一个
    // 数字，或者干脆不填撞 required。所以把常见用途的对照写进描述，让它有依据。
    const tool = createImageTool(deps())
    // 现在的写法不分「有没有说尺寸」两段，而是给一条优先级链：用户明确 → 比例词 →
    // 档位词 → 改图同比例 → 用途/方向默认。链尾那条才是「用户没说」时的兜底，
    // 所以断言它落在第 ⑤ 步——模型必须自己定，不许回头问。
    // 五条必须是**有序**的：第五轮对抗评审指出旧稿写成「先按下面四条选出」是合取
    // （四条都过），②与④在「4K 聊天配图」上死锁、③与①在「改图+点名尺寸」上打架。
    expect(tool.description).toContain('按顺序匹配，命中一条就停')
    // 第十轮冷读排第一的坑：比例词（9:16 / 3:4 / 4:3）原来没有任何换算规则，
    // 「16:9」只在手机壁纸那一格出现过一次、且要先命中用途。第十一轮单列一阶，
    // 并写明比例词压过形状词，否则「16:9 横图」会掉进 3:2 那格。
    // 第十一轮：比例词一阶改成「一个词一个画布」的表，不再给「9:16 1440x2560 或 1024x1536
    // 按长边需求选」这种二选一——1024x1536 是 2:3，标成 9:16 的选项等于让模型说谎。
    expect(tool.description).toContain('② 比例词各对应唯一一档')
    expect(tool.description).toContain('「16:9」2560x1440、「9:16」1440x2560、「4:3」2048x1536')
    expect(tool.description).toContain('「3:2」1536x1024、「2:3」1024x1536、「1:1」1024x1024')
    expect(tool.description).not.toContain('按长边需求选')
    // 比例词仍然压过形状词：「16:9 横图」要 16:9，不是 3:2。
    expect(tool.description).toContain('比例词压过档位词和方向词')
    // 第 ① 步不再要求它自己判合法：用户报 4096x4096 时照写，越界由工具缩，
    // 模型只需要负责「照用户的话写」和「把 hint 里的缩放说明转告用户」。
    // 第十一轮：① 从「照他的数写」改成「先规整成数字 + 小写 x」——旧写法与 schema 的
    // pattern 逐字冲突，用户说「1024*1536」时模型照写必挂 INVALID_ARGS。
    // 第十九轮：措辞从「先规整成」改成「先改写成」——「规整」曾被读成工具替你做的事。
    expect(tool.description).toContain('① 用户对输出图给了具体像素 → 先改写成')
    expect(tool.description).toContain('1024 by 1024 都写成 1024x1024')
    // 第十七轮：schema 只收 x/X/×，正文举例里的空格、* 和 by 传进来会被宿主拒，
    // 但原稿写「先规整成…再传」，读起来像工具会替你规整。
    // 第十九轮改措辞：「改写必须你自己做 / 大小写不用管」，并把责任拆开——
    // 宿主拒的是空格、*、by，X 与 × 工具自己认。
    expect(tool.description).toContain('改写必须你自己做')
    expect(tool.description).toContain('带空格、*、by 的写法宿主会直接拒掉')
    // 用途兜底从 ④ 挪到 ⑤：中间插进了比例词台阶，否则「9:16」这类说法无处可落。
    // 第十一轮把用途与方向拆成两阶（⑤ 用途、⑥ 默认档），并写明两者同时出现时按方向，
    // 否则「给这篇文章配张图，要横的」会先命中「聊天配图 1024x1024」出成方图。
    expect(tool.description).toContain('⑤ 用户说了用途')
    // 第十八轮：原句「用途不在表里就只按方向，见 ⑦」是悬空引用——⑦ 要求「只提了方向」，
    // 表外用途 + 没提方向时无处可落。改成两支：另说了方向 → ⑦；连方向也没说 → 1024x1024。
    expect(tool.description).toContain('用途不在表里，且用户另外说了方向 → 见 ⑦')
    expect(tool.description).toContain('连方向也没说 → 1024x1024')
    // 第十五轮：默认档从 ⑥ 挪到 ⑧——⑥ 让位给「表外比例」，⑦ 是只提方向。
    expect(tool.description).toContain('⑧ 以上全都没命中、也看不出方向 → 1024x1024')
    // 第十三轮：删掉「用途和方向同时出现时按方向」这句总纲——它和 ⑤ 的用途表
    // 并置时同一句「手机壁纸，横的」有两个合法答案。改成表内每行自带方向、
    // 命中就不再降级，方向只在「表里的行与用户明说的方向不符」时才出手。
    expect(tool.description).not.toContain('用途和方向同时出现时按方向')
    expect(tool.description).toContain('用户另外说的方向与这一行冲突就交换宽高')
    expect(tool.description).toContain('配图、插图、封面、头像、表情包 1024x1024')
    expect(tool.description).toContain('手机壁纸、竖版海报（要说到「海报」才算）、手机开屏 1440x2560')
    // 「2K」是用户最常说的档位词，模型会原样搬进 size 撞 pattern；这里给出三种朝向
    // 的换算，并写明 2K 的方图是 2048x2048（旧稿漏了这一格，2K 竖图又写成 9:16，
    // 与第 ④ 步的竖图 2:3 打架）。
    expect(tool.description).toContain('「2K」横 2560x1440、竖 1440x2560、方 2048x2048')
    // 「4K」三种朝向都要写：只给横向的话，模型问「4K 竖图」时又只能瞎猜。
    // 第九轮改向：4K 三个值（3840x2160 / 4096x4096）全部越界，照字面会让 4K 档
    // 整体退化成 2K 档还每次触发缩放提示。改成直接给本工具的最大档 + 一句
    // 「出不了真 4K，回复里要说清」，把「降级」从副作用变成要转述的事实。
    // 第十一轮：4K 的三元组补上「横 / 竖 / 方」的对应，并直接写明它和 2K 是同一档。
    // 旧写法「横竖方都写 2560x1440 / 1440x2560 / 2048x2048」只给三个孤立的数，
    // 模型得自己猜哪个对哪个朝向。
    // 第十三轮：4K 改成「不设独立档」，并删掉「画布上限就到 2048x2048」——
    // 同段自己给的 2560x1440 就在那个上限之外，模型照字面会把「最大档」说错。
    expect(tool.description).toContain('「4K」不设独立档')
    // 第二十轮：③ 里那组三元组与「直接看 2K」重复，删掉；4K 只留一句「用 2K 那组值」。
    expect(tool.description).toContain('「4K」不设独立档，直接用上面 2K 那组值')
    expect(tool.description).not.toContain('2560x1440 / 1440x2560 / 2048x2048')
    // 第十四轮：上限只在「范围」那一段说一次。③ 里那份逐字重复的「单边 2560、面积 4,194,304」
    // 已删——同一个上界写两遍，两处迟早漂移（上一轮就出现过 2560x1440 与「顶格 2048x2048」打架）。
    expect(tool.description).toContain('两条边各 512–2560，宽乘高不超过 4,194,304')
    // 第二十轮：③ 里 4K 的定义重复了两遍（三元组 + 一句话术），冷读把它列为「最该删」之一。
    // 现在 ③ 只说「用 2K 那组值」，话术只说「出不了真 4K」，上限那组数只在范围段出现一次。
    expect(tool.description).toContain('本工具最长边 2560，出的是这一档')
    expect(tool.description).not.toContain('2048x2048 是方图最大档')
    expect(tool.description).not.toContain('画布上限就到 2048x2048')
    // 第十四轮：④③ 之间的死锁。旧稿 ③ 写「没说方向就按方」，而「4K 桌面壁纸」既命中
    // ③（档位词）也确实说了用途——按「命中即停」只能给方图 2048x2048，用户拿到一张
    // 方图当桌面壁纸，且已扣费。方向必须在 ③ 里有自己的裁决顺序，不能默认按方。
    expect(tool.description).toContain('方向统一这么定：用户明说了横/竖/方就按他说的')
    expect(tool.description).toContain('没说就看用途（桌面壁纸算横，手机壁纸、竖版海报、开屏算竖）')
    expect(tool.description).toContain('用途也没说就用方')
    // 第十七轮：③ 的档位词只给了 1080P/720P 的横向像素，而同一阶又说「用途只用来定方向」——
    // 「1080P 手机壁纸」字面无解，只能落 1920x1080 横图，与「手机壁纸算竖」自相矛盾。
    expect(tool.description).toContain('「1080P」横 1920x1080、竖 1080x1920')
    expect(tool.description).toContain('「720P」横 1280x720、竖 720x1280')
    // 第十八轮：1080P/720P 只有横竖两个值，原句「按本阶下面那条方向规则选」会让「来张 1080P」
    // 落到「用途也没说就用方」，而这一档没有方档——死路。改成默认按横版并说明。
    expect(tool.description).toContain('1080P / 720P 没有方档，这两个落到「用途也没说」时按横的给')
    // 兜底只能有一条：旧稿同时写着「等比缩到范围内」和「横图用 2560x1440」，
    // 3000x2000 会得到 2508x1672 与 2560x1440 两个都合法、比例不同的答案。
    // 现在越界一律由 fitIntoRange 处理，模型不用参与，描述只需说明「工具会缩」。
    // 第十四轮：小尺寸不再算「本地拒绝」。旧稿把它列进「确定不扣积分」的清单，
    // 而同段的越界说明又说「会等比缩/放后照常出图」——同一个 300x300 两种钱的说法。
    // 实现上 fitIntoRange 会在最短边 < 512 时按 512/shortest 放大（src/image-tool.ts:581-585），
    // 所以「写超了、或某条边小于 512」都只是缩放，不报错。
    expect(tool.description).toContain('写超了、或某条边小于 512，都不用你换算')
    expect(tool.description).not.toContain('数字小到画不出来')
    expect(tool.description).toContain('这句必须转告用户')
    expect(tool.description).toContain('比 5:1 还细长')
  })

  it('第十四轮：比例词压过档位词，改图按「比例→用途→方向→auto」派发', () => {
    const tool = createImageTool(deps())
    // ② 与 ③ 都自称能回答「2K 的 16:9 壁纸」：② 给 2560x1440、③ 给 2K 方图 2048x2048，
    // 「命中即停」只能选先出现的那个，而 ② 的旧尾括号「（用户同时说了 2K/4K/大图时才用
    // 2048x2048）」只挂在 1:1 后面，辖域看不出来 → 用户拿到方图，且已扣费。
    expect(tool.description).toContain('比例词压过档位词和方向词')
    expect(tool.description).toContain('「2K 的 16:9 壁纸」还是 2560x1440（不是方图 2048x2048）')
    // ② 的值是定死的，用户再加「2K / 4K / 大图」不该把它升上去（升不上去，只会撞越界）。
  // 删掉「各档都已顶到本工具上限」：3:2 是 1536x1024（1.57M），离 4,194,304 差得远，
  // 与同段的「上限两条边各 512–2560」并读像在说「上限是 1536」。
  expect(tool.description).not.toContain('且都已顶到本工具上限');
    // 第十八轮：「高清」也被 ③ 定义成 2K，但 ② 的升级名单只写了 2K / 4K / 大图，
    // 于是「1:1 高清」是 1024x1024、「1:1 2K」是 2048x2048，同一档两个结果。名单补上「高清」。
    expect(tool.description).toContain('比例词一旦命中，就不再因为用户又加了 2K / 4K / 高清 / 大图而改值')
    expect(tool.description).toContain('只说 1:1 是 1024x1024，同时说了 2K / 4K / 高清 / 大图才写 2048x2048')
    // ② 与方向词打架时要有裁决，否则「9:16 横图」无解。
    expect(tool.description).toContain('比例词和方向词打架时按比例词')
    // ③ 只在没提比例词时生效，否则「4K 16:9」会被 ③ 吃掉，「不是真 4K」的披露义务整句丢失。
    expect(tool.description).toContain('③ 档位词只在用户没提比例词时生效')
    // 披露义务改成「只要提了 2K/4K/高清就加一句」，不再只挂在 ③ 里——挂在某一阶上时，
    // 命中别的阶就没人说这句话了。
    expect(tool.description).toContain('只有用户提的档位超出本工具上限')
    // ④ 旧稿是「补丁段」：先说不提比例不提方向才 auto，再补一句提了方向按方向给档——
    // 但没给具体值，「把这张改成横的」只能靠猜。现在改成一条有序派发，每支都有落点。
    // 第十八轮：④ 原先没有「档位词」分支，「把这张改成 2K」既不是比例也不是用途/方向，
    // 只能掉到 ⑧ 的 1024x1024——用户要 2048² 拿到 1024² 还被计费。
    // 第二十一轮：④ 首句加了「先分清输出尺寸还是输入图尺寸」——旧句直接进「按这个顺序定」，
    // 而 ① 主句（数字+x 就是输出像素）已经把「我这张是 1600x900」吞掉了。
    expect(tool.description).toContain('④ 有输入图（改图）时：先把「用户说的到底是输出尺寸还是输入图尺寸」分清楚')
    expect(tool.description).toContain('分完之后按这个顺序定：提了输出像素 → 用 ①；提了比例 → 用 ②；提了档位词 → 用 ③')
    expect(tool.description).toContain('提了用途 → 用 ⑤')
    expect(tool.description).not.toContain('别再被「版式别动」拽回 auto')
    // ⑤ 的「不符时才改」原本写成「要竖的改 1024x1536」，与「手机壁纸 1440x2560」自相矛盾：
    // 那一行本来就是竖的，用户说「要竖的」不该把画布改小一半。改成只在方向相反时才换。
    expect(tool.description).toContain('用户另外说的方向与这一行冲突就交换宽高')
    expect(tool.description).toContain('「做张手机壁纸，要竖的」→ 仍是 1440x2560')
    // (c) 只说了「控制不了」，没给可操作路径；用户嫌贵时模型手里没有任何动作。
    // 第十八轮：原句「这一次调用里换不了、也查不到」是纯状态陈述，改成可操作的一句。
    expect(tool.description).toContain('去插件设置把不想用的那个区的')
    expect(tool.description).toContain('「允许模型自主生图」关掉，下一次调用才生效')
    // 越界缩放会回带 requestedSize，模型转述「缩成多少」时才有据可依。
    expect(tool.description).toContain('同时回带 requestedSize')
  })

  it('第十五轮：方向单独成一阶、表外比例有落点、多张先报价', () => {
    const tool = createImageTool(deps())
    // 旧稿的方向规则挂在 ③「档位词」条件下，而 ⑥ 的触发条件是「也看不出方向」——
    // 用户只说「来张竖图」时两阶都不命中，字面两解（1024x1536 或 1024x1024），
    // 一半概率给出方图。方向必须自己有一阶，且这一阶对 ②③⑤ 都生效。
    expect(tool.description).toContain('这一阶管所有方向词')
    expect(tool.description).toContain('都落到这里')
    // 表里没有的比例（4:5、21:9、5:4）原来无处可落：② 只列了七档，落 ⑧ 又要求
    // 「也看不出方向」，照字面只能瞎猜或反问。第十五轮先写成「套 ⑦ 的档位」——
    // 但 ⑦ 只有三档，套出来的永远是 2:3 / 3:2 / 1:1，4:5 会变成 1024x1536（2:3）。
    // 两个盲读子代理都点名这条「规则本身无法成立」，改成按比例直接算像素。
    expect(tool.description).toContain('⑥ 用户说的是表里没有的比例（4:5、21:9、5:4 等）')
    // 第十八轮：删掉「长边尽量取 2560」——它和自己的例子打架（4:5 按它算约 1831x2289，
    // 例子却给 1824x2280）。改成一句：两个上限取更严的那个。
    expect(tool.description).not.toContain('长边尽量取 2560')
    expect(tool.description).toContain('两个上限取更严的那个（长边 2560、面积 4,194,304）')
    // 第十七轮：例子的算术要能复核（21:9 的长边 2560 → 短边 2560*9/21=1097.1），
    // 4:5 的旧例子 1600x2000 既不是「长边尽量 2560」也没顶面积，等于凭空丢 30% 像素。
    expect(tool.description).toContain('21:9 → 2560x1097')
    expect(tool.description).toContain('4:5 → 1831x2289')
    expect(tool.description).toContain('再把宽高乘一遍验算')
    expect(tool.description).toContain('算出来的宽高先按 ④ 说给用户')
    expect(tool.description).toContain('调用完把实际填的宽高写进回复')
    expect(tool.description).toContain('用途不在表里，且用户另外说了方向 → 见 ⑦')
    // 「同题多版就重复调几次」原来没有任何确认门：用户说「来 4 版」直接四次付费调用。
    // 第十八轮到第十九轮：(b) 的报价口径改成「两个区各报一个数」，开头这句却仍写
    // 「按国内版估的总价」——同一段文字两个口径，模型会只报一档（冷读 7a740f46 点名的
    // 「入口不一致」）。
    // 第二十二轮：报价前先判「一样」还是「不同」——旧句「要超过一张（含同题多版）时先报价」
    // 会让「来 4 张一样的」先报 4 张价、再连调 4 次，买一个原文自己承认做不到的结果。
    // 第二十二轮把多图写成三态：一样 → 拒绝；不同 → 报总价等同意再连调；挑一张 → 先出 1 张。
    expect(tool.description).toContain('跟要几张无关——用户要的是「一样」还是「不同」')
    expect(tool.description).toContain('本工具没有 seed、不存历史、不能重放')
    expect(tool.description).toContain('让他只出一张自己复制；不报价、不调用')
    expect(tool.description).toContain('(ii) 要「不同风格」「各来一张」→ 按 (b) 的口径报张数和总价')
    expect(tool.description).not.toContain('按国内版估的总价')
    expect(tool.description).toContain('等他明确同意 → 连着调 N 次，每次换 prompt')
    // 改图时 size 比例与输入图不同，工具按 size 裁切/留白——原来只说「按 size」，
    // 没说会裁切，也没要求告知，用户拿到一张缺角的图还以为是原构图。
    // 第十六轮：原稿要求「出图后说明并问要不要改用 auto」——模型调用前量不到输入图比例，
    // 照字面必然先扣一次费再问。改成调用前先说、用户同意再调。
    expect(tool.description).toContain('改图只要 size 的比例可能和原图不一样')
    expect(tool.description).toContain('工具就按 size 裁切或留白原图')
    expect(tool.description).toContain('会按这个比例裁切/留白，原版式可能被切')
    expect(tool.description).toContain('他同意再调，别等出完图才说')
    // 第十八轮：auto 不是绝对安全——原图比 5:1 还细长时 auto 也会换比例，
    // 原句「改用 auto 保住原版式」在这里是假承诺。
    expect(tool.description).toContain('auto 会保住原版式；只有原图比 5:1 还细长时 auto 也会换比例')
    // 调用前不知道是哪个区，只报 0.03 会让用户以为那就是实价。
    // 第十八轮：把「估价一律按国内版 5.71 说」收敛成两区各报一个数 + 已拿到 credit 就按那个数报。
    // 第二十二轮：口径不再自称「只有一个」——有 credit 时按实扣报是第二种合法报法，
    // 旧句「只有一个口径」与紧随其后的「拿到 credit 就按那个数报」自相矛盾（冷读 H6）。
    expect(tool.description).toContain('报价按这个口径：还没拿到 credit 就两个区各报一个数')
    // 第十八轮：原句「一律按国内版 5.71 说，再补一句…」与 (b) 的两区报价口径重复，
    // 收敛成「两个区各报一个数」。
    expect(tool.description).toContain('两个区各报一个数（如「每张：国内版约 5.71、国际版约 0.03 积分」）')
    // 档位词与用途同句时（「4K 配图」）尺寸按 ③、用途只定方向，不能掉到 ⑤ 的 1024x1024。
    expect(tool.description).toContain('尺寸按本阶（档位词）走，用途只用来定方向')
    expect(tool.description).toContain('「4K 配图」是 2048x2048，不是 ⑤ 的 1024x1024')
  })

it('第十九轮：报价口径统一、主体门禁补方向词、改写责任说清、只改尺寸给范本', () => {
    const tool = createImageTool(deps())
    // 冷读 7a740f46 判 3/10 的「入口不一致」：开头写「按国内版估的总价」，
    // (b) 又写「两个区各报一个数」——同一件事两个口径，模型会只报一档。
    expect(tool.description).toContain('(ii) 要「不同风格」「各来一张」→ 按 (b) 的口径报张数和总价')
    expect(tool.description).toContain('按 (b) 的口径报张数和总价')
    expect(tool.description).not.toContain('按国内版估的总价')
    // (a) 的主体门禁只列了「尺寸、比例、用途或风格」，漏了「档位」「方向」——
    // 「来张竖图」严格字面读不出要先问主体，模型会自己编一个主体去扣积分。
    expect(tool.description).toContain('只说了尺寸、比例、档位、用途、方向或风格')
    // ① 同一句里先说「工具会规整成小写」、又说「规整这一步是你自己做」，
    // 两句话的责任方不同；宿主拒的是空格 / * / by，大小写工具自己认。
    expect(tool.description).toContain('带空格、*、by 的写法宿主会直接拒掉，改写必须你自己做')
    expect(tool.description).toContain('大小写和 × 不用管')
    expect(tool.description).not.toContain('工具会规整成小写）')
    // 只改尺寸或方向、不改内容时（「把这张改成横的」）原文没规定 prompt 写什么，
    // 模型要么编画面内容（违反「不要描述你没看到的具体细节」），要么卡住。
    expect(tool.description).toContain('保持主体和光线不变，按新的画布重新构图')
    expect(tool.description).toContain('不要另编画面内容')
    // 「本轮对话里也没给过」与 ⑦ 里「上一轮 C:\\Users\\me\\a.png」字面冲突：
    // 上一轮不是本轮，照字面要再问一遍路径。第二十轮把三种旧写法（本轮 / 这次对话 /
    // 往上几条）统一成一句「前面哪一轮给过就沿用那一张」——「哪一轮」覆盖了本轮与更早。
    expect(tool.description).toContain('前面哪一轮给过就沿用那一张')
    expect(tool.description).not.toContain('这次对话里也从没给过')
    // 第二十轮：旧句「往上几条给过就算给了」等于允许静默复用一张旧图（可能改错文件还扣费），
    // 改成「沿用那一张，调用前把文件名说出来确认」。
    expect(tool.description).toContain('前面哪一轮给过就沿用那一张，调用前把文件名说出来确认')
    expect(tool.description).not.toContain('往上几条给过就算给了')
    expect(tool.description).not.toContain('本轮对话里也没给过')
  })

  it('第十三轮：把三处「照字面执行就错」的分支写死', () => {
    // 两个盲读子代理各自独立点到的三件事，都是「字面照做必错」的类型：
    const tool = createImageTool(deps())
    // ① 用户说「我这张图是 1600x900」是在交代**输入图**尺寸，但 ① 的触发词是
    // 「用户给了具体像素」，加上「命中一条就停」，1600x900 会先命中 ① 并吃掉 ② 的
    // 「9:16」——输出变 16:9 横图，与用户要求相反且不报错，白花一次积分。
    expect(tool.description).toContain('用户说「我这张图是 1600x900」是在交代输入图')
    // 第二十一轮：旧句「不算提了输出尺寸」是**否定式澄清**，读者还得自己去找该走哪条；
    // 现在改成肯定句「输入图的宽高永远不是 size 的值」，去处交给 ④ 的首句。
    expect(tool.description).toContain('输入图的宽高永远不是 size 的值')
    // ② 「高清」在 schema 的档位词清单里被点名，但描述的两张表里没有这一格，
    // 模型只能落到 ⑥ 默认档或自己猜 1080P。
    expect(tool.description).toContain('「高清」按 2K')
    // ③ 改图 + 方向词：④ 说「没提比例也没提方向才 auto」，但没说提了方向该走哪一档，
    // 模型会退回 auto（保持原图方向），用户要的「竖的」被丢掉。
    // 第十四轮：④ 从「补丁式补充」改成一条有序的派发（比例→用途→只提方向→auto），
    // 并且「只提方向」必须落在具体像素上，否则「把这张改成横的」还是没值可用。
    // 第十五轮：④ 里的方向值挪进独立的 ⑦ 阶，④ 只留引用——否则「只提方向」
    // 这条规则只对改图生效，文生图说「来张竖图」仍然没有落点。
    expect(tool.description).toContain('只提了方向 → 见 ⑦')
    expect(tool.description).toContain('⑦ 只提了方向、比例档位用途都没提 → 取 ② 表里同方向那一档')
    // ④ 用户只说「这张图」却没给路径：原文只规定了元素格式，没给这个动作，
    // 模型会猜一个同目录文件名去调，白撞一次 INVALID_ARGS。
    expect(tool.description).toContain('先问他要路径，别猜一个')
  })


  it('第二十二轮第二批：4K 不再是停点、只报张数有分支、300 字不再拦调用', async () => {
    const tool = createImageTool(deps());
    // 对抗评审：七条第 5 条把「真 4K」列为必须先停，而 ③ 又要求「先调、调完说明档位」，
    // 同一句「来张 4K 壁纸」两条路都指向「照字面执行必违反其一」。改成「明确要超过 2560 的像素」才停。
    expect(tool.description).toContain('用户把某个超过 2560 的像素当验收标准');
    expect(tool.description).not.toContain('做不到（真 4K、');
    // 单张「告知即可」不能把改图裁切也一起放行——那是七条里明写的停点。
    expect(tool.description).toContain('（改图会改版式、要出多张这些仍在七条里，得等同意）');
    // 「4 张要多少钱」没说同异：旧稿只能二选一（对做不到的事报价 / 违反报价义务）。
    expect(tool.description).toContain('没说同异、只问张数价钱（「4 张要多少钱」）');
    expect(tool.description).toContain('先问「要一样的还是各不相同的」，问完再报');
    // 300 字压缩是第七个停点，与「只看这七条」互斥；改成压完直接调并回显实际 prompt。
    expect(tool.description).toContain('压完直接调，并在回复里附上实际用的那版 prompt');
    expect(tool.description).not.toContain('他说行再调');
    // ⑤ 的三分支枚举收成一句「冲突就交换宽高」，方向一致时照这一行走。
    expect(tool.description).toContain('用户另外说的方向与这一行冲突就交换宽高');
    expect(tool.description).toContain('方向与这一行相同就照这一行走');
  });

  it('第二十二轮：单张也先报价、死条件改成可判定、改图不会掉进默认方图', () => {
    const tool = createImageTool(deps())
    // 冷读 2154c618 判 −1.5 的那条：单张「不用请示」+ 默认走贵区 + 调用前查不到区
    // = 用户完全不知情就按 190 倍价扣费。补一条「告知，不用等同意」的报价口，
    // 并把「想锁定金额」的唯一合法路径写出来（关掉一个区的开关）。
    expect(tool.description).toContain('单张也要先把这两档价说一句，然后在同一轮里接着调')
    expect(tool.description).toContain('这是告知，不是请示')
    expect(tool.description).toContain('用户要锁定金额只有一条路')
    expect(tool.description).toContain('让下一次只可能走另一个区')
    // ⑦ 与 ④ 的默认值互斥：④ 说「什么都没提 → auto」，⑧ 说「全没命中 → 1024x1024」，
    // 改图会静默裁成方图，而这正是停等第 2 条要求先问的动作。
    expect(tool.description).toContain('改图有输入图时走不到这一阶')
    expect(tool.description).toContain('别把原图裁成方图')
    // 主体门槛只给了三个反例，「赛博朋克」「秋天」这类词无处归类。
    expect(tool.description).toContain('风格、流派、季节、情绪只说明怎么画，不说明画什么')
    expect(tool.description).toContain('「高级感」都不算主体')
    // ① 说「越界也别自己缩」与范围段「5:1 本地报错」对撞，照 ① 做会白跑一轮。
    expect(tool.description).toContain('唯一的例外是比 5:1 还细长的比例')
    // 唯一的交付物是 24 小时后失效的 URL，转存手段全文没写。
    expect(tool.description).toContain('本工具不负责下载或转存')
  })


  it('第二十一轮：同意门槛收成五条清单、输入尺寸只有一个否命题、主体例子不再和主题撞', () => {
    const tool = createImageTool(deps())
    // 冷读 6c61a647 与对抗 07007341 都判「单张不必请示」是全文最危险的一句：它把授权扩张到
    // 「不等裁切确认也能扣费」，与同段「改图要先说会裁切」正面冲突。改成五条可判定的清单。
    // 第二十二轮：这条原本写成「要真调一次才能报价」，但 (b) 保证任何时刻都能报两档，
    // 于是它永远不成立、成了清单里的一条死项。改判据为「两档价不够用、要确切单价」。
    // 对抗 9d9bbad5：旧句「要真调一次才能报价」与 (b)「永远能报两档」矛盾，改判据也不行——
    // 用户问的是「能写进预算的单价」，那是报价精度问题，不是停等条件。这一条改成「做不到的事」。
    expect(tool.description).toContain('文生图且主体还没定')
    expect(tool.description).toContain('用户把某个超过 2560 的像素当验收标准')
    expect(tool.description).toContain('用户要求硬排除某个元素（「绝对不能有 XX」）')
    // 对抗评审：这个括号的「不用请示」把 (b) 的强制报价告知降成了可跳过项——静默走贵区的直接诱因。
    expect(tool.description).toContain('七条都不成立（单张文生图、size 用现成档位）就直接调，不用等点头')
    expect(tool.description).toContain('但单张仍要按 (b) 报一次两档价——那是告知，不是请示')
    // 对抗 H2：④ 原来第一句就是「按这个顺序定」，而 ① 主句已经把「我这张是 1600x900」当成
    // 输出像素吞掉了。④ 必须先在「输出尺寸 / 输入图尺寸」上分一次类。
    expect(tool.description).toContain('「改成 1200x800」「要 9:16」是输出')
    expect(tool.description).toContain('「我这张是 1600x900」是输入，输入尺寸永远不填进 size')
    // 对抗 H3：(a) 举例「秋季新品静物」算主体，同一句又说「秋季新品」是主题不算主体——
    // 同一个词正反两例。例子换成不会混的。
    expect(tool.description).toContain('「秋季新品」是主题，「一束向日葵」才是主体')
    expect(tool.description).not.toContain('秋季新品静物')
    // 对抗 H4：③ 用「1080P 的头像」当竖版例子，⑤ 里「头像」却在方行——同词两向。
    expect(tool.description).toContain('「1080P 的竖版海报」：海报算竖，给 1080x1920')
    expect(tool.description).not.toContain('「1080P 的头像」')
    // 对抗反例 4：用户说「就用上次那个模型」时，原文只接受 id，模型会静默换一个。
    expect(tool.description).toContain('用上次那个模型')
    expect(tool.description).toContain('并告诉他这次实际用的是哪个')
  })
  it('第二十轮：1600x900 只有一个出口、⑧ 不发主体通行证、表外比例与 5:1 不再互斥', () => {
    const tool = createImageTool(deps())
    // 冷读 f334d629 的 C1：① 说「1600x900 是在交代输入图……继续往下匹配」，④ 又说
    // 「只是交代了输入图多大 → auto」。两种读法一条落到 ⑧ 的 1024x1024（把 16:9 裁成方图
    // 还扣一次费），一条写 auto 保住版式。输入图尺寸必须只有一个出口。
    // 第二十一轮：① 里不再复述去向（复述会与 ④ 漂移），只留一条否命题 + 「照 ④ 处理」。
    expect(tool.description).toContain('是在交代输入图，照 ④ 处理')
    expect(tool.description).not.toContain('继续往下匹配')
    // C2：⑧ 授权「全都没命中就出 1024x1024」，(a) 要求没主体先问——「随便画一张」两读法，
    // 一种先反问、一种直接扣费。⑧ 必须声明自己只管尺寸。
    expect(tool.description).toContain('⑧ 只管尺寸，不给主体发通行证')
    // C6：「主题」算不算给了主体没有判据，模型会拿「秋季新品发布主题」当主体直接出图。
    expect(tool.description).toContain('主体＝画面上要出现的人、物、景')
    // 第二十二轮：主体门槛反噬改图主路径——「把这张改成水彩」只有风格没有主体，
    // 旧稿让人拿着参考图还问「想画什么」。门槛只对 text-to-image 生效。
    expect(tool.description).toContain('只有 text-to-image 才受这条限制')
    expect(tool.description).toContain('改图（给了 image）不算没主体')
    expect(tool.description).toContain('只说「主题」「氛围」「风格」不算给了主体')
    // C4：全文只写了多张的同意卡，单张要不要先请示是空白——模型可能每次出图都先问一遍。
    // 第二十一轮：改成一份可判定的五条清单。旧句「单张不必请示」是**授权扩张**，
    // 与同段「改图裁切要先同意」互斥——冷读把它列为「最该删」第一条。
    // 第二十二轮：五条 → 七条（补「要自己按表外比例算像素」与「刚说嫌贵/刚让改区设置」），
    // 并给「同意」下定义——旧稿的「同意」没定义，沉默、反问都可能被算成同意。
    expect(tool.description).toContain('什么时候必须先停下等用户点头，只看这七条')
    expect(tool.description).toContain('「同意」只算用户明确说同意，沉默、反问、换话题都不算')
    expect(tool.description).toContain('成立两条以上时合成一次问完')
    expect(tool.description).not.toContain('单张不必为「要不要花一次积分」单独请示')
    // C5：⑥ 让模型自己算表外比例，范围段又说比 5:1 细长就本地报错——8:1 会先承诺
    // 2560x320 再必然被拒。⑥ 必须自己排除这条死路。
    expect(tool.description).toContain('而算出来的比例不能比 5:1 更细长')
    // 第二十二轮：⑥ 的「改用 auto」对文生图是死路——auto 要量输入图，没图必在本地报错。
    expect(tool.description).toContain('改图就改用 auto')
    expect(tool.description).toContain('文生图没有 auto 可退')
    // C3：旧句「往上几条给过就算给了」等于允许静默复用旧图，改错文件还扣费。
    expect(tool.description).toContain('调用前把文件名说出来确认')
    // C9：「10 字」「300 字」没写单位，中文场景下会被按单词算。
    expect(tool.description).toContain('10 个字以内')
    expect(tool.description).toContain('300 字以内（按汉字算）')
    // C8：「约」价与实扣 credit 不符时没有善后规则，模型会照旧说「约 5.71」蒙过去。
    expect(tool.description).toContain('实扣和你报的「约」对不上')
    expect(tool.description).toContain('别替它圆')
  })
  it('第十九轮：主体门禁前置、方行遇方向有解、同意卡只发一次', () => {
    const tool = createImageTool(deps())
    // 冷读 7a740f46：开头「按国内版估的总价」与 (b)「两个区各报一个数」入口不一致，
    // 模型只报一档；报价口径必须全文只有一处。
    expect(tool.description).toContain('按 (b) 的口径报张数和总价')
    expect(tool.description).not.toContain('按国内版估的总价')
    // ac8fee1c：header 让先报 4 张总价、同意再连调，下一句让先出 1 张——用户批的是 4 张预算、
    // 拿到 1 张。两件事必须合并成同一张同意卡。
    // 第二十一轮：这张卡只该在用户**明说**「挑一张」时生效——旧句写成无条件，
    // 于是普通的「来 4 张」会先只出 1 张，与同段「按张数报价、同意再连着调」打架。
    expect(tool.description).toContain('(iii) 要「挑一张」「先看一张」→ 先出 1 张给他看')
    // 「已经拿到过 credit 的直接按那个数报」没有时间限定，会把上一次的单价搬到这一次。
    expect(tool.description).toContain('本次调用返回过 credit 的（同一张图、同一次请求）')
    expect(tool.description).not.toContain('已经拿到过 credit 的，直接按那个数报')
    // (a) 说「没主体先问」、(d) 说「按顺序匹配命中即停」——两句之间没有顺序约束，
    // 「随便画个 16:9 的」会直接自编主体扣一次费。
    expect(tool.description).toContain('先过 (a) 的主体门槛')
    expect(tool.description).toContain('后面的推导一条都不要走')
    // ② 「1:1 不升级」紧跟「1:1 + 高清才 2048x2048」，一句之内自我否定。
    expect(tool.description).toContain('比例词一旦命中，就不再因为用户又加了')
    expect(tool.description).not.toContain('同一档不因为用户再加了')
    // ③ 与 ② 各给一套方向默认（「1080P 按横」vs「用途没说算方」），同一段两个反向默认。
    expect(tool.description).toContain('方向统一这么定')
    expect(tool.description).not.toContain('有方档的档位词（2K / 4K / 高清）方向这么定')
    // ⑤ 的配图行是方行，翻转规则只写了「横行要竖」「竖行要横」，方行遇方向词无定义。
    expect(tool.description).toContain('方的行他要横 → 1536x1024、要竖 → 1024x1536')
    // 「大图」在 ② 是修饰词、在 ⑤ 是用途词，单独出现两条都不命中。
    expect(tool.description).toContain('要「大一点的方图」或「大图」单独出现')
    // ④ 事前同意 vs ⑥ 事后回显：同一张图两套时序，照 ⑥ 就是先扣费后告知。
    expect(tool.description).toContain('算出来的宽高先按 ④ 说给用户（改图时尤其要说会被裁切），同意后再调用')
    expect(tool.description).toContain('调用完把实际填的宽高写进回复')
    // 只有 ① 是「输出像素」；把输入图尺寸写成输出尺寸会按 16:9 裁掉原图。
    expect(tool.description).toContain('提了输出像素 → 用 ①')
    expect(tool.description).toContain('只是交代了输入图多大（「我这张是 1600x900」）→ 写 auto')
    expect(tool.description).not.toContain('工具去量第一张输入图的宽高')
    // (c) 说「下一次调用才生效」，没说改设置之前这一次先别调——照常调用仍按国内版扣。
    expect(tool.description).toContain('改设置之前这一张先别调')
    // 重试是不是新的一次计费决策，旧稿没写。
    expect(tool.description).toContain('重试等于新的一次计费决策')
    // 纯信息、零动作的括注（「这组值是定死的」）删掉，留出字数给决策本身。
    expect(tool.description).not.toContain('这组值是定死的')
  })

  it('第十七轮：档位词给横竖两值、规整自己做、表外比例算术可复核', () => {
    const tool = createImageTool(deps())
    // ① ③ 只给「1080P」1920x1080，同阶又说「用途只用来定方向」——「1080P 手机壁纸」
    // 字面无解，只能落横图，与「手机壁纸算竖」自相矛盾。
    expect(tool.description).toContain('「1080P」横 1920x1080、竖 1080x1920')
    // ② ① 的举例含空格 / * / by，schema 的 pattern 一条都不收，「先规整成…再传」
    // 读起来像工具替你规整；实际规整发生在传进来之后。
    // 第十九轮改了措辞：同一句里原先既说「工具会规整成小写」又说「规整这一步是你自己做」，
    // 责任方对不上。宿主拒的是空格 / * / by，大小写工具自己认。
    expect(tool.description).toContain('改写必须你自己做')
    expect(tool.description).not.toContain('规整这一步是你自己做')
    // ③ ⑥ 的旧例子 4:5 → 1600x2000 与「长边尽量 2560」互斥，面积还差 30%。
    expect(tool.description).toContain('21:9 → 2560x1097')
    // ④ 「构图不变」与「按 size 裁切」互斥，改图换比例时 prompt 只保留主体与光线。
    expect(tool.description).toContain('这次 size 换了比例时别写「构图不变」也别写「只换画布」')
    // ⑤ 「没主体先问」与 ⑧ 默认档原先二义：⑧ 只负责尺寸，不负责主体。
    // 第十八轮：这句是纯交叉引用（(a) 已经写了「没主体先问」），删掉。
    expect(tool.description).not.toContain('这一阶只定尺寸')
    // ⑥ 「失败之后要不要再来一次，先看文末」是纯导航句，删除。
    expect(tool.description).not.toContain('失败之后要不要再来一次')
  })

  it('工具描述开头就说清「一次一张、要几张调用几次」', () => {
    // OpenAI 的 images 有 n，模型的肌肉记忆会直接补一个 n: 4。第八轮删掉了
    // 「没有 n 这种张数参数」这句纯防御的话（schema 的 additionalProperties:false
    // 已经挡住，写了也只是让模型读出「这里在防我」），改成正面说明计量方式：
    // 一次一张、几张就调几次、每张都扣积分。第一句就要出现，晚于 (b) 讲价时
    // 模型已经算完总价了。
    const tool = createImageTool(deps())
    // 第十三轮：首句不再出现「成功才扣」这种绝对句（与「超时可能已扣费」对撞），
    // 扣费单独由「计费边界」那段的三种说法承担。
    expect(tool.description).toContain('一次调用只出一张图，要几张就调几次')
    expect(tool.description).toContain('数组长度只表示参考图张数，不影响出图张数')
    expect(tool.description.indexOf('一次调用只出一张图')).toBeLessThan(20)
    expect(tool.description).not.toContain('成功出一张才扣一次积分')
    expect(tool.description).not.toContain('没有 n 这种张数参数')
  })

  it('工具描述说清 image 是数组、且文生图要整个省略（不是给空数组）', () => {
    const tool = createImageTool(deps())
    expect(tool.description).toContain('image 是改图用的参考图，写成数组')
    expect(tool.description).toContain('一张也写')
    // 「永远是数组」与「不给就是文生图」字面打架，模型会补一个 image: [] 撞 minItems。
    // 所以必须同时给出「省略字段」这个动作，而不只是「必须是数组」这条约束。
    expect(tool.description).toContain('整个省掉')
    expect(tool.description).toContain('不要传空数组')
    // 改图时 size 决定输出画布，不是「沿用原图」；不说清就会把 1024x1024 方图
    // 套到一张 2.6:1 的条带上，构图被模型重画。
    expect(tool.description).toContain('这是输出画布，不等于原图尺寸')
  })

  it('工具描述写清计费边界：哪些失败免费、重试前先看上一次的结果', () => {
    // 第四轮对抗评审的原话：「失败×计费矩阵只有一格」——只写了 size 越界免费，
    // model 填错 / 审核拒绝 / 超时是否扣费全空白。对「按张扣积分」的工具，
    // 这直接决定模型敢不敢重试：它默认重发是免费的，就会把一次超时花成两张图。
    const tool = createImageTool(deps())
    expect(tool.description).toContain('清单里这些是「请求根本没发到上游」，确定不扣积分')
    // 第十三轮冷读点出的边界模糊：「确定不扣积分」的清单只列了 6 类，但正文别处又写着
    // 「审核拒绝、上游报错」——模型很容易把这两类归进「免费失败」然后对用户说没扣钱。
    // 现在清单必须自带闭合句：清单之外的一切失败都算「可能已扣费」。
    // 第十八轮：闭合句换成可判定的判据——「不在清单里」要靠模型自己判断在不在清单，
    // 换成错误码：本地拒一定带 INVALID_ARGS / NOT_LOGGED_IN。
    expect(tool.description).toContain('判据：本地拒一定带 INVALID_ARGS 或 NOT_LOGGED_IN 这种错误码')
    // 第十七轮：pattern 允许 auto，但文生图写 auto 会在本地被拒（没有输入图可量）。
    // 原先这句不在「确定不扣积分」清单里，按闭合句只能讲成「可能已扣费」——虚报风险。
    expect(tool.description).toContain('size 写了 auto 但这次没给输入图（文生图）')
    // 第十三轮：扣费拆成三种说法（带 url 带 credit / 带 url 无 credit / 没图但请求已发出），
    // 每句只讲一种情形，不再有「成功才扣 vs 可能已扣」的对撞。
    expect(tool.description).toContain('计费边界分三种说法')
    expect(tool.description).toContain('返回带 url 又带 credit → 按 credit 说实扣了多少')
    expect(tool.description).toContain('没拿到图、但请求已经发到上游（超时、审核拒绝、上游报错）')
    expect(tool.description).toContain('不得断言没扣费、不得自己重发')
    expect(tool.description).toContain('这一次没拿到图、可能已扣费')
    expect(tool.description).toContain('由用户决定要不要再花一次')
    // 区域不可由参数指定，但要说清「报价要报哪个区」，否则模型报 0.03 而实际走 5.71。
    expect(tool.description).toContain('本次走哪个区调用前查不到')
    // 190 倍价差 + 不可探测（第五轮冷读：报价死循环——region 只在返回里、调用即扣费）。
    // 给两条可执行出路：多张先算总价；真要确认就先出一张 512x512 读到 region 再报。
    // 第十八轮：报价口径收敛成一条（(b) 段），这里改成引用它。
    expect(tool.description).toContain('用户问价就按 (b) 的两个数报')
    expect(tool.description).toContain('用户同意再调')
    // 24 小时链接必须配一句转存提醒：只说 URL 会过期的模型不会主动提醒用户留档。
    expect(tool.description).toContain('尽快转存')
    // 第十二轮：NOT_LOGGED_IN 出现在「还没发请求」这一侧，必须写清它免费，
    // 否则模型会把「没登录」当成「可能已扣费」去吓用户，或反过来当成可以重试的信号。
    expect(tool.description).toContain('报这个错时还没发请求，不扣积分')
  })

  it('工具描述把 region 的两个取值翻译成中文名，模型不用自己猜 cn 是哪个区', () => {
    // 第十二轮冷读：正文一律叫「国内版」「国际版」，返回值里却是 cn/global，
    // 两套命名之间没有一句映射，模型报「cn 版约 5.71」用户读不懂。
    const tool = createImageTool(deps())
    expect(tool.description).toContain('cn=国内版、global=国际版')
    // 区的判定条件必须写全：两个区各自登录、各自开开关，两区都满足时优先国内版。
    // 旧稿把「有没有打开允许模型自主生图」写成选区因素，读者会以为没开开关只是换个区。
    // 第十三轮冷读：只写「优先国内版」而不说这是固定顺序，模型会把它读成「按价格挑的」，
    // 反过来向用户保证「给你挑了便宜的」，而 5.71 其实是贵的那一档。
    expect(tool.description).toContain('两个区都满足时走国内版（贵的那一档）')
    // 第十七轮把「这是插件的固定顺序，不是按价格挑的」删了：它不改变选区结果，
    // 也不改变话术（「贵的那一档」已经写明方向），属于纯辩解。
    expect(tool.description).not.toContain('不是按价格挑的')
    expect(tool.description).toContain('本次走的是「开着且打开了那个开关」的区')
  })

  it('工具描述允许「用户只给主体」时由模型补风格，不用反问', () => {
    // 第十二轮冷读的场景 (a)：用户只说「画一只橘猫」，描述要求 prompt 写主体/风格/构图/光线，
    // 却没有说这些能不能自己补 —— 模型要么反问一句（多一轮），要么把四个要素都漏掉。
    const tool = createImageTool(deps())
    expect(tool.description).toContain('只是没给风格和光线，就由你补')
    expect(tool.description).toContain('别为这个反问他')
  })

  it('image 的 schema 给出 Windows 路径写法，不只举 Unix 的例子', () => {
    // 插件跑在 Windows 上（本仓库的 CI 与用户机器都是），而所有例子都是 /abs/a.png，
    // 模型会照着把 C:\\Users\\... 也写成 /c/Users/... 或干脆说「路径不存在」。
    const tool = createImageTool(deps())
    const image = (tool.parameters['properties'] as Record<string, Record<string, unknown>>)['image']!
    expect(image['description']).toContain('C:\\\\abs\\\\a.png')
  })

  it('model 的空串等同于留空（schema 与执行层说法一致）', () => {
    // 子代理冷读实测：模板化调用很容易传 model: ""，而 schema 只写 string 没有 minLength，
    // 字面上这是一个「填了但不存在」的 id。实现层 strictString 已经把空串当未提供，
    // 这里把两边钉在一起，避免以后改 strictString 时描述悄悄失真。
    const tool = createImageTool(deps())
    const model = (tool.parameters['properties'] as Record<string, Record<string, unknown>>)['model']!
    expect(model['type']).toBe('string')
    expect(model['description']).toContain('空字符串')
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
    // 第八轮加了 auto：改图不猜比例，交给工具量宽高。
    expect(description).toContain('auto')
  })

  it('size 的描述写出实测的大图档位与 419 万像素上限', () => {
    const tool = createImageTool(deps())
    const size = (tool.parameters['properties'] as Record<string, Record<string, unknown>>)['size']!
    const description = size['description'] as string
    // 2026-10-25 逐档实测：2048/2560 档都能出真实像素，2560x2560 起被直接拒绝。
    // 不写这两件事会各错一半——低估能力（只敢出 1024）或高估（往 4K 撞）。
    expect(description).toContain('2048x2048')
    expect(description).toContain('419')
    // 4K 不再作为「被拒的例子」出现：工具会等比缩后照常出图，所以这里只说
    // 「不要写档位词，先按表换成像素数」，不列失败尺寸。
    expect(description).toContain('「2K」「4K」「高清」「9:16」这类档位词和比例词都先按')
    // 合法范围要写进参数描述本身：schema 只有 pattern，没有 minimum/maximum，
    // 宿主把 parameters 原样投影、不代校验，只读 schema 的调用方看不到 512–2560。
    expect(description).toContain('两条边各 512–2560')
    // 比例形态（9:16 / 16:9）同样会原样被搬进 size 撞 pattern，单独点一次名。
    expect(description).toContain('9:16')
  })

  it('size 参数带上「宽x高」的 pattern，模型不用靠描述猜形状', () => {
    const tool = createImageTool(deps())
    const size = (tool.parameters['properties'] as Record<string, Record<string, unknown>>)['size']!
    expect(size['type']).toBe('string')
    // auto 是第八轮加的：改图时模型看不到原图宽高，让它猜比例必然猜错，
    // 交给工具从图片字节里量。pattern 同时放行 auto，否则 schema 与描述打架。
    expect(size['pattern']).toBe('^([0-9]+[xX×][0-9]+|auto)$')
  })

  it('size 必填：不填就 INVALID_ARGS，不再静默按方图出图', async () => {
    // 以前不填会安静地回落到 1024x1024：要竖版壁纸的人拿到一张方图，
    // 而且没有任何一处报错能指出「比例是这一步丢的」。比例是用户的诉求，
    // 不该由实现替它猜。
    const generateImage = vi.fn()
    const tool = createImageTool(deps({ generateImage }))
    const error = await tool.execute({ prompt: '猫' }, {}).catch((thrown: unknown) => thrown as Error)
    expect((error as { code?: string }).code).toBe('INVALID_ARGS')
    expect((error as Error).message).toContain('size 必填')
    expect(generateImage).not.toHaveBeenCalled()
  })

  it('size 边长越界不再报错：工具等比缩/放后照常出图，并回带原值', async () => {
    // 第八轮改向。旧稿要求模型自己算「超了怎么缩」——对抗评审实测它算不对
    // （按长边缩 2480x3508 → 1810x2560，边长合规但乘积仍超上限）。现在模型
    // 照用户的话写，越界由 fitIntoRange 收拾，代价只是必须在 hint 里说明动过什么。
    const seen: string[] = []
    const tool = createImageTool(deps({
      generateImage: async (_credential, request) => {
        seen.push(request.size)
        return { url: 'https://cos.example/a.png', credit: 5.71 }
      },
    }))
    // 太小的放大、太大的缩小，两种情况都要能出图。
    const up = await tool.execute({ prompt: '猫', size: '300x300' }, {})
    expect(up['size']).toBe('512x512')
    expect(up['requestedSize']).toBe('300x300')
    expect(String(up['hint'])).toContain('已等比放大')
    const down = await tool.execute({ prompt: '猫', size: '1024x3000' }, {})
    expect(down['size']).toBe('873x2560')
    expect(String(down['hint'])).toContain('已等比缩小')
    // 缩放后的值一定合法，才敢发给上游。
    for (const size of seen) {
      const [w = 0, h = 0] = size.split('x').map(Number)
      expect(w).toBeGreaterThanOrEqual(512)
      expect(h).toBeGreaterThanOrEqual(512)
      expect(w).toBeLessThanOrEqual(2560)
      expect(h).toBeLessThanOrEqual(2560)
      expect(w * h).toBeLessThanOrEqual(4194304)
    }
  })

  it('结果里写明这次走的是国内版还是国际版', async () => {
    // 「刚才那张是哪个区的账号画的、贵的那边还是便宜的那边」是用户的第一反应。
    // 区由凭据的 domain 现算：工具是跨区注册的，一份定义要服务两个区。
    const cn = createImageTool(deps())
    const cnValue = await cn.execute({ prompt: '猫', size: SIZE }, {})
    expect(String(cnValue['hint'])).toContain('国内版')
    expect(String(cnValue['hint'])).toContain('1024x1024')

    const global = createImageTool(deps({
      resolveCredential: async () => credential({ domain: 'www.workbuddy.ai' }),
    }))
    const globalValue = await global.execute({ prompt: '猫', size: SIZE }, {})
    expect(String(globalValue['hint'])).toContain('国际版')
    expect(globalValue['region']).toBe('global')
    expect(cnValue['region']).toBe('cn')
  })

  it('形状满足宿主 Tools.register 的硬性要求', () => {
    const tool = createImageTool(deps())
    expect(tool.name).toBe(WORKBUDDY_IMAGE_TOOL_NAME)
    expect(tool.description).toContain('积分')
    expect(typeof tool.output.render).toBe('function')
    expect(tool.output.schema['type']).toBe('object')
    expect(tool.parameters['type']).toBe('object')
    expect(tool.parameters['required']).toEqual(['prompt', 'size'])
    expect(Number.isFinite(tool.timeoutMs)).toBe(true)
    expect(tool.timeoutMs).toBeGreaterThan(0)
  })

  it('execute 返回的键严格落在 output.schema 里（宿主会校验）', async () => {
    const tool = createImageTool(deps())
    const value = await tool.execute({ prompt: '一只猫', size: SIZE }, {})
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
    // 区域与尺寸必须是可以程序化读的字段：子代理冷读时明确说过，把「国内版还是
    // 国际版」「出的多大」只写在 hint 散文里，想记账的调用方只能去正则抠文本。
    expect(value['region']).toBe('cn')
    expect(value['size']).toBe('1024x1024')
    // region 是「走哪个区」的唯一准信，size 是「到底出了多大」的唯一准信，两个都由
    // 工具自己算、一定在。第九轮冷读指出：描述要求模型「以返回的 region 为准」报价，
    // 而 region 当时只是可选字段——报价流程建在一个可能不存在的字段上。
    expect(schema.required).toContain('region')
    expect(schema.required).toContain('size')
  })

  it('prompt 缺失或为空白 → INVALID_ARGS，且不进冷却', async () => {
    const tool = createImageTool(deps())
    await expect(tool.execute({}, {})).rejects.toMatchObject({ code: 'INVALID_ARGS' })
    await expect(tool.execute({ prompt: '   ' }, {})).rejects.toMatchObject({ code: 'INVALID_ARGS' })
    // 未登录/参数错误不该冷却：紧接着一次正常调用应当成功
    const value = await tool.execute({ prompt: '猫', size: SIZE }, {})
    expect(value['url']).toBe('https://cos.example/a.png')
  })

  it('未登录 → NOT_LOGGED_IN，且不把两个区的事说成国内区的事', async () => {
    const tool = createImageTool(deps({ resolveCredential: async () => undefined }))
    const error = await tool.execute({ prompt: '猫', size: SIZE }, {}).catch((thrown: unknown) => thrown as Error)
    expect((error as { code?: string }).code).toBe('NOT_LOGGED_IN')
    expect((error as Error).message).not.toContain('国内区未登录')
    // 两种可能都要说到：没登录，或者登录了但没给那个区开「自主生图」。
    expect((error as Error).message).toContain('两个区都没登录')
  })

  describe('无水印模型（issue #241）', () => {
    /** 记录每次真正发给上游的模型 id 与尺寸。 */
    function spyDeps(overrides: Partial<ImageToolDeps> = {}): {
      readonly deps: ImageToolDeps
      readonly calls: { model: string, size: string }[]
    } {
      const calls: { model: string, size: string }[] = []
      return {
        calls,
        deps: deps({
          generateImage: async (_credential, request) => {
            calls.push({ model: request.model, size: request.size })
            return { url: 'https://cos.example/a.png', credit: 11.31 }
          },
          ...overrides,
        }),
      }
    }

    it('没选偏好时仍然用目录第一个，不替用户换贵一倍的模型', async () => {
      // 这是整个 issue 的核心承诺：升级不能让人默默多花钱。
      const { deps: fake, calls } = spyDeps()
      const tool = createImageTool(fake)
      await tool.execute({ prompt: '猫', size: SIZE }, {})
      expect(calls).toHaveLength(1)
      expect(calls[0]?.model).toBe('hunyuan-image-alpha')
    })

    it('选了 v3.0 就走 v3.0', async () => {
      const { deps: fake, calls } = spyDeps({ preferredImageModel: () => IMAGE_MODEL_NO_WATERMARK })
      const tool = createImageTool(fake)
      await tool.execute({ prompt: '猫', size: SIZE }, {})
      expect(calls[0]?.model).toBe(IMAGE_MODEL_NO_WATERMARK)
    })

    it('显式 model 压过偏好——偏好是上一次点的，参数是这一次写的', async () => {
      const { deps: fake, calls } = spyDeps({ preferredImageModel: () => IMAGE_MODEL_NO_WATERMARK })
      const tool = createImageTool(fake)
      await tool.execute({ prompt: '猫', size: SIZE, model: 'hunyuan-image-alpha' }, {})
      expect(calls[0]?.model).toBe('hunyuan-image-alpha')
    })

    it('偏好指向一个已经不存在的模型时回落到组内第一个，而不是让生成失败', async () => {
      const { deps: fake, calls } = spyDeps({ preferredImageModel: () => 'hunyuan-image-gone' })
      const tool = createImageTool(fake)
      await tool.execute({ prompt: '猫', size: SIZE }, {})
      expect(calls[0]?.model).toBe('hunyuan-image-alpha')
    })

    it('偏好不会被用到改图上：改图的模型仍由 image-to-image 目录决定', async () => {
      // 偏好只对 text-to-image 生效（index.ts 的注入按 tag 判）。把它漏到改图上，
      // 就会挑一个在 /v2/images/edits 上静默忽略输入图的模型——付钱、丢参考图。
      const editCalls: string[] = []
      const tool = createImageTool(deps({
        listMediaModels: async () => cnModels,
        editImage: async (_credential, request) => {
          editCalls.push(request.model)
          return { url: 'https://cos.example/e.png', credit: 6.11 }
        },
        preferredImageModel: (_credential, tag) =>
          tag === IMAGE_TAG_TEXT_TO_IMAGE ? IMAGE_MODEL_NO_WATERMARK : undefined,
      }))
      const INPUT = imageDataUrl('image/png', Buffer.from('hello').toString('base64'))
      await tool.execute({ prompt: '改成绿的', size: SIZE, image: [INPUT] }, {})
      expect(editCalls).toEqual(['hunyuan-image-alpha-edit'])
    })

    it('v3.0 的尺寸按它自己的窄范围收，不按 alpha 的 419 万像素放行', async () => {
      // 实测 1024x1536 在 v3.0 上是 14402。按 alpha 的范围算会原样发出去，
      // 于是用户看到的是一次「上游拒绝」而不是「已等比缩到 836x1254」。
      // 836x1254 = 1,048,344，正好顶住 104 万像素上限，且保持 2:3 比例——
      // 收窄时保比例比改比例好：用户要的是竖版构图，不是「一个竖版尺寸」。
      const { deps: fake, calls } = spyDeps({ preferredImageModel: () => IMAGE_MODEL_NO_WATERMARK })
      const tool = createImageTool(fake)
      const value = await tool.execute({ prompt: '猫', size: '1024x1536' }, {})
      expect(calls[0]?.size).toBe('836x1254')
      expect(value['size']).toBe('836x1254')
      expect(value['requestedSize']).toBe('1024x1536')
      // describeLimits 按「万」四舍五入：1,048,576 / 10,000 = 104.86 → 105。
      expect(String(value['hint'])).toContain('约 105 万像素上限')
      expect(String(value['hint'])).toContain('缩小')
    })

    it('同一个 1024x1536 在 alpha 上原样发出——换模型不该改变旧行为', async () => {
      const { deps: fake, calls } = spyDeps()
      const tool = createImageTool(fake)
      const value = await tool.execute({ prompt: '猫', size: '1024x1536' }, {})
      expect(calls[0]?.size).toBe('1024x1536')
      expect(value['requestedSize']).toBeUndefined()
    })

    it('hint 每次都讲清水印：v3.0 无水印，默认那条有且关不掉', async () => {
      const { deps: watermarked } = spyDeps()
      const alpha = await createImageTool(watermarked).execute({ prompt: '猫', size: SIZE }, {})
      expect(String(alpha['hint'])).toContain('水印')
      expect(String(alpha['hint'])).toContain('上游没有关闭它的参数')
      expect(String(alpha['hint'])).toContain(IMAGE_MODEL_NO_WATERMARK)

      const { deps: clean } = spyDeps({ preferredImageModel: () => IMAGE_MODEL_NO_WATERMARK })
      const v3 = await createImageTool(clean).execute({ prompt: '猫', size: SIZE }, {})
      expect(String(v3['hint'])).toContain('不带 WorkBuddy 水印')
    })

    it('国际区拿不到 v3.0 这个选项：选了也不生效（那边没有它的路由）', async () => {
      // 实测国际区 `hunyuan-image-v3.0` → 400 / 14401 route config not found。
      // 列进国际区的选项就是一个点了必然失败的按钮，所以这条偏好国际区直接不算数。
      const { deps: fake, calls } = spyDeps({
        resolveCredential: async () => credential({ domain: 'https://www.workbuddy.ai' }),
        listMediaModels: async () => globalModels,
        preferredImageModel: () => IMAGE_MODEL_NO_WATERMARK,
      })
      const tool = createImageTool(fake)
      await tool.execute({ prompt: '猫', size: SIZE }, {})
      expect(calls[0]?.model).toBe('hy-image-3.5')
    })

    it('国内区显式要 v3.0 可以，国际区显式要它则报错并列出可用项', async () => {
      const { deps: fake, calls } = spyDeps({ listMediaModels: async () => cnModels })
      await createImageTool(fake).execute(
        { prompt: '猫', size: SIZE, model: IMAGE_MODEL_NO_WATERMARK },
        {},
      )
      expect(calls[0]?.model).toBe(IMAGE_MODEL_NO_WATERMARK)

      const { deps: global } = spyDeps({
        resolveCredential: async () => credential({ domain: 'https://www.workbuddy.ai' }),
        listMediaModels: async () => globalModels,
      })
      await expect(createImageTool(global).execute(
        { prompt: '猫', size: SIZE, model: IMAGE_MODEL_NO_WATERMARK },
        {},
      )).rejects.toThrow(/没有.*模型/)
    })
  })

  it('目录里没有生图模型 → NO_IMAGE_MODEL', async () => {
    const tool = createImageTool(deps({ listMediaModels: async () => [] }))
    await expect(tool.execute({ prompt: '猫', size: SIZE }, {})).rejects.toMatchObject({ code: 'NO_IMAGE_MODEL' })
  })

  it('点名不存在的模型 → NO_IMAGE_MODEL，且不会发请求', async () => {
    const generateImage = vi.fn()
    const tool = createImageTool(deps({ generateImage }))
    await expect(tool.execute({ prompt: '猫', size: SIZE, model: 'nope' }, {}))
      .rejects.toMatchObject({ code: 'NO_IMAGE_MODEL' })
    expect(generateImage).not.toHaveBeenCalled()
  })

  it('size 类型不对 → INVALID_ARGS，而不是静默用默认尺寸', async () => {
    // 与 image 数组被丢掉是同一族 bug：类型不对的可选参数曾被静默丢弃、
    // 回落到默认值。size: 1024 会安静地按 1024x1024 出图，调用方无从得知。
    const generateImage = vi.fn()
    const tool = createImageTool(deps({ generateImage }))
    await expect(tool.execute({ prompt: '猫', size: 1024 }, {}))
      .rejects.toMatchObject({ code: 'INVALID_ARGS' })
    expect(generateImage).not.toHaveBeenCalled()
  })

  it('size 写档位（2K / 1024*1024）→ INVALID_ARGS，且不发请求', async () => {
    // schema 里的 pattern 只是写给模型看的，宿主把 parameters 原样投影、不代校验，
    // 真正拦住 "2K" 的是 execute。不拦的话会白白打一次扣积分的请求再拿回
    // 一个语焉不详的上游参数错误。
    const generateImage = vi.fn()
    const tool = createImageTool(deps({ generateImage }))
    for (const size of ['2K', '4K', '1024*1024', '1024', '大图']) {
      await expect(tool.execute({ prompt: '猫', size }, {}))
        .rejects.toMatchObject({ code: 'INVALID_ARGS' })
    }
    expect(generateImage).not.toHaveBeenCalled()
  })

  it('size 超过 419 万像素 → 收到 2048x2048 这类顶格档，而不是原样打给上游', async () => {
    // 4K 是用户最常说的「大图」，工具出不了 3840x2160（边长超 2560、像素超 419 万），
    // 但也不该直接拒绝——等比缩到 2048x2048 并让模型在回复里说清「实际出的是这一档」。
    const seen: string[] = []
    const tool = createImageTool(deps({
      generateImage: async (_credential, request) => {
        seen.push(request.size)
        return { url: 'https://cos.example/a.png', credit: 5.71 }
      },
    }))
    for (const size of ['4096x4096', '2560x2560', '3072x3072']) {
      const value = await tool.execute({ prompt: '猫', size }, {})
      expect(value['size']).toBe('2048x2048')
      expect(value['requestedSize']).toBe(size)
    }
    expect(seen).toEqual(['2048x2048', '2048x2048', '2048x2048'])
  })

  it('比例比 5:1 还极端、等比缩放解不出合法值时才在本地报错', async () => {
    // 这类尺寸（比如 8000x200）缩到长边 2560 时短边只剩 64，抬到 512 时长边又
    // 超过 2560——两个约束互相顶死。这是唯一剩下的「尺寸类本地失败」，免费。
    const generateImage = vi.fn()
    const tool = createImageTool(deps({ generateImage }))
    await expect(tool.execute({ prompt: '猫', size: '8000x200' }, {}))
      .rejects.toThrow(/比例太极端/)
    expect(generateImage).not.toHaveBeenCalled()
  })

  it('用户写的就是合法尺寸时不回带 requestedSize', async () => {
    // 只有真的动过才回带：否则调用方会以为「请求值和实际值不一致」是常态。
    const tool = createImageTool(deps())
    const value = await tool.execute({ prompt: '猫', size: '1024x1536' }, {})
    expect(value['size']).toBe('1024x1536')
    expect(value).not.toHaveProperty('requestedSize')
  })

  it('size 的大小写与全角乘号都规整成小写 x', async () => {
    const seen: string[] = []
    const tool = createImageTool(deps({
      generateImage: async (_credential, request) => {
        seen.push(request.size)
        return { url: 'https://cos.example/a.png', credit: 5.71 }
      },
    }))
    const upper = await tool.execute({ prompt: '猫', size: '1024X1536' }, {})
    const fullWidth = await tool.execute({ prompt: '猫', size: '1024×1536' }, {})
    expect(seen).toEqual(['1024x1536', '1024x1536'])
    // 回带的 size 也要是规整后的形态，不然调用方按返回值记账时格式各异。
    expect(upper['size']).toBe('1024x1536')
    expect(fullWidth['size']).toBe('1024x1536')
  })

  it('塞了本工具没有的参数 → INVALID_ARGS，而不是静默忽略', async () => {
    // 会话里同时挂着 agnes_draw_image（有 ratio / n / return_base64）时，
    // 模型会把那套参数原样搬过来。静默忽略的后果是它以为比例生效了，
    // 实际出的还是默认方图——比报错更贵。
    const generateImage = vi.fn()
    const tool = createImageTool(deps({ generateImage }))
    await expect(tool.execute({ prompt: '猫', size: SIZE, ratio: '16:9' }, {}))
      .rejects.toThrow(/ratio/)
    await expect(tool.execute({ prompt: '猫', size: SIZE, n: 4 }, {}))
      .rejects.toThrow(/「n」/)
    await expect(tool.execute({ prompt: '猫', size: SIZE, return_base64: true }, {}))
      .rejects.toThrow(/return_base64/)
    expect(generateImage).not.toHaveBeenCalled()
  })

  it('model 类型不对 → INVALID_ARGS，而不是静默换模型扣积分', async () => {
    // 默认模型和被点名的模型可能单价不同：静默回落等于按错的模型扣积分。
    const generateImage = vi.fn()
    const tool = createImageTool(deps({ generateImage }))
    await expect(tool.execute({ prompt: '猫', size: SIZE, model: ['hunyuan-image-alpha'] }, {}))
      .rejects.toMatchObject({ code: 'INVALID_ARGS' })
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
      const value = await tool.execute({ prompt: '换成夜景', size: SIZE, image: [INPUT] }, {})
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
      const value = await tool.execute({ prompt: '猫', size: SIZE }, {})
      expect(value['mode']).toBe('generate')
      expect(editImage).not.toHaveBeenCalled()
    })

    /**
     * 造一张只有文件头的「图片」——宽高解析只看头，不需要真能解码。
     * 这样测试不必携带二进制夹具，也能覆盖 PNG / JPEG / GIF / WEBP 四种头。
     */
    const pngOf = (width: number, height: number): string => {
      const header = Buffer.alloc(26)
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0)
      header.writeUInt32BE(13, 8)
      header.write('IHDR', 12)
      header.writeUInt32BE(width, 16)
      header.writeUInt32BE(height, 20)
      return imageDataUrl('image/png', header.toString('base64'))
    }
    const jpegOf = (width: number, height: number): string => {
      const bytes = Buffer.from([
        0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08,
        (height >> 8) & 0xff, height & 0xff,
        (width >> 8) & 0xff, width & 0xff,
        0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
      ])
      return imageDataUrl('image/jpeg', bytes.toString('base64'))
    }
    const gifOf = (width: number, height: number): string => {
      const bytes = Buffer.alloc(13)
      bytes.write('GIF89a', 0, 'ascii')
      bytes.writeUInt16LE(width, 6)
      bytes.writeUInt16LE(height, 8)
      return imageDataUrl('image/gif', bytes.toString('base64'))
    }
    const webpOf = (width: number, height: number): string => {
      const bytes = Buffer.alloc(30)
      bytes.write('RIFF', 0, 'ascii')
      bytes.write('WEBP', 8, 'ascii')
      bytes.write('VP8X', 12, 'ascii')
      const w = width - 1
      const h = height - 1
      bytes[24] = w & 0xff
      bytes[25] = (w >> 8) & 0xff
      bytes[26] = (w >> 16) & 0xff
      bytes[27] = h & 0xff
      bytes[28] = (h >> 8) & 0xff
      bytes[29] = (h >> 16) & 0xff
      return imageDataUrl('image/webp', bytes.toString('base64'))
    }
    const editDeps = (listener: (request: { readonly size: string }) => void) => deps({
      listMediaModels: async () => [
        { id: 'hunyuan-image-alpha', name: 'A', tags: [IMAGE_TAG_TEXT_TO_IMAGE] },
        { id: 'hunyuan-image-alpha-edit', name: 'B', tags: [IMAGE_TAG_IMAGE_TO_IMAGE] },
      ],
      editImage: async (_credential, request) => {
        listener(request)
        return { url: 'https://cos.example/edited.png', credit: 5.71 }
      },
    })

    it('size 写 auto：从 PNG 头量出宽高，按同比例定画布', async () => {
      // 这是第八轮的核心改动。旧稿要求模型「按原图比例挑最近的一档」——它读不到
      // 本地文件、工具也不回传输入尺寸，等于让它在看不见的东西上做判断。
      // 现在模型只写 auto，宽高由工具从字节里解。
      const sizes: string[] = []
      const tool = createImageTool(editDeps(request => sizes.push(request.size)))
      const value = await tool.execute({ prompt: '换成夜景', size: 'auto', image: [pngOf(1600, 900)] }, {})
      expect(sizes).toEqual(['1536x864'])
      expect(value['size']).toBe('1536x864')
      expect(value['requestedSize']).toBe('auto')
      // 两句实话都要在 hint 里：输入图多大、画布怎么来的。
      expect(String(value['hint'])).toContain('输入图第一张是 1600x900（横图）')
      expect(String(value['hint'])).toContain('已按输入图 1600x900 的比例取画布 1536x864')
    })

    it('auto 认竖图：900x1600 得到 864x1536，而不是照方图出', async () => {
      const sizes: string[] = []
      const tool = createImageTool(editDeps(request => sizes.push(request.size)))
      const value = await tool.execute({ prompt: '改', size: 'auto', image: [pngOf(900, 1600)] }, {})
      expect(sizes).toEqual(['864x1536'])
      expect(String(value['hint'])).toContain('竖图')
    })

    it('auto 认方图：1000x1000 仍走 1024x1024（1536x1536 白多像素、无信息增益）', async () => {
      const sizes: string[] = []
      const tool = createImageTool(editDeps(request => sizes.push(request.size)))
      await tool.execute({ prompt: '改', size: 'auto', image: [pngOf(1000, 1000)] }, {})
      expect(sizes).toEqual(['1024x1024'])
    })

    it('auto 能读 JPEG / GIF / WEBP 的头，不只 PNG', async () => {
      // 用户给的参考图很少正好是 PNG。只支持 PNG 等于「一半的 auto 调用直接报错」。
      const sizes: string[] = []
      const tool = createImageTool(editDeps(request => sizes.push(request.size)))
      await tool.execute({ prompt: '改', size: 'auto', image: [jpegOf(800, 600)] }, {})
      await tool.execute({ prompt: '改', size: 'auto', image: [gifOf(320, 240)] }, {})
      await tool.execute({ prompt: '改', size: 'auto', image: [webpOf(640, 480)] }, {})
      expect(sizes).toEqual(['1536x1152', '1536x1152', '1536x1152'])
    })

    it('auto 遇到比对 5:1 更细长的图：退回方向常用档，并在 hint 里说比例变了', async () => {
      // 5000x100 等比缩到长边 1536 时短边只剩 31，抬到 512 时长边又超过 2560，
      // 两个约束互相顶死。宁可换比例出图 + 说实话，也不要报错让用户无从下手。
      const sizes: string[] = []
      const tool = createImageTool(editDeps(request => sizes.push(request.size)))
      const value = await tool.execute({ prompt: '改', size: 'auto', image: [pngOf(5000, 100)] }, {})
      expect(sizes).toEqual(['1536x1024'])
      expect(String(value['hint'])).toContain('太细长')
      expect(String(value['hint'])).toContain('比例有变化')
    })

    it('auto 但没有输入图 / 认不出格式 → INVALID_ARGS，且不发请求', async () => {
      // auto 的语义是「照着输入图算」，没有输入图时它无解。静默回落方图会
      // 让用户以为「原版式保住了」，而实际比例被换掉还照扣积分。
      const editImage = vi.fn()
      const tool = createImageTool(deps({ editImage }))
      await expect(tool.execute({ prompt: '猫', size: 'auto' }, {}))
        .rejects.toThrow(/量不出输入图的宽高/)
      // 'hello' 是合法 base64 但不是图片：体积闸门放行，量宽高失败。
      await expect(tool.execute({ prompt: '改', size: 'auto', image: [INPUT] }, {}))
        .rejects.toThrow(/量不出输入图的宽高/)
      expect(editImage).not.toHaveBeenCalled()
    })

    it('image 传空数组 → INVALID_ARGS，而不是静默当文生图', async () => {
      // schema 写着 minItems: 1，但宿主把 parameters 原样投影、不代校验；
      // 早先 asImageList 把 [] 直接返回 undefined，于是「想改图但图丢了」
      // 会静默变成文生图，出图跟 prompt 完全无关还照扣积分。
      const editImage = vi.fn()
      const generateImage = vi.fn(async () => ({ url: 'https://cos.example/a.png', credit: 5.71 }))
      const tool = createImageTool(deps({ editImage, generateImage }))
      await expect(tool.execute({ prompt: '改', size: SIZE, image: [] }, {}))
        .rejects.toMatchObject({ code: 'INVALID_ARGS' })
      expect(generateImage).not.toHaveBeenCalled()
      expect(editImage).not.toHaveBeenCalled()
    })

    it('读不到输入图 → INVALID_ARGS，且不进冷却（一分钱没花）', async () => {
      const editImage = vi.fn()
      const tool = createImageTool(deps({ editImage }))
      const missing = fileURLToPath(new URL('./no-such-input-image.png', import.meta.url))
      await expect(tool.execute({ prompt: '改', size: SIZE, image: [missing] }, {}))
        .rejects.toMatchObject({ code: 'INVALID_ARGS' })
      expect(editImage).not.toHaveBeenCalled()
      // 紧接着一次没有输入图的调用必须照常成功：读文件失败是免费的。
      const value = await tool.execute({ prompt: '猫', size: SIZE }, {})
      expect(value['url']).toBe('https://cos.example/a.png')
    })

    it('格式不对的 data URL 也被拒，而不是原样发上去', async () => {
      const editImage = vi.fn()
      const tool = createImageTool(deps({ editImage }))
      await expect(tool.execute({ prompt: '改', size: SIZE, image: ['data:text/plain;base64,AAAA'] }, {}))
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
      await expect(tool.execute({ prompt: '改', size: SIZE, image: [INPUT], model: 'hunyuan-image-alpha' }, {}))
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
      await expect(tool.execute({ prompt: '改', size: SIZE, image: [oversized] }, {}))
        .rejects.toMatchObject({ code: 'INVALID_ARGS' })
      expect(editImage).not.toHaveBeenCalled()
      // Second call must run (not COOLDOWN): nothing was ever sent, so there is
      // nothing to cool down for.
      const value = await tool.execute({ prompt: '猫', size: SIZE }, {})
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
      await expect(tool.execute({ prompt: '改', size: SIZE, image: [sixMb] }, {}))
        .resolves.toMatchObject({ mode: 'edit' })
      expect(editImage).toHaveBeenCalledTimes(1)
    })

    it('解出来是空内容的 data URL → INVALID_ARGS，且不发请求', async () => {
      // `====` matches the data-URL shape but decodes to zero bytes: the empty
      // file check has to run on the DATA branch too, not only on readFile.
      const editImage = vi.fn()
      const tool = createImageTool(deps({ editImage }))
      await expect(tool.execute({ prompt: '改', size: SIZE, image: ['data:image/png;base64,===='] }, {}))
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
        { prompt: '按模板换装', size: SIZE, image: [template, outfit] },
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
        { prompt: '改', size: SIZE, image: ['data:image/png;base64,AAAA', 42] },
        {},
      )).rejects.toMatchObject({ code: 'INVALID_ARGS' })
      expect(editImage).not.toHaveBeenCalled()
    })

    it('image 写成单个字符串 → INVALID_ARGS，并提示改成数组', async () => {
      // schema 已收敛成 type: 'array'。仍要在这里拦：宿主不代校验 parameters，
      // 直接把 string 当「没给图」会静默退回文生图并烧积分。
      const generateImage = vi.fn()
      const editImage = vi.fn()
      const tool = createImageTool(deps({ generateImage, editImage }))
      await expect(tool.execute({ prompt: '改', size: SIZE, image: 'data:image/png;base64,AAAA' }, {}))
        .rejects.toThrow(/数组/)
      expect(generateImage).not.toHaveBeenCalled()
      expect(editImage).not.toHaveBeenCalled()
    })

    it('image 是数字 / 对象 → INVALID_ARGS，而不是悄悄退回文生图', async () => {
      // This pins the regression the multi-image fix addresses: a non-string,
      // non-array image used to be read as undefined and silently flip the tool
      // into generate mode, generating an unrelated image and burning credits.
      const generateImage = vi.fn()
      const tool = createImageTool(deps({ generateImage }))
      await expect(tool.execute({ prompt: '改', size: SIZE, image: 123 }, {}))
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
    await expect(tool.execute({ prompt: '猫', size: SIZE }, {})).rejects.toMatchObject({ code: 'UPSTREAM' })
    await expect(tool.execute({ prompt: '猫', size: SIZE }, {})).rejects.toMatchObject({ code: 'COOLDOWN' })
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
    await expect(tool.execute({ prompt: '猫', size: SIZE }, {})).rejects.toThrow(/socket hang up/)
    // Immediately retry: a free failure must not be cooling anything.
    fail = false
    const value = await tool.execute({ prompt: '猫', size: SIZE }, {})
    expect(value['url']).toBe('https://cos.example/a.png')
  })

  it('目录读取失败不缓存，下一次仍然真的去读', async () => {
    const listMediaModels = vi.fn(async () => {
      throw new Error('boom')
    })
    const tool = createImageTool(deps({ listMediaModels }))
    await expect(tool.execute({ prompt: '猫', size: SIZE }, {})).rejects.toThrow(/boom/)
    await expect(tool.execute({ prompt: '猫', size: SIZE }, {})).rejects.toThrow(/boom/)
    // A failed read is not cached, so both attempts really reached the reader.
    expect(listMediaModels).toHaveBeenCalledTimes(2)
  })

  it('媒体目录在 TTL 内只读一次', async () => {
    const listMediaModels = vi.fn(async () => [mediaModel()])
    const tool = createImageTool(deps({ listMediaModels }))
    await tool.execute({ prompt: '一', size: SIZE }, {})
    await tool.execute({ prompt: '二', size: SIZE }, {})
    expect(listMediaModels).toHaveBeenCalledTimes(1)
  })

  it('上游只给 b64 时落盘并返回 file:// 地址', async () => {
    const tool = createImageTool(deps({
      generateImage: async () => ({ b64: Buffer.from('hello').toString('base64') }),
    }))
    const value = await tool.execute({ prompt: '猫', size: SIZE }, {})
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

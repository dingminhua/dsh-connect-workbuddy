/**
 * WorkBuddy 视频生成：纯逻辑层。
 *
 * 守三件事，与 image-gen.spec.ts 同一套思路：
 *  1. **模型筛选**只认产品配置里真实的 `tags`（含 text-to-video / image-to-video）。
 *  2. **请求体分支**照抄官方 CLI 的 `submitTask`：文生视频带 `aspect_ratio`、
 *     图生视频带 `image_url`、两者都带 `watermark:true` 与 `extra_parameters`。
 *  3. **解析段**——提交取 `data.id`、轮询取 `status` / 视频 URL / 实扣积分——
 *     以及失败分类（401/403 → AUTH、404 → NO_ROUTE、429 → RATE_LIMIT、其它 → UPSTREAM）。
 */
import { describe, expect, it } from 'vitest'
import type { WorkBuddyCredential } from '../src/auth.ts'
import { readVideoGeneration as readImageVideoGeneration } from '../src/image-gen.ts'
import {
  DEFAULT_VIDEO_ASPECT_RATIO,
  DEFAULT_VIDEO_SECONDS,
  VIDEO_ASPECT_RATIOS,
  VIDEO_TAG_IMAGE_TO_VIDEO,
  VIDEO_TAG_TEXT_TO_VIDEO,
  WorkBuddyVideoError,
  buildVideoBody,
  describeVideoFailure,
  parseSupportedSecondsRange,
  parseVideoSubmission,
  parseVideoTask,
  pickVideoModel,
  readVideoGeneration,
  resolveVideoParams,
  selectMediaModels,
  type WorkBuddyMediaModel,
} from '../src/video-gen.ts'

/** 国际区 `/v3/config` 的真实形状：`kling-video-v3` 同时带两个 video tag。 */
const globalModels = [
  { id: 'hy3', name: 'Hy3', tags: ['craft'] },
  { id: 'kling-video-v3', name: 'Kling Video v3', tags: ['text-to-video', 'image-to-video'] },
]

/**
 * 国内区（2026-10-25 实测，61 条里媒体条目只有这两条）：`kling-video-v3` 与
 * `minimax-video-h3` 各带 `text-to-video` + `image-to-video`。
 */
const cnModels = [
  { id: 'kling-video-v3', name: 'Kling Video v3', tags: ['text-to-video', 'image-to-video'] },
  { id: 'minimax-video-h3', name: 'Minimax Video h3', tags: ['text-to-video', 'image-to-video'] },
]

function mediaModel(id = 'kling-video-v3'): WorkBuddyMediaModel {
  return { id, name: id, tags: ['text-to-video', 'image-to-video'] }
}

describe('selectMediaModels（视频 tag）', () => {
  it('文生视频只挑带 text-to-video 的条目', () => {
    expect(selectMediaModels(cnModels, VIDEO_TAG_TEXT_TO_VIDEO).map(model => model.id))
      .toEqual(['kling-video-v3', 'minimax-video-h3'])
    expect(selectMediaModels(globalModels, VIDEO_TAG_TEXT_TO_VIDEO).map(model => model.id))
      .toEqual(['kling-video-v3'])
  })

  it('图生视频只挑带 image-to-video 的条目', () => {
    expect(selectMediaModels(cnModels, VIDEO_TAG_IMAGE_TO_VIDEO).map(model => model.id))
      .toEqual(['kling-video-v3', 'minimax-video-h3'])
    expect(selectMediaModels(globalModels, VIDEO_TAG_IMAGE_TO_VIDEO).map(model => model.id))
      .toEqual(['kling-video-v3'])
  })

  it('国际区 kling-video-v3 两个 video tag 都能选到（同一模型命中两次）', () => {
    expect(selectMediaModels(globalModels, VIDEO_TAG_TEXT_TO_VIDEO).map(model => model.id))
      .toEqual(['kling-video-v3'])
    expect(selectMediaModels(globalModels, VIDEO_TAG_IMAGE_TO_VIDEO).map(model => model.id))
      .toEqual(['kling-video-v3'])
  })

  it('非数组 / 缺 id 的条目不会让它崩', () => {
    expect(selectMediaModels(undefined, VIDEO_TAG_TEXT_TO_VIDEO)).toEqual([])
    expect(selectMediaModels([null, 42, 'x', { tags: ['text-to-video'] }], VIDEO_TAG_TEXT_TO_VIDEO)).toEqual([])
  })
})

describe('pickVideoModel', () => {
  it('点名一个存在的模型就用它', () => {
    const models = [mediaModel('a'), mediaModel('b')]
    expect(pickVideoModel(models, 'b', VIDEO_TAG_TEXT_TO_VIDEO).id).toBe('b')
  })

  it('不点名就用目录里的第一个', () => {
    expect(pickVideoModel([mediaModel('first'), mediaModel('second')], undefined, VIDEO_TAG_TEXT_TO_VIDEO).id).toBe('first')
  })

  it('国际区同一条目两个 tag 都能作默认', () => {
    const models = selectMediaModels(globalModels, VIDEO_TAG_TEXT_TO_VIDEO)
    expect(pickVideoModel(models, undefined, VIDEO_TAG_TEXT_TO_VIDEO).id).toBe('kling-video-v3')
    expect(pickVideoModel(models, undefined, VIDEO_TAG_IMAGE_TO_VIDEO).id).toBe('kling-video-v3')
  })

  it('点名一个不存在的模型直接报错，并列出可用的', () => {
    try {
      pickVideoModel([mediaModel('a'), mediaModel('b')], 'nope', VIDEO_TAG_TEXT_TO_VIDEO)
      expect.unreachable('应当抛错')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(WorkBuddyVideoError)
      expect((error as WorkBuddyVideoError).code).toBe('NO_VIDEO_MODEL')
      expect((error as Error).message).toContain('nope')
      expect((error as Error).message).toContain('a, b')
    }
  })

  it('目录为空时报「该区没有视频模型」', () => {
    try {
      pickVideoModel([], undefined, VIDEO_TAG_TEXT_TO_VIDEO)
      expect.unreachable('应当抛错')
    } catch (error: unknown) {
      expect((error as WorkBuddyVideoError).code).toBe('NO_VIDEO_MODEL')
    }
  })

  it('拿文生视频模型去图生视频也会被拒（写错组）', () => {
    // kling-video-v3 两个 tag 都有，所以必须用只带一个 tag 的夹具才能复现：
    const models = [{ id: 'kling-video-v3', name: 'Kling', tags: [VIDEO_TAG_TEXT_TO_VIDEO] }]
    try {
      pickVideoModel(models, 'kling-video-v3', VIDEO_TAG_IMAGE_TO_VIDEO)
      expect.unreachable('应当抛错')
    } catch (error: unknown) {
      expect((error as WorkBuddyVideoError).code).toBe('NO_VIDEO_MODEL')
      expect((error as Error).message).toContain('图生视频')
    }
  })
})

describe('buildVideoBody', () => {
  it('文生视频带 aspect_ratio 与 watermark，negative_prompt 缺省空串', () => {
    const body = buildVideoBody({
      model: 'kling-video-v3',
      prompt: '一只猫在跑步',
    }, false)
    expect(body['prompt']).toBe('一只猫在跑步')
    expect(body['model']).toBe('kling-video-v3')
    expect(body['watermark']).toBe(true)
    expect(body['negative_prompt']).toBe('')
    expect(body['extra_parameters']).toEqual({
      resolution: undefined,
      enable_audio: true,
      aspect_ratio: DEFAULT_VIDEO_ASPECT_RATIO,
    })
    // 文生视频不带 image_url / last_image_url
    expect(body).not.toHaveProperty('image_url')
    expect(body).not.toHaveProperty('last_image_url')
  })

  it('图生视频带 image_url 且不上 aspect_ratio（比例由输入图决定）', () => {
    const body = buildVideoBody({
      model: 'kling-video-v3',
      prompt: '让这张图动起来',
      image: 'https://example.com/in.png',
    }, true)
    expect(body['image_url']).toBe('https://example.com/in.png')
    expect(body['extra_parameters']).toEqual({
      resolution: undefined,
      enable_audio: true,
    })
    expect((body['extra_parameters'] as Record<string, unknown>)).not.toHaveProperty('aspect_ratio')
  })

  it('图生视频支持 last_image_url（首尾帧）', () => {
    const body = buildVideoBody({
      model: 'kling-video-v3',
      prompt: 'p',
      lastImage: 'https://example.com/last.png',
    }, true)
    expect(body['last_image_url']).toBe('https://example.com/last.png')
    expect(body).not.toHaveProperty('image_url')
  })

  it('resolution / enable_audio / aspect_ratio 都被原样透传（信任已校验的值）', () => {
    const text = buildVideoBody({
      model: 'kling-video-v3',
      prompt: 'p',
      resolution: '1080p',
      aspectRatio: '9:16',
      enableAudio: false,
      seconds: 10,
    }, false)
    expect(text['seconds']).toBe(10)
    expect(text['extra_parameters']).toEqual({
      resolution: '1080p',
      enable_audio: false,
      aspect_ratio: '9:16',
    })
  })
})

describe('resolveVideoParams', () => {
  it('prompt 超 2500 字 → INVALID_ARGS', () => {
    expect(() => resolveVideoParams({ model: 'm', prompt: 'x'.repeat(2501) }))
      .toThrow(WorkBuddyVideoError)
    try {
      resolveVideoParams({ model: 'm', prompt: 'x'.repeat(2501) })
    } catch (error: unknown) {
      expect((error as WorkBuddyVideoError).code).toBe('INVALID_ARGS')
    }
  })

  it('negative_prompt 超 2500 字 → INVALID_ARGS', () => {
    try {
      resolveVideoParams({ model: 'm', prompt: 'p', negativePrompt: 'x'.repeat(2501) })
      expect.unreachable('应当抛错')
    } catch (error: unknown) {
      expect((error as WorkBuddyVideoError).code).toBe('INVALID_ARGS')
    }
  })

  it('aspect_ratio 非法 → INVALID_ARGS（图生视频不校验）', () => {
    try {
      resolveVideoParams({ model: 'm', prompt: 'p', aspectRatio: '2:3' })
      expect.unreachable('应当抛错')
    } catch (error: unknown) {
      expect((error as WorkBuddyVideoError).code).toBe('INVALID_ARGS')
    }
    // 合法值都能过
    for (const ar of VIDEO_ASPECT_RATIOS) {
      expect(resolveVideoParams({ model: 'm', prompt: 'p', aspectRatio: ar }).aspectRatio).toBe(ar)
    }
  })

  it('没有 videoGeneration 配置时透传用户时长，不盲拒', () => {
    // 拿不到 min/maxSeconds：给任意 seconds 都接受，避免把所有自定义时长判死。
    expect(resolveVideoParams({ model: 'm', prompt: 'p', seconds: 15 }).seconds).toBe(15)
    expect(resolveVideoParams({ model: 'm', prompt: 'p' }).seconds).toBe(DEFAULT_VIDEO_SECONDS)
  })

  it('有时长上限且越界 → INVALID_ARGS', () => {
    try {
      resolveVideoParams(
        { model: 'm', prompt: 'p', seconds: 60 },
        { minSeconds: 5, maxSeconds: 30, defaultSeconds: 5 },
      )
      expect.unreachable('应当抛错')
    } catch (error: unknown) {
      expect((error as WorkBuddyVideoError).code).toBe('INVALID_ARGS')
      expect((error as Error).message).toContain('5')
      expect((error as Error).message).toContain('30')
    }
  })

  it('有时长上限且在范围内 → 原数返回', () => {
    expect(resolveVideoParams({ model: 'm', prompt: 'p', seconds: 20 },
      { minSeconds: 5, maxSeconds: 30, defaultSeconds: 5 }).seconds).toBe(20)
  })

  it('分辨率不在模型集合里 → 回落默认并给告警', () => {
    const result = resolveVideoParams(
      { model: 'm', prompt: 'p', resolution: '4k' },
      { resolutions: ['720p', '1080p'], defaultResolution: '1080p' },
    )
    expect(result.resolution).toBe('1080p')
    expect(result.warnings).toEqual(['resolution 4k 不被模型 m 支持；改用 1080p'])
  })

  it('分辨率在集合里 → 原样采纳', () => {
    const result = resolveVideoParams(
      { model: 'm', prompt: 'p', resolution: '720p' },
      { resolutions: ['720p', '1080p'], defaultResolution: '1080p' },
    )
    expect(result.resolution).toBe('720p')
    expect(result.warnings).toEqual([])
  })

  it('目录没给 resolutions 时透传用户分辨率，不静默回落（与 seconds 同一条判据）', () => {
    // 回归：原实现把「不在 resolutions 集合里」和「根本没有 resolutions」当成一回事，
    // 于是一条 `resolution: "1080P"` 在拿不到 videoGeneration 的账号上被无声丢掉，
    // 只留一句「改用 上游默认」的告警。用户显式给的值不能因为目录读不到就消失。
    const noConfig = resolveVideoParams({ model: 'm', prompt: 'p', resolution: '1080P' })
    expect(noConfig.resolution).toBe('1080P')
    expect(noConfig.warnings).toEqual([])

    // 有 videoGeneration、但里面没有 resolutions 清单：同样不知道上游认不认。
    const emptyList = resolveVideoParams(
      { model: 'm', prompt: 'p', resolution: '1080P' },
      { minSeconds: 4, maxSeconds: 15 },
    )
    expect(emptyList.resolution).toBe('1080P')
    expect(emptyList.warnings).toEqual([])
  })

  it('大小写不同但语义相同 → 采纳目录的拼写（上游认的是它自己那份）', () => {
    // 官方 CLI 的兜底档位是 ["720P","1080P"]，而工具描述举的例子是 720p/1080p；
    // 精确匹配会把一个其实可用的值判成不支持。
    const result = resolveVideoParams(
      { model: 'm', prompt: 'p', resolution: '1080p' },
      { resolutions: ['720P', '1080P'], defaultResolution: '1080P' },
    )
    expect(result.resolution).toBe('1080P')
    expect(result.warnings).toEqual([])
  })

  it('图生视频时 aspectRatio 一定是 undefined（比例由输入图决定）', () => {
    const result = resolveVideoParams({ model: 'm', prompt: 'p', image: 'x', aspectRatio: '9:16' })
    expect(result.aspectRatio).toBeUndefined()
  })
})

describe('parseVideoSubmission', () => {
  it('成功取 data.id 作 taskId', () => {
    expect(parseVideoSubmission({ code: 0, data: { id: 'task-1' } }).taskId).toBe('task-1')
  })

  it('code 非 0 → UPSTREAM，并带 msg 与 request_id', () => {
    try {
      parseVideoSubmission({ code: 50001, msg: 'boom', request_id: 'r-9' })
      expect.unreachable('应当抛错')
    } catch (error: unknown) {
      expect((error as WorkBuddyVideoError).code).toBe('UPSTREAM')
      expect((error as Error).message).toContain('50001')
      expect((error as Error).message).toContain('boom')
      expect((error as Error).message).toContain('r-9')
    }
  })

  it('无 data.id → EMPTY_RESULT', () => {
    try {
      parseVideoSubmission({ code: 0, data: {} })
      expect.unreachable('应当抛错')
    } catch (error: unknown) {
      expect((error as WorkBuddyVideoError).code).toBe('EMPTY_RESULT')
    }
  })
})

describe('parseVideoTask', () => {
  it('completed 取出视频 URL 列表与实扣积分', () => {
    const result = parseVideoTask({
      code: 0,
      data: {
        status: 'completed',
        data: [{ url: 'https://cos.example/a.mp4' }, { url: 'https://cos.example/b.mp4' }],
        usage: { credit: 12.5 },
      },
    })
    expect(result.status).toBe('completed')
    expect(result.videos).toEqual(['https://cos.example/a.mp4', 'https://cos.example/b.mp4'])
    expect(result.credit).toBe(12.5)
  })

  it('completed 但空 data → 没有视频，按未完成处理（上层再判 EMPTY_RESULT）', () => {
    const result = parseVideoTask({ code: 0, data: { status: 'completed', data: [] } })
    expect(result.status).toBe('completed')
    expect(result.videos).toEqual([])
  })

  it('未知 status 当成未完成，继续轮询（不报错）', () => {
    // 上游若新增状态，旧插件不应误判成失败而浪费一次已花钱的任务。
    const result = parseVideoTask({ code: 0, data: { status: 'queued' } })
    expect(result.status).toBe('queued')
    expect(result.videos).toEqual([])
  })

  it('failed → 返回 failed 状态，视频为空（上层抛 TASK_FAILED）', () => {
    const result = parseVideoTask({ code: 0, data: { status: 'failed' } })
    expect(result.status).toBe('failed')
    expect(result.videos).toEqual([])
  })

  /**
   * issue #187 的第一种现象：failed 但插件一个字的原因都不报，用户无从判断是
   * 提示词、模型不支持还是上游自己的问题。
   *
   * 这里**不猜字段名**（没有一份上游样例能证明它叫 fail_reason 还是 error_message），
   * 而是把 data 里除已知键以外的内容原样带出来。下面几条钉的是这个契约本身。
   */
  describe('失败时的上游诊断（issue #187）', () => {
    it('把 data 里不认识的字段原样带出来', () => {
      const result = parseVideoTask({
        code: 0,
        data: { status: 'failed', fail_reason: 'content policy', task_id: 'abc-WandVideo-1' },
      })
      expect(result.detail).toContain('fail_reason')
      expect(result.detail).toContain('content policy')
      expect(result.detail).toContain('abc-WandVideo-1')
    })

    it('不重复带上已知键 status / data / usage', () => {
      const result = parseVideoTask({
        code: 0,
        data: { status: 'failed', data: [], usage: { credit: 0 }, error: 'boom' },
      })
      // 已知键不该出现在诊断里，否则每次报错都多一段噪音。
      expect(result.detail).not.toContain('"status"')
      expect(result.detail).not.toContain('"usage"')
      expect(result.detail).toContain('boom')
    })

    it('没有任何额外字段时是 undefined（上层据此说"上游没有给出原因"）', () => {
      const result = parseVideoTask({ code: 0, data: { status: 'failed' } })
      expect(result.detail).toBeUndefined()
    })

    it('空的额外字段不算"有原因"', () => {
      // 上游发一个 "" 或 null 不该被当成诊断——那会让文案写着"上游返回："
      // 后面空一片。
      const result = parseVideoTask({ code: 0, data: { status: 'failed', note: '', other: null } })
      expect(result.detail).toBeUndefined()
    })

    it('很长的诊断被截断，不会把报错撑成几 KB', () => {
      const result = parseVideoTask({
        code: 0,
        data: { status: 'failed', blob: 'x'.repeat(5000) },
      })
      expect(result.detail).toBeDefined()
      expect(result.detail!.length).toBeLessThanOrEqual(401)
      expect(result.detail!.endsWith('…')).toBe(true)
    })
  })
})

describe('describeVideoFailure', () => {
  it('401/403 归为 AUTH 并提示重新登录', () => {
    for (const status of [401, 403]) {
      const error = describeVideoFailure(status, '')
      expect(error.code).toBe('AUTH')
      expect(error.message).toContain('重新登录')
    }
  })

  it('404 归为 NO_ROUTE', () => {
    expect(describeVideoFailure(404, '').code).toBe('NO_ROUTE')
    expect(describeVideoFailure(404, '').message).toContain('404')
  })

  it('429 归为 RATE_LIMIT', () => {
    expect(describeVideoFailure(429, '').code).toBe('RATE_LIMIT')
  })

  it('从 JSON 信封里抽出 code 与 msg', () => {
    const error = describeVideoFailure(500, JSON.stringify({ code: 50001, msg: 'boom' }))
    expect(error.code).toBe('UPSTREAM')
    expect(error.message).toContain('50001')
    expect(error.message).toContain('boom')
  })

  it('非 JSON 的响应体截断后原样带上', () => {
    const error = describeVideoFailure(502, '<html>bad gateway</html>')
    expect(error.code).toBe('UPSTREAM')
    expect(error.message).toContain('bad gateway')
  })
})

/**
 * 提交阶段的 4xx：上游在创建任务之前就把请求退回了（实测原文
 * `code 14407: Create video failed with error: unsupported video duration: 1
 * seconds, supported range: 4-15 seconds`）。这类失败没有 task、没有扣积分，
 * 必须与「已经打到上游可能扣了钱」的 UPSTREAM 分开——否则工具会给一次参数写错
 * 记 60 秒冷却，用户看到的就是「上游返回这种错误，也要等半天」。
 */
describe('describeVideoFailure: 提交阶段 4xx', () => {
  const durationBody = JSON.stringify({
    code: 14407,
    msg: 'Create video failed with error: unsupported video duration: 1 seconds, supported range: 4-15 seconds',
  })

  it('400 归为 REJECTED 并明说没有建任务、没有扣积分', () => {
    const error = describeVideoFailure(400, durationBody, 'submit')
    expect(error.code).toBe('REJECTED')
    expect(error.message).toContain('没有创建任务')
    expect(error.message).toContain('没有扣积分')
    expect(error.message).toContain('可以立刻重试')
  })

  it('把上游自报的区间写进错误里，替用户把「到底几秒」补全', () => {
    const error = describeVideoFailure(400, durationBody, 'submit')
    expect(error.message).toContain('4-15 秒')
  })

  it('保留上游原文（含 unsupported video duration 那句）', () => {
    const error = describeVideoFailure(400, durationBody, 'submit')
    expect(error.message).toContain('unsupported video duration: 1 seconds')
  })

  it('轮询阶段的 400 仍然是 UPSTREAM——那时任务已经存在、钱已经花了', () => {
    expect(describeVideoFailure(400, durationBody, 'poll').code).toBe('UPSTREAM')
  })

  it('401/403/404/429 的既有归类不受影响', () => {
    expect(describeVideoFailure(401, '', 'submit').code).toBe('AUTH')
    expect(describeVideoFailure(403, '', 'submit').code).toBe('AUTH')
    expect(describeVideoFailure(404, '', 'submit').code).toBe('NO_ROUTE')
    expect(describeVideoFailure(429, '', 'submit').code).toBe('RATE_LIMIT')
  })
})

describe('parseSupportedSecondsRange', () => {
  it('读出上游文案里的区间', () => {
    expect(parseSupportedSecondsRange('supported range: 4-15 seconds')).toEqual({
      minSeconds: 4,
      maxSeconds: 15,
    })
  })

  it('兼容 to / 波浪号 / en dash 这些写法', () => {
    for (const text of [
      'supported range: 4 to 15 seconds',
      'supported range: 4~15s',
      'supported range: 4–15 seconds',
      'Supported Range: 2.5 - 10 seconds',
    ]) {
      expect(parseSupportedSecondsRange(text)).toBeDefined()
    }
    expect(parseSupportedSecondsRange('Supported Range: 2.5 - 10 seconds')).toEqual({
      minSeconds: 2.5,
      maxSeconds: 10,
    })
  })

  it('读不到 / 语序颠倒 / 非正数时返回 undefined（绝不猜）', () => {
    expect(parseSupportedSecondsRange('unsupported video duration: 1 seconds')).toBeUndefined()
    expect(parseSupportedSecondsRange('supported range: 15-4 seconds')).toBeUndefined()
    expect(parseSupportedSecondsRange('supported range: 0-15 seconds')).toBeUndefined()
    expect(parseSupportedSecondsRange('')).toBeUndefined()
  })
})

describe('videoGeneration 透传', () => {
  const raw = [
    {
      id: 'kling-video-v3',
      name: 'Kling Video v3',
      tags: ['text-to-video', 'image-to-video'],
      videoGeneration: {
        resolutions: ['720p', '1080p'],
        defaultResolution: '720p',
        defaultSeconds: 5,
        minSeconds: 4,
        maxSeconds: 15,
      },
    },
    { id: 'hunyuan-image', name: 'Hunyuan', tags: ['text-to-image'] },
  ]

  it('selectMediaModels 不再把 videoGeneration 丢掉', () => {
    const models = selectMediaModels(raw, [VIDEO_TAG_TEXT_TO_VIDEO, VIDEO_TAG_IMAGE_TO_VIDEO])
    expect(models).toHaveLength(1)
    expect(models[0]!.videoGeneration).toEqual({
      resolutions: ['720p', '1080p'],
      defaultResolution: '720p',
      defaultSeconds: 5,
      minSeconds: 4,
      maxSeconds: 15,
    })
  })

  it('条目没有 videoGeneration 时不凭空造一个', () => {
    const models = selectMediaModels(
      [{ id: 'kling-video-v3', name: 'K', tags: ['text-to-video'] }],
      VIDEO_TAG_TEXT_TO_VIDEO,
    )
    expect(models[0]).not.toHaveProperty('videoGeneration')
  })

  it('readVideoGeneration 只搬已知字段，非有限数与非字符串一律丢弃', () => {
    expect(readVideoGeneration({
      resolutions: ['720p', '', 7],
      defaultResolution: '',
      defaultSeconds: '5',
      minSeconds: 4,
      maxSeconds: Number.POSITIVE_INFINITY,
    })).toEqual({ resolutions: ['720p'], minSeconds: 4 })
    expect(readVideoGeneration(null)).toBeUndefined()
    expect(readVideoGeneration({})).toBeUndefined()
  })

  it('与 image-gen 的同名搬运函数读出同一个答案（同一份上游数据）', () => {
    const sample = {
      resolutions: ['720p', '1080p'],
      defaultResolution: '1080p',
      defaultSeconds: 5,
      minSeconds: 4,
      maxSeconds: 15,
    }
    expect(readImageVideoGeneration(sample)).toEqual(readVideoGeneration(sample))
  })

  it('传来的 videoGeneration 真的会用来在本地拦下越界时长', () => {
    const models = selectMediaModels(raw, VIDEO_TAG_TEXT_TO_VIDEO)
    const config = models[0]!.videoGeneration
    expect(() => resolveVideoParams({ model: 'kling-video-v3', prompt: '猫', seconds: 1 }, config))
      .toThrowError(/4 到 15 秒/)
  })
})


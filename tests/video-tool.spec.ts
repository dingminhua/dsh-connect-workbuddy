/**
 * The video tool's MODEL RESOLUTION order: an explicit `model` argument, then the
 * model the user pinned in the card for that mode, then the first model of the
 * tag group.
 *
 * Why this needs its own suite: the pin is a SOFT constraint. It is written by a
 * picker the user may have used weeks ago, against a catalog that can change
 * under it (a plan swap, a region switch, a model retired upstream). A stale pin
 * must therefore fall back rather than fail — while an explicit argument, which
 * the CALLER wrote for THIS call, must still fail loudly when it names a model
 * that is not in the group. Those two rules point in opposite directions, so
 * they are pinned here side by side.
 */
import { describe, expect, it } from 'vitest'
import type { WorkBuddyCredential } from '../src/auth.ts'
import {
  VIDEO_TAG_IMAGE_TO_VIDEO,
  VIDEO_TAG_TEXT_TO_VIDEO,
  WorkBuddyVideoError,
  describeVideoFailure,
} from '../src/video-gen.ts'
import { createVideoTool, VIDEO_POLL_BUDGET_MS, VIDEO_TOOL_TIMEOUT_MS, type VideoToolDeps } from '../src/video-tool.ts'

/** Both video tags — what each CN model declares today. */
const MEDIA_TAGS_FOR_VIDEO = [VIDEO_TAG_TEXT_TO_VIDEO, VIDEO_TAG_IMAGE_TO_VIDEO] as const

function credential(): WorkBuddyCredential {
  return {
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAtMs: Date.now() + 3_600_000,
    domain: 'copilot.tencent.com',
    uid: 'uid-1',
    source: 'dsh',
    filePath: '/tmp/auth.json',
  }
}

/** Two CN-style video models, both carrying both video tags (as measured). */
const MODELS = [
  { id: 'kling-video-v3', name: 'Kling v3', tags: [...MEDIA_TAGS_FOR_VIDEO] },
  { id: 'minimax-video-h3', name: 'MiniMax H3', tags: [...MEDIA_TAGS_FOR_VIDEO] },
]

function deps(overrides: Partial<VideoToolDeps> = {}): VideoToolDeps {
  return {
    resolveCredential: async () => credential(),
    listMediaModels: async () => MODELS,
    submitVideo: async () => ({ taskId: 'task-1', warnings: [] }),
    pollVideoTask: async () => ({ videos: ['https://cos.example/a.mp4'] }),
    downloadVideo: async () => '/tmp/a.mp4',
    logger: { warn: () => {} },
    ...overrides,
  }
}

/** Runs a text-to-video call and returns the model id it actually used. */
async function usedModel(overrides: Partial<VideoToolDeps>, model?: string): Promise<string> {
  const tool = createVideoTool(deps(overrides))
  const value = await tool.execute(
    model === undefined ? { prompt: '一只猫在弹钢琴' } : { prompt: '一只猫在弹钢琴', model },
    {},
  )
  return value['model'] as string
}

describe('video tool model resolution', () => {
  it('takes the group first model when nothing is pinned and nothing is passed', async () => {
    await expect(usedModel({})).resolves.toBe('kling-video-v3')
  })

  it('uses the pinned model when the call names none', async () => {
    const asked: string[] = []
    const model = await usedModel({
      preferredVideoModel: (_credential, tag) => {
        asked.push(tag)
        return 'minimax-video-h3'
      },
    })
    expect(model).toBe('minimax-video-h3')
    // The pin is per mode, so the tool must ask for the tag it is actually
    // about to use — asking for a fixed one would pick a text-to-video pin for an
    // image-to-video call.
    expect(asked).toEqual([VIDEO_TAG_TEXT_TO_VIDEO])
  })

  it('falls back to the group first model when the pin is no longer in the catalog', async () => {
    // The case that matters: the user pinned `minimax-video-h3` on a plan that
    // has since dropped it. Failing here would break a generation the user asked
    // for because of a preference they set earlier.
    const model = await usedModel({ preferredVideoModel: () => 'retired-video-9' })
    expect(model).toBe('kling-video-v3')
  })

  it('lets an explicit model win over the pin', async () => {
    const model = await usedModel({
      preferredVideoModel: () => 'kling-video-v3',
    }, 'minimax-video-h3')
    expect(model).toBe('minimax-video-h3')
  })

  it('does not even read the pin when the call named a model', async () => {
    let reads = 0
    await usedModel({
      preferredVideoModel: () => {
        reads += 1
        return 'kling-video-v3'
      },
    }, 'minimax-video-h3')
    expect(reads).toBe(0)
  })

  it('does not promise to clamp an out-of-range duration', async () => {
    // `resolveVideoParams` THROWS `INVALID_ARGS` outside the model's
    // minSeconds..maxSeconds. A description that said "clamped" would teach the
    // caller to send 30s and expect 5s back, then read the error as a bug.
    const tool = createVideoTool(deps())
    const seconds = (tool.parameters['properties'] as Record<string, Record<string, unknown>>)['seconds']!
    const description = seconds['description'] as string
    expect(description).toContain('报错')
    expect(description).not.toContain('夹回')
  })

  it('still fails loudly for an explicit model that is not in the group', async () => {
    // The other direction: this name came from THIS call, so a wrong one is a
    // caller error and must not be silently replaced by a different model.
    const tool = createVideoTool(deps({ preferredVideoModel: () => 'kling-video-v3' }))
    const failure = await tool.execute({ prompt: '一只猫', model: 'retired-video-9' }, {})
      .then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(WorkBuddyVideoError)
    expect((failure as WorkBuddyVideoError).code).toBe('NO_VIDEO_MODEL')
  })
})

/**
 * 时长校验与失败冷却。
 *
 * 用户实测撞到的是：`seconds: 1` 被上游以 HTTP 400
 * `unsupported video duration: 1 seconds, supported range: 4-15 seconds` 退回，
 * 然后工具还给这次「参数写错」记了 60 秒冷却——于是抱怨「上游返回这种错误，
 * 也要等半天」。两个根因：目录里的 `videoGeneration` 从没被用来校验（`resolveVideoParams`
 * 的第二参数一直是 undefined），以及提交阶段 4xx 被当成「已计费失败」。
 */
describe('video tool duration validation and cooldown', () => {
  /** A catalog whose entry carries the model-level videoGeneration (4..15s). */
  const CONFIGURED = [
    {
      id: 'kling-video-v3',
      name: 'Kling v3',
      tags: [...MEDIA_TAGS_FOR_VIDEO],
      videoGeneration: { defaultSeconds: 5, minSeconds: 4, maxSeconds: 15 },
    },
  ]

  it('uses the catalog videoGeneration to reject an out-of-range duration before spending anything', async () => {
    let submitted = 0
    const tool = createVideoTool(deps({
      listMediaModels: async () => CONFIGURED,
      submitVideo: async () => {
        submitted += 1
        return { taskId: 'task-1', warnings: [] }
      },
    }))
    const failure = await tool.execute({ prompt: '一只猫', seconds: 1 }, {})
      .then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(WorkBuddyVideoError)
    expect((failure as WorkBuddyVideoError).code).toBe('INVALID_ARGS')
    expect((failure as WorkBuddyVideoError).message).toContain('4 到 15 秒')
    // Not a single paid request was sent.
    expect(submitted).toBe(0)
  })

  it('accepts a duration inside the catalog range', async () => {
    const seen: number[] = []
    const tool = createVideoTool(deps({
      listMediaModels: async () => CONFIGURED,
      submitVideo: async (_credential, request) => {
        seen.push(request.seconds)
        return { taskId: 'task-1', warnings: [] }
      },
    }))
    await tool.execute({ prompt: '一只猫', seconds: 12 }, {})
    expect(seen).toEqual([12])
  })

  it('does not cool down after a submit-phase 400: nothing was created, nothing was billed', async () => {
    let submitted = 0
    const tool = createVideoTool(deps({
      submitVideo: async () => {
        submitted += 1
        throw describeVideoFailure(400, JSON.stringify({
          code: 14407,
          msg: 'Create video failed with error: unsupported video duration: 3 seconds',
        }), 'submit')
      },
    }))
    const first = await tool.execute({ prompt: '一只猫', seconds: 3 }, {})
      .then(() => undefined, (error: unknown) => error)
    expect((first as WorkBuddyVideoError).code).toBe('REJECTED')
    // The very next call must reach the upstream again instead of answering
    // "wait 58 seconds" — that wait is the whole complaint.
    const second = await tool.execute({ prompt: '一只猫', seconds: 3 }, {})
      .then(() => undefined, (error: unknown) => error)
    expect((second as WorkBuddyVideoError).code).toBe('REJECTED')
    expect(submitted).toBe(2)
  })

  it('learns the range the upstream reported and validates it locally afterwards', async () => {
    let submitted = 0
    const tool = createVideoTool(deps({
      submitVideo: async () => {
        submitted += 1
        throw describeVideoFailure(400, JSON.stringify({
          code: 14407,
          msg: 'Create video failed with error: unsupported video duration: 1 seconds, '
            + 'supported range: 4-15 seconds',
        }), 'submit')
      },
    }))
    await tool.execute({ prompt: '一只猫', seconds: 1 }, {}).catch(() => undefined)
    expect(submitted).toBe(1)
    const failure = await tool.execute({ prompt: '一只猫', seconds: 1 }, {})
      .then(() => undefined, (error: unknown) => error)
    expect((failure as WorkBuddyVideoError).code).toBe('INVALID_ARGS')
    expect((failure as WorkBuddyVideoError).message).toContain('4 到 15 秒')
    // The second attempt never left the process.
    expect(submitted).toBe(1)
  })

  it('still cools down for a failure that really may have been billed', async () => {
    const tool = createVideoTool(deps({
      submitVideo: async () => {
        throw new WorkBuddyVideoError('workbuddy video: 上游 500', 'UPSTREAM')
      },
    }))
    await tool.execute({ prompt: '一只猫' }, {}).catch(() => undefined)
    const failure = await tool.execute({ prompt: '一只猫' }, {})
      .then(() => undefined, (error: unknown) => error)
    expect((failure as WorkBuddyVideoError).code).toBe('COOLDOWN')
  })
})

/**
 * 图生视频的输入图承载形式（issue #187 的第二种现象）。
 *
 * 用户拿上一张成功的图做首帧是最自然的路径，而插件出图返回的是 COS 签名 URL。
 * 旧实现只对它发 HEAD，再把 URL 原样交给上游：COS 签名只覆盖 GET，HEAD 拿到
 * 403，于是报「输入图 URL 不可达」——把上游不接受外链这件事伪装成用户图片的问题。
 *
 * 这两条钉的是：URL 必须被**下载并编码成 data URL**，且只发 GET。
 */
describe('video tool image input (issue #187)', () => {
  /** 一个最小但合法的 PNG（1x1）。 */
  const PNG_BYTES = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )

  it('downloads an http(s) image and sends a data URL, never the URL itself', async () => {
    const calls: Array<{ url: string, method: string }> = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown, init?: { method?: string }) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET' })
      return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } })
    }) as typeof fetch
    try {
      let sentImage: string | undefined
      const tool = createVideoTool(deps({
        submitVideo: async (_c, request) => {
          sentImage = request.image
          return { taskId: 'task-1', warnings: [] }
        },
      }))
      await tool.execute({ prompt: '猫', image: 'https://cos.example/a.png' }, {})

      // 发出去的是 data URL，不是外链——上游只吃 data URI。
      expect(sentImage?.startsWith('data:image/png;base64,')).toBe(true)
      expect(sentImage).not.toContain('cos.example')
      // 而且只发 GET：对 COS 签名 URL 发 HEAD 就是 403 的来源。
      expect(calls.map(call => call.method)).toEqual(['GET'])
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('reports a download failure against the image, not against the task', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response('denied', { status: 403 })) as typeof fetch
    try {
      const tool = createVideoTool(deps())
      const error = await tool.execute({ prompt: '猫', image: 'https://cos.example/expired.png' }, {})
        .then(() => undefined, (cause: unknown) => cause)
      expect(error).toBeInstanceOf(WorkBuddyVideoError)
      expect((error as WorkBuddyVideoError).code).toBe('INVALID_ARGS')
      // 这条很关键：以前它伪装成「URL 不可达」，让人以为是图片本身坏了。
      expect((error as WorkBuddyVideoError).message).toContain('下载输入图失败')
      expect((error as WorkBuddyVideoError).message).toContain('403')
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

/**
 * 超时的**层级关系**（issue #187 的第三种现象）。
 *
 * 三个 deadline 同时存在的场景里，谁先到期决定了用户看到什么：
 *
 * - 插件内部（轮询）先到期 → 抛出 `POLL_TIMEOUT`，**带上 task id**，日志里有据可查；
 * - 宿主工具上限先到期 → 裸的 `tool call timed out after 600000ms`，task id 丢掉。
 *
 * 修之前三者都是 600000，等于同时到期，实际总是宿主那个赢。这组断言钉的是
 * "内部的永远严格更早"，而不是某个具体数字——数值以后可以调，顺序不能反。
 */
describe('video tool timeout ordering (issue #187)', () => {
  it('the host tool limit is strictly below the host default of 600s', () => {
    // 宿主给工具调用的默认上限就是 600_000；等于它就是这次 bug。
    expect(VIDEO_TOOL_TIMEOUT_MS).toBeLessThan(600_000)
  })

  it('the poll budget is strictly below the tool limit, leaving room to report', () => {
    // 轮询是最容易吃满的一段，它必须最早放弃，工具层才有机会把错误带回给模型。
    expect(VIDEO_POLL_BUDGET_MS).toBeLessThan(VIDEO_TOOL_TIMEOUT_MS)
    // 至少留够一次"抛错+下载"的余量，不能只差几十毫秒。
    expect(VIDEO_TOOL_TIMEOUT_MS - VIDEO_POLL_BUDGET_MS).toBeGreaterThanOrEqual(10_000)
  })
})

/**
 * 参数类型的严格性——与生图工具同一族 bug 的钉死。
 *
 * 生图工具曾因 `image: [模板图, 服装图]` 被当成「没给图」而静默切回文生图，
 * 当场烧积分生成毫不相关的画面（已修）。视频工具曾有一样的毛病：`image`
 * 传数组/数字 → 静默切文生视频；`seconds: "10"`、`model: [...]`、
 * `enable_audio: "true"` → 静默丢掉用默认值。
 *
 * 这组钉的是：宽容只给「单元素数组 = 字符串」这一种常见误写；其余一律
 * INVALID_ARGS，并且一条请求都不发（不花积分、不进冷却）。null 仍算未提供。
 */
describe('video tool strict argument validation', () => {
  /** 最小合法 PNG（1x1），与 issue #187 那组同一夹具。 */
  const PNG_BYTES = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )

  function captureDeps() {
    const sent: Array<{ image: string | undefined, model: string }> = []
    const tool = createVideoTool(deps({
      submitVideo: async (_credential, request) => {
        sent.push({ image: request.image, model: request.model })
        return { taskId: 'task-1', warnings: [] }
      },
    }))
    return { tool, sent }
  }

  /** 断言 INVALID_ARGS 且一次请求都没发出去。 */
  async function expectFreeRejection(tool: ReturnType<typeof createVideoTool>, args: Record<string, unknown>) {
    const submittedBefore = submittedCount
    const failure = await tool.execute(args, {}).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(WorkBuddyVideoError)
    expect((failure as WorkBuddyVideoError).code).toBe('INVALID_ARGS')
    expect(submittedCount).toBe(submittedBefore)
    return failure as WorkBuddyVideoError
  }
  let submittedCount = 0

  it('单元素 image 数组与字符串等价，走图生视频', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } })) as typeof fetch
    try {
      const { tool, sent } = captureDeps()
      const value = await tool.execute({ prompt: '猫', image: ['https://cos.example/a.png'] }, {})
      expect(value['mode']).toBe('image-to-video')
      expect(sent[0]?.image?.startsWith('data:image/png;base64,')).toBe(true)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('多元素 image 数组 → INVALID_ARGS，不发请求，并说清只支持一张', async () => {
    submittedCount = 0
    const counting = createVideoTool(deps({
      submitVideo: async () => {
        submittedCount += 1
        return { taskId: 'task-1', warnings: [] }
      },
    }))
    const failure = await expectFreeRejection(counting, { prompt: '猫', image: ['a.png', 'b.png'] })
    expect(failure.message).toContain('只支持一张输入图')
    // 空数组仍算「没给图」：那是无害的缺省写法，不该拦。
    const { tool, sent } = captureDeps()
    const value = await tool.execute({ prompt: '猫', image: [] }, {})
    expect(value['mode']).toBe('text-to-video')
    expect(sent[0]?.image).toBeUndefined()
  })

  it('image 是数字 → INVALID_ARGS，而不是静默切文生视频', async () => {
    // 钉回归（与生图工具的数组 bug 同族）：类型不对的 image 曾被读成
    // 「没给图」，工具安静地改走文生视频，生成一段与参考毫无关系的片子。
    submittedCount = 0
    const counting = createVideoTool(deps({
      submitVideo: async () => {
        submittedCount += 1
        return { taskId: 'task-1', warnings: [] }
      },
    }))
    await expectFreeRejection(counting, { prompt: '猫', image: 123 })
  })

  it('seconds 是字符串 → INVALID_ARGS，而不是静默用默认时长', async () => {
    submittedCount = 0
    const counting = createVideoTool(deps({
      submitVideo: async () => {
        submittedCount += 1
        return { taskId: 'task-1', warnings: [] }
      },
    }))
    await expectFreeRejection(counting, { prompt: '猫', seconds: '10' })
  })

  it('model 是数组 → INVALID_ARGS，而不是静默换模型扣积分', async () => {
    submittedCount = 0
    const counting = createVideoTool(deps({
      submitVideo: async () => {
        submittedCount += 1
        return { taskId: 'task-1', warnings: [] }
      },
    }))
    await expectFreeRejection(counting, { prompt: '猫', model: ['kling-video-v3'] })
  })

  it('enable_audio 是字符串 → INVALID_ARGS', async () => {
    submittedCount = 0
    const counting = createVideoTool(deps({
      submitVideo: async () => {
        submittedCount += 1
        return { taskId: 'task-1', warnings: [] }
      },
    }))
    await expectFreeRejection(counting, { prompt: '猫', enable_audio: 'true' })
  })

  it('null 仍表示未提供，默认路径照常成功', async () => {
    const { tool, sent } = captureDeps()
    const value = await tool.execute(
      { prompt: '猫', model: null, seconds: null, resolution: null, enable_audio: null },
      {},
    )
    expect(value['mode']).toBe('text-to-video')
    expect(sent[0]?.model).toBe('kling-video-v3')
  })

  it('schema 把 image 声明为字符串或数组，宿主才不会先于工具拒掉数组', async () => {
    const tool = createVideoTool(deps())
    const image = (tool.parameters['properties'] as Record<string, Record<string, unknown>>)['image']!
    expect(image['type']).toEqual(['string', 'array'])
    expect(image['items']).toEqual({ type: 'string' })
    expect(image['description'] as string).toContain('只支持一张输入图')
  })
})

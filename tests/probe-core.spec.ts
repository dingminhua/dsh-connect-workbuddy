/**
 * 阶段 B 离线测试：probe-core.ts 纯函数、CLI 编排、§7 复算器。
 *
 * 覆盖验收方案 §4 的 B6 全部 13 个场景，以及 AGENTS.md「测试要能咬」要求的
 * 三项变异验证（见 docs/PROBE-OFFLINE-TESTS.md）：
 *   变异① 忽略失败轮        → 场景① / ② / ⑦ 的断言会红
 *   变异② 取首个 usage     → 场景④ / ⑤ / unit:最后一个完整 usage 会红
 *   变异③ 允许原始错误回显  → 场景⑨ / ⑩ 的 toFailureCode 断言会红
 *
 * 隐私：全部使用合成别名（账号A / model-x / endpoint-alias / 运行内别名），
 * 不读真实凭证、不访问真实上游、不产生真实实验数据。敏感标记是合成字符串，
 * 不是任何真实账号、token、会话或设备标识。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import * as core from '../scripts/probe-core.ts'
import type { PlanEntry, ProbeParams } from '../scripts/probe-core.ts'

/** 动态导入 scripts/ 下的 .mjs（Node 24 类型擦除会处理它们 import 的 .ts）。 */
async function loadScript(rel: string): Promise<any> {
  const url = new URL(`../scripts/${rel}`, import.meta.url).href
  return await import(/* @vite-ignore */ url)
}

function baseParams(over: Partial<ProbeParams> = {}): ProbeParams {
  return {
    groups: 2,
    warmTurns: 2,
    repeats: 1,
    maxTokens: 16,
    accountAlias: '账号A',
    model: 'model-x',
    endpointAlias: 'endpoint-alias',
    seed: 7,
    templateVersion: core.TEMPLATE_VERSION,
    usageIdentity: false,
    wireProfile: 'balanced',
    experimentKind: 'OFFLINE_SYNTHETIC',
    ...over,
  }
}

interface Outcome {
  status: number
  text: string
  throwError: unknown | null
  textError: unknown | null
}

function ok(text: string, status = 200): Outcome {
  return { status, text, throwError: null, textError: null }
}
function throwIt(error: unknown): Outcome {
  return { status: 200, text: '', throwError: error, textError: null }
}
function textThrows(error: unknown): Outcome {
  return { status: 200, text: '', throwError: null, textError: error }
}

/** 合成 SSE：终态 usage 有 hit/miss/completion/prompt，prompt_tokens 恒等于 hit+miss 以免触发 PARTITION_CONFLICT。 */
function sseUsage(hit: number, extras: Record<string, unknown>[] = []): string {
  const miss = 100 - hit
  const usage: Record<string, unknown> = {
    prompt_cache_hit_tokens: hit,
    prompt_cache_miss_tokens: miss,
    completion_tokens: 1,
    prompt_tokens: hit + miss,
  }
  return core.makeUsageSse(usage, extras.length > 0 ? { extraUsageFrames: extras } : {})
}

function usage(hit: number): Record<string, unknown> {
  return {
    prompt_cache_hit_tokens: hit,
    prompt_cache_miss_tokens: 100 - hit,
    completion_tokens: 1,
    prompt_tokens: 100,
  }
}

/**
 * 用注入的假 fetch 跑一次 CLI 编排。绝不覆写 globalThis.fetch，绝不触碰真实网络。
 * 每个计划条目恰好一次 fetch（无自动重试）。
 */
async function runWithOutcomes(
  params: ProbeParams,
  outcomeForEntry: (entry: PlanEntry, index: number) => Outcome,
  extraDeps: Record<string, unknown> = {},
): Promise<any> {
  const cli = await loadScript('probe-stable-conversation-id.mjs')
  const plan = core.buildPlan(params)
  let call = 0
  const fetchFn = async () => {
    const entry = plan.entries[call]!
    const out = outcomeForEntry(entry, call)
    call += 1
    if (out.throwError !== null) throw out.throwError
    return {
      status: out.status,
      text: async () => {
        if (out.textError !== null) throw out.textError
        return out.text
      },
    }
  }
  const result = await cli.runProbe(params, {
    fetch: fetchFn,
    now: () => 0,
    requestTimeoutMs: 25,
    ...extraDeps,
  })
  return { ...result, calls: call }
}

// ---------------------------------------------------------------------------
// B1：导入机制 / 纯函数模块零副作用（场景⑫）
// ---------------------------------------------------------------------------

describe('B1 / 场景⑫：导入与零副作用', () => {
  it('core .ts 静态导入、cli / recompute .mjs 动态导入都可用', async () => {
    expect(core.SCHEMA_VERSION).toBe('1.0.0')
    const cli = await loadScript('probe-stable-conversation-id.mjs')
    expect(typeof cli.runProbe).toBe('function')
    expect(typeof cli.main).toBe('function')
    expect(typeof cli.buildJsonl).toBe('function')
    const rc = await loadScript('recompute-probe.mjs')
    expect(typeof rc.recomputeFromJsonl).toBe('function')
    expect(typeof rc.selfTest).toBe('function')
  })

  it('⑫ probe-core.ts 源码不含任何 I/O 或 main，仅导出纯函数', () => {
    const src = readFileSync(new URL('../scripts/probe-core.ts', import.meta.url), 'utf8')
    const cleaned = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    expect(cleaned).not.toMatch(/\bimport\b/)
    expect(cleaned).not.toMatch(/\brequire\s*\(/)
    expect(cleaned).not.toMatch(/\bfetch\s*\(/)
    expect(cleaned).not.toMatch(/\bglobalThis\b/)
    expect(cleaned).not.toMatch(/\bprocess\b/)
    expect(cleaned).not.toMatch(/readFileSync|writeFileSync|readdirSync|Date\.now|Math\.random|setTimeout|AbortSignal/)
    expect('main' in core).toBe(false)
    expect('runProbe' in core).toBe(false)
    expect('loadCredential' in core).toBe(false)
  })

  it('⑫ 动态重新导入 CLI 模块不 fetch、不跑 main、不改全局状态', async () => {
    const fetchBefore = globalThis.fetch
    const exitBefore = process.exitCode
    const argvBefore = process.argv.slice()
    const cli = await import(/* @vite-ignore */ new URL(
      `../scripts/probe-stable-conversation-id.mjs?side-effect-probe=${Date.now()}`,
      import.meta.url,
    ).href)
    expect(typeof cli.runProbe).toBe('function')
    expect(globalThis.fetch).toBe(fetchBefore)
    expect(process.exitCode).toBe(exitBefore)
    expect(process.argv).toEqual(argvBefore)
  })
})

// ---------------------------------------------------------------------------
// B2：参数校验 / 预算 / 显式账号
// ---------------------------------------------------------------------------

describe('B2：参数校验', () => {
  it('parseStrictInt 拒绝 NaN / 小数 / 空串 / 脏串 / 科学计数法', () => {
    expect(core.parseStrictInt(5)).toBe(5)
    expect(core.parseStrictInt('5')).toBe(5)
    expect(core.parseStrictInt('  +12 ')).toBe(12)
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY, '', '5.0', '5abc', '5e2', '  ', null, {}, 1.5]) {
      expect(Number.isNaN(core.parseStrictInt(v))).toBe(true)
    }
  })

  it('validateParams 拒绝不完整 / 非法 / 超预算参数', () => {
    const bad: unknown[] = [
      { ...baseParams(), groups: Number.NaN },
      { ...baseParams(), groups: -1 },
      { ...baseParams(), warmTurns: 0 },
      { ...baseParams(), repeats: 1.5 },
      { ...baseParams(), groups: 100 },
      { ...baseParams(), groups: 30, warmTurns: 20 },
      { ...baseParams(), accountAlias: '' },
      { ...baseParams(), accountAlias: '/Users/<you>/vault/a.json' },
      { ...baseParams(), accountAlias: '100000000001' },
      { ...baseParams(), usageIdentity: 'yes' },
      { ...baseParams(), experimentKind: 'LIVE' },
      { ...baseParams(), maxTokens: 0 },
      { ...baseParams(), seed: -1 },
      {},
      'not an object',
      null,
      [],
    ]
    for (const b of bad) {
      expect(core.validateParams(b).ok).toBe(false)
    }
  })

  it('validateParams 接受合法参数，totalRequests = groups*2*(1+warmTurns)', () => {
    const v = core.validateParams(baseParams({ groups: 3, warmTurns: 2 }))
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(core.totalRequests(v.value)).toBe(18)
      expect(core.buildPlan(v.value).totalRequests).toBe(18)
    }
  })

  it('账号必须显式指定：main 缺 --account → PARAM_INVALID，不默默取目录第一个文件', async () => {
    const cli = await loadScript('probe-stable-conversation-id.mjs')
    const writes: string[] = []
    const orig = process.stdout.write
    process.stdout.write = ((chunk: unknown) => { writes.push(String(chunk)); return true }) as unknown as typeof process.stdout.write
    let code: number
    try {
      code = await cli.main(['--groups', '1'])
    } finally {
      process.stdout.write = orig
    }
    expect(code).toBe(core.EXIT.EXECUTION_FAILURE)
    expect(writes.join('')).toContain('STATUS PARAM_INVALID')
    expect(writes.join('')).toContain('ACCOUNT_NOT_SPECIFIED')
  })

  it('main 未知参数回显固定码，绝不回显参数原文', async () => {
    const cli = await loadScript('probe-stable-conversation-id.mjs')
    const writes: string[] = []
    const orig = process.stdout.write
    process.stdout.write = ((chunk: unknown) => { writes.push(String(chunk)); return true }) as unknown as typeof process.stdout.write
    try {
      await cli.main(['--this-arg-is-not-real'])
    } finally {
      process.stdout.write = orig
    }
    const out = writes.join('')
    expect(out).toContain('STATUS PARAM_INVALID')
    expect(out).not.toContain('--this-arg-is-not-real')
  })
})

// ---------------------------------------------------------------------------
// B3：SSE 解析与 usage 归一化
// ---------------------------------------------------------------------------

describe('B3：SSE / usage', () => {
  it('decodeSseFrames 覆盖 CRLF / LF / CR、keepalive(:) 注释、event:/id: 无关行、[DONE]', () => {
    const usageFrame = JSON.stringify({ usage: usage(50) })
    const crlf = [': keepalive', '', 'id: 7', 'event: message', `data: ${usageFrame}`, '', ': ping', '', 'data: [DONE]', ''].join('\r\n')
    const frames = core.decodeSseFrames(crlf)
    expect(frames.some((f) => f.isKeepalive)).toBe(true)
    expect(frames.some((f) => f.isDone)).toBe(true)
    expect(frames.some((f) => f.eventType === 'message')).toBe(true)
    expect(core.analyzeStream(crlf).streamStatus).toBe('COMPLETE')

    const lf = `: keepalive\n\ndata: ${usageFrame}\n\ndata: [DONE]\n\n`
    expect(core.analyzeStream(lf).streamStatus).toBe('COMPLETE')
    const cr = `: keepalive\r\rdata: ${usageFrame}\r\rdata: [DONE]\r\r`
    expect(core.analyzeStream(cr).streamStatus).toBe('COMPLETE')
  })

  it('decodeSseFrames 支持一个帧里的多个 data: 行（用 \\n 拼接）', () => {
    const frames = core.decodeSseFrames('data: {"x":1}\ndata: {"y":2}\n\n')
    expect(frames[0]!.dataLines).toEqual(['{"x":1}', '{"y":2}'])
    expect(frames[0]!.parseOk).toBe(false)
  })

  it('④ 中间 usage=0% 最终 99% → 读【最后一个结构有效的完整 usage】', () => {
    const terminal = usage(99)
    const middle = usage(0)
    const sse = core.makeUsageSse(terminal, { extraUsageFrames: [middle], crlf: true, keepalive: true })
    const a = core.analyzeStream(sse)
    expect(a.streamStatus).toBe('COMPLETE')
    expect(a.candidateCount).toBeGreaterThanOrEqual(2)
    expect(a.terminal).toEqual(terminal)
    const n = core.normalizeUsage(a.terminal)
    expect(n.usageSource).toBe('HIT_MISS')
    expect(n.rate).toBe(0.99)
    expect(n.denominator).toBe(100)
    expect(n.hit).toBe(99)
    expect(n.miss).toBe(1)
    expect(n.valid).toBe(true)
  })

  it('⑤ 多个累计 usage 帧 → 绝不重复累加，分母仍是单个终态', async () => {
    const terminal = usage(99)
    const cumulative = [0, 10, 20, 30].map(usage)
    const sse = core.makeUsageSse(terminal, { extraUsageFrames: cumulative })
    const a = core.analyzeStream(sse)
    expect(a.candidateCount).toBe(cumulative.length + 1)
    expect(a.terminal).toEqual(terminal)
    const n = core.normalizeUsage(a.terminal)
    expect(n.denominator).toBe(100)
    expect(n.rate).toBe(0.99)

    // 经由完整 CLI 编排：统计里的加权命中率仍是 0.99，不因多帧放大或求和。
    const params = baseParams({ groups: 1, warmTurns: 1 })
    const res = await runWithOutcomes(params, () => ok(sse))
    expect(res.records.every((r: any) => r.rate === 0.99)).toBe(true)
    expect(res.report.stats.weightedOnHitRate).toBe(0.99)
    expect(res.report.stats.weightedOffHitRate).toBe(0.99)
    expect(res.report.dataStatus).toBe('COMPLETE')
  })

  it('⑥ usage 非有限 / 负数 / 分母零 / cached>prompt → 无效记录，不静默选有利口径', () => {
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ prompt_cache_hit_tokens: Number.NaN, prompt_cache_miss_tokens: 1, completion_tokens: 1, prompt_tokens: 100 }, 'NON_FINITE'],
      [{ prompt_cache_hit_tokens: -3, prompt_cache_miss_tokens: 1, completion_tokens: 1, prompt_tokens: 100 }, 'NEGATIVE'],
      [{ prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 0, completion_tokens: 1, prompt_tokens: 100 }, 'ZERO_DENOMINATOR_HIT_MISS'],
      [{ cached_tokens: 150, prompt_tokens: 100, completion_tokens: 1 }, 'CACHED_GT_PROMPT'],
      [{ cached_tokens: 20, prompt_tokens: 0, completion_tokens: 1 }, 'ZERO_DENOMINATOR_CACHED_PROMPT'],
      [{ prompt_cache_hit_tokens: 50, prompt_cache_miss_tokens: 50, prompt_tokens: 200, completion_tokens: 1 }, 'PARTITION_CONFLICT'],
      [null as unknown as Record<string, unknown>, 'NO_USAGE_OBJECT'],
      [{}, 'NO_VALID_DENOMINATOR'],
    ]
    for (const [obj, marker] of bad) {
      const n = core.normalizeUsage(obj)
      expect(n.rate).toBeNull()
      expect(n.valid).toBe(false)
      expect([...n.invalidCodes, ...n.conflicts].join(' ')).toContain(marker)
    }
    // fallback cached/prompt 合法路径必须验证 cached<=prompt 且 prompt>0。
    const goodCp = core.normalizeUsage({ cached_tokens: 20, prompt_tokens: 100, completion_tokens: 1 })
    expect(goodCp.usageSource).toBe('CACHED_PROMPT')
    expect(goodCp.rate).toBe(0.2)
    expect(goodCp.hit).toBe(20)
    expect(goodCp.miss).toBe(80)
    expect(goodCp.valid).toBe(true)
    // 缺字段保持 null，不补 0。
    const partial = core.normalizeUsage({ prompt_cache_hit_tokens: 50, completion_tokens: 1 })
    expect(partial.miss).toBeNull()
    expect(partial.prompt).toBeNull()
  })

  it('⑥b 完整流但 usage 无效 → dataStatus=INVALID，禁止收益成功标签', async () => {
    const invalid = core.makeUsageSse({ cached_tokens: 150, prompt_tokens: 100, completion_tokens: 1 })
    expect(core.analyzeStream(invalid).streamStatus).toBe('COMPLETE')
    const params = baseParams({ groups: 1, warmTurns: 1 })
    const res = await runWithOutcomes(params, () => ok(invalid))
    expect(res.records.every((r: any) => r.invalidCodes.length > 0)).toBe(true)
    expect(res.records.every((r: any) => r.usageStatus === 'INVALID')).toBe(true)
    expect(res.report.dataStatus).toBe('INVALID')
    expect(res.report.reasons).toContain('DATA_INVALID')
    expect(res.report.effectStatus).toBe('NOT_EVALUATED')
    expect(res.report.exitCode).toBe(core.EXIT.INVALID_DATA)
  })

  it('⑦ HTTP 200 但 SSE 错误 / 截断 / 缺终态 → INCOMPLETE（不是 INVALID）', async () => {
    const good = usage(50)
    const cases = [
      { name: 'SSE_ERROR', text: core.makeUsageSse(good, { payloadError: true }), status: 'SSE_ERROR', code: 'SSE_ERROR' },
      { name: 'TRUNCATED', text: core.makeUsageSse(good, { truncateAtDataLine: true }), status: 'TRUNCATED', code: 'STREAM_TRUNCATED' },
      { name: 'NO_TERMINAL_USAGE', text: core.makeUsageSse(null, { omitTerminal: true }), status: 'NO_TERMINAL_USAGE', code: 'NO_TERMINAL_USAGE' },
    ]
    for (const c of cases) {
      expect(core.analyzeStream(c.text).streamStatus).toBe(c.status)
      const params = baseParams({ groups: 1, warmTurns: 1 })
      const res = await runWithOutcomes(params, () => ok(c.text))
      expect(res.records.every((r: any) => !r.complete)).toBe(true)
      expect(res.records.every((r: any) => r.streamStatus === c.status)).toBe(true)
      expect(res.records.every((r: any) => r.failureCode === c.code)).toBe(true)
      // 流不完整 → usage 记 MISSING、无 invalidCodes，故 dataStatus 是 INCOMPLETE 而非 INVALID。
      expect(res.records.every((r: any) => r.invalidCodes.length === 0)).toBe(true)
      expect(res.records.every((r: any) => r.usageStatus === 'MISSING')).toBe(true)
      expect(res.report.dataStatus).toBe('INCOMPLETE')
      expect(res.report.reasons).toContain('DATA_INCOMPLETE')
      expect(res.report.effectStatus).toBe('NOT_EVALUATED')
      expect(res.report.exitCode).toBe(core.EXIT.INVALID_DATA)
    }
    expect(core.analyzeStream('').streamStatus).toBe('EMPTY')
  })
})

// ---------------------------------------------------------------------------
// B4：wiring / data / effect 三态分离
// ---------------------------------------------------------------------------

describe('B4 / 场景⑧：wiring 判定与三态分离', () => {
  function snapshots(params: ProbeParams): any[] {
    return core.buildPlan(params).entries.map((e) => ({ ...core.buildSyntheticWiringSnapshot(e) }))
  }
  function patched(params: ProbeParams, i: number, patch: Record<string, unknown>): any[] {
    const s = snapshots(params)
    Object.assign(s[i]!, patch)
    return s
  }

  it('⑧ 合法 ID 基线通过；isValidId 拒绝空 / null / 控制字符', () => {
    const params = baseParams({ groups: 1, warmTurns: 1 })
    expect(core.evaluateWiring(snapshots(params), params).status).toBe('PASS')
    expect(core.isValidId('on-convo-g0')).toBe(true)
    expect(core.isValidId('')).toBe(false)
    expect(core.isValidId('  ')).toBe(false)
    expect(core.isValidId(null)).toBe(false)
    expect(core.isValidId('a\u0000b')).toBe(false)
  })

  it('⑧ 空 ID / undefined ID / ID 复用 / 镜像破坏 → wiring FAIL', () => {
    const params = baseParams({ groups: 2, warmTurns: 1 })
    const s = snapshots(params)
    expect(core.evaluateWiring(patched(params, 0, { conversationId: '' }), params).codes).toContain('WIRING_INVALID_OR_EMPTY_ID')
    expect(core.evaluateWiring(patched(params, 0, { requestId: null }), params).codes).toContain('WIRING_INVALID_OR_EMPTY_ID')
    expect(core.evaluateWiring(s.slice(1), params).codes).toContain('WIRING_SNAPSHOT_COUNT_MISMATCH')

    const allSameMsg = s.map((x) => ({ ...x, messageId: 'same' }))
    expect(core.evaluateWiring(allSameMsg, params).codes).toContain('MESSAGE_ID_REUSED_OR_EMPTY')
    const allSameReq = s.map((x) => ({ ...x, requestId: 'same' }))
    expect(core.evaluateWiring(allSameReq, params).codes).toContain('REQUEST_ID_REUSED_OR_EMPTY')
    const brokenRoot = s.map((x) => ({ ...x, rootId: 'different' }))
    expect(core.evaluateWiring(brokenRoot, params).codes).toContain('ROOT_REQUEST_MIRROR_BROKEN')

    const offIdx = s.findIndex((x) => x.arm === 'OFF')
    const offIdx2 = s.findIndex((x, i) => i > offIdx && x.arm === 'OFF')
    expect(core.evaluateWiring(patched(params, offIdx2, { conversationId: s[offIdx]!.conversationId }), params).codes)
      .toContain('OFF_CONVERSATION_NOT_FRESH')

    const onIdx = s.findIndex((x) => x.arm === 'ON')
    expect(core.evaluateWiring(patched(params, onIdx, { conversationId: 'different' }), params).codes)
      .toContain('ON_CONVERSATION_NOT_STABLE')

    const uidParams = baseParams({ groups: 1, warmTurns: 1, usageIdentity: true })
    const us = snapshots(uidParams)
    const brokenX = us.map((x) => ({ ...x, xRequestId: 'not-mirrored' }))
    expect(core.evaluateWiring(brokenX, uidParams).codes).toContain('X_REQUEST_ID_MIRROR_BROKEN')
    expect(core.evaluateWiring(us, uidParams).status).toBe('PASS')
  })

  it('wiring FAIL → effect=NOT_EVALUATED、exitCode=2、reasons 含 WIRING_FAILED', async () => {
    const params = baseParams({ groups: 1, warmTurns: 1 })
    const res = await runWithOutcomes(params, () => ok(sseUsage(50)), {
      captureWiring: (entry: PlanEntry) => ({ ...core.buildSyntheticWiringSnapshot(entry), messageId: 'reused' }),
    })
    expect(res.wiring.status).toBe('FAIL')
    expect(res.report.wiringStatus).toBe('FAIL')
    expect(res.report.effectStatus).toBe('NOT_EVALUATED')
    expect(res.report.reasons).toContain('WIRING_FAILED')
    expect(res.report.exitCode).toBe(core.EXIT.INVALID_DATA)
  })

  it('classifyEffect 阈值与禁止含糊 RESULT: VALID', () => {
    const mk = (mean: number | null, low: number | null) => ({ meanD: mean, ciLow: low }) as unknown as core.Stats
    expect(core.classifyEffect(mk(0.25, 0.1))).toBe('BENEFIT_SUPPORTED')
    expect(core.classifyEffect(mk(0.1, 0.05))).toBe('MIXED')
    expect(core.classifyEffect(mk(0.1, -0.05))).toBe('NO_CLEAR_BENEFIT')
    expect(core.classifyEffect(mk(null, null))).toBe('NO_CLEAR_BENEFIT')
    expect(core.FORBIDDEN_CLAIMS).toContain('RESULT: VALID')
    expect(core.FORBIDDEN_CLAIMS).toContain('证明按 ID 分区')
    expect(core.containsForbiddenClaim('RESULT: VALID')).toBe('RESULT: VALID')
    expect(core.containsForbiddenClaim(core.MECHANISM_DISCLAIMER)).toBeNull()
  })

  it('三态分离：完整数据 + 无收益 → NO_CLEAR_BENEFIT，且结论不含任一禁语', async () => {
    const params = baseParams({ groups: 2, warmTurns: 2 })
    const res = await runWithOutcomes(params, () => ok(sseUsage(50)))
    expect(res.wiring.status).toBe('PASS')
    expect(res.report.wiringStatus).toBe('PASS')
    expect(res.report.dataStatus).toBe('COMPLETE')
    expect(res.report.effectStatus).toBe('NO_CLEAR_BENEFIT')
    expect(res.report.exitCode).toBe(core.EXIT.COMPLETE)
    expect(res.report.mechanismProven).toBe(false)
    expect(res.report.forbiddenClaimsFound).toEqual([])
    for (const claim of core.FORBIDDEN_CLAIMS) {
      expect(res.report.conclusionText).not.toContain(claim)
    }
  })
})

// ---------------------------------------------------------------------------
// B6 场景①②③
// ---------------------------------------------------------------------------

describe('B6：完整性闸门（场景①②③）', () => {
  it('① 第二轮 ON=99%/OFF=0% 但后续 ON 失败 → 数据不完整、禁止收益成功标签', async () => {
    const params = baseParams({ groups: 2, warmTurns: 2 })
    const res = await runWithOutcomes(params, (entry) => {
      if (entry.stage === 'cold') return ok(sseUsage(50))
      // group 1 的最后一轮 ON 故意失败；此前 ON 全部 99%、OFF 全部 0%。
      if (entry.group === 1 && entry.arm === 'ON' && entry.turn === params.warmTurns) return ok('', 500)
      return ok(sseUsage(entry.arm === 'ON' ? 99 : 0))
    })
    expect(res.calls).toBe(res.plan.totalRequests) // 绝不自动重试填补失败轮
    expect(res.report.dataStatus).toBe('INCOMPLETE')
    expect(res.report.incompleteRecords).toBeGreaterThan(0)
    expect(res.report.reasons).toContain('DATA_INCOMPLETE')
    expect(res.report.effectStatus).toBe('NOT_EVALUATED')
    expect(res.report.exitCode).toBe(core.EXIT.INVALID_DATA)
    expect(res.report.mechanismProven).toBe(false)
    expect(res.report.forbiddenClaimsFound).toEqual([])
    // 若拆掉完整性闸门，仅看统计会误判成「支持」——证明闸门是承重的。
    expect(res.report.stats.meanD).not.toBeNull()
    expect(res.report.stats.meanD as number).toBeGreaterThan(0)
    expect(core.classifyEffect(res.report.stats)).toBe('BENEFIT_SUPPORTED')
  })

  it('② 所有请求失败但头部符合 → wiring 可过、data 不过、effect 不评估', async () => {
    const params = baseParams({ groups: 1, warmTurns: 2 })
    const res = await runWithOutcomes(params, () => throwIt(new TypeError('synthetic network error')))
    expect(res.calls).toBe(res.plan.totalRequests)
    expect(res.wiring.status).toBe('PASS')
    expect(res.report.wiringStatus).toBe('PASS')
    expect(res.report.dataStatus).toBe('INCOMPLETE')
    expect(res.report.effectStatus).toBe('NOT_EVALUATED')
    expect(res.report.exitCode).toBe(core.EXIT.INVALID_DATA)
    expect(res.records.every((r: any) => !r.complete)).toBe(true)
    expect(res.records.every((r: any) => r.failureCode === 'NETWORK_ERROR')).toBe(true)
    expect(res.records.every((r: any) => r.requestStatus === 'NETWORK_ERROR')).toBe(true)
  })

  it('③ 预热失败 warm 成功 → 不得按正常冷→热组分析', async () => {
    const params = baseParams({ groups: 2, warmTurns: 2 })
    const res = await runWithOutcomes(params, (entry) =>
      entry.stage === 'cold'
        ? throwIt(Object.assign(new Error('cold fail'), { name: 'TimeoutError' }))
        : ok(sseUsage(entry.arm === 'ON' ? 99 : 0)))
    const gs = core.computeGroupStats(res.records, params)
    expect(gs).toHaveLength(2)
    for (const g of gs) {
      expect(g.complete).toBe(false)
      expect(g.reason).toBe('COLD_INCOMPLETE')
      expect(g.d).toBeNull()
    }
    expect(res.report.stats.completeGroups).toBe(0)
    expect(res.report.stats.meanD).toBeNull()
    expect(res.report.dataStatus).toBe('INCOMPLETE')
    expect(res.report.effectStatus).toBe('NOT_EVALUATED')
  })
})

// ---------------------------------------------------------------------------
// B6 场景⑨⑩：资源恢复与脱敏
// ---------------------------------------------------------------------------

describe('B6：资源恢复与脱敏（场景⑨⑩）', () => {
  it('⑨ 超时 / 取消 / 流抛错 → 资源恢复且固定脱敏错误', async () => {
    const params = baseParams({ groups: 1, warmTurns: 1 })
    const outcomes: Outcome[] = [
      throwIt(Object.assign(new Error('aborted'), { name: 'AbortError' })),
      throwIt(Object.assign(new Error('timeout'), { name: 'TimeoutError' })),
      textThrows(Object.assign(new Error('stream read failed'), { name: 'Error' })),
      ok(sseUsage(50)),
    ]
    let cleanup = 0
    const fetchBefore = globalThis.fetch
    const exitBefore = process.exitCode
    const res = await runWithOutcomes(params, (_e, i) => outcomes[i % outcomes.length]!, {
      onCleanup: () => { cleanup += 1 },
    })
    expect(res.calls).toBe(res.plan.totalRequests)
    expect(cleanup).toBe(res.plan.totalRequests) // 每个请求 finally 必 cleanup
    expect(globalThis.fetch).toBe(fetchBefore)    // 绝不覆写全局 fetch
    expect(process.exitCode).toBe(exitBefore)     // 仅 import 不跑 main
    expect(res.records[0]!.failureCode).toBe('CANCELLED')
    expect(res.records[1]!.failureCode).toBe('TIMEOUT')
    expect(res.records[2]!.requestStatus).toBe('STREAM_READ_ERROR')
    expect(res.records[2]!.failureCode).toBe('UNKNOWN')
    expect(res.records[3]!.failureCode).toBe('NONE')
    for (const r of res.records) {
      expect(Object.values(core.FAILURE_CODES)).toContain(r.failureCode)
      expect(r.failureCode).not.toMatch(/aborted|timeout|stream read failed/)
    }
    expect(core.toFailureCode(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe('CANCELLED')
    expect(core.toFailureCode(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe('TIMEOUT')
    expect(core.toFailureCode(new TypeError('x'))).toBe('NETWORK_ERROR')
    expect(core.sanitizeFailureCode('not-in-whitelist')).toBe('INTERNAL')
  })

  it('⑩ 错误消息 / 响应 / 凭证解析异常含合成敏感标记 → stdout/stderr/产物均不含该标记', async () => {
    const marker = 'SYNTHETIC_SECRET_MARKER_9F3'
    const params = baseParams({ groups: 1, warmTurns: 1 })
    const res = await runWithOutcomes(params, (_e, i) =>
      i === 0 ? throwIt(Object.assign(new Error(marker), { name: 'Error' })) : ok(`${marker}\n\n`))
    const cli = await loadScript('probe-stable-conversation-id.mjs')
    const jsonl = cli.buildJsonl(res)
    const rendered = res.outputLines.join('\n')
    expect(jsonl).not.toContain(marker)
    expect(rendered).not.toContain(marker)
    expect(res.records.map((r: any) => core.serializeRecord(r)).join('\n')).not.toContain(marker)
    expect(res.records.every((r: any) => !String(r.failureCode).includes(marker))).toBe(true)
    expect(core.toFailureCode(new Error(marker))).toBe('UNKNOWN')
    expect(core.classifyRequestError(new Error(marker))).toBe('UNKNOWN')
    // 序列化守卫：被禁的原始字段直接拒绝，不给「裁切一下就脱敏」留口子。
    expect(() => core.serializeRecord({ ...res.records[0], message: marker }))
      .toThrow(/REFUSE_SERIALIZE_BANNED_FIELD:message/)
    for (const banned of ['body', 'headers', 'sseText', 'responseText', 'rawError', 'credential', 'token']) {
      expect(() => core.serializeRecord({ ...res.records[0], [banned]: marker }))
        .toThrow(new RegExp(`REFUSE_SERIALIZE_BANNED_FIELD:${banned}`))
    }
    // main 的 stdout 只有固定状态行，不含任何原始正文 / 异常 / ID 前缀。
    const writes: string[] = []
    const orig = process.stdout.write
    process.stdout.write = ((chunk: unknown) => { writes.push(String(chunk)); return true }) as unknown as typeof process.stdout.write
    let exit: number
    try {
      exit = await cli.main(['--account', '账号A', '--groups', '1', '--turns', '1'])
    } finally {
      process.stdout.write = orig
    }
    expect(exit).toBe(core.EXIT.NOT_RUN)
    const out = writes.join('')
    expect(out).not.toContain(marker)
    expect(out).toContain('STATUS E_PHASE_NOT_RUN')
    expect(out).toContain('WIRING PASS')
    expect(out).toContain('DATA COMPLETE')
    expect(out).not.toContain('RESULT: VALID')
  })

  it('main --real 在离线阶段不接真实上游，仍返回 NOT_RUN', async () => {
    const cli = await loadScript('probe-stable-conversation-id.mjs')
    const writes: string[] = []
    const orig = process.stdout.write
    process.stdout.write = ((chunk: unknown) => { writes.push(String(chunk)); return true }) as unknown as typeof process.stdout.write
    let code: number
    try {
      code = await cli.main(['--account', '账号A', '--real'])
    } finally {
      process.stdout.write = orig
    }
    expect(code).toBe(core.EXIT.NOT_RUN)
    expect(writes.join('')).toContain('STATUS REAL_MODE_NOT_WIRED_IN_OFFLINE_PHASE')
    expect(writes.join('')).toContain('STATUS E_PHASE_NOT_RUN')
  })
})

// ---------------------------------------------------------------------------
// B6 场景⑪：seed 可重建
// ---------------------------------------------------------------------------

describe('B6：确定性（场景⑪）', () => {
  it('⑪ 同一 seed → 实验计划、发送顺序、前缀分配、运行结果可重建', async () => {
    const params = baseParams({ groups: 3, warmTurns: 3 })
    const a = core.buildPlan(params)
    const b = core.buildPlan(params)
    expect(core.stableStringify(a)).toBe(core.stableStringify(b))
    expect(core.stableStringify(a)).not.toBe(core.stableStringify(core.buildPlan({ ...params, seed: params.seed + 1 })))
    const r1 = core.mulberry32(42)
    const r2 = core.mulberry32(42)
    expect(Array.from({ length: 8 }, () => r1())).toEqual(Array.from({ length: 8 }, () => r2()))
    // runId 只由 seed + 模板版本派生，不由账号别名派生。
    expect(core.syntheticRunId(params)).not.toContain(params.accountAlias)
    expect(core.syntheticRunId(params)).toBe(core.syntheticRunId({ ...params, accountAlias: '账号B' }))

    const res1 = await runWithOutcomes(params, () => ok(sseUsage(50)))
    const res2 = await runWithOutcomes(params, () => ok(sseUsage(50)))
    expect(core.stableStringify(res1.records)).toBe(core.stableStringify(res2.records))
    expect(core.stableStringify(res1.report)).toBe(core.stableStringify(res2.report))
    expect(core.stableStringify(res1.plan)).toBe(core.stableStringify(res2.plan))
  })

  it('buildPlan 保证至少 1 次 cold + warmTurns 次 warm，两臂齐全', () => {
    const params = baseParams({ groups: 4, warmTurns: 3 })
    const plan = core.buildPlan(params)
    expect(plan.totalRequests).toBe(params.groups * 2 * (1 + params.warmTurns))
    for (let g = 0; g < params.groups; g += 1) {
      const inG = plan.entries.filter((e) => e.group === g)
      expect(inG.filter((e) => e.stage === 'cold')).toHaveLength(2)
      expect(inG.filter((e) => e.arm === 'ON' && e.stage === 'warm')).toHaveLength(params.warmTurns)
      expect(inG.filter((e) => e.arm === 'OFF' && e.stage === 'warm')).toHaveLength(params.warmTurns)
    }
  })
})

// ---------------------------------------------------------------------------
// B6 场景⑬：周期后端混淆 + 禁止过强表述
// ---------------------------------------------------------------------------

describe('B6：机制克制（场景⑬）', () => {
  /**
   * 旧判据的混淆模型：A/B/B/C 这类周期后端，每个后端各有一份本地缓存；
   * 路由只看请求序号，完全不看会话 ID。OFF 臂每轮换新前缀，ON 臂复用稳定前缀。
   */
  function simulateCyclic(order: string[]): { firstWarmOn: number; d: number } {
    const caches = new Map<string, Set<string>>()
    let seq = 0
    const send = (prefix: string): number => {
      const backend = order[seq % order.length]!
      seq += 1
      const set = caches.get(backend) ?? new Set<string>()
      caches.set(backend, set)
      const hit = set.has(prefix) ? 1 : 0
      set.add(prefix)
      return hit
    }
    const cold = 'fixed-cold-prefix'
    send(`${cold}:off-cold`)
    send(`${cold}:on-cold`)
    let offHits = 0
    let onHits = 0
    let firstWarmOn = -1
    const T = 8
    for (let t = 1; t <= T; t += 1) {
      offHits += send(`${cold}:off-warm-${t}`)
      const onHit = send(`${cold}:on-warm-stable`)
      if (t === 1) firstWarmOn = onHit
      onHits += onHit
    }
    return { firstWarmOn, d: (onHits - offHits) / T }
  }

  it('⑬ 周期后端 + 每后端本地缓存可误导旧判据，结论不得宣称证明按 ID 分区', async () => {
    const orders = [
      ['A', 'B', 'B', 'C'],
      ['A', 'B', 'C'],
      ['A', 'A', 'B', 'C'],
      ['B', 'C', 'A', 'B'],
      ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
    ]
    const runs = orders.map(simulateCyclic)
    // 旧判据「ON 稳定 ID 从首个 warm 起确定性命中」在周期路由下被反例推翻。
    expect(runs.every((r) => r.firstWarmOn === 0)).toBe(true)
    // 同一稳定 ID 实验在不同路由周期下给出明显不同的朴素收益 ⇒ 固定控制组无法排除路由混淆。
    const distinct = new Set(runs.map((r) => r.d.toFixed(3)))
    expect(distinct.size).toBeGreaterThan(1)
    expect(Math.max(...runs.map((r) => r.d)) - Math.min(...runs.map((r) => r.d))).toBeGreaterThan(0.1)

    // 无论数据多好看，我们的报告从不宣称证明内部按 ID 分区机制。
    const params = baseParams({ groups: 2, warmTurns: 2 })
    const res = await runWithOutcomes(params, (e) => ok(sseUsage(e.arm === 'ON' ? 99 : 0)))
    expect(res.report.dataStatus).toBe('COMPLETE')
    expect(res.report.mechanismProven).toBe(false)
    expect(res.report.forbiddenClaimsFound).toEqual([])
    expect(res.report.conclusionText).toContain(core.MECHANISM_DISCLAIMER)
    expect(core.containsForbiddenClaim(res.report.conclusionText)).toBeNull()
    for (const claim of core.FORBIDDEN_CLAIMS) {
      expect(res.report.conclusionText).not.toContain(claim)
    }
  })
})

// ---------------------------------------------------------------------------
// §7：纯离线复算
// ---------------------------------------------------------------------------

describe('§7：纯离线复算', () => {
  it('现场 JSONL → 复算与现场 report 逐字节一致，且只读记录、不依赖网络', async () => {
    const cli = await loadScript('probe-stable-conversation-id.mjs')
    const rc = await loadScript('recompute-probe.mjs')
    const params = baseParams({ groups: 2, warmTurns: 2 })
    const res = await runWithOutcomes(params, () => ok(sseUsage(50)))
    const jsonl = cli.buildJsonl(res)
    const fetchBefore = globalThis.fetch
    const out = rc.recomputeFromJsonl(jsonl)
    expect(globalThis.fetch).toBe(fetchBefore)
    expect(out.match).toBe(true)
    expect(out.dataStatus).toBe(res.report.dataStatus)
    expect(out.report.effectStatus).toBe(res.report.effectStatus)
    expect(out.report.exitCode).toBe(res.report.exitCode)
    expect(core.stableStringify(out.report)).toBe(core.stableStringify(res.report))
    expect(out.completeness.totalRecords).toBe(res.plan.totalRequests)
    expect(out.completeness.plannedRequests).toBe(res.plan.totalRequests)
    expect(out.completeness.incompleteRecords).toBe(0)
    expect(out.completeness.completeGroups).toBe(params.groups)
  })

  it('无末行现场 report 时 match=null，但仍能独立重建完整报告', async () => {
    const cli = await loadScript('probe-stable-conversation-id.mjs')
    const rc = await loadScript('recompute-probe.mjs')
    const params = baseParams({ groups: 1, warmTurns: 2 })
    const res = await runWithOutcomes(params, () => ok(sseUsage(50)))
    const lines = cli.buildJsonl(res).trim().split('\n')
    const withoutReport = `${lines.slice(0, -1).join('\n')}\n`
    const out = rc.recomputeFromJsonl(withoutReport)
    expect(out.match).toBeNull()
    expect(out.report.exitCode).toBe(core.EXIT.COMPLETE)
    expect(out.report.dataStatus).toBe('COMPLETE')
    expect(out.storedReport).toBeNull()
  })

  it('损坏 JSONL → 固定错误码，绝不回显原文 / 路径 / 异常', async () => {
    const cli = await loadScript('probe-stable-conversation-id.mjs')
    const rc = await loadScript('recompute-probe.mjs')
    const params = baseParams({ groups: 1, warmTurns: 1 })
    const res = await runWithOutcomes(params, () => ok(sseUsage(50)))
    const lines = cli.buildJsonl(res).trim().split('\n')
    const meta = JSON.parse(lines[0]!)
    const j = (v: unknown) => `${JSON.stringify(v)}\n`
    expect(() => rc.recomputeFromJsonl('')).toThrow(/EMPTY_JSONL/)
    expect(() => rc.recomputeFromJsonl('not json at all')).toThrow(/MALFORMED_JSONL_LINE/)
    expect(() => rc.recomputeFromJsonl(j({ kind: 'record' }))).toThrow(/MISSING_META/)
    expect(() => rc.recomputeFromJsonl(j({ ...meta, schemaVersion: '0.0.0' }))).toThrow(/SCHEMA_MISMATCH/)
    expect(() => rc.recomputeFromJsonl(j({ kind: 'meta', schemaVersion: core.SCHEMA_VERSION }))).toThrow(/META_INCOMPLETE/)
    expect(() => rc.recomputeFromJsonl(`${lines[0]}\n${j({ kind: 'wat' })}`)).toThrow(/UNKNOWN_JSONL_RECORD_KIND/)
  })

  it('selfTest：合成样例复算自洽（SELF_TEST_MATCH PASS，E_PHASE_NOT_RUN）', async () => {
    const rc = await loadScript('recompute-probe.mjs')
    const st = rc.selfTest()
    expect(st.ok).toBe(true)
    expect(st.res.match).toBe(true)
    expect(st.lines).toContain('SELF_TEST_MATCH PASS')
    expect(st.lines).toContain('E_PHASE_NOT_RUN')
    expect(st.res.report.realExperiment).toBe('NOT_RUN')
  })
})

// ---------------------------------------------------------------------------
// 序列化守卫（B5 / §7 schema）
// ---------------------------------------------------------------------------

describe('B5：记录序列化白名单', () => {
  it('serializeRecord 产出稳定 JSON，且不含任何被禁的原始字段', async () => {
    const params = baseParams({ groups: 1, warmTurns: 1 })
    const res = await runWithOutcomes(params, () => ok(sseUsage(50)))
    const line = core.serializeRecord(res.records[0]!)
    expect(JSON.parse(line).kind).toBe('record')
    expect(line).not.toMatch(/"(message|body|headers|sseText|responseText|rawError|credential|token)":/)
    expect(core.stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(core.stableStringify([3, { b: 1, a: 2 }])).toBe('[3,{"a":2,"b":1}]')
  })

  it('JSONL schema 含 runId / 脚本与构建哈希 / 模板版本 / seed / 计划 / 逐轮状态', async () => {
    const cli = await loadScript('probe-stable-conversation-id.mjs')
    const params = baseParams({ groups: 1, warmTurns: 1 })
    const res = await runWithOutcomes(params, () => ok(sseUsage(50)))
    const lines = cli.buildJsonl(res).trim().split('\n')
    const meta = JSON.parse(lines[0]!)
    expect(meta.schemaVersion).toBe(core.SCHEMA_VERSION)
    expect(meta.runId).toBe(core.syntheticRunId(params))
    expect(typeof meta.scriptHash).toBe('string')
    expect(typeof meta.buildHash).toBe('string')
    expect(meta.templateVersion).toBe(core.TEMPLATE_VERSION)
    expect(meta.seed).toBe(params.seed)
    expect(meta.plan.totalRequests).toBe(res.plan.totalRequests)
    expect(meta.wiring.status).toBe('PASS')
    const rec = JSON.parse(lines[1]!)
    for (const key of ['group', 'arm', 'stage', 'turn', 'order', 'sentAt', 'completedAt', 'durationMs',
      'httpStatus', 'requestStatus', 'streamStatus', 'usageStatus', 'failureCode',
      'hit', 'miss', 'prompt', 'completion', 'usageSource', 'denominator', 'complete']) {
      expect(key in rec).toBe(true)
    }
    // wiring 只记运行内别名，不记任何真实 ID。
    expect(rec.wiring.aliasConversationId).toMatch(/^alias-/)
    expect(JSON.stringify(rec)).not.toMatch(/X-(Session|Machine|Device)-ID/)
  })
})

/**
 * 阶段 E 真实 usage 适配器单元测试（「会咬」）。
 *
 * 背景见 docs/E-PHASE-FROZEN-PLAN.md §11：真实 hy4free / CN 终态 usage 带一个
 * 恒为 0 的惰性顶层 `cached_tokens`，与规范 hit/miss 计数对及
 * `prompt_tokens_details.cached_tokens` 同时出现，使离线防御式 `normalizeUsage`
 * 误报 HIT_SOURCE_CONFLICT / RATE_CONFLICT，把所有 ON warm 轮判为 invalid。
 *
 * 本测试固定以下契约，任何一项被改坏都会红（AGENTS.md「测试要能咬」）：
 *   - 适配后真实 warm 形状 ⇒ valid / HIT_MISS / rate≈0.986；
 *   - 不适配（裸喂）⇒ 复现 smoke 里的冲突（证明问题真实存在、适配确有必要）；
 *   - 护栏仍生效：`prompt≠hit+miss` ⇒ PARTITION_CONFLICT 仍 invalid；
 *     `details.cached_tokens≠hit` ⇒ HIT_SOURCE_CONFLICT 仍 invalid；
 *   - 适配器只删顶层 `cached_tokens`，绝不删 `prompt_tokens` /
 *     `prompt_tokens_details`（删了护栏断言会红）；
 *   - 对 OFF/ON、cold/warm 完全一致（不看 hit/miss 取值）；
 *   - 不改原对象；非对象 / 缺规范对 / 无冗余字段 ⇒ 原样返回。
 *
 * 隐私：全部为合成计数器，无账号 / token / 真实 ID / 路径，零网络零凭证。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import * as core from '../scripts/probe-core.ts'
import { adaptTerminalUsage } from '../scripts/probe-usage-adapter.ts'

/** 复刻真实 smoke 的 warm usage（计数器，合成值但同真实 schema）。 */
function realWarm() {
  return {
    prompt_tokens: 8048,
    completion_tokens: 16,
    prompt_cache_hit_tokens: 7936,
    prompt_cache_miss_tokens: 112,
    prompt_tokens_details: { cached_tokens: 7936 },
    cached_tokens: 0,
  }
}

/** 复刻真实 smoke 的 cold usage（hit=0）。 */
function realCold() {
  return {
    prompt_tokens: 8048,
    completion_tokens: 16,
    prompt_cache_hit_tokens: 0,
    prompt_cache_miss_tokens: 8048,
    prompt_tokens_details: { cached_tokens: 0 },
    cached_tokens: 0,
  }
}

describe('adaptTerminalUsage + normalizeUsage（E 阶段真实 schema）', () => {
  it('适配后真实 warm 形状 → valid HIT_MISS，rate≈7936/8048', () => {
    const n = core.normalizeUsage(adaptTerminalUsage(realWarm()))
    expect(n.valid).toBe(true)
    expect(n.usageSource).toBe('HIT_MISS')
    expect(n.conflicts).toEqual([])
    expect(n.invalidCodes).toEqual([])
    expect(n.hit).toBe(7936)
    expect(n.miss).toBe(112)
    expect(n.denominator).toBe(8048)
    expect(n.rate).toBeCloseTo(7936 / 8048, 10)
  })

  it('适配后 cold 形状 → valid HIT_MISS，rate=0', () => {
    const n = core.normalizeUsage(adaptTerminalUsage(realCold()))
    expect(n.valid).toBe(true)
    expect(n.usageSource).toBe('HIT_MISS')
    expect(n.rate).toBe(0)
  })

  it('裸喂（不适配）复现 smoke 冲突：HIT_SOURCE_CONFLICT + RATE_CONFLICT', () => {
    const n = core.normalizeUsage(realWarm())
    expect(n.valid).toBe(false)
    expect(n.conflicts).toContain('HIT_SOURCE_CONFLICT')
    expect(n.conflicts).toContain('RATE_CONFLICT')
    expect(n.rate).toBeNull()
  })

  it('护栏保留①：prompt≠hit+miss 仍触发 PARTITION_CONFLICT invalid', () => {
    const bad = { ...realWarm(), prompt_tokens: 9999 }
    const n = core.normalizeUsage(adaptTerminalUsage(bad))
    expect(n.valid).toBe(false)
    expect(n.conflicts).toContain('PARTITION_CONFLICT')
    expect(n.rate).toBeNull()
  })

  it('护栏保留②：details.cached_tokens≠hit 仍触发 HIT_SOURCE_CONFLICT invalid', () => {
    const bad = { ...realWarm(), prompt_tokens_details: { cached_tokens: 1234 } }
    const n = core.normalizeUsage(adaptTerminalUsage(bad))
    expect(n.valid).toBe(false)
    expect(n.conflicts).toContain('HIT_SOURCE_CONFLICT')
    expect(n.rate).toBeNull()
  })

  it('只删顶层 cached_tokens；prompt_tokens / prompt_tokens_details 必须保留', () => {
    const original = realWarm()
    const adapted = adaptTerminalUsage(original) as Record<string, unknown>
    expect('cached_tokens' in adapted).toBe(false)
    expect(adapted['prompt_tokens']).toBe(8048)
    expect(adapted['prompt_tokens_details']).toEqual({ cached_tokens: 7936 })
    expect(adapted['prompt_cache_hit_tokens']).toBe(7936)
    expect(adapted['prompt_cache_miss_tokens']).toBe(112)
    // 原对象未被改动（返回副本）。
    expect('cached_tokens' in original).toBe(true)
    expect(original.cached_tokens).toBe(0)
  })

  it('对 OFF/ON、cold/warm 完全一致：只看规范计数对是否为 number', () => {
    for (const shape of [realWarm(), realCold()]) {
      const adapted = adaptTerminalUsage(shape) as Record<string, unknown>
      expect('cached_tokens' in adapted).toBe(false)
      expect('prompt_tokens' in adapted).toBe(true)
      expect('prompt_tokens_details' in adapted).toBe(true)
    }
  })

  it('缺规范计数对 / 无冗余字段 / 非对象 ⇒ 原样返回（不适配）', () => {
    const noPair = { cached_tokens: 0, prompt_tokens: 100, completion_tokens: 1 }
    expect(adaptTerminalUsage(noPair)).toBe(noPair)
    const noTop = { ...realWarm() }
    delete (noTop as Record<string, unknown>)['cached_tokens']
    expect(adaptTerminalUsage(noTop)).toBe(noTop)
    for (const v of [null, undefined, 42, 'x', [1, 2]]) {
      expect(adaptTerminalUsage(v)).toBe(v)
    }
  })

  it('SSE 端到端：合成流含冗余 schema 时 analyzeStream→适配→normalizeUsage 仍 COMPLETE', () => {
    const sse = core.makeUsageSse(realWarm(), { keepalive: true, crlf: true })
    const a = core.analyzeStream(sse)
    expect(a.streamStatus).toBe('COMPLETE')
    expect(a.hasDone).toBe(true)
    const n = core.normalizeUsage(adaptTerminalUsage(a.terminal))
    expect(n.valid).toBe(true)
    expect(n.usageSource).toBe('HIT_MISS')
  })
})

describe('冻结纪律：A–D 的 probe-core.ts 未因 E 适配而改动', () => {
  it('probe-core.ts 仍保留 cached = cachedTop ?? cachedDetails 与全部冲突护栏', () => {
    const src = readFileSync(new URL('../scripts/probe-core.ts', import.meta.url), 'utf8')
    expect(src).toContain('const cached = cachedTop ?? cachedDetails')
    expect(src).toContain("r.conflicts.push('HIT_SOURCE_CONFLICT')")
    expect(src).toContain("r.conflicts.push('RATE_CONFLICT')")
    expect(src).toContain("r.conflicts.push('PARTITION_CONFLICT')")
    expect(src).toContain('if (r.conflicts.length > 0 || r.invalidCodes.length > 0) r.rate = null')
  })
})

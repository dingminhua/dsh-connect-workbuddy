import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * PR review #262 的守护测试：真实驱动的三条安全契约从「注释里的承诺」变成「CI 咬得住的断言」。
 *
 * 为什么这些测试不 import ../lib/、不碰网络、不花额度：
 *
 * - 门控契约（缺 flag ⇒ NOT_RUN / EXIT 3 / 零凭证零写）必须在一个**没有构建产物
 *   也能跑**的环境里钉住——那正是中-2 修的洞：旧版顶层静态 import 让 CI 永远走
 *   不到门控代码，契约改坏了没有任何东西会红。main() 因此导出并参数化了 argv。
 * - 凭证选择契约（中-1：多账号不 --account-id 即拒绝，绝不默默取 files[0]）用
 *   注入的假 vault（DSH_HOME 指到临时目录）测 loadCredential 本体，零真凭证。
 * - 网络授权下沉（低-6：runExperiment 自己从 args 推导，不接受调用方送 true）
 *   用注入的 fake lib 测：opts.network:true 而无 flag ⇒ NETWORK_GATE_VIOLATION，
 *   且 fake client 一次都没被构造。
 *
 * 全文件零 skip、零环境变量假设（除每文件独立 DSH_HOME 的仓库惯例）；任何机器
 * （含未构建的 CI）都应通过。
 */

async function loadReal(): Promise<any> {
  const url = new URL('../scripts/probe-stable-conversation-id-real.mjs', import.meta.url).href
  return await import(/* @vite-ignore */ url)
}

/** 捕获 stdout 行，返回 { lines, code }。main 用 process.exitCode 而非 exit。 */
async function captureMain(real: any, argv: string[]): Promise<{ lines: string[], code: number }> {
  const writes: string[] = []
  const orig = process.stdout.write
  process.stdout.write = ((chunk: unknown) => { writes.push(String(chunk)); return true }) as unknown as typeof process.stdout.write
  const prevExitCode = process.exitCode
  process.exitCode = undefined
  try {
    const code = await real.main(argv)
    return { lines: writes.join('').split('\n'), code: code as number }
  } finally {
    process.stdout.write = orig
    process.exitCode = prevExitCode
  }
}

describe('真实驱动门控（PR review #262 中-2 / 低-6 / 低-7）', () => {
  it('缺 flag：NOT_RUN / EXIT 3 / E_PHASE_NOT_RUN，不需要 lib/，零写', async () => {
    const real = await loadReal()
    const out = join(tmpdir(), `gate-should-not-exist-${Date.now()}.jsonl`)
    const r = await captureMain(real, ['--out', out])
    expect(r.code).toBe(3)
    expect(r.lines).toContain('STATUS NOT_RUN')
    expect(r.lines).toContain('E_PHASE_NOT_RUN')
    // 契约的另一半：这个入口在 CI（永远没有 lib/、永远没授权）上能跑到这里，
    // 本身就是「静态 import 先于门控」不再存在的证明——旧版在模块链接阶段就
    // ERR_MODULE_NOT_FOUND，根本执行不到这些断言。
    const { existsSync } = await import('node:fs')
    expect(existsSync(out)).toBe(false)
  })

  it('只有 --real、缺 --e-phase-authorized：同样 NOT_RUN', async () => {
    const real = await loadReal()
    const r = await captureMain(real, ['--real', '--out', '/tmp/never-written.jsonl'])
    expect(r.code).toBe(3)
    expect(r.lines).toContain('STATUS NOT_RUN')
  })

  it('只有 --e-phase-authorized、缺 --real：同样 NOT_RUN', async () => {
    const real = await loadReal()
    const r = await captureMain(real, ['--e-phase-authorized', '--out', '/tmp/never-written.jsonl'])
    expect(r.code).toBe(3)
    expect(r.lines).toContain('STATUS NOT_RUN')
  })

  it('双 flag 缺 --out：OUT_REQUIRED，且不触网（合成 vs 真实由 args 推导）', async () => {
    const real = await loadReal()
    const r = await captureMain(real, ['--real', '--e-phase-authorized'])
    expect(r.lines).toContain('STATUS OUT_REQUIRED')
    expect(r.code).toBe(1)
  })

  it('runExperiment：opts.network=true 而 args 无双 flag ⇒ NETWORK_GATE_VIOLATION（授权不接受调用方送）', async () => {
    const real = await loadReal()
    let clientCtorCalls = 0
    const fakeLib = {
      WorkBuddyUpstreamClient: function FakeClient() { clientCtorCalls += 1 },
      prepareChatBody: (s: string) => s,
      deriveStableConversationId: () => undefined,
      parseWorkBuddyAuth: () => undefined,
    }
    await expect(real.runExperiment({
      args: { groups: 1, warmTurns: 0, repeats: 1, maxTokens: 1, accountAlias: '账号A', model: 'hy4free', endpointAlias: 'cn-chat-v2', seed: 7, usageIdentity: false, wireProfile: 'balanced', timeoutMs: 1000, out: '', real: false, ePhaseAuthorized: false, synthetic: false },
      network: true, // 旧旁路：调用方直接送 true
      lib: fakeLib,
    })).rejects.toThrow('NETWORK_GATE_VIOLATION')
    // 断言在构造 client 之前：想开网的旁路一个连接都没摸到。
    expect(clientCtorCalls).toBe(0)
  })

  it('runExperiment：args 带双 flag 即授权（与 CLI 推导同一判据），注入 lib 全程零真网络', async () => {
    const real = await loadReal()
    const home = mkdtempSync(join(tmpdir(), 'probe-gate-home-'))
    const vault = join(home, 'workbuddy-vault', 'cn')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(vault, { recursive: true })
    const acct = '111111111111111111111111'
    writeFileSync(join(vault, `${acct}.json`), JSON.stringify({ access_token: 'fake', refresh_token: 'fake', expires_at_ms: Date.now() + 60_000, domain: 'example.invalid', uid: '100000000001' }))
    const prevHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    let sentCount = 0
    const fakeLib = {
      prepareChatBody: (s: string) => s,
      deriveStableConversationId: () => 'on-stable-g0',
      parseWorkBuddyAuth: () => ({ accessToken: 'fake', refreshToken: 'fake', expiresAtMs: Date.now() + 60_000, uid: '100000000001', domain: 'example.invalid' }),
      WorkBuddyUpstreamClient: class FakeClient {
        opts: { stableConversationId?: boolean }
        constructor(_u: unknown, opts: { stableConversationId?: boolean }) { this.opts = opts }
        async chatStream(_c: unknown, body: string, _s: unknown) {
          sentCount += 1
          const headers = new Headers({
            'X-Conversation-ID': this.opts.stableConversationId === true ? 'on-stable-g0' : `off-${sentCount}`,
            'X-Conversation-Request-ID': `req-${sentCount}`,
            'X-Conversation-Message-ID': `msg-${sentCount}`,
            'X-Root-Request-ID': `req-${sentCount}`,
          })
          // 与 makeSyntheticFetch 同形的终态 usage（合成计数器，非真值数据）。
          const sse = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_cache_hit_tokens":50,"prompt_cache_miss_tokens":50,"completion_tokens":1,"prompt_tokens":100,"prompt_tokens_details":{"cached_tokens":50},"cached_tokens":0}}\n\ndata: [DONE]\n\n'
          return { ok: true, response: { status: 200, text: async () => sse, headers } }
        }
      },
    }
    try {
      const result = await real.runExperiment({
        args: { groups: 1, warmTurns: 1, repeats: 1, maxTokens: 8, accountAlias: '账号A', model: 'hy4free', endpointAlias: 'cn-chat-v2', seed: 7, usageIdentity: false, wireProfile: 'balanced', timeoutMs: 5000, out: '', accountId: acct, real: true, ePhaseAuthorized: true, synthetic: false },
        network: true,
        lib: fakeLib,
      })
      // 授权来自 args：双 flag 齐 ⇒ 放行（声明与推导一致），fake lib 全程接管，
      // 零真网络；buildHash 记 TEST_INJECTED，不可能混进真实证据。
      expect(result.meta.buildHash).toBe('TEST_INJECTED')
      expect(result.meta.e.accountResolution).toBe('explicit')
      expect(sentCount).toBeGreaterThan(0)
      expect(result.meta.params.experimentKind).toBe('REAL')
    } finally {
      if (prevHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prevHome
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('凭证选择（PR review #262 中-1）', () => {
  // loadCredential 直接导出：测选择规则本体，不依赖 lib/、不读任何真 vault。
  const fakeParse = (text: string) => {
    const j = JSON.parse(text)
    return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresAtMs: j.expires_at_ms, uid: j.uid, domain: j.domain }
  }

  function withVault(files: Record<string, unknown>, fn: () => void): void {
    const home = mkdtempSync(join(tmpdir(), 'probe-vault-home-'))
    const vault = join(home, 'workbuddy-vault', 'cn')
    mkdirSync(vault, { recursive: true })
    for (const [name, body] of Object.entries(files)) writeFileSync(join(vault, name), JSON.stringify(body))
    const prev = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try { fn() } finally {
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
      rmSync(home, { recursive: true, force: true })
    }
  }

  const acct = (n: string) => ({ access_token: `t${n}`, refresh_token: `r${n}`, expires_at_ms: Date.now() + 60_000, uid: '100000000001', domain: 'example.invalid' })

  it('多账号且未指定 --account-id：AMBIGUOUS，绝不默默取目录第一个文件', async () => {
    const real = await loadReal()
    const a = 'aaaaaaaaaaaaaaaaaaaaaaaa', b = 'bbbbbbbbbbbbbbbbbbbbbbbb'
    withVault({ [`${a}.json`]: acct('a'), [`${b}.json`]: acct('b') }, () => {
      // 旧行为会把 `a`（排序第一）静默用掉、证据标 `--account` 的别名。新契约：拒绝。
      expect(() => real.loadCredential('', fakeParse)).toThrow('CREDENTIAL_AMBIGUOUS')
      expect(() => real.loadCredential(undefined, fakeParse)).toThrow('CREDENTIAL_AMBIGUOUS')
    })
  })

  it('恰一个账号：使用它，resolution=sole', async () => {
    const real = await loadReal()
    const a = 'aaaaaaaaaaaaaaaaaaaaaaaa'
    withVault({ [`${a}.json`]: acct('a') }, () => {
      const r = real.loadCredential('', fakeParse)
      expect(r.resolution).toBe('sole')
      expect(r.credential.accessToken).toBe('ta')
    })
  })

  it('--account-id 精确命中：resolution=explicit，即便目录里还有别的账号', async () => {
    const real = await loadReal()
    const a = 'aaaaaaaaaaaaaaaaaaaaaaaa', b = 'bbbbbbbbbbbbbbbbbbbbbbbb'
    withVault({ [`${a}.json`]: acct('a'), [`${b}.json`]: acct('b') }, () => {
      const r = real.loadCredential(b, fakeParse)
      expect(r.resolution).toBe('explicit')
      expect(r.credential.accessToken).toBe('tb') // 不是排序第一个的 ta
    })
  })

  it('--account-id 不存在：CREDENTIAL_NOT_FOUND，不降级取别的账号', async () => {
    const real = await loadReal()
    const a = 'aaaaaaaaaaaaaaaaaaaaaaaa'
    withVault({ [`${a}.json`]: acct('a') }, () => {
      expect(() => real.loadCredential('cccccccccccccccccccccccc', fakeParse)).toThrow('CREDENTIAL_NOT_FOUND')
    })
  })

  it('非规范 --account-id（路径穿越 / 大写 / 短串）：ACCOUNT_ID_INVALID，先于任何 fs 枚举', async () => {
    const real = await loadReal()
    // '' 不在此列：它是 CLI 未指定 --account-id 的默认值，语义是「未指定」
    // （走 sole/AMBIGUOUS/NOT_FOUND 分支，由 vault 状态决定，见上面的用例）。
    for (const bad of ['../evil', 'AAAAAAAAAAAAAAAAAAAAAAAA', 'short', 'a b']) {
      expect(() => real.loadCredential(bad as string, fakeParse), bad).toThrow('ACCOUNT_ID_INVALID')
    }
  })
})

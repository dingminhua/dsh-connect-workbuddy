import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Guard the declared DSH host line: the lower bound, the upper bound, and —
 * the part that actually failed — the fact that the upper bound BITES.
 *
 * ## Why this exists
 *
 * 0.1.7 线期间，8~10 条 `dsh-*` peer 写的是 `>=0.1.7-rc.1 <0.2.0`。这个上界在当时
 * 是对的，但它有一个**只在下一个版本线落地那一刻才显形**的缺陷：
 *
 *   - `0.2.0-rc.1 < 0.2.0` 成立 → 整条 0.2.0 预发布线被放行（所以 0.2.0-rc.1 上一切正常）
 *   - `0.2.0 < 0.2.0` 不成立     → 正式版一发布，10 条 peer 全部失败
 *
 * DSH 的 shipped 门禁（`packages/boot/app-boot/src/plugin-compatibility.ts`，
 * `evaluatePluginCompatibility`）对这 10 条逐条判定：**只要有一条不满足，整个组合包
 * 就被 `loadProfileDirectory` 跳过**，只写进 `skippedBundles` 并由
 * `reportSkippedBundles` 打到 stderr。它不是崩溃，是**静默消失**——provider 不注册、
 * 卡片不出现、模型列表清空，页面上没有任何提示。
 *
 * 本次复核已经在本机实测到这条路径**正在生效**：0.2.0-rc.1 宿主上，`dsh-rewind-plugin`
 * (`^0.1.7-rc.2`)、`dsh-free-search` (`^0.1.7-rc.1`)、`dsh-better-reasoning-effort`、
 * `@changfenhuang/dsh-genui` 四个组合包都因此**没有出现在实时组合里**
 * （`listConfigs` 共 203 条，其中无一条来自它们；同 profile 内 peer 全通过的包全部在场）。
 *
 * ## 为什么是 `<0.3.0-0` 而不是 `<0.3.0`
 *
 * DSH 至今 **23 个 tag 全部是预发布**（`-alpha.N` / `-rc.N`），从未发过 GA。所以：
 *
 *   - `<0.3.0`   只挡 `0.3.0` GA —— 而 GA 永远不来 —— 上界**永不生效**，
 *                同时静默放行 `0.3.0-alpha.1` / `0.3.0-rc.1` 整条从未验证过的线。
 *                这正是今天这个缺陷的形状：**看起来是围栏，实际不挡任何东西。**
 *   - `<0.3.0-0` 显式挡掉 `0.3.0-0`（含）以上的一切预发布与 GA，围栏真的会响。
 *
 * `-0` 是 semver 里"该版本线的最小可能预发布"，因此 `<0.3.0-0` 的意思是
 * 「0.3.0 线一个都不放」。这与同作者同架构的 `dsh-connect-trae` 2.3.0 的处置一致
 * （其 `docs/DSH_0.2.0_RC1_IMPACT_CHECK.md` §4 记录了同一处判断）。
 *
 * ## 这些用例为什么读文件而不是导入
 *
 * 1. 要断言的是**发布出去的清单**，`package.json` 才是权威副本（`inject` 那套同理）。
 * 2. `peerDependencies` 是给 shipped 门禁读的**数据**，不是给本仓库 import 的代码。
 * 3. 本仓库没有 `semver` 依赖，而引入它只为跑一条断言不划算；下面用一个
 *    小而完整的 semver 序比较直接判定边界，不依赖任何第三方解析器。
 *
 * 变异验证：把任一条改回 `<0.2.0` → 上界用例变红；把 `<0.3.0-0` 改成 `<0.3.0` →
 * 「上界必须真的挡住下一线预发布」那条变红；把下界抬到 `>=0.2.0-rc.1` → 下界用例变红。
 */

const repoRoot = new URL('../', import.meta.url)

/** Parsed `package.json` of the published package. */
function manifest(): {
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
} {
  return JSON.parse(readFileSync(fileURLToPath(new URL('package.json', repoRoot)), 'utf8'))
}

/**
 * 每条 `dsh-*` peer 的期望上界。
 *
 * 写成常量而不是就地拼字符串，是为了让「上界该是多少」这件事只有一个出处：
 * 改这里就等于改口径，而下面的用例会同时盯住声明与实际边界行为。
 */
const UPPER_BOUND = '<0.3.0-0'
const LOWER_BOUND = '>=0.1.7-rc.1'

/**
 * semver 序比较：按 主.次.补 数值比较，预发布段按 semver 规则低于同号正式版。
 *
 * 只覆盖本套件用到的形态（`x.y.z` 与 `x.y.z-pre.N`），够用且无依赖。
 * 返回 -1 / 0 / 1；无法解析时抛错，避免把格式错误静默当成相等。
 */
function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const parse = (value: string): { nums: number[], pre: (string | number)[] } => {
    const [core, ...rest] = value.split('-')
    const pre = rest.join('-')
    const nums = (core ?? '').split('.').map(part => {
      const n = Number(part)
      if (!Number.isInteger(n) || n < 0) throw new Error(`not a version core: ${JSON.stringify(value)}`)
      return n
    })
    if (nums.length !== 3) throw new Error(`not a full x.y.z version: ${JSON.stringify(value)}`)
    return {
      nums,
      pre: pre === '' ? [] : pre.split('.').map(id => (/^\d+$/.test(id) ? Number(id) : id)),
    }
  }
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < 3; i += 1) {
    const l = left.nums[i] ?? 0
    const r = right.nums[i] ?? 0
    if (l !== r) return l < r ? -1 : 1
  }
  // 有预发布段的低于无预发布段的（1.0.0-rc.1 < 1.0.0）。
  if (left.pre.length === 0 && right.pre.length === 0) return 0
  if (left.pre.length === 0) return 1
  if (right.pre.length === 0) return -1
  const len = Math.max(left.pre.length, right.pre.length)
  for (let i = 0; i < len; i += 1) {
    const l = left.pre[i]
    const r = right.pre[i]
    if (l === undefined) return -1
    if (r === undefined) return 1
    if (l === r) continue
    const lNum = typeof l === 'number'
    const rNum = typeof r === 'number'
    if (lNum && rNum) return l < r ? -1 : 1
    if (lNum) return -1 // 数字标识符低于字母标识符
    if (rNum) return 1
    return l < r ? -1 : 1
  }
  return 0
}

/** 每个声明了 `dsh-*` peer 的包名与其范围。 */
function dshPeers(section: 'peerDependencies' | 'devDependencies'): Array<[string, string]> {
  const deps = manifest()[section] ?? {}
  return Object.entries(deps).filter(
    ([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'),
  )
}

/**
 * 判定一个版本是否落在 `>= 下界 < 上界` 形态的范围里。
 *
 * 存在的理由：下面「上界真的挡得住」那几条**必须对声明本身求值**，而不是对
 * 测试里另写一遍的字面量求值。否则声明与断言各自漂移也照样全绿——那正是本
 * 套件要防的那类「看起来是围栏、实际不挡」的缺陷，只不过换了一层。
 *
 * 只接受本插件实际使用的形态；遇到别的形态就抛错，绝不静默放过。
 */
function satisfiesRange(version: string, range: string): boolean {
  const parts = range.trim().split(/\s+/)
  if (parts.length !== 2) throw new Error(`unsupported range shape: ${JSON.stringify(range)}`)
  const [lower, upper] = parts as [string, string]
  if (!lower.startsWith('>=') || !upper.startsWith('<')) {
    throw new Error(`unsupported range shape: ${JSON.stringify(range)}`)
  }
  return compareVersions(version, lower.slice(2)) >= 0 && compareVersions(version, upper.slice(1)) < 0
}

/**
 * 从**真实清单**里取出那一条 `dsh-*` 声明，作为边界断言的求值对象。
 *
 * 取 `peerDependencies` 的第一条：上面已有一条用例断言所有 `dsh-*` 范围完全一致，
 * 所以任取一条即代表全部；这里再校验一次形态，避免把不一致悄悄当成一致。
 */
function declaredRange(): string {
  const ranges = new Set(dshPeers('peerDependencies').map(([, range]) => range))
  if (ranges.size !== 1) {
    throw new Error(`dsh-* peers disagree on their range: ${JSON.stringify([...ranges])}`)
  }
  const only = [...ranges][0]
  if (only === undefined) throw new Error('no dsh-* peer dependency declared')
  return only
}

describe('declared DSH host line', () => {
  it('declares at least the ten dsh packages the plugin actually imports', () => {
    // 反向兜底：这十条是源码真实 import 的那批（见 `src/` 的 kernel imports）。
    // 少一条意味着有人删声明却没删引用，或反之——两者都该当场发现。
    const names = dshPeers('peerDependencies').map(([name]) => name)
    expect(names).toEqual(expect.arrayContaining([
      '@deepseek-ai/dsh-atomic-write',
      '@deepseek-ai/dsh-attachment',
      '@deepseek-ai/dsh-home-paths',
      '@deepseek-ai/dsh-host-webserver',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-llm-pi-ai',
      '@deepseek-ai/dsh-settings',
    ]))
    expect(names.length).toBeGreaterThanOrEqual(10)
  })

  it('keeps every dsh-* peer on the same lower and upper bound', () => {
    // 本次缺陷的形态就是「上界写死在某一版」；统一的上下界让下一轮复核只需看一处。
    for (const section of ['peerDependencies', 'devDependencies'] as const) {
      for (const [name, range] of dshPeers(section)) {
        expect(range, `${section}.${name}`).toBe(`${LOWER_BOUND} ${UPPER_BOUND}`)
      }
    }
  })

  it('admits the whole 0.2.0 line, including its GA release', () => {
    // 回归本体：`0.2.0` 曾被 `<0.2.0` 挡在门外，而 `0.2.0-rc.1` 能过——
    // 「预发布能用、正式版不能用」的悬崖。这里把两者一起钉住。
    //
    // 关键：对**声明里的那条范围**求值，而不是对测试自己另写的字面量求值。
    // 否则清单与断言各自漂移也能全绿。
    const declared = declaredRange()
    for (const host of ['0.1.7-rc.1', '0.1.7-rc.2', '0.2.0-rc.1', '0.2.0-rc.9', '0.2.0', '0.2.1', '0.2.99']) {
      expect(satisfiesRange(host, declared), `${host} in ${JSON.stringify(declared)}`).toBe(true)
    }
  })

  it('the upper bound actually stops the next line, prereleases included', () => {
    // 这条是 `<0.3.0-0` 与 `<0.3.0` 的唯一区别，也是本次复核最重要的一条：
    // DSH 至今 23 个 tag 全部是预发布，所以「只挡 GA」的上界等于不挡。
    const declared = declaredRange()
    for (const host of ['0.3.0-0', '0.3.0-alpha.1', '0.3.0-rc.1', '0.3.0', '0.4.0-rc.1']) {
      expect(satisfiesRange(host, declared), `${host} must be blocked by ${JSON.stringify(declared)}`).toBe(false)
    }
  })

  it('still refuses hosts older than the declared baseline', () => {
    // 下界不是本次改动对象，但同一处口径必须一起守住：0.1.5 线已移除，
    // 停在 v2.0.15 的用户不应被这一版静默接受。
    const declared = declaredRange()
    for (const host of ['0.1.5-rc.3', '0.1.6-alpha.1', '0.1.7-alpha.2']) {
      expect(satisfiesRange(host, declared), `${host} must be refused`).toBe(false)
    }
  })

  it('does not silently drop the two client packages the card composes against', () => {
    // `ui-settings` / `ui-renderer` 承载客户端的 `configForms` 与 `slots` 服务声明；
    // 它们掉出 peer 列表不会让构建失败，只会让卡片在运行时不出现。
    const peers = manifest().peerDependencies ?? {}
    for (const name of ['@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-ui-renderer']) {
      expect(peers[name], name).toBe(`${LOWER_BOUND} ${UPPER_BOUND}`)
    }
  })

  it('does not keep a devDependency on a package that stopped publishing', () => {
    // `dsh-client-runtime` 停在 0.1.1-rc.2、不在任何受支持主机的捆绑集内，且源码零引用。
    // 它此前作为「旧主机行的类型来源」被保留，但那条线已随 2.1.0 移除——保留只会让
    // 清单与 lockfile 继续声称一份并不存在的依赖。
    const dev = manifest().devDependencies ?? {}
    expect(dev['@deepseek-ai/dsh-client-runtime']).toBeUndefined()
  })
})

describe('host-range policy is written down where releases read it', () => {
  /**
   * 上界这类口径**只有在人看得到的地方被复核**才不会过期，而发布清单是唯一
   * 「每次发布都必然被读到」的位置（2.1.1 对 `docs/WINDOWS.md` 的处置同理）。
   * 这几条是 POLICY 断言，不是行为断言：它们不证明上界是对的，只证明这条
   * 复核路径还在——少了它，下一次 DSH 换线时没人会被提醒。
   */
  function read(relativePath: string): string {
    return readFileSync(fileURLToPath(new URL(relativePath, repoRoot)), 'utf8')
  }

  it('keeps the host-range check in the release flow', () => {
    const releasing = read('RELEASING.md')
    expect(releasing).toContain('宿主范围核对')
    expect(releasing).toContain(UPPER_BOUND)
    // 必须说明 -0 的理由，否则下一个人会「顺手」把它删成 <0.3.0。
    expect(releasing).toContain('-0')
  })

  it('keeps the supported-range table in both READMEs', () => {
    expect(read('README.md')).toContain('受支持的宿主范围')
    expect(read('README.en.md')).toContain('Supported host range')
    // 两语的表都必须点名被拒绝的那条线，而不是只写好话。
    for (const doc of ['README.md', 'README.en.md']) {
      expect(read(doc), doc).toContain('0.3.0-0')
    }
  })
})

describe('version-comparator self-check', () => {
  // 上面全部断言都建立在 compareVersions 上；它自己错了，整套守卫就是装饰品。
  it('orders prereleases below their release and compares numeric segments', () => {
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1)
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(1)
    expect(compareVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBe(-1)
    expect(compareVersions('0.2.0', '0.3.0-0')).toBe(-1)
    expect(compareVersions('0.3.0-0', '0.3.0-0')).toBe(0)
    expect(compareVersions('0.3.0-alpha.1', '0.3.0-0')).toBe(1)
    expect(compareVersions('1.2.0', '1.10.0')).toBe(-1)
    expect(compareVersions('0.1.7-rc.1', '0.1.7-rc.1')).toBe(0)
  })

  it('rejects malformed versions instead of treating them as equal', () => {
    expect(() => compareVersions('0.2', '0.2.0')).toThrow()
    expect(() => compareVersions('x.y.z', '0.2.0')).toThrow()
  })
})

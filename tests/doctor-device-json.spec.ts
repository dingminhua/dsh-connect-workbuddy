/**
 * `doctor --json` 的档位分岔字段。
 *
 * `effd45c` 承诺 `deviceIdentity.tierSent` / `deviceIdentity.fallbackToVirtual`
 * 「只在分岔时出现」，但首版只把它们接进了人类可读行——`--json` 的组装处漏了
 * 这两个字段的展开，消费者永远读不到。本文件就是在那条承诺上钉的钉子：跑真实的
 * `run(['doctor','--json'])`，解析 stdout，两种设置各验一次。
 *
 * 环境由 vitest 的 isolated env 保证：`DSH_HOME` 指向临时目录（设置文件写在那里）、
 * `WORKBUDDY_TURING_SDK_DIR` 指向不存在的目录（probe 立刻答 `missing`，不起子进程、
 * 不发网络请求），所以「真实值档 + 断 token」在本测试里是确定性的。
 */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { run } from '../src/bin.ts'
import { DEVICE_PROFILE_VERSION } from '../src/device-profile.ts'

const homes: string[] = []

afterEach(() => {
  homes.length = 0
})

/**
 * 在一份**全新的** `$DSH_HOME` 下写设备设置。
 *
 * 每个用例换一个目录不是洁癖：`readDeviceSettings` 有 5 秒读缓存（按路径键），
 * 同一个 home 里连写三次会读到上一用例的 `mode`——这正是本文件第一版失败的原因。
 */
async function writeDeviceSettings(
  mode: 'virtual' | 'real',
  sdkFallbackToVirtual: boolean,
  /** `'absent'` = 写一份没有总开关字段的文件（5.17.0 的形状）。默认写 `true`。 */
  enabled: boolean | 'absent' = true,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'doctor-device-'))
  homes.push(home)
  process.env['DSH_HOME'] = home
  await writeFile(
    join(home, '.workbuddy-device-profiles.json'),
    `${JSON.stringify({
      version: DEVICE_PROFILE_VERSION,
      ...enabled === 'absent' ? {} : { enabled },
      mode,
      accounts: {},
      sdkFallbackToVirtual,
    }, null, 2)}\n`,
    'utf8',
  )
}

/** 跑一次真实的 `doctor --json` 并解析它的 stdout。 */
async function doctorJson(): Promise<Record<string, unknown>> {
  const chunks: string[] = []
  const original = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: unknown) => {
    if (typeof chunk === 'string') chunks.push(chunk)
    return true
  }) as typeof process.stdout.write
  try {
    const exit = await run(['doctor', '--json'])
    // doctor 的退出码是 `anySignedIn && desktopPresent`：隔离环境没有账号，1 是
    // 正常答案（报告在返回前就已打印完毕），所以这里只要求它是这两者之一。
    expect([0, 1]).toContain(exit)
  } finally {
    process.stdout.write = original
  }
  const lines = chunks.join('').split('\n').filter(line => line.trim().startsWith('{'))
  expect(lines.length).toBeGreaterThan(0)
  return JSON.parse(lines[0] as string) as Record<string, unknown>
}

describe('doctor --json 的档位分岔（schemaVersion 10 的承诺）', () => {
  it('real 档 + 断 token + 开关开：tier 保留 real，tierSent 降成 virtual', async () => {
    await writeDeviceSettings('real', true)
    const report = await doctorJson()
    const device = report['deviceIdentity'] as Record<string, unknown>
    expect(device['tier']).toBe('real')
    // 这三条就是"报告与出站字节一致"的形状：请求的是 real、线上发的是 virtual、
    // 且报告明说这是退回而不是用户的选择。
    expect(device['tierSent']).toBe('virtual')
    expect(device['fallbackToVirtual']).toBe(true)
  })

  it('真实值档 + 关掉退回：Windows 上不发设备头，无真实值档的平台退回虚拟值', async () => {
    await writeDeviceSettings('real', false)
    const report = await doctorJson()
    const device = report['deviceIdentity'] as Record<string, unknown>
    // 设置里写的是 real，报告里的 `tier` 保留这个意愿——两种平台的差别只在
    // "这台机器兑不兑现得了它"。
    expect(device['tier']).toBe('real')
    /**
     * 只有 Windows 有真实值档（SDK 要桌面端的主队列，见 `realTierAvailable`）。
     * 在 macOS / Linux 上，设置里那个 `real` 无法兑现，请求路径一律按虚拟值走，
     * 所以这里必然出现分岔字段——而"退回"不是用户把开关关掉的结果，是平台缺少
     * 这一档的结果。这台机器跑什么平台由 `process.platform` 决定，不是断言"测试
     * 跑在哪台机器上"，而是断言"这条平台规则在两种平台上各自成立"。
     */
    const hasRealTier = process.platform === 'win32'
    expect(device['tierSent']).toBe(hasRealTier ? undefined : 'virtual')
    expect(device['fallbackToVirtual']).toBe(hasRealTier ? undefined : true)
    // 两种情形下都没有设备头：Windows 是"真实值档取不到 token 且不退回"，
    // 隔离环境里也没有账号可供派生。
    expect(device['onWire']).toEqual([])
  })

  it('virtual 档：常态无分岔，两个字段都不出现', async () => {
    await writeDeviceSettings('virtual', true)
    const report = await doctorJson()
    const device = report['deviceIdentity'] as Record<string, unknown>
    expect(device['tier']).toBe('virtual')
    expect(device['tierSent']).toBeUndefined()
    expect(device['fallbackToVirtual']).toBeUndefined()
  })
})

/**
 * 总开关（用户意见）：`--json` 里那个 `enabled: false` 是唯一的证据。
 *
 * `onWire: []` 单独存在时读不出原因——本版本之前它已经有两个别的含义
 * （盐不可用、真实值档取不到 token）。开关关掉是第三个，所以必须有一个字段
 * 把它和"坏了"分开；这也让 schemaVersion 从 10 走到 11。
 */
describe('doctor --json 的总开关（schemaVersion 11）', () => {
  it('缺字段 = 关：5.17.0 写下的文件升级后默认静默', async () => {
    // 这是"默认关闭"在 doctor 上的样子：文件里根本没有 enabled，报告必须说关。
    // 升级不该替用户打开设备身份——那是一个属于用户的决定。
    await writeDeviceSettings('virtual', true, 'absent')
    const device = (await doctorJson())['deviceIdentity'] as Record<string, unknown>
    expect(device['enabled']).toBe(false)
    expect(device['onWire']).toEqual([])
    expect(device['sdk']).toBeUndefined()
  })

  it('关掉之后：enabled: false、onWire 空、SDK 不出现（没探测）', async () => {
    await writeDeviceSettings('virtual', true, false)
    const device = (await doctorJson())['deviceIdentity'] as Record<string, unknown>
    expect(device['enabled']).toBe(false)
    expect(device['onWire']).toEqual([])
    // 关着的时候 doctor 连 probe 都不起，报告里也就不该有一个 sdk 读数。
    expect(device['sdk']).toBeUndefined()
    // 档位照实报：它是"重新打开之后会走哪条路"，不是"现在在走哪条路"。
    expect(device['tier']).toBe('virtual')
  })

  it('开着的时间不出现这个字段——恒等值只是噪音', async () => {
    await writeDeviceSettings('virtual', true, true)
    const device = (await doctorJson())['deviceIdentity'] as Record<string, unknown>
    // 隔离环境里没有账号，`onWire` 本来就是空的——所以这条用例只看字段在不在，
    // 不看头名清单（那由 device-state / wire-profile 的用例负责）。
    expect(Object.hasOwn(device, 'enabled')).toBe(false)
    expect(device['onWire']).toEqual([])
  })
})

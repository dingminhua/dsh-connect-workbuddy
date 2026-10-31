import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEVICE_PROFILE_FILE_NAME,
  createDeviceProfileLookup,
  describeDerivedDevices,
  deviceProfilePath,
  readDeviceSettings,
  saveDeviceProfile,
  saveDeviceSdkSettings,
  setDeviceMode,
} from '../src/device-profile.ts'

/** Two well-formed ids (36 lowercase hex) and one deliberately malformed. */
const MACHINE = 'a'.repeat(36)
const SESSION = 'b'.repeat(36)
const BAD = 'A'.repeat(36)

const ACCOUNT = 'acct-1'
const UID = 'uid-1'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wb-device-profile-'))
})
afterEach(async () => {
  await rm(dir, { force: true, recursive: true })
})

const file = () => join(dir, DEVICE_PROFILE_FILE_NAME)

describe('readDeviceSettings', () => {
  it('answers virtual + empty without creating a file', async () => {
    // A read must never leave state behind: the panel polls this on every open.
    expect(await readDeviceSettings({ dir })).toEqual({
      mode: 'virtual',
      accounts: {},
      sdkDir: '',
      // 回退默认**开**（作者意见 #2）：一个没有这个字段的文件（5.16.0 时代写的）
      // 升级后立刻拿到新行为，不需要用户去点一次。
      sdkFallbackToVirtual: true,
    })
    await expect(stat(file())).rejects.toThrow()
  })

  it('treats a corrupt document as "no settings" instead of throwing', async () => {
    // Hand-edited files happen; a thrown error here would blank the whole card.
    await writeFile(file(), '{ not json', 'utf8')
    expect(await readDeviceSettings({ dir })).toEqual({
      mode: 'virtual',
      accounts: {},
      sdkDir: '',
      // 回退默认**开**（作者意见 #2）：一个没有这个字段的文件（5.16.0 时代写的）
      // 升级后立刻拿到新行为，不需要用户去点一次。
      sdkFallbackToVirtual: true,
    })
  })

  it('ignores a document from an unknown version', async () => {
    await writeFile(file(), JSON.stringify({ version: 99, mode: 'real', accounts: {} }), 'utf8')
    expect(await readDeviceSettings({ dir })).toEqual({
      mode: 'virtual',
      accounts: {},
      sdkDir: '',
      // 回退默认**开**（作者意见 #2）：一个没有这个字段的文件（5.16.0 时代写的）
      // 升级后立刻拿到新行为，不需要用户去点一次。
      sdkFallbackToVirtual: true,
    })
  })

  it('drops malformed ids but keeps the rest of the record', async () => {
    // A hand edit that shortens one id must not take the other down with it.
    await writeFile(file(), JSON.stringify({
      version: 1,
      mode: 'virtual',
      accounts: { [ACCOUNT]: { uid: UID, machineId: MACHINE, sessionId: 'short' } },
    }), 'utf8')
    const settings = await readDeviceSettings({ dir })
    expect(settings.accounts[ACCOUNT]).toEqual({ machineId: MACHINE })
  })
})

describe('setDeviceMode', () => {
  it('persists the choice and reports it back', async () => {
    const settings = await setDeviceMode('real', { dir })
    expect(settings.mode).toBe('real')
    expect((await readDeviceSettings({ dir })).mode).toBe('real')
  })

  it('leaves the per-account overrides alone', async () => {
    await saveDeviceProfile(ACCOUNT, { uid: UID, machineId: MACHINE }, { dir })
    const settings = await setDeviceMode('real', { dir })
    expect(settings.accounts[ACCOUNT]).toEqual({ machineId: MACHINE })
  })

  it('writes owner-only permissions where the platform honours them', async () => {
    await setDeviceMode('virtual', { dir })
    if (process.platform === 'win32') return
    expect((await stat(file())).mode & 0o777).toBe(0o600)
  })
})

describe('saveDeviceProfile', () => {
  it('stores one field and leaves the other deriving', async () => {
    const settings = await saveDeviceProfile(ACCOUNT, { uid: UID, machineId: MACHINE }, { dir })
    expect(settings.accounts[ACCOUNT]).toEqual({ machineId: MACHINE })
  })

  it('merges per field — saving the session must not wipe the machine id', async () => {
    // This is the whole reason `undefined` and `''` are different values: a dialog
    // that only touched one field would otherwise erase the other on every save.
    await saveDeviceProfile(ACCOUNT, { uid: UID, machineId: MACHINE }, { dir })
    const settings = await saveDeviceProfile(ACCOUNT, { sessionId: SESSION }, { dir })
    expect(settings.accounts[ACCOUNT]).toEqual({ machineId: MACHINE, sessionId: SESSION })
  })

  it('clears a field back to "derive it" with an empty string', async () => {
    await saveDeviceProfile(ACCOUNT, { uid: UID, machineId: MACHINE, sessionId: SESSION }, { dir })
    const settings = await saveDeviceProfile(ACCOUNT, { machineId: '' }, { dir })
    expect(settings.accounts[ACCOUNT]).toEqual({ sessionId: SESSION })
  })

  it('removes the record entirely when nothing is overridden any more', async () => {
    await saveDeviceProfile(ACCOUNT, { uid: UID, machineId: MACHINE }, { dir })
    const settings = await saveDeviceProfile(ACCOUNT, { machineId: '' }, { dir })
    expect(settings.accounts[ACCOUNT]).toBeUndefined()
  })

  it('refuses a malformed id instead of writing it', async () => {
    // The header would be rejected upstream; failing at the write keeps the file
    // free of values the rest of the plugin would then have to distrust.
    await expect(saveDeviceProfile(ACCOUNT, { machineId: BAD }, { dir })).rejects.toThrow('36 lowercase hex')
    await expect(stat(file())).rejects.toThrow()
  })

  it('keeps the account when the uid is unknown, and the lookup ignores it', async () => {
    // An account can be saved while its credential is gone (vault cleared); the
    // values survive, but nothing is sent until it comes back.
    await saveDeviceProfile(ACCOUNT, { machineId: MACHINE }, { dir })
    const lookup = createDeviceProfileLookup({ dir })
    expect(await lookup.forUid(UID)).toBeUndefined()
  })
})

describe('createDeviceProfileLookup', () => {
  it('answers by uid, not by account id', async () => {
    await saveDeviceProfile(ACCOUNT, { uid: UID, machineId: MACHINE, sessionId: SESSION }, { dir })
    const lookup = createDeviceProfileLookup({ dir })
    expect(await lookup.forUid(UID)).toEqual({ machineId: MACHINE, sessionId: SESSION })
    expect(await lookup.forUid('someone-else')).toBeUndefined()
  })

  it('sees a save immediately, despite the read cache', async () => {
    // The request path caches for 5s; a save must invalidate rather than wait —
    // otherwise "I saved it and it still sends the old id" for five seconds.
    await saveDeviceProfile(ACCOUNT, { uid: UID, machineId: MACHINE }, { dir })
    const lookup = createDeviceProfileLookup({ dir })
    expect(await lookup.forUid(UID)).toEqual({ machineId: MACHINE })
    await saveDeviceProfile(ACCOUNT, { machineId: SESSION }, { dir })
    expect(await lookup.forUid(UID)).toEqual({ machineId: SESSION })
  })

  it('returns undefined for an empty uid', async () => {
    const lookup = createDeviceProfileLookup({ dir })
    expect(await lookup.forUid('')).toBeUndefined()
  })

  it('writes a document the next process could read', async () => {
    await saveDeviceProfile(ACCOUNT, { uid: UID, machineId: MACHINE }, { dir })
    const document = JSON.parse(await readFile(file(), 'utf8')) as { version: number, accounts: Record<string, { uid?: string }> }
    expect(document.version).toBe(1)
    expect(document.accounts[ACCOUNT]?.uid).toBe(UID)
    expect(deviceProfilePath(dir)).toBe(file())
  })
})

/**
 * 「留空会发什么」这件事必须能被看见，也必须每个账号不同。
 *
 * 派生输入是 uid（与 `deviceHeaders()` 同一份），所以：
 * - 不同账号 → 不同设备（相邻两个账号被上游合成一台机器，正是风控最敏感的信号）；
 * - 同一账号 → 同一个值（换一次进程就换一台设备，比不发更糟）；
 * - 没有 uid → 不编一个值出来：那个账号本来就不发设备头。
 */
describe('describeDerivedDevices', () => {
  const SALT = 'a'.repeat(64)

  it('gives every account its own pair, and machine ≠ session', async () => {
    const derived = await describeDerivedDevices(
      [{ accountId: 'a1', uid: 'uid-1' }, { accountId: 'a2', uid: 'uid-2' }],
      { salt: SALT },
    )
    expect(derived).toBeDefined()
    const first = derived?.['a1']
    const second = derived?.['a2']
    expect(first?.machineId).toMatch(/^[0-9a-f]{36}$/u)
    expect(first?.sessionId).toMatch(/^[0-9a-f]{36}$/u)
    expect(first?.machineId).not.toBe(first?.sessionId)
    // 这一条就是"每个账号的值要不同"的守卫：只要派生退回 sha256(purpose) 或
    // 用错了输入（比如拿 accountId 之外的常量），这里立刻变红。
    expect(second?.machineId).not.toBe(first?.machineId)
    expect(second?.sessionId).not.toBe(first?.sessionId)
  })

  it('is stable for the same uid across calls', async () => {
    const one = await describeDerivedDevices([{ accountId: 'a1', uid: 'uid-1' }], { salt: SALT })
    const two = await describeDerivedDevices([{ accountId: 'a1', uid: 'uid-1' }], { salt: SALT })
    expect(two).toEqual(one)
  })

  it('skips an account without a uid instead of inventing one', async () => {
    const derived = await describeDerivedDevices(
      [{ accountId: 'a1', uid: '' }, { accountId: 'a2', uid: 'uid-2' }],
      { salt: SALT },
    )
    expect(derived?.['a1']).toBeUndefined()
    expect(derived?.['a2']).toBeDefined()
  })

  it('answers undefined when this machine has no salt', async () => {
    // 不是空对象：空对象是"算过，一个都不能算"，undefined 是"这次没算"。
    // 两种状态在弹窗里说不同的话，所以不能在类型上就糊成一种。
    expect(await describeDerivedDevices([{ accountId: 'a1', uid: 'uid-1' }], { dir })).toBeUndefined()
  })

  it('reads the salt from the given directory when none is passed', async () => {
    await writeFile(join(dir, '.workbuddy-device.json'), JSON.stringify({
      version: 1,
      salt: SALT,
      createdAt: new Date().toISOString(),
    }), 'utf8')
    const derived = await describeDerivedDevices([{ accountId: 'a1', uid: 'uid-1' }], { dir })
    expect(derived?.['a1']?.machineId).toMatch(/^[0-9a-f]{36}$/u)
  })

  it('never leaks the salt into the answer', async () => {
    const derived = await describeDerivedDevices([{ accountId: 'a1', uid: 'uid-1' }], { salt: SALT })
    expect(JSON.stringify(derived)).not.toContain(SALT)
  })
})

/**
 * 作者意见 #1 与 #2：卡片上可填 SDK 目录、可关掉回退。
 *
 * 这一组断言的重点全在**约定**上，而不是"能不能存"：留空 = 自动发现（不是"路径
 * 为空"）、`undefined` = 不动这一项（两个控件互不覆盖）、回退缺字段 = 开（老文件
 * 升级后立刻拿到新默认）。
 */
describe('the SDK settings (作者意见 #1 / #2)', () => {
  it('defaults to automatic discovery and a fallback that is ON', async () => {
    const settings = await readDeviceSettings({ dir })
    expect(settings.sdkDir).toBe('')
    expect(settings.sdkFallbackToVirtual).toBe(true)
  })

  it('round-trips a typed directory', async () => {
    const saved = await saveDeviceSdkSettings({ sdkDir: '  E:\\WorkBuddy\\sdk  ' }, { dir })
    // 去空白，但**不**规范化分隔符或大小写：那是一条路径，用户从资源管理器复制来
    // 的就该原样保存；改了之后"我填的和看到的不一样"会让人怀疑没存上。
    expect(saved.sdkDir).toBe('E:\\WorkBuddy\\sdk')
    expect((await readDeviceSettings({ dir })).sdkDir).toBe('E:\\WorkBuddy\\sdk')
  })

  it('keeps an unusable path instead of silently reverting to discovery', async () => {
    // 路径填错时的正确反馈是"探不到 SDK 并显示这个路径"，不是悄悄回退——后者会让
    // 用户以为保存失败了，然后反复保存。
    await saveDeviceSdkSettings({ sdkDir: 'Z:\\nope\\turing-sdk' }, { dir })
    expect((await readDeviceSettings({ dir })).sdkDir).toBe('Z:\\nope\\turing-sdk')
  })

  it('clears back to discovery on an empty string — not the same as leaving it alone', async () => {
    await saveDeviceSdkSettings({ sdkDir: 'E:\\sdk' }, { dir })
    const cleared = await saveDeviceSdkSettings({ sdkDir: '' }, { dir })
    expect(cleared.sdkDir).toBe('')
    // `undefined` 不动这一项。
    await saveDeviceSdkSettings({ sdkDir: 'E:\\sdk' }, { dir })
    const untouched = await saveDeviceSdkSettings({ sdkFallbackToVirtual: false }, { dir })
    expect(untouched.sdkDir).toBe('E:\\sdk')
    expect(untouched.sdkFallbackToVirtual).toBe(false)
  })

  it('does not let one control write the other one back', async () => {
    // 面板上两个独立控件：保存开关不能顺手把刚改的目录覆盖回旧值。
    await saveDeviceSdkSettings({ sdkDir: 'E:\\a' }, { dir })
    await saveDeviceSdkSettings({ sdkFallbackToVirtual: false }, { dir })
    const settings = await readDeviceSettings({ dir })
    expect(settings.sdkDir).toBe('E:\\a')
    expect(settings.sdkFallbackToVirtual).toBe(false)
  })

  it('treats a missing fallback field as ON — a 5.16.0 file upgrades into the new default', async () => {
    await writeFile(file(), JSON.stringify({ version: 1, mode: 'virtual', accounts: {} }), 'utf8')
    expect((await readDeviceSettings({ dir })).sdkFallbackToVirtual).toBe(true)
  })

  it('only an explicit false turns the fallback off', async () => {
    await writeFile(file(), JSON.stringify({ version: 1, mode: 'virtual', accounts: {}, sdkFallbackToVirtual: false }), 'utf8')
    expect((await readDeviceSettings({ dir })).sdkFallbackToVirtual).toBe(false)
  })

  it('does not touch the tier or the account overrides', async () => {
    // 保存目录与保存档位是两条独立的意图：一个不该顺手改另一个。
    await saveDeviceProfile(ACCOUNT, { uid: UID, machineId: MACHINE }, { dir })
    await setDeviceMode('real', { dir })
    const settings = await saveDeviceSdkSettings({ sdkDir: 'E:\\sdk' }, { dir })
    expect(settings.mode).toBe('real')
    expect(settings.accounts[ACCOUNT]).toEqual({ machineId: MACHINE })
  })

  it('exposes both through the request-path lookup', async () => {
    await saveDeviceSdkSettings({ sdkDir: 'E:\\sdk', sdkFallbackToVirtual: false }, { dir })
    const lookup = createDeviceProfileLookup({ dir })
    expect(await lookup.sdkDir()).toBe('E:\\sdk')
    expect(await lookup.fallbackToVirtual()).toBe(false)
  })
})

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
    expect(await readDeviceSettings({ dir })).toEqual({ mode: 'virtual', accounts: {} })
    await expect(stat(file())).rejects.toThrow()
  })

  it('treats a corrupt document as "no settings" instead of throwing', async () => {
    // Hand-edited files happen; a thrown error here would blank the whole card.
    await writeFile(file(), '{ not json', 'utf8')
    expect(await readDeviceSettings({ dir })).toEqual({ mode: 'virtual', accounts: {} })
  })

  it('ignores a document from an unknown version', async () => {
    await writeFile(file(), JSON.stringify({ version: 99, mode: 'real', accounts: {} }), 'utf8')
    expect(await readDeviceSettings({ dir })).toEqual({ mode: 'virtual', accounts: {} })
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

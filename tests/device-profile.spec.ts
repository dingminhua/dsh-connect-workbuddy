import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEVICE_PROFILE_FILE_NAME,
  createDeviceProfileLookup,
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

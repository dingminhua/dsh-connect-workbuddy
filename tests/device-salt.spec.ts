import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEVICE_SALT_FILE_NAME,
  DEVICE_SALT_VERSION,
  deviceSaltPath,
  ensureDeviceSalt,
  readDeviceSalt,
} from '../src/device-salt.ts'
import type { DeviceSaltReadout } from '../src/device-salt.ts'
import { isDeviceSalt } from '../src/device-id.ts'

/**
 * The module takes an explicit `dir`, so these tests never touch a real profile
 * (same convention as `tests/roster-seen-store.spec.ts`).
 */
let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wb-device-salt-'))
})
afterEach(async () => {
  await rm(home, { force: true, recursive: true })
})

const saltFile = () => join(home, DEVICE_SALT_FILE_NAME)

/**
 * Readouts are a discriminated union, so the fields can only be touched after a
 * narrowing — and `expect(...).toBe()` does not narrow for the compiler. These
 * two helpers do the narrowing AND fail loudly when the state is not the one the
 * test is about, so a wrong state can never masquerade as "the field was absent".
 */
function saltOf(readout: DeviceSaltReadout): string {
  if (readout.state !== 'ok') throw new Error(`expected state ok, got ${readout.state}`)
  return readout.salt
}

function reasonOf(readout: DeviceSaltReadout): string {
  if (!('reason' in readout)) throw new Error(`expected a reason, got state ${readout.state}`)
  return readout.reason
}

/** Write a raw document, for the "someone edited this file" cases. */
async function writeRaw(text: string): Promise<void> {
  await writeFile(saltFile(), text, 'utf8')
}

describe('deviceSaltPath', () => {
  it('lives under the pinned directory, dot-prefixed like the other stores', () => {
    expect(deviceSaltPath(home)).toBe(saltFile())
    expect(DEVICE_SALT_FILE_NAME.startsWith('.')).toBe(true)
  })

  it('falls back to $DSH_HOME, not the plugin install directory', () => {
    // A salt inside `node_modules/dsh-connect-workbuddy` would be destroyed by
    // the next npm install, and the account would silently change devices.
    expect(deviceSaltPath()).toContain(DEVICE_SALT_FILE_NAME)
    expect(deviceSaltPath()).not.toContain('node_modules')
  })
})

describe('readDeviceSalt', () => {
  it('reports a missing file as absent and creates nothing', async () => {
    const readout = await readDeviceSalt({ dir: home })
    expect(readout.state).toBe('absent')
    expect('salt' in readout).toBe(false)
    await expect(stat(saltFile())).rejects.toThrow()
  })

  it('reports malformed JSON as unreadable, NOT absent', async () => {
    // The distinction is load-bearing: `absent` permits writing a new salt,
    // `unreadable` forbids it. Collapsing them re-keys the device on a corrupt
    // file, which is exactly the signal the audit is trying to avoid.
    await writeRaw('{ this is not json')
    const readout = await readDeviceSalt({ dir: home })
    expect(readout.state).toBe('unreadable')
    expect(reasonOf(readout)).toBe('file is not valid JSON')
  })

  it('refuses a version this build does not know', async () => {
    await writeRaw(JSON.stringify({ version: DEVICE_SALT_VERSION + 1, salt: 'a'.repeat(64) }))
    const readout = await readDeviceSalt({ dir: home })
    expect(readout.state).toBe('unreadable')
    expect(reasonOf(readout)).toContain('version')
  })

  it('refuses a salt of the wrong shape', async () => {
    await writeRaw(JSON.stringify({ version: DEVICE_SALT_VERSION, salt: 'a'.repeat(32) }))
    const readout = await readDeviceSalt({ dir: home })
    expect(readout.state).toBe('unreadable')
    expect(reasonOf(readout)).toContain('64 lowercase hex')
  })
})

describe('ensureDeviceSalt', () => {
  it('creates a 64-hex salt on first use', async () => {
    const readout = await ensureDeviceSalt({ dir: home })
    expect(readout.state).toBe('ok')
    expect(isDeviceSalt(saltOf(readout))).toBe(true)
  })

  it('reuses the same salt on every later call', async () => {
    const first = await ensureDeviceSalt({ dir: home })
    const second = await ensureDeviceSalt({ dir: home })
    expect(saltOf(second)).toBe(saltOf(first))
  })

  it('writes a versioned document so a future format can refuse cleanly', async () => {
    await ensureDeviceSalt({ dir: home })
    const document = JSON.parse(await readFile(saltFile(), 'utf8')) as Record<string, unknown>
    expect(document['version']).toBe(DEVICE_SALT_VERSION)
    expect(isDeviceSalt(String(document['salt']))).toBe(true)
    expect(typeof document['createdAt']).toBe('string')
  })

  it('writes owner-only permissions where the platform honours them', async () => {
    // On Windows the DACL decides and `mode` is a no-op; the vault's own ACL
    // report is the Windows-side check (issue #183). On POSIX this must hold.
    await ensureDeviceSalt({ dir: home })
    if (process.platform === 'win32') return
    expect((await stat(saltFile())).mode & 0o777).toBe(0o600)
  })

  it('never re-keys an unreadable document', async () => {
    const broken = JSON.stringify({ version: 99, salt: 'a'.repeat(64) })
    await writeRaw(broken)
    const readout = await ensureDeviceSalt({ dir: home })
    expect(readout.state).toBe('unreadable')
    // The file is left EXACTLY as found: no "repair" that would mint a new device.
    expect(await readFile(saltFile(), 'utf8')).toBe(broken)
  })
})

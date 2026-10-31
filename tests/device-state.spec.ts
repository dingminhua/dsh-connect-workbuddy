import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEVICE_SALT_FILE_NAME } from '../src/device-salt.ts'
import { describeDeviceState } from '../src/device-state.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'

/**
 * `describeDeviceState` takes an explicit `dir`, so these tests never touch a
 * real profile.
 */
let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wb-device-state-'))
})
afterEach(async () => {
  await rm(home, { force: true, recursive: true })
})

/** Only `uid` participates in derivation; the rest is realistic filler. */
function credentialOf(uid: string): WorkBuddyCredential {
  return {
    accessToken: 'access-token-fixture',
    refreshToken: 'refresh-token-fixture',
    expiresAtMs: 0,
    domain: 'www.codebuddy.cn',
    uid,
    source: 'desktop',
    filePath: join(home, `${uid}.info`),
  }
}

const saltFile = () => join(home, DEVICE_SALT_FILE_NAME)

/**
 * P0 ships NO device header. This is the guard that says so.
 *
 * It is deliberately written against `onWire` — a value computed by running the
 * real header builders — and not against a list of strings, so it cannot pass
 * while the request path sends something else. When P1 lands
 * (`X-Machine-ID` / `X-Session-ID`), THIS test must be updated to the new
 * expectation; that edit is the point, because it is the moment someone has to
 * decide the device tier on purpose instead of by accident.
 *
 * Both directions were exercised: adding a header to `chatHeaders` turns it red,
 * and removing one from `WORKBUDDY_DEVICE_HEADER_NAMES` turns it red too (the
 * filter would stop recognising the name).
 */
describe('describeDeviceState — what is on the wire', () => {
  it('reports no device header at all (P0)', async () => {
    const report = await describeDeviceState([credentialOf('u-1')], { dir: home })
    expect(report.onWire).toEqual([])
  })

  it('reports nothing even with several accounts, because none is attached', async () => {
    const report = await describeDeviceState(['u-1', 'u-2', 'u-3'].map(credentialOf), { dir: home })
    expect(report.onWire).toEqual([])
  })
})

describe('describeDeviceState — the derived tier', () => {
  it('gives every account its own virtual device', async () => {
    // The audit's §5.4 question: does a pool collapse into ONE device? Derived
    // ids answer it per account, which is the entire reason this tier exists.
    const report = await describeDeviceState(['u-1', 'u-2', 'u-3'].map(credentialOf), { dir: home })
    expect(report.derived?.accounts).toBe(3)
    expect(report.derived?.distinct).toBe(3)
  })

  it('counts duplicate uid once — two credential files are still one account', async () => {
    // A live `workbuddy-desktop.info` plus its timestamped backup both parse into
    // credentials with the same uid; counting them as two devices would report a
    // pool size that does not exist.
    const report = await describeDeviceState(['u-1', 'u-1'].map(credentialOf), { dir: home })
    expect(report.derived?.accounts).toBe(1)
    expect(report.derived?.distinct).toBe(1)
  })

  it('is stable across calls — the id must survive a restart', async () => {
    const first = await describeDeviceState([credentialOf('u-1')], { dir: home })
    const second = await describeDeviceState([credentialOf('u-1')], { dir: home })
    expect(second.derived?.sample).toEqual(first.derived?.sample)
  })

  it('never puts the salt in the report', async () => {
    const report = await describeDeviceState([credentialOf('u-1')], { dir: home })
    const document = JSON.parse(await readFile(saltFile(), 'utf8')) as Record<string, unknown>
    const salt = String(document['salt'])
    expect(salt).toHaveLength(64)
    expect(JSON.stringify(report)).not.toContain(salt)
  })
})

describe('describeDeviceState — salt lifecycle', () => {
  it('creates no salt file when there is no account to derive from', async () => {
    // A machine that never signed in has no device to name; leaving a file
    // behind would be an identity the user never asked for.
    const report = await describeDeviceState([], { dir: home })
    expect(report.salt.state).toBe('absent')
    expect(report.derived).toBeUndefined()
    await expect(stat(saltFile())).rejects.toThrow()
  })

  it('derives nothing from an unreadable salt, and reports why', async () => {
    const broken = JSON.stringify({ version: 99, salt: 'a'.repeat(64) })
    await writeFile(saltFile(), broken, 'utf8')
    const report = await describeDeviceState([credentialOf('u-1')], { dir: home })
    expect(report.salt.state).toBe('unreadable')
    expect(report.salt.reason).toContain('version')
    expect(report.derived).toBeUndefined()
    // Still untouched — see tests/device-salt.spec.ts for the re-key guard.
    expect(await readFile(saltFile(), 'utf8')).toBe(broken)
  })
})

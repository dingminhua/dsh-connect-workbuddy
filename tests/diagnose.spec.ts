/**
 * `WorkBuddyCredentialStore.diagnose()` tests.
 *
 * The card can only explain a signed-out state if the store reports WHY each
 * probed path yielded nothing. These tests pin the four reasons apart —
 * especially `encrypted`, which is the WorkBuddy-specific case where the user
 * is very likely signed in already and "sign in again" is the wrong advice.
 *
 * The encrypted fixtures are sealed with the same AES-256-GCM codec the desktop
 * app uses (see at-rest.spec.ts), so `encrypted` is proven against a genuine
 * envelope rather than a hand-written marker that could never occur in the wild.
 */

import { createCipheriv, createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deriveAtRestKeyId } from '../src/at-rest.ts'
import { WorkBuddyCredentialStore } from '../src/auth.ts'
import type { WorkBuddyStoreOptions } from '../src/auth.ts'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'wb-diagnose-')) })
afterEach(async () => { await rm(root, { force: true, recursive: true }) })

const AUTH_DIR = 'auth'
const LIVE = 'workbuddy-desktop.info'

async function writeAuth(name: string, body: unknown): Promise<string> {
  const dir = join(root, AUTH_DIR)
  await mkdir(dir, { recursive: true })
  const path = join(dir, name)
  await writeFile(path, typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
  return path
}

/** A plain, readable credential document — the healthy case. */
function accountDoc(): Record<string, unknown> {
  return {
    account: { uid: 'uid-1', uin: '100000000001', nickname: 'Alpha' },
    auth: {
      accessToken: 'token-alpha',
      refreshToken: 'refresh-alpha',
      domain: 'www.codebuddy.cn',
      expiresAt: Date.now() + 86_400_000,
    },
  }
}

const encoder = new TextEncoder()
function encodeUint32(value: number): Buffer {
  const bytes = Buffer.allocUnsafe(4)
  bytes.writeUInt32BE(value)
  return bytes
}
function encodeLengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8')
  return Buffer.concat([encodeUint32(bytes.length), bytes])
}

/**
 * Seal a token exactly as the desktop app's field codec does.
 *
 * `keyId` is derived from the sealing key and bound into the AAD, so an
 * envelope sealed with one secret can never be opened with another.
 */
function sealField(plaintext: string, secretBase64: string): object {
  const key = createHash('sha256').update(secretBase64, 'utf8').digest()
  const keyId = deriveAtRestKeyId(key)
  const nonce = Buffer.alloc(12, 7)
  const aad = Buffer.concat([
    Buffer.from('WB-AAD\0', 'ascii'),
    Buffer.from([1]),
    encodeLengthPrefixed('WBEV1'),
    encodeLengthPrefixed('sym-v1'),
    encodeUint32(1),
    encodeLengthPrefixed(keyId),
    Buffer.from([2]),
    Buffer.from([0]),
    Buffer.from([0]),
  ])
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  cipher.setAAD(aad)
  const ciphertext = Buffer.concat([cipher.update(encoder.encode(plaintext)), cipher.final()])
  const envelope = {
    suite: 1,
    keyId,
    nonce: nonce.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
  return { $wbEncrypted: 1, envelope: Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64') }
}

const SEAL_SECRET = createHash('sha256').update('diagnose-secret').digest('base64')

/** A document whose token fields are encrypted, as Windows builds write it. */
function encryptedDoc(): Record<string, unknown> {
  return {
    account: { uid: 'uid-1', uin: '100000000001', nickname: 'Alpha' },
    auth: {
      accessToken: sealField('token-alpha', SEAL_SECRET),
      refreshToken: sealField('refresh-alpha', SEAL_SECRET),
      domain: 'www.codebuddy.cn',
      expiresAt: Date.now() + 86_400_000,
    },
  }
}

/** A store pinned to this test's auth directory and nothing else. */
function makeStore(overrides: Partial<WorkBuddyStoreOptions> = {}): WorkBuddyCredentialStore {
  return new WorkBuddyCredentialStore({
    authDirs: [join(root, AUTH_DIR)],
    refresh: async () => ({ accessToken: 'never' }),
    ...overrides,
  })
}

describe('WorkBuddyCredentialStore.diagnose', () => {
  it('reports the probed desktop path as missing on a machine with nothing installed', async () => {
    const store = makeStore()
    const { tried, failures } = await store.diagnose()
    // The store still says where it looked — that is the whole point: the user
    // needs those paths to be able to point the plugin somewhere else.
    expect(tried).toContain(join(root, AUTH_DIR, LIVE))
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ reason: 'missing', source: 'desktop' })
  })

  it('carries no message for an absence, because ENOENT only repeats the path', async () => {
    // The card prints each entry's path on its own `<code>` line. Node's ENOENT
    // text ("ENOENT: no such file or directory, open '<path>'") embeds that same
    // path, so shipping it rendered the identical string twice in a row — a
    // second, subtler version of the duplication this release fixes.
    const { failures } = await makeStore().diagnose()
    expect(failures[0]?.reason).toBe('missing')
    expect(failures[0]?.message).toBeUndefined()
  })

  it('keeps a message for a genuine read error, which says more than the reason', async () => {
    // EISDIR/EACCES are findings the reason alone cannot convey, and their text
    // does NOT repeat the path. Dropping those would hide real information.
    await mkdir(join(root, AUTH_DIR, LIVE), { recursive: true })
    const { failures } = await makeStore().diagnose()
    expect(failures[0]?.reason).toBe('unreadable')
    expect(failures[0]?.message).toContain('EISDIR')
    expect(failures[0]?.message).not.toContain(LIVE)
  })

  it('keeps absent plugin-owned copies out of the report', async () => {
    // Every machine lacks the plugin's own copy until the first refresh. Listing
    // it as a "checked path" would put two permanent entries of noise in front
    // of the one desktop path that actually matters.
    const { failures } = await makeStore().diagnose()
    expect(failures.some(failure => failure.source === 'dsh')).toBe(false)
  })

  it('reports nothing for a file it could actually read', async () => {
    await writeAuth(LIVE, accountDoc())
    const { failures } = await makeStore().diagnose()
    // A readable file must not appear: otherwise every healthy machine gets a
    // diagnostic list describing files that are perfectly fine.
    expect(failures).toEqual([])
  })

  it('reports a present but unparsable file as invalid', async () => {
    await writeAuth(LIVE, 'this is not JSON at all')
    const { failures } = await makeStore().diagnose()
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ reason: 'invalid', source: 'desktop' })
    expect(failures[0]?.path).toContain(LIVE)
    expect(failures[0]?.message).toContain('not valid JSON')
  })

  it('reports valid JSON with no token as invalid rather than missing', async () => {
    await writeAuth(LIVE, { account: { uid: 'uid-1' }, auth: { refreshToken: 'r' } })
    const { failures } = await makeStore().diagnose()
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ reason: 'invalid', source: 'desktop' })
    expect(failures[0]?.message).toContain('no access token')
  })

  it('reports an encrypted document as encrypted, not invalid, when no key is available', async () => {
    // This is the case the whole feature exists for: the user IS signed in, the
    // file is right there, and the plugin cannot open it without the desktop
    // app. Reporting this as "invalid" (or as nothing at all) sends them to
    // sign in again — the one action that cannot work.
    await writeAuth(LIVE, encryptedDoc())
    const { failures } = await makeStore({ resolveAtRestKey: async () => undefined }).diagnose()
    expect(failures).toHaveLength(1)
    expect(failures[0]?.reason).toBe('encrypted')
    expect(failures[0]?.message).toContain('desktop app')
  })

  it('reports encrypted when the key lookup itself throws', async () => {
    await writeAuth(LIVE, encryptedDoc())
    const { failures } = await makeStore({
      resolveAtRestKey: async () => { throw new Error('the app is not installed here') },
    }).diagnose()
    expect(failures).toHaveLength(1)
    expect(failures[0]?.reason).toBe('encrypted')
    expect(failures[0]?.message).toContain('not installed')
  })

  it('reports a key mismatch as invalid: the app was found, the document is broken', async () => {
    // A key WAS obtained and the envelope still would not open. That is a real
    // format problem (another build, a corrupted file), and the advice differs
    // from "install the desktop app".
    await writeAuth(LIVE, encryptedDoc())
    const wrongSecret = createHash('sha256').update('some-other-build').digest('base64')
    const { failures } = await makeStore({
      resolveAtRestKey: async () => createHash('sha256').update(wrongSecret, 'utf8').digest(),
    }).diagnose()
    expect(failures).toHaveLength(1)
    expect(failures[0]?.reason).toBe('invalid')
    expect(failures[0]?.message).toContain('desktop app')
  })

  it('does not leak token material into the report', async () => {
    await writeAuth(LIVE, accountDoc())
    await writeAuth('workbuddy-desktop.2026-01-01T00-00-00-000Z.info', encryptedDoc())
    const { failures } = await makeStore({ resolveAtRestKey: async () => undefined }).diagnose()
    // Only the encrypted backup fails; nothing that crosses to the browser may
    // contain token material from either file.
    expect(failures).toHaveLength(1)
    const serialized = JSON.stringify(failures)
    expect(serialized).not.toContain('token-alpha')
    expect(serialized).not.toContain('refresh-alpha')
  })

  it('reports a plugin-owned copy belonging to the other region as invalid', async () => {
    // Region scoping is enforced on the plugin's own copies too: a global store
    // must not present a CN credential as a usable (or merely unreadable) file.
    const ownPath = join(root, 'own-global.info')
    const legacyPath = join(root, 'own-legacy.info')
    await writeFile(ownPath, JSON.stringify({
      version: 1,
      credential: { accessToken: 'token-cn', domain: 'www.codebuddy.cn' },
    }), 'utf8')
    const store = makeStore({
      region: 'global',
      ownPath,
      legacyOwnPath: legacyPath,
    })
    const { failures } = await store.diagnose()
    const own = failures.find(failure => failure.source === 'dsh')
    expect(own?.reason).toBe('invalid')
    expect(own?.path).toBe(ownPath)
    // The absent legacy copy is still skipped rather than reported.
    expect(failures.some(failure => failure.path === legacyPath)).toBe(false)
  })

  it('reports a desktop file holding the OTHER region\'s sign-in', async () => {
    // The regression this pins, measured on a real machine: a CN-scoped store
    // saw a valid GLOBAL credential in the desktop file, and `diagnose` dropped
    // it on `'credential' in probe` — the same `continue` that drops malformed
    // files. `readAll` had already filtered it out by region, so the file was in
    // NO list: not an account, not a failure. A card then named two paths and
    // truthfully reported one, while the user's working sign-in was the entry
    // made invisible. It must be reported, and as the other region's.
    await writeAuth(LIVE, accountDoc()) // codebuddy.cn — the CN doc
    const store = makeStore({ region: 'global' })
    const { failures } = await store.diagnose()
    const desktop = failures.filter(failure => failure.source === 'desktop')
    expect(desktop).toHaveLength(1)
    expect(desktop[0]).toMatchObject({ reason: 'wrong-region', source: 'desktop' })
    expect(desktop[0]?.path).toBe(join(root, AUTH_DIR, LIVE))
    expect(desktop[0]?.message).toContain('cn')
  })

  it('counts every candidate path it names, so the total cannot under-report', async () => {
    // The visible symptom of the bug above: the summary said "1" while the
    // signed-out message enumerated two desktop paths. Every path the store
    // consults must come back either as a failure or as a read credential —
    // never as nothing.
    const store = makeStore({ region: 'global' })
    const { tried, failures } = await store.diagnose()
    // Match on the `desktop app` source, not on a path substring: the plugin's
    // own copies are named `.workbuddy-auth*.json` and a loose `includes('auth')`
    // counts them too.
    const desktopTried = tried.filter(path => path.startsWith(root) && path.includes(AUTH_DIR))
    expect(desktopTried).toHaveLength(1)
    const desktopFailures = failures.filter(failure => failure.source === 'desktop')
    // Nothing on disk: each desktop candidate is reported as missing.
    expect(desktopFailures).toHaveLength(desktopTried.length)
    expect(desktopFailures[0]).toMatchObject({ reason: 'missing' })
  })
})
